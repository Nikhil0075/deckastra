"""Pattern-aware V2 composition.

The original composer deliberately had a tiny, reliable layout vocabulary.
That made it safe, but semantic patterns such as ``roadmap`` and ``pricing``
still looked like ``bullets`` and ``split``.  This module keeps the same safe
content contract while giving each thumbnail-level family its own deterministic
geometry.  Saved documents are unaffected: this runs only while composing a new
slide.
"""

from __future__ import annotations

from typing import Any, Callable

from .compose import (
    CONTENT_BOTTOM,
    CONTENT_W,
    CONTENT_X,
    VIEWPORT_H,
    VIEWPORT_W,
    _caption,
    _headline,
    _layout_chart,
    _layout_code,
    _layout_diagram,
    _layout_image,
    _layout_metrics,
    _layout_timeline,
    _rich_list,
    _rich_text,
    _text,
)
from .language_kit import _line, _radial, _shape, _solid
from .models import SlidePlan

Elements = list[dict[str, Any]]
Builder = Callable[[SlidePlan], Elements]


def _eyebrow(plan: SlidePlan, *, x: float = CONTENT_X, y: float = 92, width: float = CONTENT_W) -> Elements:
    if not plan.eyebrow:
        return []
    return [
        _text(
            role="eyebrow", x=x, y=y, width=width, height=38,
            content=_rich_text(plan.eyebrow), token="caption", size=18,
            weight=700, color="token:colors.accent", letter_spacing=2.4,
            transform_case="uppercase",
        )
    ]


def _panel(name: str, x: float, y: float, width: float, height: float, *, accent: bool = False, radius: float = 16) -> dict[str, Any]:
    return _shape(
        name, x=x, y=y, width=width, height=height,
        fill=_solid("token:colors.surfaceAlt" if accent else "token:colors.surface"),
        radius=radius, role="supportingVisual",
        stroke=_line("token:colors.borderStrong" if accent else "token:colors.border", 1),
    )


def _items(plan: SlidePlan, limit: int = 4) -> list[str]:
    return [str(item) for item in plan.bullets[:limit]]


def _split_label(item: str) -> tuple[str, str]:
    for separator in (" — ", " – ", ": "):
        if separator in item:
            first, second = item.split(separator, 1)
            return first.strip(), second.strip()
    return item.strip(), ""


def _agenda(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=58)]
    items = _items(plan, 5)
    row_y = 365.0
    row_h = min(116.0, 520 / max(1, len(items)))
    for index, item in enumerate(items):
        y = row_y + index * row_h
        elements.append(_shape(f"Agenda rule {index + 1}", x=CONTENT_X, y=y + row_h - 12, width=CONTENT_W, height=2, fill=_solid("token:colors.border")))
        elements.append(_text(role="label", x=CONTENT_X, y=y, width=100, height=64, content=_rich_text(f"{index + 1:02}"), token="metric", size=38, weight=700, color="token:colors.accent"))
        elements.append(_text(role="body", x=CONTENT_X + 150, y=y + 3, width=CONTENT_W - 150, height=62, content=_rich_text(item), token="h3", size=29, weight=600, fit="shrinkToFit", min_font_size=20))
    return elements


def _section(plan: SlidePlan) -> Elements:
    label = plan.eyebrow or "NEXT"
    elements = [
        _shape("Section field", x=0, y=0, width=VIEWPORT_W * 0.36, height=VIEWPORT_H, fill=_solid("token:colors.accent"), role="background"),
        _text(role="label", x=CONTENT_X, y=120, width=480, height=160, content=_rich_text(label), token="metric", size=76, weight=700, color="token:colors.accentForeground", fit="shrinkToFit", min_font_size=36),
        _text(role="headline", x=760, y=300, width=1000, height=340, content=_rich_text(plan.headline), token="display", size=86, weight=700, fit="shrinkToFit", min_font_size=46, line_height=1.04),
    ]
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=765, y=690, width=850, height=110, content=_rich_text(plan.subtitle), token="body", size=28, color="token:colors.foregroundMuted", line_height=1.4))
    return elements


