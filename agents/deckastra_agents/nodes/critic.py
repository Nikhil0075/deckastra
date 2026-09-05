"""The Critic (doc 03 §13, gap register doc 03 S3).

Reviews the draft and either passes it or routes a revision to whoever can fix
it. Two things here are more interesting than the review itself.

**Routing, not complaining.** A verdict names the stage that should act:
`revise_story` for a narrative problem, `revise_layout` for a fit problem,
`revise_creative` for a visual one. A critic that only says "this is bad" makes a
human the router.

**The disagreement fallback.** Doc 03 leaves open what happens when the Critic
keeps asking for revisions and the producer keeps not satisfying it. Left alone
that is an infinite loop, and the usual fix — a hard iteration cap that fails the
run — throws away work the user could have used. So: after the revision budget is
spent, the run accepts the highest-scoring candidate it has seen and attaches the
unresolved issues to the deck. A user can read an attached issue and decide; they
cannot do anything with a run that never finished.
"""

from __future__ import annotations

from typing import Any

from ..contracts import CriticResult
from ..envelope import Source, envelope
from ..state import PresentationAgentState
from ._common import NodeContext, ask_model, completed, started
from ._signals import describe as describe_measurements
from ._signals import measure_deck

AGENT_ID = "critic"
STAGE = "critic"

SYSTEM = """\
You review a draft presentation and decide whether it is ready.

Return one verdict:

  pass             The deck is good enough to hand to the user.
  revise_story     The narrative or the copy is the problem.
  revise_layout    The content is right but a slide's layout does not fit it.
  revise_creative  The visual direction is the problem.
  revise_motion    The motion is the problem: too much of it, the wrong order,
                   or an entrance the presenter would have to talk over.

The verdict names the stage that should act. A review that only says "this is
bad" leaves a human to work out who fixes it.

SCORE EIGHT DIMENSIONS, each 0 to 1:

  hierarchy          Does the eye land on the most important thing first?
  readability        Can this be read from the back of a room?
  contrast           Is the text legible against what is behind it?
  alignment          Do edges line up, or nearly line up?
  density            Is there more here than a listener can take in?
  consistency        Does the deck look like one deck?
  narrative_clarity  Does it open, build and close?
  motion_quality     Null when nothing on the deck moves.

The scores must be comparable BETWEEN DRAFTS of the same deck - they are used to
pick the best attempt when reviewer and writer cannot converge. So score what is
there, not how much is left to do. A draft that fixed two of five problems scores
higher than the one before it, even though three remain.

YOU ARE GIVEN MEASUREMENTS. Word counts, bullet counts, layout misfits, uncited
numbers and motion counts are measured, not estimated. Use them: do not re-count,
do not contradict them, and do not raise a density issue about a slide the
measurements say is short.

Judge:
  - Narrative: does it open, build and close? Is any slide redundant?
  - Claims: is anything asserted that the material does not support? A number
    with no source is the most important thing you can catch.
  - Layout fit: the measurements name misfits outright.
  - Density: a slide nobody can read while also listening.
  - Motion: does it earn its place? Motion reads as emphasis, and a deck that
    emphasises everything emphasises nothing.

Do not pass a deck to be kind and do not fail one to be thorough. Every issue you
raise costs the user attention, so raise the ones that would change what they
ship. If the deck is ready, say pass and say why in one sentence.\
"""


def critic(state: PresentationAgentState, ctx: NodeContext) -> dict[str, Any]:
    ctx.emit(started(state, STAGE, AGENT_ID, "Reviewing the draft"))
    ctx.budget.check_clock()

    plan = state.get("story_plan") or {}
    slides = plan.get("slides") or []
    research = state.get("research") or {}

    known_sources = {source["id"] for source in research.get("sources") or []}

    # Doc 03 §13's "render metadata" input, and doc 03 §14's deterministic
    # services. Counts are measured rather than left to the model: density is a
    # count, and a model asked to count will sometimes say four when it is three
    # and then raise an issue about it.
    measurements = measure_deck(state)

    described = "\n\n".join(
        "\n".join(
            [
                f"slide {index}: {slide.get('layout', '?')}",
                f"headline: {slide.get('headline', '')}",
                f"key_message: {slide.get('key_message', '')}",
                f"cites: {', '.join(slide.get('source_ids') or []) or 'nothing'}",
            ]
        )
        for index, slide in enumerate(slides)
    )

    user = "\n".join(
        [
            f"Review this {len(slides)}-slide draft.",
            "",
            envelope(described, Source(id="draft", kind="draft")),
            "",
            "Measurements (these are facts; do not re-count them):",
            describe_measurements(measurements),
            "",
            (
                f"Sources available to the writer: {', '.join(sorted(known_sources)) or 'none'}."
                if known_sources
                else "The writer had no sources; treat any specific number or quotation as invented."
            ),
        ]
    )

    memory_context = ctx.memory.prompt_context() if ctx.memory else ""

    result = ask_model(
        ctx,
        stage=STAGE,
        task_type="critique",
        system=SYSTEM,
        user=user,
        model=CriticResult,
        context=[memory_context] if memory_context else None,
        max_tokens=6_000,
    )

    payload = result.model_dump(mode="json")
    # The single number the fallback compares drafts by, alongside the eight it
    # came from. Both are kept: the fallback needs one, and the editor shows the
    # reader which dimension failed.
    payload["score"] = result.score
    payload["measurements"] = measurements
    warnings: list[str] = []

    # Issues in categories this project's users have already dismissed are
    # dropped, and the drop is reported. Silently keeping them out would hide
    # that the Critic had something to say (gap register doc 03 S2).
    if ctx.memory:
        kept, notes = ctx.memory.filter_issues(payload.get("issues") or [])
        payload["issues"] = kept
        warnings.extend(notes)

    verdict = payload["verdict"]
    slide_ids = {issue.get("slide_id") for issue in payload.get("issues") or []} - {""}
    target_slide = next(iter(sorted(slide_ids)), None)

    if verdict != "pass" and not ctx.budget.may_revise(target_slide):
        # The fallback. Accept what we have, attach what is unresolved, and say
        # so — rather than looping until some other budget kills the run.
        payload["verdict"] = "pass"
        payload["forced"] = True
        warnings.append(
            "The reviewer and the writer did not converge. The best draft was kept "
            "and the unresolved issues are attached to the deck."
        )
        ctx.emit(
            completed(
                state, STAGE, AGENT_ID, "Kept the best draft; unresolved issues attached"
            )
        )
        return {
            "current_stage": STAGE,
            "critic_results": [payload],
            "revision_target": None,
            "warnings": warnings + ctx.budget.warnings,
        }

    if verdict != "pass":
        ctx.budget.record_revision(target_slide)

    ctx.emit(completed(state, STAGE, AGENT_ID, result.summary))

    return {
        "current_stage": STAGE,
        "critic_results": [payload],
        "revision_target": None if verdict == "pass" else verdict,
        "warnings": warnings,
    }


def best_result(state: PresentationAgentState) -> dict[str, Any] | None:
    """The highest-scoring review this run produced.

    Used by the fallback to choose which draft to keep. Ties go to the later
    result, because a later draft incorporates the earlier feedback even when the
    score did not move.
    """
    results = state.get("critic_results") or []
    if not results:
        return None
    return max(results, key=lambda result: (result.get("score", 0.0), results.index(result)))
