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
from copy import deepcopy
import re
from typing import Any

from .ids import new_id
from .motion import animate_slide
from .models import POINT_CHARTS, SlideLayout, SlidePlan, StoryPlan
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


def blank_document(title: str = "Untitled presentation", *, theme_definition: dict[str, Any] | None = None, theme_id: str | None = None) -> dict[str, Any]:
    """Reuse the canonical document shell without generated content or provenance."""
    document = compose_document(StoryPlan(title=title, audience="", objective="", narrative_arc="", slides=[]), instruction="", theme_definition=theme_definition, theme_id=theme_id)
    document["metadata"] = {"title": title, "language": "en"}
    if theme_id is not None:
        document["metadata"]["themeId"] = theme_id
    document["extensions"] = {}
    document["slides"] = [{"id": new_id("sld"), "name": "Slide 1", "elements": []}]
    return document


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


#: Captions are 18px body text, so WCAG 1.4.3's normal-text minimum applies.
CAPTION_MINIMUM = 4.5
#: Quietest first. A theme promises nothing about `foregroundSubtle`, and only 3:1
#: (large text) about `foregroundMuted`; `foreground` carries its 4.5:1 pair.
CAPTION_COLOURS = ("foregroundSubtle", "foregroundMuted", "foreground")


def _theme_colour(theme: dict[str, Any], name: str, depth: int = 0) -> str | None:
    value = (theme.get("colors") or {}).get(name)
    if isinstance(value, str) and value.startswith("token:colors.") and depth < 8:
        return _theme_colour(theme, value.removeprefix("token:colors."), depth + 1)
    return value if isinstance(value, str) and re.fullmatch(r"#[0-9A-Fa-f]{6}", value) else None


def caption_colour(theme: dict[str, Any]) -> str:
    """The quietest theme colour a caption can be read in on this theme's background.

    Neo Technical's `foregroundSubtle` is 4.49:1 on its background, so every
    caption the composer drew on that theme failed contrast by a hundredth, and
    the assistant's layout gate refused every generated slide that had one.
    A colour that cannot be measured (an alpha value, a missing role) is not
    assumed to pass: the caption takes `foreground`.
    """
    from .office_theme import contrast

    background = _theme_colour(theme, "background")
    for name in CAPTION_COLOURS:
        colour = _theme_colour(theme, name)
        if background and colour and contrast(colour, background) >= CAPTION_MINIMUM:
            return f"token:colors.{name}"
    return "token:colors.foreground"


def readable_captions(slides: list[dict[str, Any]], theme: dict[str, Any]) -> None:
    """Re-colour composed captions for the theme they will actually render in.

    In place, on slides this module composed. A caller appending composed slides
    to an existing deck must pass that deck's theme, not the composer's.
    """
    chosen = caption_colour(theme)
    if chosen == "token:colors.foregroundSubtle":
        return

    def walk(elements: list[dict[str, Any]]) -> None:
        for element in elements:
            typography = element.get("typography") or {}
            if element.get("semanticRole") == "caption" and typography.get("color") == "token:colors.foregroundSubtle":
                typography["color"] = chosen
            walk(element.get("children") or [])

    for slide in slides:
        walk(slide.get("elements") or [])


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

    # The container lays out (pipeline stage 6), so these coordinates are advisory
    # and the renderer positions children from `containerLayout` instead. They are
    # still emitted deliberately: doc 02 §16.2 keeps advisory positions so that
    # pulling a card out of the row restores a sensible spot rather than dropping
    # it at the origin. Padding is declared on the layout, which is what actually
    # applies it — a card whose padding lived only in these coordinates would go
    # flush the moment the container took over.
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
            "semanticRole": "metric",
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



# ------------------------------------------------- layouts that carry data
#
# Added 2026-10-11, after a review found every agent-built deck converging on
# cards and rows: the schema could draw charts, diagrams and photographs, and no
# layout put one on a slide. The plan carries the data; geometry is here.


def _subtitle_below(plan: SlidePlan, y: float, width: float = CONTENT_W * 0.8) -> tuple[list[dict[str, Any]], float]:
    if not plan.subtitle:
        return [], y
    return [
        _text(role="subtitle", x=CONTENT_X, y=y, width=width, height=60, content=_rich_text(plan.subtitle),
              token="body", size=26, color="token:colors.foregroundMuted")
    ], y + 84