def _comparison(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=56)]
    gap = 30
    width = (CONTENT_W - gap) / 2
    top = 350
    height = 590
    elements += [_panel("Current state", CONTENT_X, top, width, height), _panel("Preferred state", CONTENT_X + width + gap, top, width, height, accent=True)]
    elements += [
        _text(role="label", x=CONTENT_X + 36, y=top + 32, width=width - 72, height=38, content=_rich_text("CURRENT"), token="caption", size=18, weight=700, color="token:colors.foregroundMuted", letter_spacing=2),
        _text(role="label", x=CONTENT_X + width + gap + 36, y=top + 32, width=width - 72, height=38, content=_rich_text("BETTER"), token="caption", size=18, weight=700, color="token:colors.accent", letter_spacing=2),
    ]
    left = plan.body or "The existing path carries hidden cost, delay and uncertainty."
    elements.append(_text(role="body", x=CONTENT_X + 36, y=top + 105, width=width - 72, height=390, content=_rich_text(left), token="body", size=29, color="token:colors.foregroundMuted", line_height=1.45, fit="shrinkToFit", min_font_size=20))
    items = _items(plan, 4)
    elements.append(_text(role="body", x=CONTENT_X + width + gap + 36, y=top + 105, width=width - 72, height=390, content=_rich_list(items), token="body", size=27, line_height=1.55, fit="shrinkToFit", min_font_size=19))
    return elements


def _process(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=56)]
    items = _items(plan, 4)
    count = max(1, len(items))
    gap = 22
    width = (CONTENT_W - gap * (count - 1)) / count
    top = 410
    elements.append(_shape("Process spine", x=CONTENT_X + 40, y=top + 65, width=CONTENT_W - 80, height=4, fill=_solid("token:colors.borderStrong")))
    for index, item in enumerate(items):
        x = CONTENT_X + index * (width + gap)
        elements.append(_shape(f"Step {index + 1}", kind="ellipse", x=x + 12, y=top + 35, width=64, height=64, fill=_solid("token:colors.accent"), role="supportingVisual"))
        elements.append(_text(role="label", x=x + 12, y=top + 48, width=64, height=38, content=_rich_text(str(index + 1)), token="metric", size=25, weight=700, color="token:colors.accentForeground", align="center"))
        label, detail = _split_label(item)
        elements.append(_text(role="body", x=x + 10, y=top + 145, width=width - 20, height=90, content=_rich_text(label), token="h3", size=27, weight=650, fit="shrinkToFit", min_font_size=19))
        if detail:
            elements.append(_text(role="caption", x=x + 10, y=top + 245, width=width - 20, height=160, content=_rich_text(detail), token="bodySmall", size=20, color="token:colors.foregroundMuted", line_height=1.4, fit="shrinkToFit", min_font_size=15))
    return elements


def _practice(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=56)]
    left_w = CONTENT_W * 0.42
    elements.append(_panel("Practice prompt", CONTENT_X, 380, left_w, 520, accent=True, radius=28))
    prompt = plan.body or "Work from a real situation. Make the next move observable and small enough to try."
    elements.append(_text(role="body", x=CONTENT_X + 42, y=430, width=left_w - 84, height=360, content=_rich_text(prompt), token="quote", size=34, weight=550, line_height=1.35, fit="shrinkToFit", min_font_size=23))
    right_x = CONTENT_X + left_w + 90
    for index, item in enumerate(_items(plan, 4)):
        y = 390 + index * 128
        elements.append(_shape(f"Practice mark {index + 1}", kind="ellipse", x=right_x, y=y, width=44, height=44, fill=_solid("token:colors.accent")))
        elements.append(_text(role="body", x=right_x + 72, y=y - 2, width=CONTENT_X + CONTENT_W - right_x - 72, height=80, content=_rich_text(item), token="body", size=27, weight=550, fit="shrinkToFit", min_font_size=19))
    return elements


