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


@dataclass(frozen=True)
class ImageInput:
    data: str
    mime_type: str = "image/png"


@dataclass(frozen=True)
class ModelTool:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class ToolInvocation:
    name: str
    arguments: dict[str, Any]
    id: str = ""


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
    images: list[ImageInput] = field(default_factory=list)
    tools: list[ModelTool] = field(default_factory=list)
    stage: str = ""
    web_search: bool = False
    image_output: bool = False


@dataclass
class ModelResponse:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""
    #: Set when the provider declined; the caller decides what to tell the user.
    refusal: str | None = None
    tool_calls: list[ToolInvocation] = field(default_factory=list)
    provider_parts: list[dict[str, Any]] = field(default_factory=list)
    sources: list[dict[str, Any]] = field(default_factory=list)

    def json(self) -> Any:
        return json.loads(self.text)


class ModelClient(Protocol):
    """What the agents need from a provider. Implemented by Vertex and the development stub."""

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


class ContextTooLarge(ModelUnavailable):
    """The request does not fit the serving context window.

    A subclass so every existing handler treats it as before; its own type lets a
    caller tell the person the remedy is a smaller selection rather than set-up.
    """


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


# Provider choice is explicit; stubs are restricted to development and CI.
MODELS: dict[str, str] = {}
INTELLIGENCE_ENV = "DECKASTRA_INTELLIGENCE"
DISTRIBUTION_ENV = "DECKASTRA_DISTRIBUTION"
PROVIDER_STUB = "stub"
PROVIDER_NONE = "none"
NOT_SET_UP = "Sign in to use Deckastra AI credits. Editing, exports and MCP remain available."

class IntelligenceMisconfigured(ModelUnavailable):
    pass


def distribution() -> bool:
    return os.environ.get(DISTRIBUTION_ENV, "").strip() == "1"


def intelligence() -> str:
    raw = os.environ.get(INTELLIGENCE_ENV, "").strip().lower()
    if raw not in ("", "vertex", "stub"):
        raise IntelligenceMisconfigured("DECKASTRA_INTELLIGENCE must be vertex, stub, or unset. The local and Anthropic providers have been retired.")
    return raw


def selected_provider() -> str:
    choice = intelligence()
    hosted = os.environ.get("DECKASTRA_ENV", "").lower() == "production"
    if choice == "vertex":
        return "vertex"
    if distribution() or hosted:
        if choice == "stub":
            raise ModelUnavailable("The stub planner is only available in development and CI.")
        return PROVIDER_NONE
    return PROVIDER_STUB


def generation_status() -> dict[str, object]:
    try:
        provider = selected_provider()
    except IntelligenceMisconfigured as exc:
        return {"provider": "misconfigured", "available": False, "reason": str(exc)}
    except ModelUnavailable as exc:
        return {"provider": "unavailable", "available": False, "reason": str(exc)}
    if provider == PROVIDER_NONE:
        return {"provider": provider, "available": False, "reason": NOT_SET_UP}
    if provider == "vertex":
        from .vertex_router import status
        return status()
    return {"provider": provider, "available": True, "reason": None}


def default_client(fallback: Callable[[], ModelClient] | None = None) -> ModelClient:
    provider = selected_provider()
    if provider == "vertex":
        from .vertex_router import configured_client
        return configured_client()
    if provider == PROVIDER_NONE:
        raise ModelUnavailable(NOT_SET_UP)
    return fallback() if fallback is not None else StubClient()
