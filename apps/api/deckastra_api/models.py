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
    pattern_id: str | None = Field(
        default=None,
        description="The author-facing preset pattern when it refines a geometry family.",
    )
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


# ------------------------------------------------ deterministic deck creation


class DeckFromTemplateRequest(BaseModel):
    template_id: str = Field(min_length=1, max_length=120)
    theme_key: str | None = Field(default=None, min_length=1, max_length=120)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    project_id: str | None = None
    #: Stable slide key -> named slot -> content. Geometry is never accepted.
    content: dict[str, dict[str, object]] = Field(default_factory=dict)


class TemplatePreviewRequest(BaseModel):
    """A dry run of `DeckFromTemplateRequest`: composed, returned, never stored."""

    theme_key: str | None = Field(default=None, min_length=1, max_length=120)
    #: Stable slide key -> named slot -> content, as for creating. Bounded in the
    #: route by its serialised size (`template_compose.MAX_CONTENT_BYTES`).
    content: dict[str, dict[str, object]] = Field(default_factory=dict)
    #: "cover" for a gallery card, "all" for the detail drawer's contact sheet.
    slides: Literal["cover", "all"] = "cover"


class TemplatePreviewResponse(BaseModel):
    template_id: str
    #: Which catalog composed this, so a client cache can never serve an old one.
    catalog_revision: str
    #: The template's design-language version; none until languages exist.
    language_version: int | None = None
    slides: Literal["cover", "all"]
    #: A document for drawing. It has no presentation or version id because it is
    #: not stored anywhere.
    document: dict


class DeckComposeRequest(BaseModel):
    story_plan: StoryPlan
    #: Absent means the language's own theme, or the neutral default.
    theme_key: str | None = Field(default=None, min_length=1, max_length=120)
    #: The grammar to compose in (UI audit unit 7b). Absent is neutral.
    design_language: str | None = Field(default=None, min_length=1, max_length=64)
    project_id: str | None = None


class ComposedDeckResponse(BaseModel):
    presentation_id: str
    version_id: str
    document: dict
    template_id: str | None = None
    #: What composing changed or noticed: bullets past a language's limit, long headlines.
    warnings: list[str] = Field(default_factory=list)