def _roadmap(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=56)]
    items = _items(plan, 4)
    count = max(1, len(items))
    # The labels extend 110 px either side of a milestone. Keep those labels,
    # not just the points, inside the slide's safe area.
    left = CONTENT_X + 110
    usable = CONTENT_W - 220
    step = usable / max(1, count - 1)
    points: list[tuple[float, float]] = []
    for index in range(count):
        points.append((left + index * step, 760 - index * 105))
    for index in range(len(points) - 1):
        x1, y1 = points[index]
        x2, y2 = points[index + 1]
        elements.append(_shape(f"Road segment {index + 1}", x=x1, y=(y1 + y2) / 2, width=x2 - x1, height=5, fill=_solid("token:colors.borderStrong"), rotation=-12))
    for index, (item, (x, y)) in enumerate(zip(items, points)):
        label, detail = _split_label(item)
        elements.append(_shape(f"Road milestone {index + 1}", kind="ellipse", x=x - 22, y=y - 22, width=44, height=44, fill=_solid("token:colors.accent")))
        elements.append(_text(role="label", x=x - 95, y=y - 92, width=190, height=45, content=_rich_text(label), token="caption", size=19, weight=700, color="token:colors.accent", align="center", fit="shrinkToFit", min_font_size=14))
        if detail:
            elements.append(_text(role="caption", x=x - 110, y=y + 38, width=220, height=86, content=_rich_text(detail), token="bodySmall", size=17, color="token:colors.foregroundMuted", align="center", fit="shrinkToFit", min_font_size=13))
    return elements


def _timeline_v2(plan: SlidePlan) -> Elements:
    if plan.timeline:
        return _layout_timeline(plan)
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=54)]
    items = _items(plan, 6)
    count = max(1, len(items))
    step = CONTENT_W / count
    rule_y = 560
    elements.append(_shape("Timeline rule", x=CONTENT_X, y=rule_y, width=CONTENT_W, height=4, fill=_solid("token:colors.borderStrong")))
    for index, item in enumerate(items):
        when, label = _split_label(item)
        x = CONTENT_X + index * step
        elements.append(_shape(f"Timeline point {index + 1}", kind="ellipse", x=x + step / 2 - 17, y=rule_y - 15, width=34, height=34, fill=_solid("token:colors.accent")))
        elements.append(_text(role="label", x=x + 10, y=rule_y - 100, width=step - 20, height=52, content=_rich_text(when), token="caption", size=20, weight=700, color="token:colors.accent", align="center", fit="shrinkToFit", min_font_size=14))
        elements.append(_text(role="body", x=x + 10, y=rule_y + 55, width=step - 20, height=130, content=_rich_text(label or when), token="h3", size=24, weight=620, align="center", fit="shrinkToFit", min_font_size=17))
    return elements


def _checklist(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=54)]
    items = _items(plan, 5)
    top = 350
    row_h = min(112, 560 / max(1, len(items)))
    for index, item in enumerate(items):
        y = top + index * row_h
        elements.append(_shape(f"Check {index + 1}", kind="ellipse", x=CONTENT_X, y=y + 8, width=44, height=44, fill=_solid("token:colors.accent")))
        elements.append(_text(role="label", x=CONTENT_X, y=y + 13, width=44, height=30, content=_rich_text("✓"), token="caption", size=20, weight=800, color="token:colors.accentForeground", align="center"))
        label, detail = _split_label(item)
        elements.append(_text(role="body", x=CONTENT_X + 80, y=y, width=CONTENT_W * 0.45, height=64, content=_rich_text(label), token="h3", size=27, weight=650, fit="shrinkToFit", min_font_size=19))
        if detail:
            elements.append(_text(role="caption", x=CONTENT_X + CONTENT_W * 0.53, y=y + 4, width=CONTENT_W * 0.47, height=64, content=_rich_text(detail), token="bodySmall", size=20, color="token:colors.foregroundMuted", fit="shrinkToFit", min_font_size=15))
        elements.append(_shape(f"Check rule {index + 1}", x=CONTENT_X + 80, y=y + row_h - 12, width=CONTENT_W - 80, height=1, fill=_solid("token:colors.border")))
    return elements


