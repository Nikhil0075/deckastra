"""Proposal (doc 03 §16, doc 02 §31.6).

The last node. It turns whatever the run produced into patch operations and stops
— it does not write them. Doc 03 §2.2 and §25 both say an agent must not mutate
the store, and this is where that stays true even though the run now has
something worth writing.

The output is a list of operations and nothing else. The caller passes them to
the transaction service, which validates, computes the risk tier server-side and
decides whether they apply now or wait for a human (doc 02 §31.7).
"""

from __future__ import annotations

from typing import Any, Callable

from ..state import PresentationAgentState
from ._common import NodeContext, completed, started

AGENT_ID = "propose"
STAGE = "propose"

#: Turns a story plan into operations. Injected because it is the composer's job,
#: and the composer lives in the API — an agent that imported it would be an
#: agent that knows about the application (doc 05 §17).
Composer = Callable[
    [dict[str, Any], dict[str, Any], dict[str, Any]], list[dict[str, Any]]
]


def propose(
    state: PresentationAgentState,
    ctx: NodeContext,
    compose: Composer,
) -> dict[str, Any]:
    ctx.emit(started(state, STAGE, AGENT_ID, "Preparing the change"))
    ctx.budget.check_clock()

    plan = state.get("story_plan") or {}
    if not plan.get("slides"):
        ctx.emit(completed(state, STAGE, AGENT_ID, "Nothing to propose"))
        return {"current_stage": "done", "proposed_operations": []}

    operations = compose(
        plan,
        state.get("creative_direction") or {},
        state.get("motion_plan") or {},
    )

    # Unresolved issues travel with the proposal so the editor can show them
    # against the slides they belong to (doc 03 §13's fallback, made visible).
    unresolved = [
        issue
        for result in (state.get("critic_results") or [])
        for issue in result.get("issues", [])
        if result.get("forced")
    ]

    ctx.emit(
        completed(
            state,
            STAGE,
            AGENT_ID,
            f"{len(operations)} operation(s) ready for review",
            artifact_refs=[f"proposal:{state.get('run_id', '')}"],
        )
    )

    return {
        "current_stage": "done",
        "proposed_operations": operations,
        "unresolved_issues": unresolved,
    }
