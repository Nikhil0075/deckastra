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

from pydantic import BaseModel, Field, model_validator


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
    # Layouts that carry data rather than words (2026-10-11). Without them an
    # agent asked for a revenue chart, a system diagram or a roadmap could only
    # draw cards and rows, and every deck converged on the same three shapes.
    CHART = "chart"
    DIAGRAM = "diagram"
    TIMELINE = "timeline"
    IMAGE = "image"


class Metric(BaseModel):
    value: str = Field(description="The number itself, e.g. '250ms' or '3x'. Short.")
    label: str = Field(description="What the number measures. A few words.")


class ChartSeriesPlan(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    values: list[float] = Field(min_length=1, max_length=24)


class ChartPlan(BaseModel):
    """The numbers, never the drawing: the renderer lays the chart out."""

    type: Literal["column", "bar", "line", "area", "pie", "donut", "stackedColumn", "stackedBar", "combo", "waterfall", "slope"] = "column"
    categories: list[str] = Field(min_length=1, max_length=24)
    series: list[ChartSeriesPlan] = Field(min_length=1, max_length=6)
    #: Shown after each number ("%", "₹ cr"). Empty for none.
    unit: str = Field(default="", max_length=12)

    @model_validator(mode="after")
    def _one_value_per_category(self) -> "ChartPlan":
        for series in self.series:
            if len(series.values) != len(self.categories):
                raise ValueError(
                    f"Series {series.name!r} has {len(series.values)} values for {len(self.categories)} categories."
                )
        if len({series.name for series in self.series}) != len(self.series):
            raise ValueError("Each series needs its own name.")
        return self


class DiagramNodePlan(BaseModel):
    #: The agent's own name for the node, used only to connect edges; the
    #: composer mints the real id.
    key: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=60)
    sublabel: str = Field(default="", max_length=80)
    #: "service", "datastore", "external" or "actor".
    role: str = Field(default="", max_length=20)


class DiagramEdgePlan(BaseModel):
    source: str = Field(min_length=1, max_length=40)
    target: str = Field(min_length=1, max_length=40)
    label: str = Field(default="", max_length=40)


class DiagramPlan(BaseModel):
    kind: Literal["architecture", "flow", "sequence", "network", "mindmap"] = "architecture"
    direction: Literal["LR", "TB"] = "LR"
    nodes: list[DiagramNodePlan] = Field(min_length=2, max_length=12)
    edges: list[DiagramEdgePlan] = Field(default_factory=list, max_length=24)

    @model_validator(mode="after")
    def _edges_join_known_nodes(self) -> "DiagramPlan":
        keys = [node.key for node in self.nodes]
        if len(set(keys)) != len(keys):
            raise ValueError("Each diagram node needs its own key.")
        for edge in self.edges:
            missing = [end for end in (edge.source, edge.target) if end not in keys]
            if missing:
                raise ValueError(f"An edge names {', '.join(missing)}, which is not a node.")
        return self


class TimelineEntryPlan(BaseModel):
    when: str = Field(min_length=1, max_length=24)
    label: str = Field(min_length=1, max_length=60)
    detail: str = Field(default="", max_length=120)


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
    chart: ChartPlan | None = Field(default=None, description="Used by the chart layout: categories and series.")
    diagram: DiagramPlan | None = Field(default=None, description="Used by the diagram layout: nodes and edges.")
    timeline: list[TimelineEntryPlan] = Field(default_factory=list, max_length=8, description="Used by the timeline layout.")
    picture: str = Field(default="", max_length=400, description="Used by the image layout: what the photograph shows.")

    @model_validator(mode="after")
    def _data_for_data_layouts(self) -> "SlidePlan":
        # A data layout without its data would compose an empty frame; say so
        # where the plan is written instead.
        if self.layout == SlideLayout.CHART and self.chart is None:
            raise ValueError("A chart slide needs chart data (categories and series).")
        if self.layout == SlideLayout.DIAGRAM and self.diagram is None:
            raise ValueError("A diagram slide needs a diagram (nodes and edges).")
        if self.layout == SlideLayout.TIMELINE and len(self.timeline) < 2:
            raise ValueError("A timeline slide needs at least two entries.")
        return self


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