def _big_number(plan: SlidePlan) -> Elements:
    metric = plan.metrics[0] if plan.metrics else None
    value = metric.value if metric else "NOW"
    label = metric.label if metric else (plan.subtitle or plan.body)
    elements = _eyebrow(plan)
    elements.append(_text(role="metric", x=CONTENT_X, y=220, width=CONTENT_W * 0.56, height=430, content=_rich_text(value), token="metric", size=250, weight=750, color="token:colors.accent", fit="shrinkToFit", min_font_size=110, line_height=0.9))
    elements.append(_text(role="headline", x=CONTENT_X + CONTENT_W * 0.58, y=280, width=CONTENT_W * 0.42, height=260, content=_rich_text(plan.headline), token="display", size=64, weight=700, fit="shrinkToFit", min_font_size=36, line_height=1.08))
    if label:
        elements.append(_text(role="caption", x=CONTENT_X + CONTENT_W * 0.58, y=590, width=CONTENT_W * 0.36, height=120, content=_rich_text(label), token="body", size=24, color="token:colors.foregroundMuted", line_height=1.4))
    elements.append(_shape("Big number rule", x=CONTENT_X, y=830, width=CONTENT_W, height=5, fill=_solid("token:colors.accent")))
    if plan.caption:
        elements.append(_caption(plan.caption, 865))
    return elements


def _profile(plan: SlidePlan) -> Elements:
    elements = [
        _shape("Portrait frame", x=0, y=0, width=VIEWPORT_W * 0.43, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
    ]
    elements[0]["altText"] = plan.picture or plan.attribution or plan.headline
    # This is deliberately a full-bleed portrait plane. Record that intent so
    # Design Check does not propose shrinking the composition into the safe area.
    elements[0]["metadata"] = {
        "designCheckIgnore": ["W104"],
        **({"picture": plan.picture} if plan.picture else {}),
    }
    x = 930
    elements += _eyebrow(plan, x=x, y=150, width=820)
    elements.append(_text(role="headline", x=x, y=220, width=820, height=190, content=_rich_text(plan.headline), token="display", size=58, weight=700, fit="shrinkToFit", min_font_size=34, line_height=1.08))
    quote = plan.quote or plan.body or "A point of view grounded in the work."
    elements.append(_text(role="quote", x=x, y=465, width=780, height=250, content=_rich_text(f"“{quote}”"), token="quote", size=38, line_height=1.35, fit="shrinkToFit", min_font_size=25))
    if plan.attribution:
        elements.append(_text(role="caption", x=x, y=755, width=760, height=60, content=_rich_text(plan.attribution), token="caption", size=20, weight=700, color="token:colors.accent"))
    return elements


def _case_study(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=54)]
    labels = ["CHALLENGE", "MOVE", "RESULT"]
    values = [plan.body or "Name the situation that had to change.", *(_items(plan, 2) or ["Make the intervention visible.", "Measure the outcome."])]
    while len(values) < 3:
        values.append("Make the outcome observable.")
    gap = 24
    width = (CONTENT_W - gap * 2) / 3
    for index in range(3):
        x = CONTENT_X + index * (width + gap)
        elements.append(_panel(labels[index].title(), x, 390 + index * 34, width, 480 - index * 34, accent=index == 2))
        elements.append(_text(role="label", x=x + 30, y=425 + index * 34, width=width - 60, height=36, content=_rich_text(labels[index]), token="caption", size=17, weight=750, color="token:colors.accent" if index == 2 else "token:colors.foregroundMuted", letter_spacing=1.8))
        elements.append(_text(role="body", x=x + 30, y=500 + index * 34, width=width - 60, height=270, content=_rich_text(values[index]), token="body", size=26, weight=550, line_height=1.4, fit="shrinkToFit", min_font_size=18))
    return elements


