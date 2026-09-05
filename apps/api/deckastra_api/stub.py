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
from dataclasses import dataclass

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


# ------------------------------------------------------- repository-grounded


@dataclass(frozen=True)
class StubSource:
    """One retrieved chunk, as the stub planner sees it."""

    id: str
    label: str
    text: str

    @property
    def path(self) -> str:
        return self.label.split(":")[0] if self.label else self.id


#: How many source-quoting slides the stub will write. Past this the deck is a
#: file listing rather than a presentation.
MAX_GROUNDED_SLIDES = 8


def parse_sources(prompt: str) -> list[StubSource]:
    """Pull the enveloped repository chunks back out of the prompt.

    The stub reads the same material the real model is given, which is what lets
    it cite honestly: every claim on a grounded stub slide is a quotation of a
    block that was actually retrieved, not a sentence written in advance and
    attributed afterwards.
    """
    sources: list[StubSource] = []

    pattern = re.compile(
        r'<untrusted-content ([^>]*)>\n(.*?)\n</untrusted-content>', re.DOTALL
    )
    for attributes, body in pattern.findall(prompt):
        if 'kind="github"' not in attributes:
            continue

        identifier = re.search(r'id="([^"]*)"', attributes)
        label = re.search(r'label="([^"]*)"', attributes)
        if identifier is None:
            continue

        sources.append(
            StubSource(
                id=identifier.group(1),
                label=label.group(1) if label else "",
                text=body,
            )
        )

    return sources


def stub_repository_story_plan(
    request: GenerateRequest, sources: list[StubSource]
) -> dict[str, object]:
    """A deck about a repository, built only from what was retrieved.

    The generic stub deck says the same six things whatever it is pointed at.
    That is fine when there is nothing to say, and wrong when a repository has
    been indexed: the retrieved chunks are real material, and a deck that ignores
    them while claiming to be grounded is the failure mode this phase exists to
    prevent.

    So every slide below quotes a block that was actually retrieved and cites the
    source it came from. The writing is mechanical — that is what a stub is — but
    the citations are true, which means the provenance path is exercised for real
    rather than simulated.

    Returns the agent contract's shape rather than the API `StoryPlan`, because
    only the agent contract carries `source_ids`, and a citation is the entire
    point of this function.
    """
    repository = sources[0].id.split("#")[0] if "#" in sources[0].id else "this repository"
    paths: list[str] = []
    for source in sources:
        if source.path not in paths:
            paths.append(source.path)

    def slide(layout: SlideLayout, **fields: object) -> dict[str, object]:
        return {
            "layout": layout.value,
            "eyebrow": "", "subtitle": "", "body": "", "bullets": [], "metrics": [],
            "quote": "", "attribution": "", "code": "", "language": "", "caption": "",
            "speaker_notes": "", "source_ids": [],
            **fields,
        }

    slides: list[dict[str, object]] = [
        slide(
            SlideLayout.TITLE,
            purpose="Name the subject",
            key_message=f"This deck is about {repository}",
            eyebrow="REPOSITORY",
            headline=repository,
            subtitle=f"Read from {len(paths)} file(s) in the indexed source",
            speaker_notes=(
                "Composed by the deterministic planner from indexed source files. "
                "Set ANTHROPIC_API_KEY for a written narrative."
            ),
        ),
        slide(
            SlideLayout.BULLETS,
            purpose="Show what the deck is grounded in",
            key_message="Every claim here comes from a named file",
            headline="What was read",
            bullets=[source.label for source in sources[:6]],
            caption="Each line is a file and a line range you can open.",
            # Cited because the list *is* the sources — the one slide whose claim
            # is about the retrieval itself.
            source_ids=[source.id for source in sources[:6]],
        ),
    ]

    for source in sources[: max(0, min(MAX_GROUNDED_SLIDES, request.slide_count - 3))]:
        slides.append(
            slide(
                SlideLayout.CODE,
                purpose=f"Show what {source.path} contains",
                key_message=f"{source.path} is part of how this works",
                headline=source.path,
                language=_language_hint(source.path),
                code=_excerpt(source.text),
                caption=source.label,
                source_ids=[source.id],
            )
        )

    slides.append(
        slide(
            SlideLayout.STATEMENT,
            purpose="Close on what grounding means",
            key_message="A citation you can open is the point",
            headline="Every line above has a source",
            subtitle="Click any slide to see the files it was written from",
        )
    )

    slides = slides[: request.slide_count]
    while len(slides) < request.slide_count:
        # Repeat a grounded slide rather than padding with invented content.
        slides.insert(-1, slides[min(2, len(slides) - 1)])

    return {
        "title": f"Inside {repository}",
        "narrative_arc": (
            "Name the repository, list what was read, walk the files, close on provenance."
        ),
        "slides": slides,
        "embedded_instructions_found": False,
    }


#: Enough to read, short enough to fit a code slide at a legible size.
EXCERPT_LINES = 14


def _excerpt(text: str) -> str:
    lines = [line.rstrip() for line in text.splitlines()][:EXCERPT_LINES]
    return "\n".join(lines) or "(empty)"


def _language_hint(path: str) -> str:
    extension = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return {
        "py": "python", "ts": "typescript", "tsx": "typescript",
        "js": "javascript", "jsx": "javascript", "go": "go", "rs": "rust",
        "java": "java", "rb": "ruby", "sql": "sql", "sh": "bash",
        "json": "json", "yml": "yaml", "yaml": "yaml", "toml": "toml",
        "md": "markdown",
    }.get(extension, "text")
