"""Running a graph, and resuming one (doc 03 §17, §19).

The graph is the interesting part; this is the boring part that has to be right.
It owns the things that are per-run rather than per-node: the budget, the
emitter, the checkpoint thread id, and what happens when the run stops at a human
checkpoint.

Resumption is the reason this is a module rather than three lines at a call site.
A run that pauses for story approval may be resumed minutes or hours later, in a
different process, by a different request. That works only if the thread id is
derived from the run id and the checkpointer is durable — which is why the run id
is chosen by the caller and stored, rather than generated here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from .budgets import BudgetExceeded, RunBudget
from .events import AgentEvent, Emitter, collector
from .memory import ProjectMemory
from .nodes._common import NodeContext
from .nodes.propose import Composer
from .router import ModelClient
from .state import PresentationAgentState
from .tools.registry import ToolRegistry


@dataclass
class RunResult:
    run_id: str
    status: str
    state: dict[str, Any]
    events: list[AgentEvent] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[dict[str, Any]] = field(default_factory=list)
    budget: dict[str, Any] = field(default_factory=dict)

    @property
    def awaiting(self) -> str | None:
        return self.state.get("awaiting")

    @property
    def operations(self) -> list[dict[str, Any]]:
        return self.state.get("proposed_operations") or []


@dataclass
class AgentRun:
    """Everything one run needs, assembled once."""

    client: ModelClient
    registry: ToolRegistry
    compose: Composer
    budget: RunBudget = field(default_factory=RunBudget)
    memory: ProjectMemory | None = None
    emit: Emitter | None = None
    checkpointer: Any | None = None
    #: False in the API's synchronous path, where there is nobody to approve
    #: mid-request. The checkpoint is a product feature, not a test artefact —
    #: see `run_generation`'s docstring for when it is off.
    human_checkpoint: bool = True

    def context(self) -> NodeContext:
        return NodeContext(
            client=self.client,
            budget=self.budget,
            emit=self.emit or (lambda event: None),
            registry=self.registry,
            memory=self.memory,
        )


def _thread(run_id: str) -> dict[str, Any]:
    """The checkpoint key.

    Derived from the run id rather than generated, so a resume in another process
    finds the same thread. Getting this wrong produces a resume that silently
    starts a new run, which looks like the checkpoint never happened.
    """
    return {"configurable": {"thread_id": f"deckastra:{run_id}"}}


def run_generation(
    run: AgentRun,
    state: PresentationAgentState,
) -> RunResult:
    """Run the graph until it finishes or stops at a checkpoint.

    Returns rather than raises on a budget exhaustion: doc 03 §21's rule is that
    a failure degrades and reports, and a caller that gets an exception has lost
    the partial work along with the explanation.
    """
    from .graph import build_graph  # imported here so `import deckastra_agents` needs no langgraph

    events, collect = collector()
    emit = run.emit or collect
    if run.emit is not None:
        # Collected as well as emitted: the caller wants the list back even when
        # events are also going to Redis.
        original = run.emit

        def emit(event: AgentEvent) -> None:  # type: ignore[misc]
            collect(event)
            original(event)

    run.emit = emit
    graph = build_graph(
        run.context(),
        run.compose,
        checkpointer=run.checkpointer,
        checkpoint_before_story_approval=run.human_checkpoint and run.checkpointer is not None,
    )

    config = _thread(state["run_id"]) if run.checkpointer is not None else {}

    try:
        final = graph.invoke(state, config=config)
    except BudgetExceeded as exhausted:
        return RunResult(
            run_id=state["run_id"],
            status="exhausted",
            state=dict(state),
            events=events,
            warnings=[*run.budget.warnings, str(exhausted)],
            errors=[
                {
                    "stage": state.get("current_stage", "unknown"),
                    "category": "timeout" if exhausted.budget == "time" else "budget",
                    "message": str(exhausted),
                    "recoverable": True,
                    "fallback": "What the run produced before the budget ran out is kept.",
                }
            ],
            budget=run.budget.report(),
        )

    # A graph compiled with an interrupt returns when it hits one. `awaiting`
    # tells the caller whether this is a finished run or a paused one.
    paused = run.checkpointer is not None and _is_paused(graph, config)

    return RunResult(
        run_id=state["run_id"],
        status="awaiting_approval" if paused else _status(final),
        state=dict(final),
        events=events,
        warnings=list(final.get("warnings") or []) + run.budget.warnings,
        errors=list(final.get("errors") or []),
        budget=run.budget.report(),
    )


def resume_generation(
    run: AgentRun,
    run_id: str,
    decision: dict[str, Any],
) -> RunResult:
    """Continue a run that stopped for story approval.

    The decision is written into the checkpointed state before resuming, so the
    routing after the checkpoint reads a real answer rather than a default. A
    rejection ends the run — the user said no, and continuing to "save the work"
    would be doing the thing they declined.
    """
    from .graph import build_graph

    if run.checkpointer is None:
        raise ValueError("Resuming needs a checkpointer; this run had none.")

    events, collect = collector()
    run.emit = collect

    graph = build_graph(run.context(), run.compose, checkpointer=run.checkpointer)
    config = _thread(run_id)

    graph.update_state(config, {"human_decision": decision, "awaiting": None})

    try:
        final = graph.invoke(None, config=config)
    except BudgetExceeded as exhausted:
        return RunResult(
            run_id=run_id,
            status="exhausted",
            state={},
            events=events,
            warnings=[str(exhausted)],
            budget=run.budget.report(),
        )

    return RunResult(
        run_id=run_id,
        status=_status(final),
        state=dict(final),
        events=events,
        warnings=list(final.get("warnings") or []) + run.budget.warnings,
        errors=list(final.get("errors") or []),
        budget=run.budget.report(),
    )


def _is_paused(graph: Any, config: dict[str, Any]) -> bool:
    try:
        snapshot = graph.get_state(config)
    except Exception:  # noqa: BLE001 - a missing checkpoint is not a pause
        return False
    return bool(getattr(snapshot, "next", ()))


def _status(final: dict[str, Any]) -> str:
    if final.get("current_stage") == "failed":
        return "failed"
    if final.get("awaiting"):
        return "awaiting_approval"
    return "completed"


#: Type alias re-exported so callers do not import from `nodes`.
ComposeFn = Callable[[dict[str, Any], dict[str, Any]], list[dict[str, Any]]]
