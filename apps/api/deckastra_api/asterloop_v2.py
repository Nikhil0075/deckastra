"""Image-led flagship compositions for the AsterLoop V2 template.

The structural catalogue intentionally stays brand-neutral.  A flagship is a
different thing: it pairs exact narrative beats with exact art direction.  The
photographs remain replaceable assets, while every headline, milestone, chart,
diagram label and comparison point remains native and editable.
"""

from __future__ import annotations

from typing import Any

from .compose import VIEWPORT_H, VIEWPORT_W, _rich_list, _rich_text
from .ids import new_id
from .language_kit import _line, _shape, _solid, _text
from .models import SlidePlan

Elements = list[dict[str, Any]]
INK = "#F7F3E8"
MUTED = "#C7D0DC"
LIME = "#C8FF3D"
NAVY = "#06101F"


def _frame(name: str, *, role: str = "background") -> dict[str, Any]:
    frame = _shape(name, x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("#0D1A2C"), role=role)
    frame["metadata"] = {"designCheckIgnore": ["W104"]}
    return frame


def _linear(*stops: tuple[float, str], angle: float = 0) -> dict[str, Any]:
    return {
        "type": "linearGradient",
        "angle": angle,
        "stops": [{"offset": offset, "color": color} for offset, color in stops],
    }


def _glass(name: str, *, x: float, y: float, width: float, height: float, opacity: float = 1, radius: float = 24) -> dict[str, Any]:
    panel = _shape(
        name,
        x=x,
        y=y,
        width=width,
        height=height,
        fill=_solid("#081525B8"),
        stroke=_line("#FFFFFF52", 1.2),
        radius=radius,
        opacity=opacity,
        role="decoration",
    )
    panel["style"]["backdropFilters"] = [{"type": "blur", "radius": 22}]
    panel["style"]["shadow"] = [
        {"type": "drop", "offsetX": 0, "offsetY": 20, "blur": 48, "spread": -10, "color": "#00000099"},
        {"type": "inner", "offsetX": 0, "offsetY": 1, "blur": 0, "spread": 0, "color": "#FFFFFF38"},
    ]
    return panel


def _eyebrow(text: str, *, x: float, y: float, width: float = 720, color: str = LIME) -> dict[str, Any]:
    return _text(
        role="eyebrow", x=x, y=y, width=width, height=38,
        content=_rich_text(text), token="caption", size=19, weight=700,
        color=color, letter_spacing=3.2, transform_case="uppercase",
    )


def _headline(text: str, *, x: float, y: float, width: float, height: float, size: float, minimum: float = 38) -> dict[str, Any]:
    return _text(
        role="headline", x=x, y=y, width=width, height=height,
        content=_rich_text(text), token="display", size=size, weight=700,
        color=INK, fit="shrinkToFit", min_font_size=minimum,
        line_height=1.02, letter_spacing=-1.8,
    )


def _image_title(plan: SlidePlan) -> Elements:
    elements = [
        _frame("AsterLoop hero frame"),
        _shape(
            "Hero readability wash", x=0, y=0, width=1210, height=VIEWPORT_H,
            fill=_linear((0, "#03101FF2"), (0.64, "#06101FC4"), (1, "#06101F00")),
            role="decoration",
        ),
        _shape("Hero signal", x=78, y=122, width=82, height=8, fill=_solid(LIME)),
    ]
    if plan.eyebrow:
        elements.append(_eyebrow(plan.eyebrow, x=82, y=164))
    elements.append(_headline(plan.headline, x=78, y=255, width=820, height=360, size=98, minimum=55))
    if plan.subtitle:
        elements.append(_text(
            role="subtitle", x=84, y=690, width=680, height=116,
            content=_rich_text(plan.subtitle), token="body", size=27,
            color=MUTED, line_height=1.4, fit="shrinkToFit", min_font_size=20,
        ))
    elements.append(_text(
        role="caption", x=84, y=930, width=580, height=38,
        content=_rich_text("CLEANER HEAT · STRONGER INDUSTRY"), token="caption",
        size=16, weight=700, color=INK, letter_spacing=2.2,
    ))
    return elements