def _decision(plan: SlidePlan) -> Elements:
    elements = [
        _shape("Decision signal", x=0, y=0, width=430, height=VIEWPORT_H, fill=_solid("token:colors.accent"), role="background"),
        _text(role="label", x=CONTENT_X, y=120, width=270, height=90, content=_rich_text(plan.eyebrow or "DECISION"), token="caption", size=22, weight=800, color="token:colors.accentForeground", letter_spacing=2, transform_case="uppercase"),
        _text(role="headline", x=560, y=190, width=1160, height=370, content=_rich_text(plan.headline), token="display", size=78, weight=720, fit="shrinkToFit", min_font_size=42, line_height=1.05),
    ]
    detail = plan.body or plan.subtitle
    if detail:
        elements.append(_text(role="body", x=565, y=650, width=1000, height=190, content=_rich_text(detail), token="body", size=29, color="token:colors.foregroundMuted", line_height=1.45))
    elements.append(_shape("Decision rule", x=565, y=900, width=1030, height=4, fill=_solid("token:colors.accent")))
    return elements


def _closing(plan: SlidePlan) -> Elements:
    elements = [
        _shape("Closing glow", kind="ellipse", x=1160, y=120, width=760, height=760, fill=_radial("token:colors.accent", "token:colors.background"), opacity=0.38),
    ]
    elements += _eyebrow(plan, y=210)
    elements.append(_text(role="headline", x=CONTENT_X, y=300, width=1120, height=360, content=_rich_text(plan.headline), token="display", size=84, weight=720, fit="shrinkToFit", min_font_size=44, line_height=1.02))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=CONTENT_X, y=720, width=900, height=90, content=_rich_text(plan.subtitle), token="body", size=28, color="token:colors.foregroundMuted"))
    elements.append(_shape("Closing action", x=CONTENT_X, y=900, width=560, height=5, fill=_solid("token:colors.accent")))
    return elements


def _summary(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=54)]
    items = _items(plan, 3)
    while len(items) < 3:
        items.append("A concise decision-ready takeaway")
    top = 360
    big_w = CONTENT_W * 0.56
    side_x = CONTENT_X + big_w + 24
    side_w = CONTENT_W - big_w - 24
    elements += [_panel("Primary summary", CONTENT_X, top, big_w, 550, accent=True, radius=24), _panel("Summary two", side_x, top, side_w, 263, radius=24), _panel("Summary three", side_x, top + 287, side_w, 263, radius=24)]
    elements.append(_text(role="body", x=CONTENT_X + 44, y=top + 55, width=big_w - 88, height=390, content=_rich_text(items[0]), token="display", size=46, weight=650, line_height=1.15, fit="shrinkToFit", min_font_size=27))
    for index in range(1, 3):
        y = top + (index - 1) * 287
        elements.append(_text(role="label", x=side_x + 34, y=y + 30, width=side_w - 68, height=35, content=_rich_text(f"0{index + 1}"), token="metric", size=20, weight=700, color="token:colors.accent"))
        elements.append(_text(role="body", x=side_x + 34, y=y + 92, width=side_w - 68, height=120, content=_rich_text(items[index]), token="h3", size=27, weight=600, fit="shrinkToFit", min_font_size=19))
    return elements


def _feature_grid(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=54)]
    items = _items(plan, 4)
    while len(items) < 4:
        items.append("A focused capability")
    gap = 24
    width = (CONTENT_W - gap) / 2
    height = 250
    for index, item in enumerate(items[:4]):
        col, row = index % 2, index // 2
        x, y = CONTENT_X + col * (width + gap), 380 + row * (height + gap)
        elements.append(_panel(f"Capability {index + 1}", x, y, width, height, accent=index == 0, radius=22))
        elements.append(_text(role="metric", x=x + 30, y=y + 26, width=72, height=52, content=_rich_text(f"{index + 1:02}"), token="metric", size=30, weight=700, color="token:colors.accent"))
        elements.append(_text(role="body", x=x + 125, y=y + 35, width=width - 165, height=150, content=_rich_text(item), token="h3", size=27, weight=620, fit="shrinkToFit", min_font_size=19))
    return elements


