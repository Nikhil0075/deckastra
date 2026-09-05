"""Deterministic measurements for the Critic (doc 03 §13, §14).

Doc 03 §13 lists the Critic's inputs as "structured slide, **rendered preview
image or render metadata**, story intent, design direction, audience". The second
one is the interesting one, and it is what stops a review being a model's
impression of a deck it cannot see.

**Why these are computed here rather than rendered.** The Critic runs before the
composer — it reviews the plan, and the plan is what a revision would change — so
there is no document to render and no scene to measure. What *can* be measured at
this stage is content shape: how much text a slide carries, whether its layout
has the material it needs, whether a run of slides is identical, whether the
motion fits its budget. Those are the failures a reader notices first, and they
are exactly the ones a model asked to "judge density" gets wrong, because density
is a count and models do not count.

Doc 03 §14 calls this a deterministic service rather than an agent, and that is
the right framing: nothing here has an opinion. It measures, the Critic judges.

The image path from §13 is a wiring job now rather than a missing capability —
`apps/worker` renders a slide headlessly at §41.4's 1280×720 Critic size. It
needs a vision model and a composed document, so it belongs with the run that has
both, not here.
"""

from __future__ import annotations

from typing import Any

#: Past this a slide is something the audience reads instead of listening. Doc 04
#: §24.4 uses the same threshold for what not to animate, and for the same
#: reason: it is where a slide stops supporting a talk and starts replacing it.
DENSE_WORDS = 60
CROWDED_WORDS = 110

#: A bullet nobody can read from the back of a room.
LONG_BULLET_WORDS = 18

#: Doc 04 §24.2's per-slide entrance budget.
MOTION_BUDGET_MS = 2_500


def measure_deck(state: dict[str, Any]) -> dict[str, Any]:
    """Everything measurable about a draft, as facts rather than judgements.

    Returned as plain data so it can go into the Critic's prompt verbatim *and*
    be asserted in a test. A measurement the Critic paraphrases is a measurement
    nobody can check.
    """
    plan = state.get("story_plan") or {}
    slides = plan.get("slides") or []
    research = state.get("research") or {}
    motion = state.get("motion_plan") or {}

    known_sources = {source.get("id") for source in research.get("sources") or []}
    per_slide = [_measure_slide(index, slide, known_sources) for index, slide in enumerate(slides)]

    layouts = [slide.get("layout", "") for slide in slides]

    return {
        "slide_count": len(slides),
        "slides": per_slide,
        "layout_runs": _longest_run(layouts),
        "layout_variety": len({layout for layout in layouts if layout}),
        "uncited_claims": sum(1 for slide in per_slide if slide["has_numbers"] and not slide["cites"]),
        "dense_slides": [slide["index"] for slide in per_slide if slide["words"] > DENSE_WORDS],
        "crowded_slides": [slide["index"] for slide in per_slide if slide["words"] > CROWDED_WORDS],
        "layout_misfits": [slide["index"] for slide in per_slide if slide["layout_misfit"]],
        "motion": _measure_motion(motion, len(slides)),
    }


def _measure_slide(index: int, slide: dict[str, Any], known_sources: set[str]) -> dict[str, Any]:
    bullets = [str(bullet) for bullet in (slide.get("bullets") or [])]
    metrics = slide.get("metrics") or []
    body = str(slide.get("body") or "")

    text = " ".join(
        [
            str(slide.get("headline") or ""),
            str(slide.get("subtitle") or ""),
            body,
            *bullets,
            str(slide.get("quote") or ""),
            str(slide.get("caption") or ""),
        ]
    )
    words = len(text.split())

    cites = [source for source in (slide.get("source_ids") or []) if source in known_sources]

    return {
        "index": index,
        "layout": slide.get("layout", ""),
        "words": words,
        "headline_words": len(str(slide.get("headline") or "").split()),
        "bullet_count": len(bullets),
        "longest_bullet_words": max((len(bullet.split()) for bullet in bullets), default=0),
        "metric_count": len(metrics),
        # A number with no source is doc 03 §13's most important catch, so
        # "contains a number" is measured rather than left to the model to spot.
        "has_numbers": _contains_number(text),
        "cites": cites,
        "layout_misfit": _layout_misfit(slide, bullets, metrics),
    }