def _image_number(plan: SlidePlan) -> Elements:
    metric = plan.metrics[0] if plan.metrics else None
    value = metric.value if metric else "42%"
    label = metric.label if metric else (plan.body or "")
    elements = [
        _frame("AsterLoop emissions frame"),
        _shape("Emissions wash", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("#06101FFF")),
        _shape("Number reading field", x=0, y=0, width=690, height=VIEWPORT_H, fill=_linear((0, "#06101FF7"), (1, "#06101F99"))),
    ]
    if plan.eyebrow:
        elements.append(_eyebrow(plan.eyebrow, x=74, y=94))
    elements.append(_headline(plan.headline, x=72, y=164, width=500, height=165, size=57, minimum=36))
    if label:
        elements.append(_text(
            role="body", x=76, y=366, width=500, height=220,
            content=_rich_text(label), token="body", size=27, color=INK,
            line_height=1.45, fit="shrinkToFit", min_font_size=20,
        ))
    image_number = _text(
        role="metric", x=600, y=178, width=1130, height=690,
        content=_rich_text(value), token="metric", size=420, weight=800,
        color="#F7F3E8E8", fit="shrinkToFit", min_font_size=220,
        line_height=0.82, letter_spacing=-12,
    )
    image_number["name"] = "AsterLoop image number"
    elements.append(image_number)
    elements.append(_shape("Metric underline", x=78, y=828, width=470, height=5, fill=_solid(LIME)))
    if plan.caption:
        elements.append(_text(
            role="caption", x=78, y=862, width=500, height=86,
            content=_rich_text(plan.caption), token="caption", size=16,
            color=MUTED, line_height=1.4, fit="shrinkToFit", min_font_size=13,
        ))
    return elements


def _chart(plan: SlidePlan) -> Elements:
    chart = plan.chart
    assert chart is not None
    keys = [series.name for series in chart.series]
    rows = [
        {"category": category, **{series.name: series.values[index] for series in chart.series}}
        for index, category in enumerate(chart.categories)
    ]
    last = chart.series[0].values[-1] if chart.series and chart.series[0].values else 0
    elements: Elements = [
        _eyebrow(plan.eyebrow or "COMMERCIAL MOMENTUM", x=78, y=78),
        _headline(plan.headline, x=78, y=142, width=980, height=170, size=62),
        _text(role="metric", x=84, y=380, width=350, height=150, content=_rich_text(f"${last:g}M"), token="metric", size=98, weight=750, color=INK, fit="shrinkToFit", min_font_size=52),
        _text(role="caption", x=90, y=538, width=330, height=42, content=_rich_text("SIGNED PIPELINE"), token="caption", size=16, weight=700, color=MUTED, letter_spacing=2),
        _shape("Chart divider", x=500, y=360, width=2, height=560, fill=_solid("#50647C")),
        {
            "id": new_id("el"), "type": "chart", "name": "Commercial momentum", "semanticRole": "chart",
            "chartType": chart.type,
            "transform": {"x": 580, "y": 345, "width": 1245, "height": 590},
            "data": {"type": "inline", "rows": rows},
            "encoding": {"category": "category", "value": keys if len(keys) > 1 else keys[0]},
            "chartStyle": {
                "showLegend": len(keys) > 1, "showDataLabels": True, "showGridlines": True,
                "numberFormat": {"decimals": 0, "suffix": f" {chart.unit}" if chart.unit else ""},
            },
            "altText": "Line chart showing " + "; ".join(
                f"{series.name}: " + ", ".join(f"{category} {value:g}" for category, value in zip(chart.categories, series.values))
                for series in chart.series
            )[:900],
        },
    ]
    if plan.body:
        elements.append(_text(role="body", x=84, y=650, width=360, height=200, content=_rich_text(plan.body), token="body", size=22, color=MUTED, line_height=1.45, fit="shrinkToFit", min_font_size=17))
    return elements