def _journey(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=54)]
    items = _items(plan, 4)
    count = max(1, len(items))
    gap = 36
    width = (CONTENT_W - gap * (count - 1)) / count
    for index, item in enumerate(items):
        x = CONTENT_X + index * (width + gap)
        y = 640 - index * 72
        elements.append(_shape(f"Journey station {index + 1}", x=x, y=y, width=width, height=250, fill=_solid("token:colors.surface"), radius=90 if index in (0, count - 1) else 24, role="supportingVisual", stroke=_line("token:colors.borderStrong", 1)))
        elements.append(_text(role="label", x=x + 24, y=y + 28, width=width - 48, height=42, content=_rich_text(f"MOMENT {index + 1}"), token="caption", size=16, weight=700, color="token:colors.accent", letter_spacing=1.4))
        elements.append(_text(role="body", x=x + 24, y=y + 92, width=width - 48, height=112, content=_rich_text(item), token="h3", size=25, weight=620, fit="shrinkToFit", min_font_size=18))
    return elements


def _pricing(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=54)]
    items = ([plan.body] if plan.body else []) + _items(plan, 3)
    while len(items) < 3:
        items.append("A clear option for the next stage")
    items = items[:3]
    gap = 24
    width = (CONTENT_W - gap * 2) / 3
    for index, item in enumerate(items):
        label, detail = _split_label(item)
        x = CONTENT_X + index * (width + gap)
        y = 390 - (26 if index == 1 else 0)
        height = 500 + (52 if index == 1 else 0)
        elements.append(_panel(f"Price tier {index + 1}", x, y, width, height, accent=index == 1, radius=22))
        elements.append(_text(role="label", x=x + 34, y=y + 40, width=width - 68, height=50, content=_rich_text(label or f"OPTION {index + 1}"), token="h3", size=27, weight=700, color="token:colors.accent" if index == 1 else "token:colors.foreground"))
        elements.append(_text(role="body", x=x + 34, y=y + 130, width=width - 68, height=260, content=_rich_text(detail or item), token="body", size=24, color="token:colors.foregroundMuted", line_height=1.45, fit="shrinkToFit", min_font_size=17))
    return elements


def _gallery(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=52)]
    frames = [(CONTENT_X, 380, 720, 500), (CONTENT_X + 750, 380, 360, 300), (CONTENT_X + 1140, 380, 540, 500)]
    captions = _items(plan, 3)
    for index, (x, y, width, height) in enumerate(frames):
        elements.append(_shape(f"Gallery frame {index + 1}", x=x, y=y, width=width, height=height, fill=_solid("token:colors.surfaceAlt"), radius=18, role="supportingVisual", stroke=_line("token:colors.border", 1)))
        elements[-1]["altText"] = captions[index] if index < len(captions) else f"Gallery image {index + 1}"
        if index == 1:
            elements.append(_text(role="caption", x=x, y=y + height + 24, width=width, height=90, content=_rich_text(captions[index] if index < len(captions) else "A supporting view"), token="caption", size=18, color="token:colors.foregroundMuted"))
    return elements


def _architecture(plan: SlidePlan) -> Elements:
    if plan.diagram:
        return _layout_diagram(plan)
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=52)]
    items = ([plan.body] if plan.body else []) + _items(plan, 4)
    while len(items) < 4:
        items.append("A clear system responsibility")
    centre_x, centre_y = 960, 650
    positions = [(220, 430), (700, 380), (1180, 430), (700, 720)]
    for index, (item, (x, y)) in enumerate(zip(items[:4], positions)):
        elements.append(_panel(f"Architecture node {index + 1}", x, y, 420, 150, accent=index == 1, radius=18))
        elements.append(_text(role="body", x=x + 24, y=y + 34, width=372, height=80, content=_rich_text(item), token="body", size=23, weight=600, align="center", fit="shrinkToFit", min_font_size=17))
        if index != 1:
            elements.append(_shape(f"Architecture connector {index + 1}", x=min(x + 210, centre_x), y=min(y + 75, centre_y), width=abs(centre_x - (x + 210)) or 5, height=4, fill=_solid("token:colors.accent"), opacity=0.7))
    return elements


