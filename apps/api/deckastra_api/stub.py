"""The deterministic stub planner.

This exists so the vertical slice is runnable end to end without credentials: the
composer, the renderer, present mode and the whole HTTP path can be exercised in
CI and by anyone who clones the repo, without an API key and without spending
money on every test run.

It is honest about what it is. It writes a structurally correct deck with generic
copy, and every response it produces carries a warning saying so, so nobody mistakes
a stub deck for a generated one.
"""

from __future__ import annotations

import re

from .models import GenerateRequest, Metric, SlideLayout, SlidePlan, StoryPlan


def _topic(instruction: str) -> str:
    """A short, title-cased topic from the brief."""
    cleaned = re.sub(
        r"^\s*(create|make|build|generate|write|design|prepare)\s+"
        r"(me\s+)?(an?\s+)?(deck|presentation|slides?)\s+"
        r"(about|on|for|covering)\s+",
        "",
        instruction.strip(),
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    if not cleaned:
        return "Your Topic"

    words = cleaned.split()[:7]
    return " ".join(words)[:70]


def stub_story_plan(request: GenerateRequest) -> StoryPlan:
    topic = _topic(request.instruction)
    audience = request.audience or "your audience"
    objective = request.objective or f"Explain {topic} clearly"

    # Deliberately varied layouts. A stub that emitted five bullet slides would
    # exercise one code path and hide bugs in the other six.
    catalogue: list[SlidePlan] = [
        SlidePlan(
            layout=SlideLayout.TITLE,
            purpose="Open the deck and say what it is about",
            key_message=f"This deck is about {topic}",
            eyebrow="DECKASTRA",
            headline=topic,
            subtitle=f"Prepared for {audience}",
            speaker_notes=(
                "Placeholder deck. Set ANTHROPIC_API_KEY to generate real content."
            ),
        ),
        SlidePlan(
            layout=SlideLayout.STATEMENT,
            purpose="State the central claim before supporting it",
            key_message="There is one idea worth remembering",
            headline="Every slide here is a real, editable object",
            subtitle="Not an image, and not a template you cannot change",
        ),
        SlidePlan(
            layout=SlideLayout.BULLETS,
            purpose="Give the supporting structure",
            key_message="Three properties make the model work",
            headline="What holds this together",
            bullets=[
                "The document is the source of truth, not the rendering",
                "Every element carries a semantic role, not just geometry",
                "An AI edit is a reviewable patch, not a regeneration",
            ],
        ),
        SlidePlan(
            layout=SlideLayout.METRICS,
            purpose="Show that the targets are numbers, not adjectives",
            key_message="The performance budgets are measurable",
            headline="Budgets, not adjectives",
            metrics=[
                Metric(value="250ms", label="Typical slide first paint"),
                Metric(value="16ms", label="Drag frame time, p95"),
                Metric(value="120ms", label="Warm slide switch"),
            ],
            caption="Every budget is instrumented as a dashboard line.",
        ),
        SlidePlan(
            layout=SlideLayout.SPLIT,
            purpose="Contrast the two halves of the approach",
            key_message="Agents propose and deterministic engines compose",
            headline="Two halves, clearly divided",
            body=(
                "A model chooses the narrative and writes the words. It never "
                "chooses a coordinate. Everything you can see on this slide was "
                "placed by code that runs the same way every time."
            ),
            bullets=[
                "Model: narrative, copy, layout choice",
                "Code: geometry, spacing, colour, validation",
                "Human: the final call on all of it",
            ],
        ),
        SlidePlan(
            layout=SlideLayout.CODE,
            purpose="Make the change model concrete",
            key_message="An AI edit is one narrow, reviewable operation",
            headline="One property, not a rewrite",
            language="json",
            code=(
                "{\n"
                '  "op": "replace",\n'
                '  "path": "/slides/id:sld_04/elements/id:el_12/typography/fontSize",\n'
                '  "value": 72\n'
                "}"
            ),
            caption="Id-addressed paths survive a concurrent insertion. Index paths do not.",
        ),
        SlidePlan(
            layout=SlideLayout.QUOTE,
            purpose="Close on the thesis",
            key_message="The product thesis in one line",
            headline="The thesis",
            quote="AI proposes. Deterministic engines compose. Humans remain in control.",
            attribution="Deckastra product principles",
        ),
    ]

    slides = catalogue[: request.slide_count]

    # Asked for more than the catalogue holds? Repeat the middle rather than
    # truncating the close — a deck that stops mid-argument is worse than one that
    # restates a point.
    while len(slides) < request.slide_count:
        slides.append(catalogue[2 + (len(slides) % 4)])

    return StoryPlan(
        title=topic,
        audience=audience,
        objective=objective,
        narrative_arc="Open, state the claim, support it, make it concrete, close.",
        slides=slides,
    )