def _chart_alt_text(plan: SlidePlan) -> str:
    """Words for a screen reader (WCAG 1.1.1): the kind, then every value."""
    chart = plan.chart
    assert chart is not None
    unit = f" {chart.unit}" if chart.unit else ""
    if chart.type in POINT_CHARTS:
        kind = {"bubbleMap": "Bubble map", "bubble": "Bubble chart", "scatter": "Scatter chart"}[chart.type]
        described = []
        for index, point in enumerate(chart.points):
            name = point.label or f"Point {index + 1}"
            if chart.type == "bubbleMap":
                described.append(f"{name} {point.size:g}{unit}")
            else:
                size = f", size {point.size:g}" if chart.type == "bubble" and point.size is not None else ""
                described.append(f"{name} at {point.x:g}, {point.y:g}{size}")
        return f"{kind}. " + "; ".join(described)[:900]
    parts = []
    for series in chart.series:
        values = ", ".join(f"{category} {value:g}{unit}" for category, value in zip(chart.categories, series.values))
        parts.append(f"{series.name}: {values}")
    kind = {"stackedColumn": "stacked column", "stackedBar": "stacked bar"}.get(chart.type, chart.type)
    return f"{kind.capitalize()} chart. " + "; ".join(parts)[:900]


def _layout_chart(plan: SlidePlan) -> list[dict[str, Any]]:
    chart = plan.chart
    assert chart is not None
    elements = [_headline(plan.headline, size=56)]
    extra, y = _subtitle_below(plan, 300)
    elements += extra
    bottom = CONTENT_BOTTOM - (64 if plan.caption else 0)
    # A takeaway beside the chart when there is one: the number is the
    # evidence, the sentence is the point.
    width = CONTENT_W * (0.66 if plan.body else 1.0)
    if chart.type in POINT_CHARTS:
        elements.append(_point_chart(plan, y, width, bottom))
        if plan.body:
            side_x = CONTENT_X + CONTENT_W * 0.70
            elements.append(
                _text(role="body", x=side_x, y=y + 40, width=CONTENT_W * 0.30, height=bottom - y - 40,
                      content=_rich_text(plan.body), token="body", size=28, line_height=1.4)
            )
        if plan.caption:
            elements.append(_caption(plan.caption, CONTENT_BOTTOM - 48))
        return elements
    keys = [f"s{index}" for index in range(len(chart.series))]
    rows = [
        {"category": category, **{key: series.values[i] for key, series in zip(keys, chart.series)}}
        for i, category in enumerate(chart.categories)
    ]
    # Encoded by series *name*, so the legend and the slope's end labels read
    # as the agent wrote them.
    for row in rows:
        for key, series in zip(keys, chart.series):
            row[series.name] = row.pop(key)
    names = [series.name for series in chart.series]
    style: dict[str, Any] = {
        # A pie names its slices in the legend; a slope and a waterfall label
        # their own marks.
        "showLegend": chart.type in ("pie", "donut") or (len(names) > 1 and chart.type not in ("slope", "waterfall")),
        "showDataLabels": len(chart.categories) <= 8,
        "showGridlines": chart.type not in ("pie", "donut", "slope"),
    }
    # One number of decimals for the whole chart, the most the data uses (at
    # most two), so "2.1" and "4" do not sit side by side as "2.10" and "4".
    decimals = max((len(f"{value:g}".split(".")[1]) if "." in f"{value:g}" else 0) for series in chart.series for value in series.values)
    number_format: dict[str, Any] = {"decimals": min(decimals, 2)}
    if chart.unit:
        number_format["suffix"] = chart.unit if chart.unit.startswith("%") else f" {chart.unit}"
    style["numberFormat"] = number_format
    elements.append({
        "id": new_id("el"),
        "type": "chart",
        "name": "Chart",
        "semanticRole": "chart",
        "chartType": chart.type,
        "transform": {"x": CONTENT_X, "y": round(y + 10, 2), "width": round(width, 2), "height": round(bottom - y - 10, 2)},
        "data": {"type": "inline", "rows": rows},
        "encoding": {"category": "category", "value": names if len(names) > 1 else names[0]},
        "chartStyle": style,
        "altText": _chart_alt_text(plan),
    })
    if plan.body:
        side_x = CONTENT_X + CONTENT_W * 0.70
        elements.append(
            _text(role="body", x=side_x, y=y + 40, width=CONTENT_W * 0.30, height=bottom - y - 40,
                  content=_rich_text(plan.body), token="body", size=28, line_height=1.4)
        )
    if plan.caption:
        elements.append(_caption(plan.caption, CONTENT_BOTTOM - 48))
    return elements