def _system_flow(plan: SlidePlan) -> Elements:
    if plan.diagram:
        return _layout_diagram(plan)
    elements = _eyebrow(plan) + [_headline(plan.headline, y=145, size=52)]
    items = _items(plan, 5)
    count = max(1, len(items))
    gap = 20
    width = (CONTENT_W - gap * (count - 1)) / count
    y = 510
    for index, item in enumerate(items):
        x = CONTENT_X + index * (width + gap)
        elements.append(_shape(f"Flow node {index + 1}", x=x, y=y, width=width, height=210, fill=_solid("token:colors.surface"), radius=18, role="supportingVisual", stroke=_line("token:colors.borderStrong", 1)))
        elements.append(_text(role="label", x=x + 20, y=y + 24, width=width - 40, height=38, content=_rich_text(f"{index + 1:02}"), token="metric", size=23, weight=700, color="token:colors.accent"))
        elements.append(_text(role="body", x=x + 20, y=y + 82, width=width - 40, height=90, content=_rich_text(item), token="body", size=23, weight=600, fit="shrinkToFit", min_font_size=16, align="center"))
        if index < count - 1:
            elements.append(_shape(f"Flow arrow {index + 1}", kind="chevron", x=x + width + 2, y=y + 83, width=16, height=46, fill=_solid("token:colors.accent")))
    return elements


def _code_demo(plan: SlidePlan) -> Elements:
    elements = _layout_code(plan)
    elements.insert(0, _shape("Demo chrome", x=CONTENT_X, y=285, width=CONTENT_W, height=44, fill=_solid("token:colors.surfaceAlt"), radius=12, role="decoration"))
    for index, color in enumerate(("token:colors.danger", "token:colors.warning", "token:colors.success")):
        elements.insert(index + 1, _shape(f"Demo light {index + 1}", kind="ellipse", x=CONTENT_X + 18 + index * 28, y=299, width=14, height=14, fill=_solid(color)))
    return elements


def _media(plan: SlidePlan) -> Elements:
    if plan.picture or plan.pattern_id == "full-bleed-photo":
        return _layout_image(plan)
    elements = [
        _shape("Image frame", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="background"),
        _shape("Media veil", x=0, y=0, width=VIEWPORT_W * 0.52, height=VIEWPORT_H, fill=_solid("token:colors.background"), opacity=0.88, role="decoration"),
    ]
    elements += _eyebrow(plan, x=CONTENT_X, y=220, width=760)
    elements.append(_text(role="headline", x=CONTENT_X, y=300, width=760, height=360, content=_rich_text(plan.headline), token="display", size=72, weight=700, fit="shrinkToFit", min_font_size=40, line_height=1.05))
    return elements


def _statement_question(plan: SlidePlan) -> Elements:
    elements = _eyebrow(plan)
    elements.append(_shape("Statement marker", kind="ellipse", x=CONTENT_X, y=250, width=170, height=170, fill=_solid("token:colors.accent"), opacity=0.9))
    elements.append(_text(role="label", x=CONTENT_X, y=275, width=170, height=110, content=_rich_text("?"), token="display", size=64, weight=700, color="token:colors.accentForeground", align="center"))
    elements.append(_text(role="headline", x=CONTENT_X + 250, y=230, width=CONTENT_W - 250, height=480, content=_rich_text(plan.quote or plan.headline), token="display", size=66, weight=650, fit="shrinkToFit", min_font_size=30, line_height=1.12))
    if plan.attribution or plan.body:
        elements.append(_text(role="caption", x=CONTENT_X + 250, y=760, width=900, height=80, content=_rich_text(plan.attribution or plan.body), token="body", size=23, color="token:colors.foregroundMuted"))
    return elements


