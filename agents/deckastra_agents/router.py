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


#: The smallest output allowance a cloud request is given (see `complete`).
#: The SDK refuses a non-streaming request whose `max_tokens` implies more than
#: ten minutes of output (about 21,000 for these models), so this stays under it.
CLOUD_MIN_OUTPUT_TOKENS = 16_000


def api_key_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


#: JSON Schema keywords Anthropic's structured output rejects (a 400 for the
#: whole request). Pydantic emits several of them from `Field(ge=, le=,
#: min_length=, ...)`, and every cloud generation and AI edit failed on the
#: first one it met — "For 'number' type, properties maximum, minimum are not
#: supported" — on an installed app with a valid key. Nothing tested it: the
#: suites run the stub client, which never sends a schema anywhere.
_UNSUPPORTED_KEYWORDS = frozenset(
    {
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minLength",
        "maxLength",
        "pattern",
        "maxItems",
        "uniqueItems",
        "minProperties",
        "maxProperties",
    }
)
#: The string formats structured output accepts; any other is dropped.
_SUPPORTED_FORMATS = frozenset(
    {"date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"}
)


def api_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """The subset of a contract's JSON Schema the API will accept.

    The schema is a hint that constrains sampling; **our Pydantic validation is
    the authority** (`ask_model` validates every answer and asks for a repair),
    so a bound removed here is still enforced — it is just enforced by us. What
    is removed: numeric and string bounds, `pattern`, array bounds other than a
    `minItems` of 0 or 1, unknown string formats. Every object is closed with
    `additionalProperties: false`, which structured output requires.

    A copy: the caller's schema (often cached) is never modified.
    """

    def clean(node: Any) -> Any:
        if isinstance(node, list):
            return [clean(item) for item in node]
        if not isinstance(node, dict):
            return node
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key in _UNSUPPORTED_KEYWORDS:
                continue
            if key == "minItems" and not (isinstance(value, int) and value in (0, 1)):
                continue
            if key == "format" and value not in _SUPPORTED_FORMATS:
                continue
            if key in ("properties", "$defs", "definitions") and isinstance(value, dict):
                out[key] = {name: clean(child) for name, child in value.items()}
                continue
            out[key] = clean(value)
        if out.get("type") == "object" or "properties" in out:
            if out.get("additionalProperties") not in (None, False):
                # A map-valued field (`dict[str, X]`) cannot be expressed; the
                # model returns an empty object and our validation decides.
                out["additionalProperties"] = False
            elif "properties" in out:
                out["additionalProperties"] = False
        return out

    return clean(schema)


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
            # Thinking is charged against `max_tokens`, so a stage's own figure
            # (2,000 for the orchestrator, 4,000 for a 20-slide layout) can be
            # spent before any JSON is written. A floor keeps room for the
            # answer; it is a ceiling, not a charge, and the run's token budget
            # is still what bounds cost. Below the SDK's non-streaming limit.
            "max_tokens": max(request.max_tokens, CLOUD_MIN_OUTPUT_TOKENS),
            "system": system,
            "messages": request.messages,
        }
        if not model.startswith("claude-haiku-4-5"):
            # Adaptive thinking: the agents' work is exactly the kind that
            # benefits, and the budget ceiling is what bounds the cost rather
            # than a per-request token guess. Haiku 4.5 predates it.
            kwargs["thinking"] = {"type": "adaptive"}
        if request.response_schema is not None:
            kwargs["output_config"] = {
                "format": {"type": "json_schema", "schema": api_schema(request.response_schema)}
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
                # A rejected key is not a failure of the request, and retrying
                # it will never help. Said plainly, and as "not available" so the
                # app offers the place to fix it (item 23).
                if exc.status_code in (401, 403):
                    raise ModelUnavailable(
                        "Anthropic refused this API key. Check the key under Intelligence, "
                        f"or use an AI agent instead. ({exc.status_code})"
                    ) from exc
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

            # Cut off: whatever text there is, is half an answer. Said as what
            # it is, rather than surfacing as a JSON syntax error that a repair
            # request at the same limit would only reproduce.
            if response.stop_reason == "max_tokens":
                raise ModelError(
                    f"The answer was cut off at the {kwargs['max_tokens']:,}-token limit "
                    "before it was complete. Try fewer slides or a shorter brief."
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
#: Nothing is set up to generate. Only a distributed build answers this; see
#: `distribution()`.
PROVIDER_NONE = "none"

#: Set by the desktop app when it is the installed product rather than a
#: checkout (`sidecar.ts`, from `app.isPackaged`).
DISTRIBUTION_ENV = "DECKASTRA_DISTRIBUTION"

NOT_SET_UP = (
    "Generation is not set up on this install. Add a cloud API key under "
    "Intelligence, or connect an AI agent (Claude Code, Codex) to write decks."
)
LOCAL_NOT_INCLUDED = (
    "Local models are not included in this release. Use a cloud API key, or "
    "connect an AI agent."
)


def distribution() -> bool:
    """Whether this is an installed product rather than a checkout, a test or CI.

    The difference that matters (final package review, item 20): unset means the
    stub here — which keeps the vertical slice runnable with no key and no money
    — and the stub writes a template deck that looks like a model wrote it
    badly. On an installed product that is a deck someone believes was
    generated. So an installed product answers "not set up" instead, and also
    will not treat a key it merely inherited from the environment as consent to
    send anything to the cloud: that takes choosing cloud explicitly.
    """
    return os.environ.get(DISTRIBUTION_ENV, "").strip() == "1"


#: Every value `DECKASTRA_INTELLIGENCE` may hold, after trimming and
#: lower-casing. Empty is "unset": the web app and CI.
INTELLIGENCE_MODES = frozenset({"", INTELLIGENCE_LOCAL, INTELLIGENCE_CLOUD})


class IntelligenceMisconfigured(ModelUnavailable):
    """`DECKASTRA_INTELLIGENCE` holds a value this build does not know.

    A subclass of `ModelUnavailable` so every route that already answers "not
    available" with a 503 and the message answers this one the same way: nothing
    failed and nothing is upstream, the install was told something it cannot do.
    """


def intelligence() -> str:
    """The configured mode, validated.

    An unknown value is refused rather than read as unset (final package review,
    item 04). It used to fall through to the unset case, which picks the cloud
    whenever a key happens to be present — so `locla`, written by someone who
    meant *nothing leaves this machine*, selected the cloud provider. The probe
    established that selection, not an observed request; the next generation is
    what would have sent anything. A typo in the one setting that decides where
    content goes must stop, not guess.
    """
    raw = os.environ.get(INTELLIGENCE_ENV, "")
    choice = raw.strip().lower()
    if choice not in INTELLIGENCE_MODES:
        raise IntelligenceMisconfigured(
            f"{INTELLIGENCE_ENV} is set to {raw!r}, which this build does not recognise. "
            f"Use 'local' or 'cloud', or leave it unset. Nothing was sent anywhere."
        )
    return choice


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
        if distribution():
            raise ModelUnavailable(LOCAL_NOT_INCLUDED)
        return PROVIDER_LOCAL
    if choice == INTELLIGENCE_CLOUD:
        return PROVIDER_CLOUD
    if distribution():
        return PROVIDER_NONE
    return PROVIDER_CLOUD if api_key_available() else PROVIDER_STUB


def generation_status() -> dict[str, object]:
    """What generation will do here, for a person to read before they start.

    `provider` is `cloud`, `local`, `stub`, `none` (nothing set up, installed
    product only), `unavailable` (chosen but not in this release) or
    `misconfigured` (a mode this build does not know). `available` says whether
    pressing Generate can work; `reason` says why not, in words someone can act
    on (final package review, item 19). Builds nothing and sends nothing.
    """
    try:
        provider = selected_provider()
    except IntelligenceMisconfigured as exc:
        return {"provider": "misconfigured", "available": False, "reason": str(exc)}
    except ModelUnavailable as exc:
        return {"provider": "unavailable", "available": False, "reason": str(exc)}
    if provider == PROVIDER_NONE:
        return {"provider": PROVIDER_NONE, "available": False, "reason": NOT_SET_UP}
    if provider == PROVIDER_CLOUD and not api_key_available():
        return {
            "provider": PROVIDER_CLOUD,
            "available": False,
            "reason": "Cloud generation is chosen and no API key is set.",
        }
    return {"provider": provider, "available": True, "reason": None}


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

    # An installed product with nothing chosen refuses rather than stubbing
    # (item 20), and does not ship local models (the 0.9 release scope).
    provider = selected_provider()
    if provider == PROVIDER_NONE:
        raise ModelUnavailable(NOT_SET_UP)

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
