"""What each picture frame is for (template media slots, 2026-10-13).

A design language draws frames for photographs: Cinema Noir's full-bleed
image, Quiet Luxe's portrait, Earth Story's arch, Spatial Future's hologram,
Play Lab's blob. Until now a frame said only where a picture goes. This module
says what belongs in it, on the frame itself (`mediaSlot`), so an agent knows
whether to bring a scene, a cut-out, a product render or a texture, and the
editor can turn the slot into a generation brief (`mediaSlotBrief` in
presentation-core).

**One table, applied after composition** (`annotate`), so every frame any
layout draws is described the same way and no layout has to remember to.
Geometry-derived facts are computed rather than declared:

- the *orientation* from the frame's own box;
- the *text-safe area* from the words the slide places over the frame, as a
  share of the frame, so a picture keeps that part calm;
- the *focal region* on the side away from those words, where the picture's
  subject should stand;
- the *mask* from the frame's shape (a pill frame is an arch).

A frame that already carries a `mediaSlot` (a flagship that set its own) is
left alone. Nothing here changes where anything is drawn.
"""

from __future__ import annotations

from typing import Any

from .compose import VIEWPORT_H, VIEWPORT_W

#: role, layer role, transparent cut-out needed, what to picture when nothing better is known.
FRAME_SLOTS: dict[str, dict[str, Any]] = {
    "Image frame": {"role": "background"},
    "Portrait frame": {"role": "subject", "subject": "a person, head and shoulders"},
    "Arch frame": {"role": "background"},
    "Hologram frame": {"role": "product", "subject": "a product or device render"},
    "Picture blob": {"role": "subject"},
    "Play Lab hero frame": {"role": "subject"},
    "AsterLoop hero frame": {"role": "background"},
    "AsterLoop emissions frame": {"role": "background"},
    "AsterLoop roadmap frame": {"role": "background"},
    "AsterLoop module frame": {"role": "product", "subject": "the product module, whole"},
    "AsterLoop comparison frame": {"role": "detail"},
    "AsterLoop operator frame": {"role": "subject", "subject": "an operator at work"},
    "AsterLoop closing frame": {"role": "background"},
}

#: The look a language grades its photographs with (`image.treatment` presets).
LANGUAGE_TREATMENTS: dict[str, str] = {
    "cinema-noir": "mono",
    "swiss-signal": "mono",
    "earth-story": "faded",
    "quiet-luxe": "film",
}

#: A frame covering at least this much of the slide is the slide's backdrop.
FULL_BLEED = 0.85


def _walk(elements: list[dict[str, Any]]):
    for element in elements:
        yield element
        yield from _walk(element.get("children") or [])


def _overlap(a: dict[str, float], b: dict[str, float]) -> dict[str, float] | None:
    x0 = max(a["x"], b["x"])
    y0 = max(a["y"], b["y"])
    x1 = min(a["x"] + a["width"], b["x"] + b["width"])
    y1 = min(a["y"] + a["height"], b["y"] + b["height"])
    if x1 <= x0 or y1 <= y0:
        return None
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}


def _r(value: float) -> float:
    return round(max(0.0, min(1.0, value)), 3)


def slot_for(frame: dict[str, Any], slide: dict[str, Any], language: str) -> dict[str, Any] | None:
    """The slot a frame on this slide describes, or None for a shape that is not a picture frame."""
    base = FRAME_SLOTS.get(str(frame.get("name") or ""))
    if base is None:
        return None
    box = frame["transform"]
    width, height = float(box["width"]), float(box["height"])
    ratio = width / height if height else 1.0
    orientation = "square" if 0.9 <= ratio <= 1.1 else "landscape" if ratio > 1 else "portrait"
    slot: dict[str, Any] = {"role": base["role"], "orientation": orientation}
    if base.get("subject"):
        slot["subject"] = base["subject"]

    full_bleed = width * height >= VIEWPORT_W * VIEWPORT_H * FULL_BLEED
    if base["role"] == "background":
        slot["layerRole"] = "background" if full_bleed else "scene"
    elif base["role"] in ("subject", "product"):
        slot["layerRole"] = "subject"
    if frame.get("shape") == "pill":
        slot["mask"] = "arch" if orientation == "portrait" else "pill"
    elif frame.get("shape") == "ellipse":
        slot["mask"] = "ellipse"
    elif frame.get("shape") == "blob":
        slot["mask"] = "blob"

    # The words over the frame, as one region of it.
    frame_box = {"x": float(box["x"]), "y": float(box["y"]), "width": width, "height": height}
    covered: list[dict[str, float]] = []
    for element in _walk(slide.get("elements") or []):
        if element.get("type") != "text" or element is frame:
            continue
        t = element.get("transform") or {}
        found = _overlap(frame_box, {k: float(t.get(k, 0)) for k in ("x", "y", "width", "height")})
        if found:
            covered.append(found)
    if covered:
        x0 = min(c["x"] for c in covered)
        y0 = min(c["y"] for c in covered)
        x1 = max(c["x"] + c["width"] for c in covered)
        y1 = max(c["y"] + c["height"] for c in covered)
        safe = {
            "x": _r((x0 - frame_box["x"]) / width),
            "y": _r((y0 - frame_box["y"]) / height),
            "width": _r((x1 - x0) / width),
            "height": _r((y1 - y0) / height),
        }
        slot["textSafeArea"] = safe
        # The subject stands on the side the words leave free.
        centre_x = safe["x"] + safe["width"] / 2
        centre_y = safe["y"] + safe["height"] / 2
        if safe["width"] < 0.8:
            slot["focalRegion"] = {"x": 0.3 if centre_x > 0.5 else 0.7, "y": 0.5}
        else:
            slot["focalRegion"] = {"x": 0.5, "y": 0.35 if centre_y > 0.5 else 0.65}

    treatment = LANGUAGE_TREATMENTS.get(language)
    if treatment and base["role"] in ("background", "detail"):
        slot["treatmentPreset"] = treatment
    return slot


def annotate(slide: dict[str, Any], language: str) -> dict[str, Any]:
    """Give every picture frame on a composed slide its `mediaSlot`. Returns the slide."""
    for element in _walk(slide.get("elements") or []):
        if element.get("type") != "shape" or "mediaSlot" in element:
            continue
        slot = slot_for(element, slide, language)
        if slot is not None:
            element["mediaSlot"] = slot
    return slide