def _roadmap(plan: SlidePlan) -> Elements:
    points = [(310, 820), (690, 675), (1130, 488), (1570, 300)]
    elements: Elements = [
        _frame("AsterLoop roadmap frame"),
        _shape("Roadmap title wash", x=0, y=0, width=VIEWPORT_W, height=260, fill=_linear((0, "#03101FF2"), (1, "#03101F00"), angle=90)),
        _eyebrow(plan.eyebrow or "ROAD TO SCALE", x=72, y=58),
        _headline(plan.headline, x=72, y=112, width=980, height=130, size=52),
    ]
    for index, (item, (x, y)) in enumerate(zip(plan.bullets[:4], points)):
        year, label = (item.split(" — ", 1) + [""])[:2] if " — " in item else (str(index + 1), item)
        elements.append(_shape(f"Milestone halo {index + 1}", kind="ellipse", x=x - 27, y=y - 27, width=54, height=54, fill=_solid("#F7F3E8"), opacity=0.92))
        elements.append(_shape(f"Milestone core {index + 1}", kind="ellipse", x=x - 15, y=y - 15, width=30, height=30, fill=_solid(LIME)))
        elements.append(_glass(f"Milestone label {index + 1}", x=x - 96, y=y - 142, width=255, height=100, opacity=0.96, radius=14))
        elements.append(_text(role="label", x=x - 76, y=y - 126, width=215, height=30, content=_rich_text(year), token="metric", size=22, weight=750, color=LIME))
        elements.append(_text(role="caption", x=x - 76, y=y - 92, width=215, height=40, content=_rich_text(label), token="caption", size=15, weight=650, color=INK, fit="shrinkToFit", min_font_size=12))
    return elements


def _diagram(plan: SlidePlan) -> Elements:
    diagram = plan.diagram
    assert diagram is not None
    ids = {node.key: new_id("dn") for node in diagram.nodes}
    nodes = [
        {"id": ids[node.key], "label": node.label, **({"sublabel": node.sublabel} if node.sublabel else {}), **({"role": node.role} if node.role else {})}
        for node in diagram.nodes
    ]
    edges = [
        {"id": new_id("de"), "from": ids[edge.source], "to": ids[edge.target], "direction": "forward", **({"label": edge.label} if edge.label else {})}
        for edge in diagram.edges
    ]
    return [
        _frame("AsterLoop module frame"),
        _shape("Module reading field", x=0, y=0, width=720, height=VIEWPORT_H, fill=_linear((0, "#03101FF8"), (0.78, "#06101FE8"), (1, "#06101F00"))),
        _eyebrow(plan.eyebrow or "THERMAL LOOP", x=70, y=70),
        _headline(plan.headline, x=70, y=124, width=650, height=180, size=54),
        {
            "id": new_id("el"), "type": "diagram", "name": "Thermal loop", "semanticRole": "diagram",
            "diagramType": diagram.kind,
            "transform": {"x": 62, "y": 350, "width": 610, "height": 610},
            "nodes": nodes, "edges": edges,
            "layoutHint": {"algorithm": "layered", "direction": "TB", "mode": "managed"},
            "altText": "Thermal loop architecture from heat input through storage and exchange to industrial process.",
        },
    ]


def _comparison(plan: SlidePlan) -> Elements:
    items = plan.bullets[:4]
    elements: Elements = [
        _frame("AsterLoop comparison frame"),
        _shape("Comparison header", x=0, y=0, width=VIEWPORT_W, height=218, fill=_solid("#03101FDF")),
        _eyebrow(plan.eyebrow or "WHY ASTERLOOP WINS", x=64, y=48),
        _headline(plan.headline, x=64, y=96, width=1300, height=105, size=52),
        _glass("Conventional caption", x=58, y=710, width=820, height=270, opacity=0.98),
        _glass("AsterLoop caption", x=1042, y=710, width=820, height=270, opacity=0.98),
        _text(role="label", x=96, y=746, width=720, height=36, content=_rich_text("CONVENTIONAL SYSTEMS"), token="caption", size=18, weight=750, color=MUTED, letter_spacing=2),
        _text(role="label", x=1080, y=746, width=720, height=36, content=_rich_text("ASTERLOOP"), token="caption", size=18, weight=750, color=LIME, letter_spacing=2),
    ]
    if plan.body:
        elements.append(_text(role="body", x=96, y=808, width=720, height=120, content=_rich_text(plan.body), token="body", size=21, color=INK, line_height=1.35, fit="shrinkToFit", min_font_size=16))
    if items:
        elements.append(_text(role="body", x=1080, y=802, width=720, height=142, content=_rich_list(items), token="body", size=21, color=INK, line_height=1.45, fit="shrinkToFit", min_font_size=16))
    return elements