def _point_chart(plan: SlidePlan, y: float, width: float, bottom: float) -> dict[str, Any]:
    """A scatter, bubble chart or bubble map from the plan's points (2026-10-13).

    The points become rows with fixed field names; the renderer projects and
    places them. Groups become the series, so a region shares a colour.
    """
    chart = plan.chart
    assert chart is not None
    grouped = any(point.group for point in chart.points)
    rows: list[dict[str, Any]] = []
    for index, point in enumerate(chart.points):
        row: dict[str, Any] = {"label": point.label or f"Point {index + 1}"}
        if chart.type == "bubbleMap":
            row.update({"latitude": point.latitude, "longitude": point.longitude, "size": point.size})
        else:
            row.update({"x": point.x, "y": point.y})
            if chart.type == "bubble":
                row["size"] = point.size
        if grouped:
            row["group"] = point.group or "Other"
        rows.append(row)
    if chart.type == "bubbleMap":
        encoding: dict[str, Any] = {"category": "label", "value": "size", "size": "size", "latitude": "latitude", "longitude": "longitude"}
    else:
        encoding = {"category": "label", "x": "x", "value": "y"}
        if chart.type == "bubble":
            encoding["size"] = "size"
    if grouped:
        encoding["series"] = "group"
    style: dict[str, Any] = {"showLegend": grouped, "showDataLabels": len(chart.points) <= 12}
    if chart.unit:
        style["numberFormat"] = {"suffix": chart.unit if chart.unit.startswith("%") else f" {chart.unit}"}
    if chart.x_title:
        style["axisX"] = {"title": chart.x_title}
    if chart.y_title:
        style["axisY"] = {"title": chart.y_title}
    return {
        "id": new_id("el"),
        "type": "chart",
        "name": "Chart",
        "semanticRole": "chart",
        "chartType": chart.type,
        "transform": {"x": CONTENT_X, "y": round(y + 10, 2), "width": round(width, 2), "height": round(bottom - y - 10, 2)},
        "data": {"type": "inline", "rows": rows},
        "encoding": encoding,
        "chartStyle": style,
        "altText": _chart_alt_text(plan),
    }


def _layout_diagram(plan: SlidePlan) -> list[dict[str, Any]]:
    diagram = plan.diagram
    assert diagram is not None
    elements = [_headline(plan.headline, size=56)]
    extra, y = _subtitle_below(plan, 300)
    elements += extra
    bottom = CONTENT_BOTTOM - (64 if plan.caption else 0)
    ids = {node.key: new_id("dn") for node in diagram.nodes}
    nodes = []
    for node in diagram.nodes:
        entry: dict[str, Any] = {"id": ids[node.key], "label": node.label}
        if node.sublabel:
            entry["sublabel"] = node.sublabel
        if node.role:
            entry["role"] = node.role
        nodes.append(entry)
    edges = []
    for edge in diagram.edges:
        entry = {"id": new_id("de"), "from": ids[edge.source], "to": ids[edge.target], "direction": "forward"}
        if edge.label:
            entry["label"] = edge.label
        edges.append(entry)
    described = "; ".join(
        f"{next(n.label for n in diagram.nodes if n.key == e.source)} to {next(n.label for n in diagram.nodes if n.key == e.target)}"
        + (f" ({e.label})" if e.label else "")
        for e in diagram.edges
    )
    elements.append({
        "id": new_id("el"),
        "type": "diagram",
        "name": "Diagram",
        "semanticRole": "diagram",
        "diagramType": diagram.kind,
        "transform": {"x": CONTENT_X, "y": round(y + 10, 2), "width": CONTENT_W, "height": round(bottom - y - 10, 2)},
        "nodes": nodes,
        "edges": edges,
        "layoutHint": {"algorithm": "layered", "direction": diagram.direction, "mode": "managed"},
        "altText": (f"{diagram.kind.capitalize()} diagram of " + ", ".join(n.label for n in diagram.nodes)
                    + (f". Connections: {described}." if described else "."))[:900],
    })
    if plan.caption:
        elements.append(_caption(plan.caption, CONTENT_BOTTOM - 48))
    return elements


