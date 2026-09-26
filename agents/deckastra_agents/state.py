"""The shared graph state (doc 03 §5).

A TypedDict rather than a class, because that is what LangGraph merges between
nodes — but the important property is the one doc 03 §5 states in a sentence and
that is easy to lose: **the state stores references to large artifacts, not the
artifacts.** A slide preview or a repository blob in the state is a slide preview
in every checkpoint, every Redis message and every resumed run.

The one deliberate exception is `document`. It is large, and it is here anyway,
because every node after Layout reasons about the current document and fetching
it per node would mean a node could act on a stale one. It is also the thing the
run exists to produce.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypedDict

from .budgets import RunBudget
from .events import AgentEvent

Stage = Literal[
    "orchestrate",
    "research",
    "story",
    "story_checkpoint",
    "creative",
    "layout",
    "motion",
    "critic",
    "propose",
    "done",
    "failed",
]

#: The verdicts the Critic may return, and where each routes (doc 03 §13.4).
CriticVerdict = Literal[
    "pass", "revise_story", "revise_layout", "revise_creative", "revise_motion"
]


def _append(left: list[Any] | None, right: list[Any] | None) -> list[Any]:
    """Reducer for the accumulating channels.

    LangGraph merges each key by replacement unless told otherwise, which would
    make every node's events overwrite the previous node's. Events, warnings and
    errors accumulate; everything else replaces.
    """
    return [*(left or []), *(right or [])]


class AgentError(TypedDict, total=False):
    stage: str
    category: str
    message: str
    recoverable: bool
    #: What the run did instead. Doc 03 §21 requires a stated fallback, not a
    #: silent one.
    fallback: str


class EditScope(TypedDict, total=False):
    """What the user is asking about (doc 03 §6, cross-cutting gap #1).

    Always explicit — doc 03 §28 makes that an acceptance criterion. An agent
    that has to infer scope from an instruction infers it wrong on the first
    ambiguous sentence, and then edits the whole deck.
    """

    kind: Literal["deck", "slide", "elements"]
    slide_ids: list[str]
    element_ids: list[str]
    #: Ids of the sources the user brought into scope — a file, a data source, a
    #: previous run's research. Added in Phase 5; without it, a scoped edit could
    #: not say which evidence it was allowed to use.
    sources: list[str]


class PresentationAgentState(TypedDict, total=False):
    run_id: str
    user_id: str
    project_id: str
    presentation_id: str

    request: dict[str, Any]
    scope: EditScope

    #: How the Orchestrator routed this run. Declared here rather than passed
    #: informally because LangGraph merges only the keys this TypedDict names —
    #: an undeclared key is silently dropped between nodes, and the routing then
    #: falls through to the default as though the Orchestrator had said nothing.
    orchestrator_plan: dict[str, Any]

    #: Research output. Ids and short summaries; retrieved bodies stay in the
    #: tool layer and are enveloped there.
    research: dict[str, Any]

    story_plan: dict[str, Any]
    creative_direction: dict[str, Any]
    layout_result: dict[str, Any]
    #: Motion intent per slide — roles and pacing, never durations. Declared here
    #: for the same reason as `orchestrator_plan`: LangGraph merges only the keys
    #: this TypedDict names, and an undeclared one is silently dropped.
    motion_plan: dict[str, Any]
    critic_results: Annotated[list[dict[str, Any]], _append]
    #: Every draft the Critic reviewed, with the score it gave it. Kept because
    #: the fallback has to be able to go *back* to a draft: a later revision can
    #: score worse than the one it replaced, and the run then tells the user the
    #: best draft was kept while proposing the worst one. Declared here because
    #: LangGraph merges only the keys this TypedDict names.
    reviewed_drafts: Annotated[list[dict[str, Any]], _append]

    #: The document as it stands. See the module docstring for why it is here.
    document: dict[str, Any]
    #: Operations the run wants applied. Never applied by an agent — handed to
    #: the transaction service, which is the only writer (doc 03 §2.2).
    proposed_operations: list[dict[str, Any]]

    current_stage: Stage
    #: Set when the graph is parked at a human checkpoint (doc 03 §17).
    awaiting: str | None
    human_decision: dict[str, Any]

    revision_target: str | None

    #: The contextual-edit path's output. Same reason as `orchestrator_plan`.
    edit_plan: dict[str, Any]
    #: The built-in agent's written change (`nodes/author.py`): operations, a summary
    #: for the person, or a refusal.
    author_plan: dict[str, Any]
    #: Critic issues the run could not resolve, travelling with the proposal so
    #: the editor can show them against the slides they belong to.
    unresolved_issues: list[dict[str, Any]]

    events: Annotated[list[AgentEvent], _append]
    warnings: Annotated[list[str], _append]
    errors: Annotated[list[AgentError], _append]

    #: Not serialised into the checkpoint — rebuilt per run by the runner.
    budget: RunBudget


def initial_state(
    *,
    run_id: str,
    user_id: str,
    project_id: str,
    presentation_id: str,
    request: dict[str, Any],
    document: dict[str, Any],
    scope: EditScope | None = None,
) -> PresentationAgentState:
    return {
        "run_id": run_id,
        "user_id": user_id,
        "project_id": project_id,
        "presentation_id": presentation_id,
        "request": request,
        "scope": scope or {"kind": "deck", "slide_ids": [], "element_ids": [], "sources": []},
        "document": document,
        "proposed_operations": [],
        "critic_results": [],
        "reviewed_drafts": [],
        "current_stage": "orchestrate",
        "awaiting": None,
        "events": [],
        "warnings": [],
        "errors": [],
    }


def scope_slide_ids(state: PresentationAgentState) -> list[str]:
    """The slides a run may touch, resolved from the scope.

    An empty list means the whole deck; a scope that names elements resolves to
    the slides those elements are on, so a node never has to do that resolution
    itself and get it subtly different.
    """
    scope = state.get("scope") or {}
    if scope.get("kind") == "deck":
        return []

    slide_ids = list(scope.get("slide_ids") or [])
    element_ids = set(scope.get("element_ids") or [])

    if element_ids:
        for slide in state.get("document", {}).get("slides", []):
            if _contains_any(slide.get("elements", []), element_ids) and slide["id"] not in slide_ids:
                slide_ids.append(slide["id"])

    return slide_ids


def _contains_any(elements: list[dict[str, Any]], wanted: set[str]) -> bool:
    for element in elements:
        if element.get("id") in wanted:
            return True
        if element.get("type") == "group" and _contains_any(element.get("children", []), wanted):
            return True
    return False
