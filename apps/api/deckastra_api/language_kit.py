"""Drawing helpers every design language shares (UI audit 2026-10-10, units 5 and 7).

Kept apart from the languages themselves so each language's file is only its
geometry. Everything here returns a schema-valid element dict; nothing here
decides where anything goes.
"""

from __future__ import annotations

from typing import Any

from .compose import _rich_text, _text
from .ids import new_id


def _shape(
    name: str,
    *,
    x: float,
    y: float,
    width: float,
    height: float,
    fill: dict[str, Any],
    kind: str = "rectangle",
    role: str = "decoration",
    radius: float = 0,
    opacity: float | None = None,
    rotation: float | None = None,
    stroke: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A drawn motif. Decoration by role, so motion and overlap checks leave it be."""
    transform: dict[str, Any] = {"x": round(x, 2), "y": round(y, 2), "width": round(width, 2), "height": round(height, 2)}
    if rotation is not None:
        transform["rotation"] = rotation
    style: dict[str, Any] = {"fill": fill, "cornerRadius": radius}
    if stroke is not None:
        style["stroke"] = stroke
    element: dict[str, Any] = {
        "id": new_id("el"),
        "type": "shape",
        "name": name,
        "semanticRole": role,
        "shape": kind,
        "transform": transform,
        "style": style,
    }
    if opacity is not None:
        element["opacity"] = opacity
    return element


def _solid(color: str) -> dict[str, Any]:
    return {"type": "solid", "color": color}


def _none() -> dict[str, Any]:
    return {"type": "none"}


def _line(color: str, width: float) -> dict[str, Any]:
    """A stroke for an outlined motif."""
    return {"paint": _solid(color), "width": width}


def _radial(inner: str, outer: str) -> dict[str, Any]:
    return {"type": "radialGradient", "stops": [{"offset": 0, "color": inner}, {"offset": 1, "color": outer}]}


def _rotated(element: dict[str, Any], degrees: float) -> dict[str, Any]:
    """A text or shape turned a few degrees: a sticker, never a reading angle."""
    element["transform"]["rotation"] = degrees
    return element


def _stack_lines(text: str, max_lines: int = 2) -> list[str]:
    """A headline broken into display lines of balanced length.

    Up to `max_lines` words go one to a line, which is how every reference cover
    sets its title: a word per line, all at one size. Longer headlines are split
    where the longest line is shortest, so the stack stays a block rather than
    one long line over one short word.
    """
    words = text.split()
    if not words:
        return [text]
    if len(words) <= max_lines:
        return words
    count = len(words)
    lengths = [len(word) for word in words]

    def span(i: int, j: int) -> int:
        return sum(lengths[i:j]) + (j - i - 1)

    # best[k][j]: the smallest longest line setting words[:j] on k lines.
    best = [[float("inf")] * (count + 1) for _ in range(max_lines + 1)]
    cut = [[0] * (count + 1) for _ in range(max_lines + 1)]
    best[0][0] = 0
    for k in range(1, max_lines + 1):
        for j in range(1, count + 1):
            for i in range(k - 1, j):
                cost = max(best[k - 1][i], span(i, j))
                if cost < best[k][j]:
                    best[k][j], cut[k][j] = cost, i
    lines: list[str] = []
    j = count
    for k in range(max_lines, 0, -1):
        i = cut[k][j]
        lines.insert(0, " ".join(words[i:j]))
        j = i
    return lines


def _display_stack(
    text: str,
    *,
    x: float,
    y: float,
    width: float,
    height: float,
    size: float,
    minimum: float,
    line_height: float = 0.88,
    token: str = "display",
    weight: int | None = None,
    color: str = "token:colors.foreground",
    accent: str | None = None,
    letter_spacing: float | None = None,
    transform_case: str | None = None,
    align: str = "left",
    lines: int | None = None,
    role: str = "headline",
) -> dict[str, Any]:
    """The cover headline: one text element, a block per line, sized to its region.

    The size is a ceiling, not a target: `shrinkToFit` brings the whole stack
    down until its longest line fits the width and every line fits the height,
    so a short title fills its region and a long one still fits. One element
    keeps every line at one size and edits as one headline; the last line takes
    the accent as its own span colour (design-system v3, 2026-10-14).
    """
    stacked = _stack_lines(text, lines or (2 if len(text.split()) <= 5 else 3))
    blocks = []
    for index, line in enumerate(stacked):
        span: dict[str, Any] = {"text": line}
        if accent and len(stacked) > 1 and index == len(stacked) - 1:
            span["color"] = accent
        blocks.append({"id": new_id("blk"), "type": "paragraph", "spans": [span]})
    return _text(
        role=role,
        x=x,
        y=y,
        width=width,
        height=height,
        content={"version": 1, "blocks": blocks},
        token=token,
        size=size,
        weight=weight,
        color=color,
        fit="shrinkToFit",
        min_font_size=minimum,
        line_height=line_height,
        letter_spacing=letter_spacing,
        transform_case=transform_case,
        align=align,
    )


def _rows(
    items: list[str],
    *,
    x: float,
    y: float,
    width: float,
    height: float,
    size: float,
    minimum: float,
    numbers: list[str] | None = None,
    number_width: float = 0,
    number_size: float | None = None,
    number_token: str = "display",
    number_color: str = "token:colors.accent",
    number_weight: int | None = None,
    token: str = "body",
    weight: int | None = None,
    color: str = "token:colors.foreground",
    rule: str | None = "token:colors.border",
    line_height: float = 1.2,
    gap: float = 28,
) -> list[dict[str, Any]]:
    """A list as rows that share the whole region, each with its own number.

    The design-system v3 inside-slide concepts (2026-10-14) all set a list this
    way: the rows divide the height between them, so four items fill the slide
    instead of huddling at its top, and a hairline separates each row from the
    next. Each item is its own text element, sized to fit its row, so a long
    item shrinks alone and the rest keep the scale.
    """
    out: list[dict[str, Any]] = []
    if not items:
        return out
    row = height / len(items)
    text_x = x + (number_width + gap if numbers else 0)
    text_w = width - (text_x - x)
    for index, item in enumerate(items):
        top = y + index * row
        if rule and index:
            out.append(_shape("Row rule", x=x, y=top, width=width, height=2, fill=_solid(rule)))
        pad = min(24.0, row * 0.12)
        if numbers:
            out.append(_text(role="decoration", x=x, y=top + pad, width=number_width, height=row - 2 * pad,
                             content=_rich_text(numbers[index]), token=number_token, size=number_size or size * 1.6,
                             weight=number_weight, color=number_color, fit="shrinkToFit",
                             min_font_size=minimum, line_height=1, align="left"))
        out.append(_text(role="body", x=text_x, y=top + pad, width=text_w, height=row - 2 * pad,
                         content=_rich_text(item), token=token, size=size, weight=weight, color=color,
                         fit="shrinkToFit", min_font_size=minimum, line_height=line_height, align="left"))
    return out


def _over_scene(elements: list[dict[str, Any]], scenes: set[str]) -> list[dict[str, Any]]:
    """Mark a photograph as the scene and what stands on it as content.

    Words set over a washed photograph are the composition, not a collision,
    and Design Check reads that from layer roles (W110 gives way to them). The
    roles are written into the document so the editor, an export and the
    check all see the same intent.
    """
    for element in elements:
        if element.get("name") in scenes:
            element["layerRole"] = "scene"
        elif element.get("type") == "text" or element.get("role") == "supportingVisual" or element.get("semanticRole") == "supportingVisual":
            element.setdefault("layerRole", "content")
    return elements


def _path(
    name: str,
    commands: list[tuple[Any, ...]],
    *,
    fill: dict[str, Any] | None = None,
    stroke: dict[str, Any] | None = None,
    role: str = "decoration",
    opacity: float | None = None,
) -> dict[str, Any]:
    """A drawn outline from slide coordinates, normalized into its own box.

    `commands` are ("M", x, y), ("L", x, y), ("C", x1, y1, x2, y2, x, y) and
    ("Z",). The schema's custom paths are 0..1 of the element's box (doc 02
    §13.2), so the box is the outline's bounds and each pair is scaled into it.
    """
    xs = [value for command in commands for value in command[1::2]]
    ys = [value for command in commands for value in command[2::2]]
    x0, y0 = min(xs), min(ys)
    width = max(max(xs) - x0, 1.0)
    height = max(max(ys) - y0, 1.0)
    parts: list[str] = []
    for command in commands:
        letter, *values = command
        pairs = [
            f"{round((values[i] - x0) / width, 4)} {round((values[i + 1] - y0) / height, 4)}"
            for i in range(0, len(values), 2)
        ]
        parts.append(letter + (" " + " ".join(pairs) if pairs else ""))
    element = _shape(name, x=x0, y=y0, width=width, height=height,
                     fill=fill or _none(), role=role, opacity=opacity, stroke=stroke)
    element["shape"] = "customPath"
    element["pathData"] = " ".join(parts)
    return element


def _clipped_circle(
    name: str,
    *,
    cx: float,
    cy: float,
    r: float,
    fill: dict[str, Any],
    bounds: tuple[float, float] = (1920, 1080),
    opacity: float | None = None,
) -> dict[str, Any]:
    """A circle that runs off the slide, drawn as the part that is on it.

    Nothing a language draws may leave the slide, and a cover's big disc often
    should: clamping the outline to the slide gives exactly the visible part,
    because a circle is convex and the slide is a rectangle.
    """
    import math

    width, height = bounds
    if cx - r >= 0 and cy - r >= 0 and cx + r <= width and cy + r <= height:
        return _shape(name, kind="ellipse", x=cx - r, y=cy - r, width=2 * r, height=2 * r, fill=fill, opacity=opacity)
    points = []
    for step in range(96):
        angle = 2 * math.pi * step / 96
        points.append((min(max(cx + r * math.cos(angle), 0), width), min(max(cy + r * math.sin(angle), 0), height)))
    commands: list[tuple[Any, ...]] = [("M", *points[0])] + [("L", *point) for point in points[1:]] + [("Z",)]
    return _path(name, commands, fill=fill, opacity=opacity)


__all__ = [
    "_clipped_circle", "_display_stack", "_line", "_none", "_path", "_radial", "_rotated",
    "_over_scene", "_rows", "_shape", "_solid", "_stack_lines", "_text",
]
