"""The Layout Agent (doc 03 §11).

Chooses *which* layout each slide uses. It proposes; it never places. Doc 03 §11
is explicit that the Layout Agent emits intent and the deterministic layout
engine emits geometry, and the split is what keeps generated slides from
overlapping the first time real text is longer than the sample.

In Phase 5 the Story Architect already names a layout per slide, so this node's
job is narrower than it will eventually be: it reviews those choices against the
content and changes the ones that do not fit — a `metrics` slide with no numbers,
a `bullets` slide with one bullet. That is a real job, and doing it separately
from story writing is what lets the Critic route a layout complaint back here
without asking for the copy to be rewritten.
"""

from __future__ import annotations

from typing import Any

from ..contracts import LayoutProposal, SlideLayout
from ..state import PresentationAgentState
from ._common import NodeContext, ask_model, completed, started

AGENT_ID = "layout"
STAGE = "layout"

SYSTEM = """\
You are the Layout Agent for Deckastra.

For each slide you are given content and a proposed layout. You decide whether
that layout suits the content, and change it when it does not.

You emit layout NAMES only. You never emit coordinates, sizes, or spacing —
deterministic code places every object, and it can only do that correctly if you
tell it the shape of the content rather than where to put it.

The vocabulary:
  title | statement | bullets | metrics | quote | code | split

Judge on fit, not variety alone:
  - metrics needs two or more actual numbers. One number is a statement.
  - bullets needs three or more points. Two points is a split or a statement.
  - quote needs a real quotation and an attribution.
  - code needs a code sample. A description of code is bullets or body text.
  - statement is for a turning point, and works because it is rare.

If a run of slides all use the same layout, say so in warnings even when each one
individually fits. A deck of seven bullet slides is a failure even when every
bullet is correct.\
"""


def layout(state: PresentationAgentState, ctx: NodeContext) -> dict[str, Any]:
    ctx.emit(started(state, STAGE, AGENT_ID, "Reviewing layout choices"))
    ctx.budget.check_clock()

    plan = state.get("story_plan") or {}
    slides = plan.get("slides") or []

    if not slides:
        # Nothing to review is not an error; it is a run that never had a story
        # stage. Saying so beats an empty proposal that looks like a decision.
        ctx.emit(completed(state, STAGE, AGENT_ID, "No slides to lay out"))
        return {"current_stage": STAGE, "layout_result": {"choices": [], "warnings": []}}

    described = "\n\n".join(_describe(index, slide) for index, slide in enumerate(slides))

    proposal = ask_model(
        ctx,
        stage=STAGE,
        task_type="structured",
        system=SYSTEM,
        user="Review these layout choices.\n\n" + described,
        model=LayoutProposal,
        max_tokens=4_000,
    )

    known = {choice.slide_id: choice for choice in proposal.choices}
    changes: list[dict[str, Any]] = []
    warnings = list(proposal.warnings)

    for index, slide in enumerate(slides):
        key = str(index)
        choice = known.get(key)
        if choice is None:
            continue
        if choice.layout.value != slide.get("layout"):
            changes.append(
                {
                    "index": index,
                    "from": slide.get("layout"),
                    "to": choice.layout.value,
                    "reason": choice.reason,
                }
            )

    # Applied to the plan here rather than left for the composer: the composer
    # reads one field, and two places deciding what it holds is one too many.
    revised = {**plan, "slides": [dict(slide) for slide in slides]}
    for change in changes:
        revised["slides"][change["index"]]["layout"] = change["to"]

    ctx.emit(
        completed(
            state,
            STAGE,
            AGENT_ID,
            f"{len(changes)} layout change(s)" if changes else "Layout choices look right",
        )
    )

    return {
        "current_stage": STAGE,
        "story_plan": revised,
        "layout_result": {"changes": changes, "warnings": warnings},
        "warnings": warnings,
    }


def _describe(index: int, slide: dict[str, Any]) -> str:
    """One slide, as the facts a layout decision depends on.

    Counts rather than content where a count is what matters: whether `metrics`
    fits depends on how many numbers there are, not what they say, and sending
    the content costs tokens on every slide (doc 03 §23).
    """
    lines = [
        f"slide_id: {index}",
        f"proposed_layout: {slide.get('layout', '')}",
        f"headline: {slide.get('headline', '')}",
        f"bullet_count: {len(slide.get('bullets') or [])}",
        f"metric_count: {len(slide.get('metrics') or [])}",
        f"has_quote: {bool(slide.get('quote'))}",
        f"has_code: {bool(slide.get('code'))}",
        f"has_body: {bool(slide.get('body'))}",
    ]
    return "\n".join(lines)


VALID_LAYOUTS = {layout.value for layout in SlideLayout}
