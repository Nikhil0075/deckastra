"""Deterministic image and video art direction derived from a deck.

This module deliberately contains no model call.  It turns the document facts a
person can inspect (frame, theme and design language) into the exact prompt that
is priced and later sent to a media provider.
"""
from __future__ import annotations

import math
import re
from typing import Any, Literal

from . import presets

StyleSource = Literal["deck", "prompt"]
MediaKind = Literal["image", "video"]

_KINDS = {
    "background": "scene",
    "subject": "scene",
    "product": "product render",
    "texture": "texture",
    "detail": "close-up",
}
_TREATMENT_WORDS = {
    "mono": "It will be shown in black and white, so it should read through light and shape rather than colour.",
    "faded": "It will be shown softly faded; natural, muted light suits it.",
    "film": "It will be shown with a film grade; warm, natural light suits it.",
    "dramatic": "It will be shown with deep shadows; directional light suits it.",
    "duotone": "It will be shown in two theme colours, so strong contrast matters more than colour.",
}

# Small, fixed and intentionally ordinary.  Names make a prompt easier to read;
# the hex remains the authority and prevents a naming change from changing colour.
_COLOURS = {
    "black": "#000000", "charcoal": "#222222", "deep navy": "#14213D",
    "navy": "#1D3557", "royal blue": "#2457C5", "sky blue": "#63B3ED",
    "teal": "#168C8C", "forest green": "#256D3A", "sage green": "#8BA888",
    "warm coral": "#E76F51", "signal red": "#E63946", "orange": "#F28C28",
    "gold": "#D4A017", "warm yellow": "#F2C14E", "violet": "#7C5CE7",
    "magenta": "#C23B8E", "warm beige": "#D8C3A5", "light grey": "#D9DDE3",
    "off white": "#F5F3EE", "white": "#FFFFFF",
    # Vivid hues, so a bright colour is not named after a muted one: #4ADE80
    # was "sage green", which would steer a model to a grey-green (2026-10-15).
    "bright green": "#4ADE80", "lime": "#A3E635", "cyan": "#22D3EE",
    "electric blue": "#3B82F6", "hot pink": "#F472B6", "amber": "#F59E0B",
    "pale green": "#D4F0D4", "pale blue": "#D6E4F5",
}


