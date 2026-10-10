"""Drawing helpers every design language shares (UI audit 2026-10-10, units 5 and 7).

Kept apart from the languages themselves so each language's file is only its
geometry. Everything here returns a schema-valid element dict; nothing here
decides where anything goes.
"""

from __future__ import annotations

from typing import Any

from .compose import _text
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


__all__ = ["_line", "_none", "_radial", "_rotated", "_shape", "_solid", "_text"]
