"""Deterministic composition: StoryPlan -> PresentationDocument.

This is the "deterministic engines compose" half of the product thesis. The model
chose a layout name and wrote the words; every coordinate, font size and colour on
the slide is decided here, by code, the same way every time.

Two properties follow from that, and both are the reason it is built this way:

1. **Generated slides cannot overlap.** Geometry comes from templates that were
   written once and checked, not from a model guessing pixel values that happen to
   suit the sample text. Where content is repeated, it is emitted as a container
   layout (doc 02 §16.2) so a longer label re-flows instead of colliding.

2. **The output is always schema-valid.** The interesting failure mode moves to
   the plan — small, structured, and cheap to re-ask — instead of the document.

Nothing here calls a model. It is a pure function of the plan, which is what makes
it testable without an API key and reproducible in CI.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .ids import new_id
from .models import SlideLayout, SlidePlan, StoryPlan
from .theme import neo_technical_theme

SCHEMA_VERSION = "1.1.0"

# Logical coordinate space (doc 04 §4). Every number below is a logical pixel.
VIEWPORT_W = 1920
VIEWPORT_H = 1080
SAFE = {"top": 80, "right": 120, "bottom": 80, "left": 120}

CONTENT_X = SAFE["left"]
CONTENT_W = VIEWPORT_W - SAFE["left"] - SAFE["right"]
CONTENT_TOP = SAFE["top"]
CONTENT_BOTTOM = VIEWPORT_H - SAFE["bottom"]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rich_text(text: str) -> dict[str, Any]:
    """Blocks and spans from the start, even for a single run.

    Shipping plain strings and adding inline styling later would force a migration
    onto every stored deck (doc 02 §12.1). One span costs nothing today.
    """
    return {
        "version": 1,
        "blocks": [
            {"id": new_id("blk"), "type": "paragraph", "spans": [{"text": text}]}
        ],
    }


def _rich_list(items: list[str], block_type: str = "bullet") -> dict[str, Any]:
    return {
        "version": 1,
        "blocks": [
            {"id": new_id("blk"), "type": block_type, "spans": [{"text": item}]}
            for item in items
        ],
    }


def _text(
    *,
    role: str,
    x: float,
    y: float,
    width: float,
    height: float,
    content: dict[str, Any],
    token: str,
    size: float,
    color: str = "token:colors.foreground",
    weight: int | None = None,
    fit: str = "autoHeight",
    align: str | None = None,
    letter_spacing: float | None = None,
    transform_case: str | None = None,
    min_font_size: float | None = None,
    line_height: float | None = None,
) -> dict[str, Any]:
    typography: dict[str, Any] = {
        "fontFamily": f"token:typography.{token}.fontFamily",
        "fontSize": size,
        "color": color,
    }
    if weight is not None:
        typography["fontWeight"] = weight
    if letter_spacing is not None:
        typography["letterSpacing"] = letter_spacing
    if transform_case is not None:
        typography["textTransform"] = transform_case
    if line_height is not None:
        typography["lineHeight"] = line_height
    if token == "metric":
        # Tabular numerals so a row of figures does not jitter when animated.
        typography["fontFeatures"] = ["tnum"]

    element: dict[str, Any] = {
        "id": new_id("el"),
        "type": "text",
        "semanticRole": role,
        "transform": {
            "x": round(x, 2),
            "y": round(y, 2),
            "width": round(width, 2),
            "height": round(height, 2),
        },
        "content": content,
        "typography": typography,
        "fit": fit,
    }
    if align:
        # "balanced" prevents the single-orphan last line that makes generated
        # headlines look unconsidered (doc 02 §12.3).
        element["paragraph"] = {"align": align, "lineBreakStrategy": "balanced"}
    else:
        element["paragraph"] = {"lineBreakStrategy": "balanced"}
    if min_font_size is not None:
        element["minFontSize"] = min_font_size
    return element


def _headline(text: str, y: float = 120, size: float = 64) -> dict[str, Any]:
    return _text(
        role="headline",
        x=CONTENT_X,
        y=y,
        width=CONTENT_W,
        height=size * 1.15 * 2,
        content=_rich_text(text),
        token="h1",
        size=size,
        weight=700,
        # Headlines live in a fixed hero region, so they shrink rather than
        # overflow when the model writes a long one (doc 02 §12.4).
        fit="shrinkToFit",
        min_font_size=size * 0.55,
        line_height=1.1,
    )


def _caption(text: str, y: float) -> dict[str, Any]:
    return _text(
        role="caption",
        x=CONTENT_X,
        y=y,
        width=CONTENT_W,
        height=48,
        content=_rich_text(text),
        token="caption",
        size=18,
        color="token:colors.foregroundSubtle",
    )


# --------------------------------------------------------------------- layouts


def _layout_title(plan: SlidePlan) -> list[dict[str, Any]]:
    elements: list[dict[str, Any]] = []
    y = 340.0

    if plan.eyebrow:
        elements.append(
            _text(
                role="eyebrow",
                x=CONTENT_X,
                y=y,
                width=CONTENT_W,
                height=40,
                content=_rich_text(plan.eyebrow),
                token="caption",
                size=18,
                color="token:colors.accent",
                letter_spacing=4,
                transform_case="uppercase",
            )
        )
        y += 60

    elements.append(
        _text(
            role="headline",
            x=CONTENT_X,
            y=y,
            width=CONTENT_W,
            height=280,
            content=_rich_text(plan.headline),
            token="display",
            size=88,
            weight=700,
            fit="shrinkToFit",
            min_font_size=48,
            line_height=1.05,
        )
    )
    y += 300

    if plan.subtitle:
        elements.append(
            _text(
                role="subtitle",
                x=CONTENT_X,
                y=y,
                width=CONTENT_W * 0.7,
                height=90,
                content=_rich_text(plan.subtitle),
                token="body",
                size=28,
                color="token:colors.foregroundMuted",
            )
        )
    return elements


def _layout_statement(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = [
        _text(
            role="headline",
            x=CONTENT_X,
            y=380,
            width=CONTENT_W,
            height=320,
            content=_rich_text(plan.headline),
            token="display",
            size=80,
            weight=700,
            fit="shrinkToFit",
            min_font_size=44,
            align="center",
            line_height=1.1,
        )
    ]
    if plan.subtitle:
        elements.append(
            _text(
                role="subtitle",
                x=CONTENT_X + CONTENT_W * 0.15,
                y=720,
                width=CONTENT_W * 0.7,
                height=90,
                content=_rich_text(plan.subtitle),
                token="body",
                size=26,
                color="token:colors.foregroundMuted",
                align="center",
            )
        )
    return elements


def _layout_bullets(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = [_headline(plan.headline)]
    y = 300.0

    if plan.subtitle:
        elements.append(
            _text(
                role="subtitle",
                x=CONTENT_X,
                y=y,
                width=CONTENT_W * 0.8,
                height=70,
                content=_rich_text(plan.subtitle),
                token="body",
                size=26,
                color="token:colors.foregroundMuted",
            )
        )
        y += 100

    if plan.bullets:
        # Height scales with the number of bullets rather than being fixed, so a
        # six-point slide does not overflow a box sized for three.
        height = min(CONTENT_BOTTOM - y - 40, len(plan.bullets) * 76 + 40)
        elements.append(
            _text(
                role="body",
                x=CONTENT_X,
                y=y,
                width=CONTENT_W * 0.85,
                height=height,
                content=_rich_list(plan.bullets),
                token="body",
                size=28,
                line_height=1.5,
            )
        )
    return elements


def _layout_metrics(plan: SlidePlan) -> list[dict[str, Any]]:
    """A KPI row emitted as a horizontal container, not four absolute boxes.

    This is the difference between a slide that survives real content and one that
    breaks the moment a label runs long (doc 02 §21.2). The container re-flows;
    absolute boxes overlap.
    """
    elements = [_headline(plan.headline)]

    metrics = plan.metrics[:4]
    if not metrics:
        return elements

    # Container-layout resolution is pipeline stage 6 and lands in Phase 3. Until
    # then a child's advisory x/y is what actually positions it, so the padding is
    # baked into those coordinates: the card looks right today, and it still looks
    # right once the container starts laying out (doc 02 §16.2 keeps advisory
    # positions precisely so pulling a child out restores a sensible spot).
    pad = 32
    value_h = 110
    label_h = 64
    inner_gap = 12

    gap = 24
    card_w = (CONTENT_W - gap * (len(metrics) - 1)) / len(metrics)
    card_h = float(pad * 2 + value_h + inner_gap + label_h)
    row_y = 400.0

    children = []
    for i, metric in enumerate(metrics):
        inner_w = card_w - pad * 2
        children.append(
            {
                "id": new_id("el"),
                "type": "group",
                "name": f"KPI {metric.label}",
                "groupRole": "kpiCard",
                # Advisory while the parent container lays out, but retained so
                # pulling a card out of the row restores a sensible position.
                "transform": {
                    "x": round(i * (card_w + gap), 2),
                    "y": 0,
                    "width": round(card_w, 2),
                    "height": card_h,
                },
                "containerLayout": {
                    "type": "vertical",
                    "gap": inner_gap,
                    "align": "start",
                    "padding": {"top": pad, "right": pad, "bottom": pad, "left": pad},
                },
                "resizeMode": "resizeContainer",
                "style": {
                    "fill": {"type": "solid", "color": "token:colors.surface"},
                    "cornerRadius": 12,
                    "stroke": {
                        "paint": {"type": "solid", "color": "token:colors.border"},
                        "width": 1,
                    },
                },
                "children": [
                    _text(
                        role="metric",
                        x=pad,
                        y=pad,
                        width=inner_w,
                        height=value_h,
                        content=_rich_text(metric.value),
                        token="metric",
                        size=72,
                        weight=700,
                        color="token:colors.accent",
                        fit="shrinkToFit",
                        min_font_size=36,
                    ),
                    _text(
                        role="caption",
                        x=pad,
                        y=pad + value_h + inner_gap,
                        width=inner_w,
                        height=label_h,
                        content=_rich_text(metric.label),
                        token="caption",
                        size=19,
                        color="token:colors.foregroundMuted",
                        line_height=1.35,
                    ),
                ],
            }
        )

    elements.append(
        {
            "id": new_id("el"),
            "type": "group",
            "name": "KPI row",
            "groupRole": "kpiRow",
            "transform": {"x": CONTENT_X, "y": row_y, "width": CONTENT_W, "height": card_h},
            "containerLayout": {
                "type": "horizontal",
                "gap": gap,
                "distribute": "equal",
                "align": "stretch",
            },
            "resizeMode": "resizeContainer",
            "children": children,
        }
    )

    if plan.caption:
        elements.append(_caption(plan.caption, row_y + card_h + 48))
    return elements


def _layout_quote(plan: SlidePlan) -> list[dict[str, Any]]:
    quote = plan.quote or plan.headline
    elements = [
        _text(
            role="quote",
            x=CONTENT_X + 80,
            y=340,
            width=CONTENT_W - 160,
            height=340,
            content=_rich_text(f"“{quote}”"),
            token="quote",
            size=48,
            fit="shrinkToFit",
            min_font_size=28,
            align="center",
            line_height=1.3,
        )
    ]
    if plan.attribution:
        elements.append(
            _text(
                role="caption",
                x=CONTENT_X + 80,
                y=720,
                width=CONTENT_W - 160,
                height=50,
                content=_rich_text(f"— {plan.attribution}"),
                token="caption",
                size=22,
                color="token:colors.foregroundMuted",
                align="center",
            )
        )
    return elements


def _layout_code(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = [_headline(plan.headline)]
    code = plan.code or "// no code provided"
    line_count = code.count("\n") + 1
    height = min(CONTENT_BOTTOM - 320, max(180, line_count * 34 + 80))

    elements.append(
        {
            "id": new_id("el"),
            "type": "code",
            "name": "Code",
            "transform": {"x": CONTENT_X, "y": 300, "width": CONTENT_W, "height": round(height, 2)},
            "language": plan.language or "text",
            "code": code,
            "showLineNumbers": line_count > 3,
            "style": {
                "fill": {"type": "solid", "color": "token:colors.surface"},
                "cornerRadius": 12,
                "stroke": {"paint": {"type": "solid", "color": "token:colors.border"}, "width": 1},
            },
        }
    )

    if plan.caption:
        elements.append(_caption(plan.caption, 320 + height))
    return elements


def _layout_split(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = [_headline(plan.headline)]
    half = (CONTENT_W - 64) / 2

    if plan.body:
        elements.append(
            _text(
                role="body",
                x=CONTENT_X,
                y=320,
                width=half,
                height=CONTENT_BOTTOM - 360,
                content=_rich_text(plan.body),
                token="body",
                size=27,
                color="token:colors.foregroundMuted",
                line_height=1.5,
            )
        )

    if plan.bullets:
        elements.append(
            _text(
                role="body",
                x=CONTENT_X + half + 64,
                y=320,
                width=half,
                height=min(CONTENT_BOTTOM - 360, len(plan.bullets) * 72 + 40),
                content=_rich_list(plan.bullets),
                token="body",
                size=25,
                line_height=1.5,
            )
        )
    return elements


_LAYOUTS = {
    SlideLayout.TITLE: _layout_title,
    SlideLayout.STATEMENT: _layout_statement,
    SlideLayout.BULLETS: _layout_bullets,
    SlideLayout.METRICS: _layout_metrics,
    SlideLayout.QUOTE: _layout_quote,
    SlideLayout.CODE: _layout_code,
    SlideLayout.SPLIT: _layout_split,
}


def compose_slide(plan: SlidePlan, index: int) -> dict[str, Any]:
    builder = _LAYOUTS[plan.layout]
    elements = builder(plan)

    slide: dict[str, Any] = {
        "id": new_id("sld"),
        "name": plan.headline[:60] or f"Slide {index + 1}",
        # Semantic intent and key message are not decoration — every agent reads
        # them, and a slide whose keyMessage has no prominent element expressing it
        # is a hierarchy failure the Critic can detect mechanically (doc 02 §7.1).
        "semanticIntent": plan.purpose,
        "keyMessage": plan.key_message,
        "background": {"paint": {"type": "solid", "color": "token:colors.background"}},
        "layout": {"styleLabel": plan.layout.value, "templateId": f"phase1.{plan.layout.value}"},
        "elements": elements,
        "transition": {"type": "fade", "durationMs": 300},
    }

    if plan.speaker_notes:
        slide["speakerNotes"] = plan.speaker_notes
    return slide


def compose_document(plan: StoryPlan, *, instruction: str = "") -> dict[str, Any]:
    now = _now()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "id": new_id("doc"),
        "metadata": {
            "title": plan.title,
            "description": plan.narrative_arc,
            "language": "en",
            "presentationType": "technical",
            # Read by the Story Agent for vocabulary and by the Critic for density
            # judgement (doc 02 §5.1). A deck without them forces every agent to
            # guess, and guessing produces generic output.
            "audience": plan.audience,
            "objective": plan.objective,
            "estimatedDurationSeconds": max(60, len(plan.slides) * 60),
        },
        "viewport": {
            "width": VIEWPORT_W,
            "height": VIEWPORT_H,
            "unit": "px",
            "aspectRatio": "16:9",
            "safeArea": SAFE,
        },
        "theme": neo_technical_theme(),
        "slides": [compose_slide(slide, i) for i, slide in enumerate(plan.slides)],
        "assets": [],
        "components": [],
        "dataSources": [],
        "variables": {},
        "createdAt": now,
        "updatedAt": now,
        "extensions": {
            "deckastra.generation": {"phase": 1, "instruction": instruction[:500]}
        },
    }