def _layout_timeline(plan: SlidePlan) -> list[dict[str, Any]]:
    """A rule across the slide, a marker per entry, the date above and the words below."""
    from .language_kit import _shape, _solid

    entries = plan.timeline
    elements = [_headline(plan.headline, size=56)]
    extra, _ = _subtitle_below(plan, 300)
    elements += extra
    rule_y = 560.0
    elements.append(_shape("Timeline rule", x=CONTENT_X, y=rule_y - 2, width=CONTENT_W, height=4,
                           fill=_solid("token:colors.borderStrong")))
    step = CONTENT_W / len(entries)
    for index, entry in enumerate(entries):
        x = CONTENT_X + step * index
        centre = x + step / 2
        elements.append(_shape(f"Milestone {index + 1}", kind="ellipse", x=centre - 14, y=rule_y - 14, width=28, height=28,
                               fill=_solid("token:colors.accent")))
        elements.append(
            _text(role="label", x=x + 8, y=rule_y - 96, width=step - 16, height=56, content=_rich_text(entry.when),
                  token="caption", size=22, weight=700, color="token:colors.accent", align="center")
        )
        elements.append(
            _text(role="body", x=x + 8, y=rule_y + 40, width=step - 16, height=72, content=_rich_text(entry.label),
                  token="h3", size=26, weight=600, align="center", fit="shrinkToFit", min_font_size=18)
        )
        if entry.detail:
            elements.append(
                _text(role="body", x=x + 8, y=rule_y + 120, width=step - 16, height=140, content=_rich_text(entry.detail),
                      token="bodySmall", size=20, color="token:colors.foregroundMuted", align="center",
                      fit="shrinkToFit", min_font_size=14)
            )
    if plan.caption:
        elements.append(_caption(plan.caption, CONTENT_BOTTOM - 48))
    return elements


def _layout_image(plan: SlidePlan) -> list[dict[str, Any]]:
    """A full-bleed photograph with the headline on a scrim at its foot.

    The frame is a named placeholder until a picture fills it: a generated image
    for this slide takes the frame's place (`assistant_routes`), and the scrim
    keeps the headline readable over whatever the photograph turns out to be.
    """
    from .language_kit import _shape, _solid

    elements = [
        # Full bleed is the slide's background, which is what lets it reach the
        # edges: Design Check's safe area (W104) exempts a background.
        _shape("Image frame", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"),
               role="background"),
        _shape("Scrim", x=0, y=VIEWPORT_H - 420, width=VIEWPORT_W, height=420, fill=_solid("#000000"), opacity=0.55,
               role="decoration"),
    ]
    elements[0]["altText"] = plan.picture or plan.headline
    if plan.picture:
        elements[0]["metadata"] = {"picture": plan.picture}
    if plan.eyebrow:
        elements.append(
            _text(role="eyebrow", x=CONTENT_X, y=VIEWPORT_H - 360, width=CONTENT_W, height=40, content=_rich_text(plan.eyebrow),
                  token="caption", size=20, weight=700, color="#FFFFFF", letter_spacing=2, transform_case="uppercase")
        )
    headline = _headline(plan.headline, y=VIEWPORT_H - 310, size=64)
    headline["typography"]["color"] = "#FFFFFF"
    headline["transform"]["height"] = 160
    elements.append(headline)
    if plan.subtitle:
        elements.append(
            _text(role="subtitle", x=CONTENT_X, y=VIEWPORT_H - 140, width=CONTENT_W * 0.8, height=56,
                  content=_rich_text(plan.subtitle), token="body", size=26, color="#FFFFFF")
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
    SlideLayout.CHART: _layout_chart,
    SlideLayout.DIAGRAM: _layout_diagram,
    SlideLayout.TIMELINE: _layout_timeline,
    SlideLayout.IMAGE: _layout_image,
}