def _profile(plan: SlidePlan) -> Elements:
    quote = plan.quote or plan.body or plan.headline
    elements: Elements = [
        _frame("AsterLoop operator frame"),
        _shape("Operator reading field", x=0, y=0, width=1040, height=VIEWPORT_H, fill=_linear((0, "#03101FF7"), (0.72, "#03101FD4"), (1, "#03101F00"))),
        _eyebrow(plan.eyebrow or "BUILT WITH OPERATORS", x=72, y=78),
        _headline(plan.headline, x=72, y=136, width=780, height=140, size=55),
        _text(role="quote", x=72, y=350, width=760, height=300, content=_rich_text(f"“{quote}”"), token="quote", size=42, weight=550, color=INK, line_height=1.28, fit="shrinkToFit", min_font_size=28),
    ]
    if plan.attribution:
        elements.append(_text(role="caption", x=74, y=678, width=640, height=58, content=_rich_text(plan.attribution), token="caption", size=17, weight=700, color=LIME, letter_spacing=1.5, transform_case="uppercase"))
    elements.extend([
        _shape("Operator metric rule", x=74, y=802, width=300, height=4, fill=_solid(LIME)),
        _text(role="metric", x=72, y=820, width=210, height=120, content=_rich_text("30%"), token="metric", size=82, weight=750, color=INK),
        _text(role="caption", x=285, y=848, width=300, height=70, content=_rich_text("LOWER FUEL COSTS\nIN YEAR ONE"), token="caption", size=16, weight=700, color=MUTED, line_height=1.35, letter_spacing=1.5),
    ])
    return elements


def _closing(plan: SlidePlan) -> Elements:
    elements: Elements = [
        _frame("AsterLoop closing frame"),
        _shape("Closing reading field", x=0, y=0, width=1150, height=VIEWPORT_H, fill=_linear((0, "#03101FF5"), (0.7, "#03101FB0"), (1, "#03101F00"))),
        _eyebrow(plan.eyebrow or "SERIES A", x=76, y=92),
        _headline(plan.headline, x=74, y=210, width=840, height=280, size=88, minimum=50),
    ]
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=80, y=550, width=680, height=126, content=_rich_text(plan.subtitle), token="body", size=27, color=MUTED, line_height=1.45, fit="shrinkToFit", min_font_size=20))
    elements.extend([
        _shape("CTA circle", kind="ellipse", x=78, y=824, width=82, height=82, fill=_solid(LIME)),
        _text(role="label", x=78, y=837, width=82, height=55, content=_rich_text("→"), token="display", size=38, weight=700, color=NAVY, align="center"),
        _text(role="label", x=190, y=842, width=440, height=52, content=_rich_text("PARTNER WITH US"), token="caption", size=19, weight=750, color=INK, letter_spacing=2),
        _shape("CTA rule", x=650, y=866, width=300, height=3, fill=_solid(LIME)),
    ])
    return elements


BUILDERS = {
    "full-bleed-photo": _image_title,
    "big-number": _image_number,
    "trend-chart": _chart,
    "roadmap": _roadmap,
    "system-diagram": _diagram,
    "comparison": _comparison,
    "profile": _profile,
    "closing": _closing,
}


def layout_for(plan: SlidePlan) -> tuple[Elements, str] | None:
    if not plan.pattern_id:
        return None
    builder = BUILDERS.get(plan.pattern_id)
    if builder is None:
        return None
    return builder(plan), str(plan.pattern_id)


__all__ = ["layout_for"]
