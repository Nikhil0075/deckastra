"""Model routing (doc 03 §24).

One interface between the agents and whatever produces text. It exists for two
reasons, and only one of them is provider independence:

1. **The provider can change without touching an agent.** Doc 03 §28 makes that
   an acceptance criterion.
2. **Every agent's model call goes through one place**, which is where the
   budget is charged, the envelope policy is asserted, retries happen and the
   structured-output contract is enforced. Six agents each calling the SDK
   directly is six places to forget one of those.

Routing is by *task*, not by name. An agent asks for "the model for structured
planning" rather than for a model id, so raising the reasoning effort for story
work is a change here rather than in six prompts.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from collections.abc import Callable
from typing import Any, Protocol

from .budgets import RunBudget
from .envelope import POLICY

#: Task classes agents route by. Deliberately few: a taxonomy nobody can hold in
#: their head gets used inconsistently.
TASK_PLANNING = "planning"  # narrative, structure, long-horizon decisions
TASK_STRUCTURED = "structured"  # a schema-constrained transformation
TASK_CRITIQUE = "critique"  # judging work, needs care but not invention
TASK_FAST = "fast"  # classification and routing


@dataclass
class ModelRequest:
    task_type: str
    system: str
    messages: list[dict[str, Any]]
    #: JSON Schema the response must satisfy. Structured output, not parsing.
    response_schema: dict[str, Any] | None = None
    max_tokens: int = 8_000
    #: Extra system context appended after the contract, before the policy.
    context: list[str] = field(default_factory=list)


@dataclass
class ModelResponse:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""
    #: Set when the provider declined; the caller decides what to tell the user.
    refusal: str | None = None

    def json(self) -> Any:
        return json.loads(self.text)


class ModelClient(Protocol):
    """What the agents need from a provider. Implemented by Anthropic and by the stub."""

    def complete(self, request: ModelRequest, budget: RunBudget) -> ModelResponse: ...


class ModelError(RuntimeError):
    """A provider failure the run cannot recover from on its own."""


class ModelUnavailable(ModelError):
    """There is no model to ask, and the run must say so rather than substitute one.

    Separate from `ModelError` because the cause is configuration rather than a
    provider having a bad minute: nothing is wrong, something is missing, and the
    message names what to install or choose. `ask_model` already turns any
    `ModelError` into a stage failure that keeps earlier stages, which is the
    right handling for both.
    """


# ---------------------------------------------------------------- Anthropic

#: Task -> model. One table, so changing what runs where is one edit.
MODELS: dict[str, str] = {
    TASK_PLANNING: "claude-opus-5",
    TASK_STRUCTURED: "claude-opus-5",
    TASK_CRITIQUE: "claude-opus-5",
    TASK_FAST: "claude-haiku-4-5-20251001",
}


def api_key_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


class AnthropicClient:
    """The real provider.

    Retries only on the failures a retry can fix — a connection drop, a 429, a
    5xx. Retrying a 400 sends the same malformed request again and burns the
    budget twice for the same answer.
    """

    MAX_ATTEMPTS = 3

    def __init__(self, models: dict[str, str] | None = None) -> None:
        import anthropic  # imported lazily so the stub path needs no SDK

        self._anthropic = anthropic
        self._client = anthropic.Anthropic()
        self._models = models or MODELS

    def complete(self, request: ModelRequest, budget: RunBudget) -> ModelResponse:
        budget.check_clock()
        model = self._models.get(request.task_type, MODELS[TASK_STRUCTURED])

        system = "\n\n".join([request.system, *request.context, POLICY])

        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": request.max_tokens,
            "system": system,
            "messages": request.messages,
            # Adaptive thinking: the agents' work is exactly the kind that
            # benefits, and the budget ceiling is what bounds the cost rather than
            # a per-request token guess.
            "thinking": {"type": "adaptive"},
        }
        if request.response_schema is not None:
            kwargs["output_config"] = {
                "format": {"type": "json_schema", "schema": request.response_schema}
            }

        last_error: Exception | None = None

        for attempt in range(1, self.MAX_ATTEMPTS + 1):
            try:
                response = self._client.messages.create(**kwargs)
            except (self._anthropic.APIConnectionError, self._anthropic.RateLimitError) as exc:
                last_error = exc
                # Exponential, because an immediate retry into a rate limit is
                # just a second rate limit.
                time.sleep(min(2**attempt, 8))
                continue
            except self._anthropic.APIStatusError as exc:
                if exc.status_code >= 500:
                    last_error = exc
                    time.sleep(min(2**attempt, 8))
                    continue
                raise ModelError(f"Claude API error {exc.status_code}: {exc.message}") from exc

            budget.spend_tokens(response.usage.input_tokens, response.usage.output_tokens)

            # Always check stop_reason before reading content.
            if response.stop_reason == "refusal":
                detail = getattr(response, "stop_details", None)
                category = getattr(detail, "category", None) or "unspecified"
                return ModelResponse(
                    text="",
                    input_tokens=response.usage.input_tokens,
                    output_tokens=response.usage.output_tokens,
                    model=model,
                    refusal=str(category),
                )

            text = next((block.text for block in response.content if block.type == "text"), "")
            return ModelResponse(
                text=text,
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                model=model,
            )

        raise ModelError(f"Could not reach the Claude API after {self.MAX_ATTEMPTS} attempts: {last_error}")


# --------------------------------------------------------------------- stub


class StubClient:
    """A deterministic client for running without credentials.

    Not a test mock. It is what keeps the whole agent path — the graph, the
    checkpointer, the streaming, the proposal lifecycle — exercisable on a fresh
    clone and in CI without spending anything. Every agent registers the answer
    it should give; anything unregistered raises, so a new agent cannot silently
    get an empty response and look like it worked.
    """

    def __init__(self) -> None:
        self._answers: dict[str, Any] = {}
        self.calls: list[ModelRequest] = []

    def register(self, task_type: str, payload: Any) -> None:
        """Register the answer for a task type.

        `payload` may be a callable taking the `ModelRequest`. That is not a
        convenience: some stub answers have to depend on what was actually
        retrieved — a repository-grounded plan cannot cite sources it was written
        before seeing — and a callable is how the stub reads the same prompt the
        real model would.
        """
        self._answers[task_type] = payload

    def complete(self, request: ModelRequest, budget: RunBudget) -> ModelResponse:
        self.calls.append(request)
        if request.task_type not in self._answers:
            raise ModelError(
                f"No stub answer registered for task type {request.task_type!r}. "
                "Register one, or run with a real API key."
            )

        answer = self._answers[request.task_type]
        text = json.dumps(answer(request) if callable(answer) else answer)
        # Charged so budget accounting is exercised on the stub path too.
        budget.spend_tokens(len(request.system) // 4, len(text) // 4)
        return ModelResponse(text=text, model="stub", input_tokens=len(request.system) // 4, output_tokens=len(text) // 4)


# ------------------------------------------------------------- which provider

#: What the operator or the user chose. Unset is the historical behaviour and
#: must stay that way: the web app, CI and every existing test run through it.
INTELLIGENCE_ENV = "DECKASTRA_INTELLIGENCE"
INTELLIGENCE_LOCAL = "local"
INTELLIGENCE_CLOUD = "cloud"


#: What will actually produce text here.
PROVIDER_LOCAL = "local"
PROVIDER_CLOUD = "cloud"
PROVIDER_STUB = "stub"


def intelligence() -> str:
    return os.environ.get(INTELLIGENCE_ENV, "").strip().lower()


def selected_provider() -> str:
    """Which provider this install will use, without building it.

    Several places need this answer and none of them wants to construct a client
    to get it: `/health` reports it, generation provenance records whether a deck
    was written by a model or by the stub, and the call sites below choose which
    fallback to prepare. They all used to ask `api_key_available()` instead, which
    was the same question only while there were two answers — with local
    intelligence a keyless install is not a stub install, and every one of those
    sites would have said it was.
    """
    choice = intelligence()
    if choice == INTELLIGENCE_LOCAL:
        return PROVIDER_LOCAL
    if choice == INTELLIGENCE_CLOUD:
        return PROVIDER_CLOUD
    return PROVIDER_CLOUD if api_key_available() else PROVIDER_STUB


def default_client(fallback: "Callable[[], ModelClient] | None" = None) -> ModelClient:
    """The provider this install is configured to use.

    Three branches, and the reason there are three rather than a fallback chain:
    **a fallback is a decision made silently.** Someone who selected local
    intelligence did it because nothing of theirs should leave the machine, or
    because there is no network; answering from Anthropic instead would be a
    privacy decision taken on their behalf, in the one direction that cannot be
    taken back once the request has been sent. Someone who selected cloud and has
    no key has a configuration problem, and a stub deck is not the answer to it —
    it looks like a generated deck that came out badly.

    So each explicit choice is honoured or refused. Only the unset case, which is
    the web app and CI, keeps the old "a key if there is one, the stub if not" —
    and `fallback` is how a caller supplies the stub it has prepared answers for.
    It is a callable because on every other path it is never needed, and because
    building one means registering answers against the request.
    """
    choice = intelligence()

    if choice == INTELLIGENCE_LOCAL:
        # Imported here so nothing on the cloud path pays for it, and — more to
        # the point — so this branch returns without any expression in it that
        # could reach a key.
        from .local_model import local_client

        return local_client()

    if choice == INTELLIGENCE_CLOUD:
        if not api_key_available():
            raise ModelUnavailable(
                "Cloud generation is selected and no API key is configured. Set "
                "ANTHROPIC_API_KEY, or choose local intelligence."
            )
        return AnthropicClient()

    if api_key_available():
        return AnthropicClient()
    return fallback() if fallback is not None else StubClient()
