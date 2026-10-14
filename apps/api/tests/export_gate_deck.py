"""The export gate's deck (image-led visual systems, item 8, 2026-10-14).

One deck that carries every image-led capability at once, so the gate runs a
single real export through every format rather than one feature at a time:

1. Layers: a scene photograph, a decoration behind the subject, a transparent
   cut-out subject, the headline, and a foreground note. Its stacking order
   (depth) and its reading order (narrative) deliberately disagree.
2. A picture masked to a diamond, treated with a duotone and a vignette and
   blended (so PowerPoint gets a capture), one masked to an arch and left
   alone (so PowerPoint gets a native crop), and text filled with a picture.
3. A bubble map and a scatter.
4. An isometric diagram.

Plus a PNG mislabelled as a JPEG, which is one of the deliberate broken cases.
Ids are fixed so a failure names the same element every run.
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TECHNICAL = ROOT / "packages/presentation-schema/fixtures/technical-deck.mydeck.json"


def _id(prefix: str, n: int) -> str:
    return f"{prefix}_01JB8Z9K2QW4RN7F3XG5HTG{n:03d}"


PHOTO = _id("ast", 1)
CUTOUT = _id("ast", 2)
MISTYPED = _id("ast", 3)

ALT = {
    "scene": "A mountain valley at dawn",
    "subject": "A runner mid-stride, cut out",
    "diamond": "A wind farm on a ridge, in a diamond",
    "ridge": "A ridge line in an arch, untreated",
    "mistyped": "A transparent badge recorded with the wrong file type",
}

HEADLINE = "Depth is not reading order"
NOTE = "A caption, read after the headline"
FILLED = "FILLED WORDS"
HINDI = "एक डेक, हर भाषा"
ARABIC = "عرض واحد بكل لغة"


def png(width: int, height: int, colour: tuple[int, int, int], *, alpha: bool = False) -> bytes:
    from PIL import Image

    if alpha:
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for y in range(height // 4, height * 3 // 4):
            for x in range(width // 4, width * 3 // 4):
                image.putpixel((x, y), (*colour, 255))
    else:
        image = Image.new("RGB", (width, height), colour)
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def _text(n: int, text: str, role: str, box: tuple[int, int, int, int], *, layer: str | None = None, size: int = 56, extra: dict | None = None) -> dict:
    x, y, w, h = box
    element = {
        "id": _id("el", n),
        "type": "text",
        "name": text[:40],
        "semanticRole": role,
        "transform": {"x": x, "y": y, "width": w, "height": h, "rotation": 0},
        "content": {"version": 1, "blocks": [{"id": _id("blk", n), "type": "paragraph", "spans": [{"text": text}]}]},
        "typography": {"fontFamily": "Inter", "fontSize": size, "fontWeight": 700, "color": "token:colors.foreground"},
    }
    if layer:
        element["layerRole"] = layer
    element.update(extra or {})
    return element


def _image(n: int, asset: str, alt: str, box: tuple[int, int, int, int], **extra) -> dict:
    x, y, w, h = box
    return {
        "id": _id("el", n),
        "type": "image",
        "name": f"Picture {n}",
        "assetId": asset,
        "altText": alt,
        "fit": "cover",
        "transform": {"x": x, "y": y, "width": w, "height": h, "rotation": 0},
        **extra,
    }


def deck() -> dict:
    """The gate deck: the technical fixture's theme and shell, with the four slides above."""
    document = json.loads(TECHNICAL.read_text(encoding="utf-8"))
    document["assets"] = [
        {"id": PHOTO, "type": "image", "storageKey": "w/photo.png", "fileName": "photo.png", "mimeType": "image/png", "width": 64, "height": 40, "hasAlpha": False},
        {"id": CUTOUT, "type": "image", "storageKey": "w/cutout.png", "fileName": "cutout.png", "mimeType": "image/png", "width": 40, "height": 60, "hasAlpha": True, "derivedFrom": PHOTO},
        {"id": MISTYPED, "type": "image", "storageKey": "w/badge.jpg", "fileName": "badge.jpg", "mimeType": "image/jpeg", "width": 40, "height": 40},
    ]
    shell = document["slides"][0]
    base = {k: v for k, v in shell.items() if k not in ("id", "elements", "animations", "transition", "narration", "speakerNotes")}

    layers = {
        **base,
        "id": _id("sld", 1),
        "name": "Layers",
        "elements": [
            # Back to front: what the eye sees stacked, not what is read first.
            _image(1, PHOTO, ALT["scene"], (0, 0, 1920, 1080), semanticRole="supportingVisual", layerRole="scene"),
            {"id": _id("el", 2), "type": "shape", "shape": "ellipse", "name": "Yellow ring", "semanticRole": "decoration",
             "layerRole": "decoration-behind-subject", "transform": {"x": 1180, "y": 220, "width": 560, "height": 560, "rotation": 0},
             "style": {"fill": {"type": "solid", "color": "#FFD400"}}},
            _image(3, CUTOUT, ALT["subject"], (1200, 160, 520, 780), semanticRole="heroVisual", layerRole="subject"),
            # The caption is stacked below the headline and read after it; the
            # headline is the topmost object and read first of the words.
            _text(5, NOTE, "caption", (120, 900, 900, 80), layer="content", size=32),
            _text(4, HEADLINE, "headline", (120, 140, 1000, 240), layer="foreground", size=72),
        ],
    }
    picture = {
        **base,
        "id": _id("sld", 2),
        "name": "Picture",
        "elements": [
            _image(6, PHOTO, ALT["diamond"], (1080, 120, 640, 840), semanticRole="heroVisual",
                   mask={"type": "shape", "shape": "diamond"},
                   treatment={"duotone": ["#102030", "#F0E0D0"], "vignette": 0.4},
                   style={"blendMode": "multiply"}),
            _text(7, FILLED, "headline", (120, 200, 900, 300), size=140,
                  extra={"pictureFill": {"assetId": PHOTO, "fit": "cover", "fallbackColor": "#202020"}}),
            _image(14, PHOTO, ALT["ridge"], (1760, 120, 140, 200), semanticRole="supportingVisual",
                   mask={"type": "shape", "shape": "arch"}),
            _image(8, MISTYPED, ALT["mistyped"], (120, 640, 300, 300), semanticRole="supportingVisual"),
        ],
    }
    data = {
        **base,
        "id": _id("sld", 3),
        "name": "Data",
        "elements": [
            {"id": _id("el", 9), "type": "chart", "name": "Revenue by city", "semanticRole": "primaryChart", "chartType": "bubbleMap",
             "altText": "Revenue by city: London 42, Tokyo 47, Lagos 18",
             "transform": {"x": 80, "y": 120, "width": 1100, "height": 760, "rotation": 0},
             "data": {"type": "inline", "rows": [
                 {"city": "London", "lat": 51.5, "lon": -0.13, "v": 42},
                 {"city": "Tokyo", "lat": 35.68, "lon": 139.69, "v": 47},
                 {"city": "Lagos", "lat": 6.52, "lon": 3.38, "v": 18}]},
             "encoding": {"category": "city", "value": "v", "latitude": "lat", "longitude": "lon"},
             "chartStyle": {"mapExtent": "world", "showDataLabels": True}},
            {"id": _id("el", 10), "type": "chart", "name": "Size against growth", "semanticRole": "secondaryChart", "chartType": "scatter",
             "altText": "Size against growth for four teams",
             "transform": {"x": 1220, "y": 160, "width": 620, "height": 620, "rotation": 0},
             "data": {"type": "inline", "rows": [{"team": "A", "size": 4, "growth": 12}, {"team": "B", "size": 9, "growth": 7},
                                                  {"team": "C", "size": 14, "growth": 18}, {"team": "D", "size": 21, "growth": 10}]},
             "encoding": {"category": "team", "x": "size", "value": "growth"}},
        ],
    }
    diagram = {
        **base,
        "id": _id("sld", 4),
        "name": "Diagram",
        "elements": [
            {"id": _id("el", 11), "type": "diagram", "name": "Stack", "semanticRole": "mainDiagram", "diagramType": "architecture",
             "altText": "The web app calls the API, which writes to the database.",
             "transform": {"x": 120, "y": 140, "width": 1680, "height": 800, "rotation": 0},
             "layoutHint": {"algorithm": "layered", "direction": "LR", "projection": "isometric"},
             "nodes": [{"id": _id("dn", 1), "label": "Web app"}, {"id": _id("dn", 2), "label": "API"}, {"id": _id("dn", 3), "label": "Database"}],
             "edges": [{"id": _id("de", 1), "from": _id("dn", 1), "to": _id("dn", 2)}, {"id": _id("de", 2), "from": _id("dn", 2), "to": _id("dn", 3)}]},
        ],
    }
    scripts = {
        **base,
        "id": _id("sld", 5),
        "name": "Scripts",
        "elements": [
            _text(12, HINDI, "headline", (120, 200, 1600, 200), size=88),
            _text(13, ARABIC, "subtitle", (120, 520, 1600, 200), size=72),
        ],
    }
    scripts["elements"][0]["typography"]["fontFamily"] = "Noto Sans Devanagari"
    scripts["elements"][1]["typography"]["fontFamily"] = "Noto Sans Arabic"
    scripts["elements"][1]["direction"] = "rtl"
    document["slides"] = [layers, picture, data, diagram, scripts]
    for key in ("locales",):
        document.pop(key, None)
    return document


def assets() -> list[dict]:
    """The bytes the exporter is handed, as the API hands them."""
    def entry(asset_id: str, key: str, mime: str, data: bytes) -> dict:
        return {"assetId": asset_id, "storageKey": key, "mimeType": mime, "data": base64.b64encode(data).decode("ascii")}

    return [
        entry(PHOTO, "w/photo.png", "image/png", png(64, 40, (40, 120, 200))),
        entry(CUTOUT, "w/cutout.png", "image/png", png(40, 60, (220, 40, 60), alpha=True)),
        # A transparent PNG recorded as a JPEG: a deliberate broken case.
        entry(MISTYPED, "w/badge.jpg", "image/jpeg", png(40, 40, (30, 160, 90), alpha=True)),
    ]