FAMILY_BUILDERS: dict[str, Builder] = {
    "agenda": _agenda,
    "section": _section,
    "comparison": _comparison,
    "process": _process,
    "practice": _practice,
    "roadmap": _roadmap,
    "checklist": _checklist,
    "big-number": _big_number,
    "profile": _profile,
    "case-study": _case_study,
    "decision": _decision,
    "closing": _closing,
    "summary": _summary,
    "feature-grid": _feature_grid,
    "journey": _journey,
    "pricing": _pricing,
    "gallery": _gallery,
    "reflection": _statement_question,
    "data-chart": _layout_chart,
    "architecture": _architecture,
    "system-flow": _system_flow,
    "code-demo": _code_demo,
    "media": _media,
    "timeline": _timeline_v2,
    "metrics": _layout_metrics,
}


def _language_motifs(language: str, family: str) -> Elements:
    """Quiet edge motifs; the family still owns the information geometry."""
    if family == "media":
        return []
    if language == "swiss-signal":
        return [_shape("Swiss signal", x=44, y=80, width=12, height=920, fill=_solid("token:colors.accent"))]
    if language == "cinema-noir":
        return [
            _shape("Letterbox top", x=0, y=0, width=VIEWPORT_W, height=54, fill=_solid("#000000")),
            _shape("Letterbox bottom", x=0, y=VIEWPORT_H - 54, width=VIEWPORT_W, height=54, fill=_solid("#000000")),
        ]
    if language == "play-lab":
        return [
            _shape("Play bubble one", kind="ellipse", x=1680, y=60, width=190, height=190, fill=_solid("token:colors.secondary"), opacity=0.28),
            _shape("Play bubble two", kind="ellipse", x=30, y=850, width=140, height=140, fill=_solid("token:colors.accent"), opacity=0.22),
        ]
    if language == "system-terminal":
        return [_shape("Terminal status", x=0, y=0, width=VIEWPORT_W, height=18, fill=_solid("token:colors.accent"), opacity=0.75)]
    if language == "quiet-luxe":
        return [_shape("Luxe hairline", x=CONTENT_X, y=970, width=CONTENT_W, height=1, fill=_solid("token:colors.borderStrong"))]
    if language == "data-desk":
        return [_shape("Desk status strip", x=0, y=0, width=VIEWPORT_W, height=22, fill=_solid("token:colors.accent"))]
    if language == "earth-story":
        return [_shape("Earth horizon", kind="ellipse", x=0, y=930, width=VIEWPORT_W, height=150, fill=_solid("token:colors.surfaceAlt"), opacity=0.72)]
    if language == "spatial-future":
        return [_shape("Spatial energy", kind="ellipse", x=1440, y=0, width=480, height=480, fill=_radial("token:colors.accent", "token:colors.background"), opacity=0.24)]
    return []


def layout_for_pattern(
    plan: SlidePlan,
    language: str,
    *,
    visual_system: str | None = None,
) -> tuple[Elements, str] | None:
    """Return V2 elements and their family, or None for the legacy fallback."""
    if visual_system == "asterloop-energy":
        from .asterloop_v2 import layout_for as asterloop_layout

        flagship = asterloop_layout(plan)
        if flagship is not None:
            return flagship
    if not plan.pattern_id:
        return None
    # Base layouts keep each design language's original signature composition.
    if plan.pattern_id in {"title", "statement", "bullets", "metrics", "quote", "code", "split"}:
        return None
    from . import presets

    definition = (presets.catalog().get("patternDefinitions") or {}).get(plan.pattern_id) or {}
    family = str(definition.get("family") or "")
    builder = FAMILY_BUILDERS.get(family)
    if not builder:
        return None
    elements = builder(plan)
    return _language_motifs(language, family) + elements, family


__all__ = ["FAMILY_BUILDERS", "layout_for_pattern"]