def _contains_number(text: str) -> bool:
    """Whether the copy asserts a quantity.

    Digits only, deliberately. "Several" and "most" are vague rather than
    unsourced, and flagging them would bury the case that matters: a specific
    figure the material does not support.
    """
    return any(character.isdigit() for character in text)


def _layout_misfit(slide: dict[str, Any], bullets: list[str], metrics: list[Any]) -> str:
    """A layout that does not have the material it needs, named.

    The same rules the Layout Agent works to, checked rather than trusted. It is
    a count, and a model asked to check a count will sometimes say four when it
    is three.
    """
    layout = slide.get("layout", "")

    if layout == "metrics" and len(metrics) < 2:
        return "a metrics layout with fewer than two numbers is a statement"
    if layout == "bullets" and len(bullets) < 3:
        return "a bullets layout with fewer than three points is a split or a statement"
    if layout == "quote" and not str(slide.get("quote") or "").strip():
        return "a quote layout with no quotation"
    if layout == "code" and not str(slide.get("code") or "").strip():
        return "a code layout with no code"
    return ""


def _longest_run(layouts: list[str]) -> int:
    """The longest stretch of identical layouts.

    A deck of seven bullet slides is a failure even when every bullet is correct,
    and it is invisible one slide at a time — which is exactly why the Critic
    needs it measured rather than inferred.
    """
    longest = 0
    current = 0
    previous = None

    for layout in layouts:
        current = current + 1 if layout == previous else 1
        previous = layout
        longest = max(longest, current)

    return longest


def _measure_motion(motion: dict[str, Any], slide_count: int) -> dict[str, Any]:
    """What the motion plan does to the deck, as counts.

    The composer enforces the per-slide budget, so the Critic is not being asked
    to catch an over-run. What it is being asked to judge is whether the motion
    *earns its place* — and "how many slides move" is the fact that question
    turns on.
    """
    entries = motion.get("slides") or []
    animated = [entry for entry in entries if entry.get("sequence")]

    return {
        "animated_slides": len(animated),
        "slide_count": slide_count,
        "click_reveals": sum(int(entry.get("click_reveals") or 0) for entry in animated),
        # Doc 04 §24.4's failure mode: a deck where everything moves emphasises
        # nothing. Measured rather than left to taste.
        "everything_moves": slide_count > 3 and len(animated) == slide_count,
        "warnings": list(motion.get("warnings") or []),
    }


def describe(measurements: dict[str, Any]) -> str:
    """The measurements as prompt text.

    Written as lines of facts rather than prose. The Critic is being handed
    evidence, and evidence that has been narrated is evidence that has already
    been judged once.
    """
    lines = [
        f"slide_count: {measurements['slide_count']}",
        f"distinct_layouts: {measurements['layout_variety']}",
        f"longest_run_of_one_layout: {measurements['layout_runs']}",
        f"slides_with_numbers_but_no_source: {measurements['uncited_claims']}",
        f"dense_slides (over {DENSE_WORDS} words): {measurements['dense_slides'] or 'none'}",
        f"crowded_slides (over {CROWDED_WORDS} words): {measurements['crowded_slides'] or 'none'}",
        f"layout_misfits: {measurements['layout_misfits'] or 'none'}",
        "",
        "motion:",
        f"  animated_slides: {measurements['motion']['animated_slides']} of {measurements['motion']['slide_count']}",
        f"  click_reveals: {measurements['motion']['click_reveals']}",
        f"  every_slide_moves: {measurements['motion']['everything_moves']}",
        "",
        "per slide:",
    ]

    for slide in measurements["slides"]:
        detail = [
            f"  {slide['index']}: {slide['layout'] or '?'}",
            f"words={slide['words']}",
            f"bullets={slide['bullet_count']}",
            f"metrics={slide['metric_count']}",
            f"cites={len(slide['cites'])}",
        ]
        if slide["has_numbers"] and not slide["cites"]:
            detail.append("NUMBER WITH NO SOURCE")
        if slide["layout_misfit"]:
            detail.append(f"MISFIT: {slide['layout_misfit']}")
        if slide["longest_bullet_words"] > LONG_BULLET_WORDS:
            detail.append(f"longest_bullet={slide['longest_bullet_words']} words")
        lines.append(" ".join(detail))

    return "\n".join(lines)
