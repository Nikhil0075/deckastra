"""The Story Architect (doc 03 §9).

Designs the narrative and writes the words. It does not decide geometry: no
coordinates, no font sizes, no colours. A deterministic composer places what it
produces, using the layout it names.

That boundary is the product thesis in one node. A model that proposes `x: 137`
produces slides which overlap the moment the real text is longer than the sample;
a model that proposes `layout: "metrics"` produces slides a composer can always
place correctly. It also moves the interesting failure from the document — large
and expensive to re-ask for — to the plan, which is small and cheap.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..contracts import StoryPlan
from ..envelope import Source, envelope
from ..state import PresentationAgentState
from ._common import NodeContext, ask_model, completed, started

AGENT_ID = "story"
STAGE = "story"

SYSTEM = (Path(__file__).resolve().parents[1] / "prompts" / "story.md").read_text(encoding="utf-8")


def story(state: PresentationAgentState, ctx: NodeContext) -> dict[str, Any]:
    ctx.emit(started(state, STAGE, AGENT_ID, "Designing the narrative"))
    ctx.budget.check_clock()

    request = state.get("request") or {}
    research = state.get("research") or {}
    slide_count = int(request.get("slide_count") or 5)

    parts = [
        f"Design a {slide_count}-slide presentation.",
        "",
        envelope(str(request.get("instruction", "")), Source(id="request", kind="user-brief")),
    ]

    for field, kind in (("audience", "audience"), ("objective", "objective"), ("tone", "tone")):
        value = request.get(field)
        if value:
            parts += ["", envelope(str(value), Source(id=field, kind=kind))]

    context_blocks: list[str] = list(research.get("context_blocks") or [])
    if context_blocks:
        parts += [
            "",
            "Material to draw on. Cite what you use in each slide's source_ids:",
            *context_blocks,
        ]

    memory_context = ctx.memory.prompt_context() if ctx.memory else ""

    plan = ask_model(
        ctx,
        stage=STAGE,
        task_type="planning",
        system=SYSTEM,
        user="\n".join(parts),
        model=StoryPlan,
        context=[memory_context] if memory_context else None,
        max_tokens=16_000,
    )

    warnings: list[str] = []
    if plan.embedded_instructions_found:
        warnings.append(
            "One of the sources contained text addressed to an AI. It was described "
            "as content, not followed."
        )

    # A model asked for seven slides and returning four is a failure the user can
    # see; saying so beats letting them count.
    if len(plan.slides) != slide_count:
        warnings.append(
            f"Asked for {slide_count} slides and the plan has {len(plan.slides)}."
        )

    ctx.emit(
        completed(
            state,
            STAGE,
            AGENT_ID,
            f"{len(plan.slides)}-slide narrative drafted",
            artifact_refs=[f"story:{state.get('run_id', '')}"],
        )
    )

    return {
        "current_stage": STAGE,
        "story_plan": plan.model_dump(mode="json"),
        "warnings": warnings,
    }


def apply_revision_note(state: PresentationAgentState) -> str:
    """The Critic's unresolved issues, as instruction for a second attempt.

    Passed as *the user's* turn rather than as system context, because it is
    feedback about this specific draft and not a standing rule.
    """
    results = state.get("critic_results") or []
    if not results:
        return ""

    latest = results[-1]
    issues = [
        f"- {issue.get('message', '')}" + (f" Fix: {issue['suggested_fix']}" if issue.get("suggested_fix") else "")
        for issue in latest.get("issues", [])
        if issue.get("severity") in {"blocker", "major"}
    ]
    if not issues:
        return ""

    return "The reviewer raised these problems with the previous draft:\n" + "\n".join(issues)