def compose_slide(
    plan: SlidePlan,
    index: int,
    language: str = "neutral",
    *,
    preserve_language_media: bool = False,
    visual_system: str | None = None,
) -> dict[str, Any]:
    # A design language (UI audit unit 5) may lay a layout out its own way;
    # anything it does not supply is the composer's own, below. Imported here
    # because the languages build on this module's helpers.
    from .languages import layout_for

    from .pattern_layouts_v2 import layout_for_pattern

    pattern_layout = layout_for_pattern(plan, language, visual_system=visual_system)
    language_builder = layout_for(language, plan.layout)
    language_elements = language_builder(plan) if language_builder else None
    media_frame_names = {"Image frame", "Portrait frame", "Arch frame", "Hologram frame", "Picture blob"}
    language_has_media = bool(
        language_elements
        and any(element.get("name") in media_frame_names for element in language_elements)
    )
    if pattern_layout is None:
        elements = language_elements if language_elements is not None else _LAYOUTS[plan.layout](plan)
        family = plan.layout.value
    elif visual_system == "asterloop-energy":
        # A flagship pairs an exact composition with exact media selectors.
        # Letting a broad language frame replace it would collapse the product
        # render, split comparison or photo journey back into one generic card.
        elements, family = pattern_layout
    elif preserve_language_media and language_has_media:
        # Reviewed templates with bundled pictures keep the language's
        # signature media composition. The semantic family is still recorded
        # for discovery and pacing; templates without bundled media use V2.
        elements = language_elements
        family = pattern_layout[1]
    else:
        elements, family = pattern_layout

    slide: dict[str, Any] = {
        "id": new_id("sld"),
        "name": plan.headline[:60] or f"Slide {index + 1}",
        # Semantic intent and key message are not decoration — every agent reads
        # them, and a slide whose keyMessage has no prominent element expressing it
        # is a hierarchy failure the Critic can detect mechanically (doc 02 §7.1).
        "semanticIntent": plan.purpose,
        "keyMessage": plan.key_message,
        "background": {"paint": {"type": "solid", "color": "token:colors.background"}},
        "layout": {
            "styleLabel": plan.pattern_id or plan.layout.value,
            "templateId": f"preset.{plan.pattern_id or plan.layout.value}",
            "family": family,
        },
        "elements": elements,
        "transition": {"type": "fade", "durationMs": 300},
    }

    if plan.speaker_notes:
        slide["speakerNotes"] = plan.speaker_notes
    return slide


def compose_document(
    plan: StoryPlan,
    *,
    instruction: str = "",
    locale: str = "en",
    motion_plan: dict[str, Any] | None = None,
    theme_definition: dict[str, Any] | None = None,
    theme_id: str | None = None,
    language: str = "neutral",
    language_version: int | None = None,
    preserve_language_media: bool = False,
    visual_system: str | None = None,
) -> dict[str, Any]:
    """Compose a document, and animate it if the Motion Agent had an opinion.

    `motion_plan` is optional and defaults to nothing moving. That is the right
    default rather than a limitation: doc 04 §24.4's rule is that restraint is the
    baseline, so a deck with no motion plan is a still deck, not a deck with
    invented animation.
    """
    now = _now()
    intents = {
        int(entry.get("index", -1)): entry
        for entry in ((motion_plan or {}).get("slides") or [])
    }

    slides: list[dict[str, Any]] = []
    motion_warnings: list[str] = []
    for index, slide_plan in enumerate(plan.slides):
        slide = compose_slide(
            slide_plan,
            index,
            language,
            preserve_language_media=preserve_language_media,
            visual_system=visual_system,
        )
        motion_warnings.extend(animate_slide(slide, intents.get(index)))
        slides.append(slide)
    theme = deepcopy(theme_definition) if theme_definition is not None else neo_technical_theme()
    readable_captions(slides, theme)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "id": new_id("doc"),
        "metadata": {
            "title": plan.title,
            **({"themeId": theme_id} if theme_id is not None else {}),
            "description": plan.narrative_arc,
            "language": locale,
            "presentationType": "technical",
            # Read by the Story Agent for vocabulary and by the Critic for density
            # judgement (doc 02 §5.1). A deck without them forces every agent to
            # guess, and guessing produces generic output.
            "audience": plan.audience,
            "objective": plan.objective,
            "estimatedDurationSeconds": max(60, len(plan.slides) * 60),
            # The language and its version, so a later slide can stay in it. Not
            # written for the neutral composer: those decks are exactly what they
            # were before languages existed.
            **(
                {"designLanguage": {"id": language, "version": language_version or 1}}
                if language != "neutral"
                else {}
            ),
        },
        "viewport": {
            "width": VIEWPORT_W,
            "height": VIEWPORT_H,
            "unit": "px",
            "aspectRatio": "16:9",
            "safeArea": SAFE,
        },
        "theme": theme,
        "slides": slides,
        "assets": [],
        "components": [],
        "dataSources": [],
        "variables": {},
        "createdAt": now,
        "updatedAt": now,
        "extensions": {
            "deckastra.generation": {
                "phase": 1,
                "instruction": instruction[:500],
                # Surfaced rather than logged: a warning about motion that nobody
                # sees is a slide whose entrance was quietly tightened.
                **({"motionWarnings": motion_warnings} if motion_warnings else {}),
            }
        },
    }
