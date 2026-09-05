"""The Motion Agent (doc 03 §12, doc 04 §24).

Decides what should move, in what order, and how quickly the slide should feel.
It does **not** decide durations, delays or coordinates — the composer does, from
the pacing this node names. That is the same split the Story Architect and the
Layout Agent live under, applied to time instead of space, and it buys the same
thing: the per-slide entrance budget (doc 04 §24.2) becomes something code
enforces rather than something a model is asked to respect.

There is a second reason it cannot emit numbers even if we wanted it to. This runs
before the composer, so no element exists yet and no id can be named. Sequencing
by **semantic role** is not a stylistic choice here; it is the only vocabulary
available, and it happens to be the right one — "the numbers arrive after the
claim they support" survives a re-layout, where "el_7 at 900ms" does not.

The prompt's standing instruction is restraint. Doc 04 §24.4 is explicit about
what not to animate, and the failure mode of a motion agent is not too little
motion — it is a deck where everything moves and the audience reads none of it.
"""

from __future__ import annotations

from typing import Any

from ..contracts import MotionPlan
from ..state import PresentationAgentState
from ._common import NodeContext, ask_model, completed, started

AGENT_ID = "motion"
STAGE = "motion"

SYSTEM = """\
You are the Motion Agent for Deckastra.

You decide what moves on each slide and in what order. You do NOT decide
durations, delays, coordinates or easing — deterministic code turns your pacing
into numbers, which is what keeps every slide inside its entrance budget.

You work in SEMANTIC ROLES, not element names:
  eyebrow | headline | subtitle | body | metric | quote | caption
  primaryChart | mainDiagram | heroVisual | supportingVisual | callout | evidence

Presets available: fade, slide, scale, blurReveal, maskReveal, staggerReveal,
springIn.

The rules, in order of how often they are broken:

1. RESTRAINT IS THE DEFAULT. Most slides need one entrance, or none. A deck where
   everything moves is a deck nobody reads. If a slide has nothing to sequence,
   give it an empty sequence and say so in the rationale.

2. SEQUENCE ONLY WHAT CARRIES MEANING. Order the reveal when the order is the
   point — a claim before its evidence, a diagram before the arrows through it.
   Do not sequence three bullets that are simply three bullets.

3. NEVER ANIMATE WHAT MUST BE READ IMMEDIATELY. Body text longer than about two
   lines, and anything the audience needs while the presenter is still talking.
   Animate the container, not each line.

4. CLICK REVEALS ARE FOR PACING A SPOKEN POINT. Use them when the presenter
   should say something between steps. A slide whose every element waits for a
   click is a slide the presenter is fighting.

5. MATCH THE PACING TO THE CONTENT. `tight` for dense technical material,
   `measured` for most things, `deliberate` for a single statement that should
   land.

Give every slide a rationale a user would understand: what the motion is doing
for the audience, not which preset you picked.\
"""


def motion(state: PresentationAgentState, ctx: NodeContext) -> dict[str, Any]:
    ctx.emit(started(state, STAGE, AGENT_ID, "Sequencing motion"))
    ctx.budget.check_clock()

    plan = state.get("story_plan") or {}
    slides = plan.get("slides") or []

    if not slides:
        ctx.emit(completed(state, STAGE, AGENT_ID, "No slides to animate"))
        return {"current_stage": STAGE, "motion_plan": {"slides": [], "warnings": []}}

    direction = state.get("creative_direction") or {}
    described = "\n\n".join(_describe(index, slide) for index, slide in enumerate(slides))

    proposal = ask_model(
        ctx,
        stage=STAGE,
        task_type="structured",
        system=SYSTEM,
        user="\n\n".join(
            [
                f"Deck mood: {direction.get('mood', 'unspecified')}.",
                f"The emphasis is on the {direction.get('emphasis_role', 'headline')} role.",
                "Sequence the motion for these slides.",
                described,
            ]
        ),
        model=MotionPlan,
        max_tokens=4_000,
    )

    by_slide = {choice.slide_id: choice for choice in proposal.slides}
    warnings = list(proposal.warnings)
    sequenced = 0

    entries: list[dict[str, Any]] = []
    for index, slide in enumerate(slides):
        choice = by_slide.get(str(index))
        if choice is None:
            # No entry means no motion, which is a legitimate answer and the one
            # a restrained agent should give most often. Inventing a default
            # entrance here would quietly make every deck move.
            continue

        roles = [role for role in choice.sequence if role]
        if roles:
            sequenced += 1

        entries.append(
            {
                "index": index,
                "sequence": roles,
                "entrance": choice.entrance,
                "pacing": choice.pacing,
                "click_reveals": min(choice.click_reveals, max(0, len(roles) - 1)),
                "rationale": choice.rationale,
            }
        )

    if sequenced == len(slides) and len(slides) > 3:
        # Not an error — but a deck where every slide is choreographed is the
        # failure mode §24.4 warns about, and the user should hear it from us
        # rather than from their audience.
        warnings.append(
            "Every slide in this deck is animated. Motion reads as emphasis, and a "
            "deck that emphasises everything emphasises nothing."
        )

    ctx.emit(
        completed(
            state,
            STAGE,
            AGENT_ID,
            f"{sequenced} slide(s) sequenced" if sequenced else "No motion needed",
        )
    )

    return {
        "current_stage": STAGE,
        "motion_plan": {"slides": entries, "warnings": warnings},
        "warnings": warnings,
    }


def _describe(index: int, slide: dict[str, Any]) -> str:
    """One slide, as the facts a motion decision depends on.

    Counts and lengths rather than the copy itself. Whether the body should
    animate depends on how long it is, not what it says — and sending the content
    of every slide costs tokens on every run (doc 03 §23).
    """
    body = str(slide.get("body") or "")
    return "\n".join(
        [
            f"slide_id: {index}",
            f"layout: {slide.get('layout', '')}",
            f"purpose: {slide.get('purpose', '')}",
            f"headline: {slide.get('headline', '')}",
            f"has_subtitle: {bool(slide.get('subtitle'))}",
            f"body_words: {len(body.split())}",
            f"bullet_count: {len(slide.get('bullets') or [])}",
            f"metric_count: {len(slide.get('metrics') or [])}",
            f"has_quote: {bool(slide.get('quote'))}",
            f"has_code: {bool(slide.get('code'))}",
        ]
    )
