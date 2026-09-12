"""What every node needs, in one place.

A node gets its dependencies through a `NodeContext` rather than importing them,
so that a test can run one node against a stub client and an in-memory store with
no graph, no database and no network. Doc 05 §17's rule — agent implementations
should not know database details — falls out of that.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from ..budgets import BudgetExceeded, RunBudget
from ..contracts import strict_schema
from ..events import AgentEvent, Emitter
from ..memory import ProjectMemory
from ..router import ModelClient, ModelError, ModelRequest, ModelResponse
from ..state import PresentationAgentState
from ..tools.registry import ToolRegistry

T = TypeVar("T", bound=BaseModel)


@dataclass
class NodeContext:
    client: ModelClient
    budget: RunBudget
    emit: Emitter
    registry: ToolRegistry
    memory: ProjectMemory | None = None


class NodeFailure(RuntimeError):
    """A node could not do its job. Carries what the run should do instead.

    Doc 03 §21: an error must state its stage, whether it is recoverable, and the
    fallback. An exception with only a message satisfies none of that, so the
    fields are required rather than optional.
    """

    def __init__(self, stage: str, category: str, message: str, *, fallback: str, recoverable: bool = True) -> None:
        super().__init__(message)
        self.stage = stage
        self.category = category
        self.fallback = fallback
        self.recoverable = recoverable

    def as_error(self) -> dict[str, Any]:
        return {
            "stage": self.stage,
            "category": self.category,
            "message": str(self),
            "recoverable": self.recoverable,
            "fallback": self.fallback,
        }


def started(state: PresentationAgentState, stage: str, agent_id: str, message: str) -> AgentEvent:
    return AgentEvent(
        run_id=state.get("run_id", ""), stage=stage, agent_id=agent_id, status="started", message=message
    )


def completed(
    state: PresentationAgentState,
    stage: str,
    agent_id: str,
    message: str,
    artifact_refs: list[str] | None = None,
) -> AgentEvent:
    return AgentEvent(
        run_id=state.get("run_id", ""),
        stage=stage,
        agent_id=agent_id,
        status="completed",
        message=message,
        artifact_refs=artifact_refs or [],
    )


def ask_model(
    ctx: NodeContext,
    *,
    stage: str,
    task_type: str,
    system: str,
    user: str,
    model: type[T],
    context: list[str] | None = None,
    max_tokens: int = 8_000,
) -> T:
    """One structured request, validated into a contract, with one repair attempt.

    The repair is the whole reason this is a helper. Re-asking blind gets the same
    malformed answer; handing the model its own validation errors gets a corrected
    one most of the time, and costs one round trip instead of a failed run.
    """
    request = ModelRequest(
        task_type=task_type,
        system=system,
        messages=[{"role": "user", "content": user}],
        response_schema=strict_schema(model),
        max_tokens=max_tokens,
        context=[block for block in (context or []) if block],
    )

    errors: list[str] = []
    observation: dict[str, Any] = {
        "stage": stage, "contract": model.__name__, "attempts": 0,
        "valid_first_attempt": False, "outcome": "pending",
    }
    ctx.budget.structured_requests.append(observation)

    for attempt in (1, 2):
        observation["attempts"] = attempt
        if errors:
            request.messages = [
                *request.messages,
                {
                    "role": "user",
                    "content": (
                        "That response did not validate:\n"
                        + "\n".join(f"- {error}" for error in errors)
                        + "\n\nReturn corrected JSON matching the schema exactly."
                    ),
                },
            ]

        try:
            response: ModelResponse = ctx.client.complete(request, ctx.budget)
        except BudgetExceeded:
            observation["outcome"] = "budget_exhausted"
            raise
        except ModelError as exc:
            observation["outcome"] = "provider_error"
            raise NodeFailure(
                stage,
                "model_failure",
                str(exc),
                fallback="The run stopped at this stage; earlier stages are kept.",
                recoverable=False,
            ) from exc

        if response.refusal:
            observation["outcome"] = "refusal"
            raise NodeFailure(
                stage,
                "model_failure",
                f"The model declined this request ({response.refusal}).",
                fallback="Rephrase the brief and try again.",
                recoverable=False,
            )

        try:
            validated = model.model_validate(json.loads(response.text))
            observation["valid_first_attempt"] = attempt == 1
            observation["outcome"] = "valid"
            return validated
        except (json.JSONDecodeError, ValidationError) as exc:
            observation["outcome"] = "invalid"
            errors = [str(exc)[:600]]
            if attempt == 2:
                raise NodeFailure(
                    stage,
                    "model_failure",
                    f"The model did not return a valid {model.__name__} after two attempts.",
                    fallback="The run stopped at this stage; earlier stages are kept.",
                    recoverable=False,
                ) from exc

    raise AssertionError("unreachable")
