"""Request and plan models.

The important boundary in this file is the one between what a model produces and
what deterministic code produces. `StoryPlan` carries *intent* — narrative,
content, and a layout name chosen from a fixed set. It carries no coordinates, no
font sizes and no colours.

That is not a stylistic preference. Doc 03 §10 forbids the Creative Director from
emitting pixel coordinates, and doc 03 §2.3 puts geometry, collision detection and
constraints on the deterministic side. A model that proposes `x: 137` produces
slides that overlap the moment the text is longer than the sample; a model that
proposes `layout: "metrics"` produces slides a composer can always place
correctly.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class SlideLayout(str, Enum):
    """The layout vocabulary the model may choose from.

    A closed set, deliberately. An open one would let the model invent layouts the
    composer cannot place, and the failure would surface as a broken slide rather
    than a validation error.
    """

    TITLE = "title"
    STATEMENT = "statement"
    BULLETS = "bullets"
    METRICS = "metrics"
    QUOTE = "quote"
    CODE = "code"
    SPLIT = "split"


class Metric(BaseModel):
    value: str = Field(description="The number itself, e.g. '250ms' or '3x'. Short.")
    label: str = Field(description="What the number measures. A few words.")


class SlidePlan(BaseModel):
    layout: SlideLayout
    purpose: str = Field(description="Why this slide exists in the narrative.")
    key_message: str = Field(
        description="The one thing the audience should retain from this slide."
    )
    headline: str = Field(description="The slide's main line. Short and specific.")

    # Every field below is optional in meaning but required in the schema, filled
    # with an empty value when a layout does not use it. Strict JSON-schema output
    # is far more reliable when the model never has to decide whether to omit a
    # key — it decides what to put in it instead.
    eyebrow: str = Field(default="", description="Small label above the headline. May be empty.")
    subtitle: str = Field(default="", description="Supporting line. May be empty.")
    body: str = Field(default="", description="A short paragraph. May be empty.")
    bullets: list[str] = Field(default_factory=list, description="Used by the bullets layout.")
    metrics: list[Metric] = Field(default_factory=list, description="Used by the metrics layout.")
    quote: str = Field(default="", description="Used by the quote layout.")
    attribution: str = Field(default="", description="Who said the quote.")
    code: str = Field(default="", description="Used by the code layout.")
    language: str = Field(default="", description="Language of the code block.")
    caption: str = Field(default="", description="Small text under the main content.")
    speaker_notes: str = Field(default="", description="What the presenter says here.")


class StoryPlan(BaseModel):
    title: str
    audience: str
    objective: str
    narrative_arc: str = Field(
        description="One sentence on how the deck moves from beginning to end."
    )
    slides: list[SlidePlan]


class GenerateRequest(BaseModel):
    """A user's request for a deck (doc 03 §6, reduced to what is used so far)."""

    instruction: str = Field(min_length=1, max_length=4000)
    audience: str = ""
    objective: str = ""
    slide_count: int = Field(default=5, ge=1, le=20)
    tone: str = ""
    """Where to put the deck. Defaults to the caller's first project."""
    project_id: str | None = None
    #: Repositories to ground the deck in (Journey B). Resolved against the
    #: caller's workspace server-side; an id from elsewhere is silently dropped
    #: rather than becoming a source.
    repository_ids: list[str] = Field(default_factory=list, max_length=10)
    #: Run the Phase 5 agent graph rather than the Phase 1 single-shot chain.
    #:
    #: Default on. The flag exists so an operator can go back without a rollback
    #: — the single-shot chain is the thing that has been working, and a graph is
    #: a lot of new moving parts to make unavoidable on day one.
    use_graph: bool = True


class GenerationDiagnostics(BaseModel):
    """What the walking skeleton exists to measure.

    Phase 1's whole purpose is finding out how reliably a model produces valid
    structured output against this schema, before four more phases are built on
    the assumption that it does. So the numbers are part of the response rather
    than a log line someone has to go looking for.
    """

    source: Literal["model", "stub"]
    model: str = ""
    attempts: int = 1
    valid_first_attempt: bool = True
    plan_valid_first_attempt: bool = True
    validation_errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    duration_ms: int = 0


class GenerateResponse(BaseModel):
    presentation_id: str
    #: The head of the version chain, which a client sends back as
    #: `expected_version_id` on its first edit.
    version_id: str
    document: dict
    diagnostics: GenerationDiagnostics
    #: The agent run that produced it. Lets a client subscribe to its events and
    #: lets the agent inspector show why each slide is the way it is.
    run_id: str | None = None
