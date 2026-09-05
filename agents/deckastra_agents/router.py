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
        self._answers[task_type] = payload

    def complete(self, request: ModelRequest, budget: RunBudget) -> ModelResponse:
        self.calls.append(request)
        if request.task_type not in self._answers:
            raise ModelError(
                f"No stub answer registered for task type {request.task_type!r}. "
                "Register one, or run with a real API key."
            )

        text = json.dumps(self._answers[request.task_type])
        # Charged so budget accounting is exercised on the stub path too.
        budget.spend_tokens(len(request.system) // 4, len(text) // 4)
        return ModelResponse(text=text, model="stub", output_tokens=len(text) // 4)


def default_client() -> ModelClient:
    """The real client when a key is configured, the stub when one is not."""
    return AnthropicClient() if api_key_available() else StubClient()
