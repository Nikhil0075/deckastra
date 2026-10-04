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
from .critic import best_candidate

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
    warnings: list[str] = []

    results = state.get("critic_results") or []
    forced = bool(results and results[-1].get("forced"))
    selected = state
    review = results[-1] if results else {}

    if forced:
        # The Critic's fallback says "the best draft was kept". That was not true
        # of anything: this node composed whatever the last revision produced,
        # and a later revision can score worse than the one it replaced. Making
        # the sentence true is the whole of this branch.
        candidate = best_candidate(state)
        best = candidate.get("story_plan") if candidate else None
        if candidate:
            selected = {**state, **candidate}
            # Older checkpoints recorded only the story and score. Their
            # reviews have the same ordering as the candidate list.
            review = candidate.get("review") or next(
                (r for r in results if r.get("score") == candidate.get("score")), {}
            )
        if best and best is not plan:
            if best != plan:
                warnings.append(
                    "A later revision scored lower than an earlier draft, so the "
                    "earlier one was proposed instead."
                )
            plan = best

    if not plan.get("slides"):
        ctx.emit(completed(state, STAGE, AGENT_ID, "Nothing to propose"))
        return {"current_stage": "done", "proposed_operations": []}

    operations = compose(
        plan,
        selected.get("creative_direction") or {},
        selected.get("motion_plan") or {},
    )
    source_rows = list((selected.get("research") or {}).get("sources") or [])
    if source_rows:
        known = {source["id"] for source in source_rows}
        slides = next((op["value"] for op in operations if op.get("path") == "/slides"), [])
        for slide, planned in zip(slides, plan.get("slides", [])):
            cited = list(planned.get("source_ids") or [])
            slide.setdefault("extensions", {})["deckastra.sourceIds"] = [source_id for source_id in cited if source_id in known]
            if any(source_id not in known for source_id in cited):
                warnings.append("The writer cited an unavailable source; it was omitted from the persisted citations.")
            if not cited:
                warnings.append(f"Slide {slide.get('name', slide['id'])} has no supporting source; verify factual claims.")
        extensions = dict((state.get("document") or {}).get("extensions") or {})
        extensions["deckastra.sources"] = source_rows
        operations.append({"op": "add", "path": "/extensions", "value": extensions})

    # Unresolved issues travel with the proposal so the editor can show them
    # against the slides they belong to (doc 03 §13's fallback, made visible).
    unresolved = list(review.get("issues") or []) if forced else []

    if unresolved:
        # Into the document, not only into graph state. State is gone when the
        # run ends; the editor reads a document. `extensions` is the schema's
        # designated place for exactly this (doc 02 §0.8), so nothing has to
        # change in the schema to carry it, and an `add` rather than a `replace`
        # because a deck that has never carried extensions has no such property.
        by_slide: dict[str, list[dict[str, Any]]] = {}
        slides = next((op["value"] for op in operations if op.get("path") == "/slides"), [])
        for issue in unresolved:
            key = str(issue.get("slide_id") or "")
            # Planning contracts use zero-based slide indexes before the
            # composer mints document IDs. Store the resolved identity for UI.
            if key.isdecimal() and int(key) < len(slides):
                key = slides[int(key)]["id"]
            by_slide.setdefault(key, []).append({**issue, "slide_id": key})

        extensions = dict(next((op["value"] for op in operations if op.get("path") == "/extensions"), (state.get("document") or {}).get("extensions") or {}))
        extensions["deckastra.unresolvedIssues"] = by_slide
        operations = [
            *operations,
            {"op": "add", "path": "/extensions", "value": extensions},
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
        "story_plan": plan,
        "creative_direction": selected.get("creative_direction") or {},
        "motion_plan": selected.get("motion_plan") or {},
        "layout_result": selected.get("layout_result") or {},
        "research": selected.get("research") or {},
        "proposed_operations": operations,
        "unresolved_issues": unresolved,
        "warnings": warnings,
    }