def _rgb(value: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?", value or "")
    if not match:
        return None
    raw = match.group(1)
    return tuple(int(raw[index:index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]


def _colour_name(value: str) -> str:
    rgb = _rgb(value)
    if rgb is None:
        return value
    # Weighted RGB is enough here: names are explanatory, not colour science.
    def distance(candidate: str) -> float:
        other = _rgb(candidate) or (0, 0, 0)
        return 2 * (rgb[0] - other[0]) ** 2 + 4 * (rgb[1] - other[1]) ** 2 + 3 * (rgb[2] - other[2]) ** 2
    name = min(_COLOURS, key=lambda item: distance(_COLOURS[item]))
    return f"{name} {value[:7].upper()}"


def _resolve_colour(document: dict[str, Any], slide: dict[str, Any], token: str) -> str | None:
    colours = (document.get("theme") or {}).get("colors") or {}
    mode = (((document.get("theme") or {}).get("modes") or {}).get(slide.get("colorMode")) or {}).get("colors") or {}
    value: Any = mode.get(token, colours.get(token))
    for _ in range(10):
        if not isinstance(value, str) or not value.startswith("token:colors."):
            return value if isinstance(value, str) and _rgb(value) else None
        name = value.removeprefix("token:colors.")
        value = mode.get(name, colours.get(name))
    return None


def _aspect(width: float, height: float) -> str:
    ratio = width / max(1, height)
    options = [("16:9", 16 / 9), ("4:3", 4 / 3), ("1:1", 1), ("3:4", 3 / 4), ("9:16", 9 / 16)]
    return min(options, key=lambda option: abs(math.log(option[1] / ratio)))[0]


def _side(x: float, y: float) -> str:
    across = "left" if x < .4 else "right" if x > .6 else ""
    down = "upper" if y < .4 else "lower" if y > .6 else ""
    return " ".join(part for part in (down, across) if part) or "centre"


def _elements(items: list[dict[str, Any]]):
    for item in items:
        yield item
        yield from _elements(item.get("children") or [])


def target_frame(slide: dict[str, Any]) -> tuple[int, dict[str, Any]] | None:
    """The frame a generated picture goes in: the first empty one, else the first.

    One answer for the prompt and for placement, which disagreed: the prompt
    described the first frame with a slot, placement filled the first frame by
    name, and the editor offered the first empty one, so on a slide with two
    frames a picture could be asked for one and placed in the other
    (2026-10-15). A frame is filled when an image sits directly above it in the
    same box, as `slideMediaSlots` in presentation-core decides. Only top-level
    frames count, because placement inserts beside the frame on the slide.
    """
    from .preset_media import FRAME_NAMES

    elements = slide.get("elements") or []
    frames = [(index, element) for index, element in enumerate(elements)
              if element.get("type") == "shape"
              and (isinstance(element.get("mediaSlot"), dict) or element.get("name") in FRAME_NAMES)]

    def filled(index: int, element: dict[str, Any]) -> bool:
        above = elements[index + 1] if index + 1 < len(elements) else None
        box, other = element.get("transform") or {}, (above or {}).get("transform") or {}
        return bool(above) and above.get("type") == "image" and all(other.get(key) == box.get(key) for key in ("x", "y", "width"))

    return next(((index, element) for index, element in frames if not filled(index, element)), frames[0] if frames else None)


def _frame(slide: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    found = target_frame(slide)
    if found is None:
        return None
    element = found[1]
    return element, element.get("mediaSlot") if isinstance(element.get("mediaSlot"), dict) else {}


def _fallback_safe_area(document: dict[str, Any], slide: dict[str, Any]) -> dict[str, float] | None:
    view = document.get("viewport") or {}
    width, height = float(view.get("width") or 1), float(view.get("height") or 1)
    boxes = [item.get("transform") for item in _elements(slide.get("elements") or []) if item.get("type") == "text" and item.get("transform")]
    if not boxes:
        return None
    left = min(float(box.get("x") or 0) for box in boxes)
    top = min(float(box.get("y") or 0) for box in boxes)
    right = max(float(box.get("x") or 0) + float(box.get("width") or 0) for box in boxes)
    bottom = max(float(box.get("y") or 0) + float(box.get("height") or 0) for box in boxes)
    return {"x": left / width, "y": top / height, "width": (right - left) / width, "height": (bottom - top) / height}


def _composition(document: dict[str, Any], slide: dict[str, Any]) -> tuple[str, str, list[str], str | None]:
    found = _frame(slide)
    view = document.get("viewport") or {}
    if found:
        element, slot = found
        box = element.get("transform") or {}
        aspect = _aspect(float(box.get("width") or 1), float(box.get("height") or 1))
    else:
        slot = {}
        aspect = _aspect(float(view.get("width") or 16), float(view.get("height") or 9))
    cutout = slot.get("transparentRequired") is True
    kind = "cut-out" if cutout else _KINDS.get(str(slot.get("role") or ""), "scene")
    lines = [f"{aspect} composition."]
    checks = ["No words, letters or logos in the picture."]
    if kind == "cut-out":
        lines.extend(["Show the whole figure on a plain, even background that is easy to cut away.", "Keep complete hands and feet visible; crop nothing at the edge."])
        checks.append("Hands, feet and the top of the head are all inside the picture.")
    elif kind == "product render":
        lines.extend(["Render the whole product with a clear margin around every edge.", "Use clean studio light on a simple background."])
        checks.append("Every product edge has clear space around it.")
    elif kind == "texture":
        lines.append("Make a seamless surface texture with no objects or single point of interest.")
    elif kind == "close-up":
        lines.append("Use a close-up with one clear point of focus.")
    elif slot.get("role") == "subject":
        lines.append("Photograph the subject with the whole head and shoulders in frame.")
        checks.append("The face is not cut by the frame or mask.")
    else:
        lines.append("Compose a photographic scene.")
    if slot.get("focalRegion") and kind != "texture":
        focal = slot["focalRegion"]
        lines.append(f"Place the main subject in the {_side(float(focal['x']), float(focal['y']))} of the picture.")
    safe = slot.get("textSafeArea") or (None if found else _fallback_safe_area(document, slide))
    if safe and kind != "texture":
        where = _side(float(safe["x"]) + float(safe["width"]) / 2, float(safe["y"]) + float(safe["height"]) / 2)
        lines.append(f"Keep the {where} calm and uncluttered: words will sit there.")
        checks.append(f"The {where} is quiet enough for words to be read over it.")
    mask = slot.get("mask")
    if mask and mask != "rounded":
        lines.append(f"It will be cut to {'an arch' if mask == 'arch' else f'a {mask}'}, so keep everything important inside the edges.")
    if slot.get("orientation"):
        lines.append(f"{str(slot['orientation']).capitalize()} composition.")
    return " ".join(lines), aspect, checks, slot.get("treatmentPreset")


# The editor's looks (`treatmentPresets` in editor-ui's image-treatment.ts), the
# same numbers a person gets from the inspector. `test_media_style` holds the two
# copies to one answer, the way the patch appliers are held.
TREATMENT_PRESETS: dict[str, dict[str, Any]] = {
    "mono": {"monochrome": 1, "contrast": 0.1},
    "faded": {"exposure": 0.05, "contrast": -0.2, "saturation": -0.35},
    "dramatic": {"exposure": -0.1, "contrast": 0.35, "saturation": -0.15, "vignette": 0.5},
    "film": {"contrast": 0.1, "saturation": -0.1, "vignette": 0.25, "grain": 0.35},
}


def _lightness(value: str | None) -> float:
    rgb = _rgb(value or "")
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] if rgb else 0.0


def deck_treatment(document: dict[str, Any], slide_id: str, preset: str | None) -> dict[str, Any] | None:
    """The picture treatment a frame's preset means on this slide, or None.

    A duotone's shadows take whichever of the text and background colours is
    darker, as the editor's Duotone look does: on a light theme the background
    is near white, and putting it in the shadows turns the picture into a
    negative (2026-10-15).
    """
    if preset in TREATMENT_PRESETS:
        return dict(TREATMENT_PRESETS[preset])
    if preset != "duotone":
        return None
    slide = next((one for one in document.get("slides") or [] if one.get("id") == slide_id), {})
    text = _lightness(_resolve_colour(document, slide, "foreground"))
    background = _lightness(_resolve_colour(document, slide, "background"))
    darker = "token:colors.foreground" if text <= background else "token:colors.background"
    return {"duotone": [darker, "token:colors.accent"]}


def compose_media_prompt(document: dict[str, Any], slide_id: str, subject: str, *, kind: MediaKind, style_source: StyleSource) -> dict[str, Any]:
    """Return the exact, inspectable prompt for one slide and media kind."""
    slide = next((one for one in document.get("slides") or [] if one.get("id") == slide_id), None)
    if slide is None:
        raise ValueError("No such slide.")
    subject = subject.strip()
    if not subject:
        raise ValueError("Describe what to generate.")
    composition, aspect, checks, treatment = _composition(document, slide)
    parts: list[dict[str, str]] = [
        {"source": "subject", "label": "Your description", "text": subject},
        {"source": "composition", "label": "Frame composition", "text": composition},
    ]
    if style_source == "deck":
        colours = [(label, _resolve_colour(document, slide, token)) for label, token in (("background", "background"), ("accent", "accent"), ("text", "foreground"))]
        named = [f"{label}: {_colour_name(value)}" for label, value in colours if value]
        if named:
            parts.append({"source": "palette", "label": "From the deck: palette", "text": "Use the deck palette — " + "; ".join(named) + "."})
        language_id = str((((document.get("metadata") or {}).get("designLanguage") or {}).get("id") or "neutral"))
        language = ((presets.catalog().get("designLanguages") or {}).get(language_id) or {})
        words = ((language.get("imagery") or {}).get("promptWords") or [])
        if words:
            parts.append({"source": "language", "label": "From the deck: light and mood", "text": ", ".join(str(word) for word in words) + "."})
        if kind == "video":
            motion = (language.get("axes") or {}).get("motion")
            parts.append({"source": "camera", "label": "From the deck: camera pace", "text": "Slow, steady camera." if motion != "kinetic" else "Quick handheld movement."})
        if treatment in _TREATMENT_WORDS:
            parts.append({"source": "treatment", "label": "From the deck: picture treatment", "text": _TREATMENT_WORDS[treatment]})
    parts.append({"source": "always", "label": "Always", "text": "No text, letters or logos."})
    return {
        "prompt": "\n".join(part["text"] for part in parts),
        "parts": parts,
        "aspect_ratio": aspect,
        "checks": checks,
        "style_source": style_source,
        "treatment_preset": treatment if style_source == "deck" else None,
    }
