"""Pictures that ship with reviewed templates (UI audit 2026-10-10, unit 7b).

Several design languages draw a frame for a photograph: Cinema Noir's image
frame, Quiet Luxe's portrait, Earth Story's arch, Spatial Future's hologram,
Play Lab's picture blob. A template can bring the picture that goes in it.

**The manifest is the only list** (`packages/deck-presets/media/MANIFEST.json`).
Each entry names its file, the template and role it belongs to, and the evidence
that it may ship: how it was made, its exact prompt, digests of the source and
the shipped file, its size, alt text, a person's review, and the licence terms
it was made under. An empty manifest is a valid one: every frame then stays an
empty frame, exactly as before this module.

**Composition stays pure.** `attach` runs after the composer, finds the frames
the language drew and puts an image element on each, with the document's asset
entry beside it. The storage key is `preset-media/<file>`, which nothing stores:

- a template *preview* reads the bytes through `GET /v1/presets/media/{file}`,
  because a preview stores nothing;
- a deck *made* from a template gets the bytes copied into its workspace as
  ordinary assets (`adopt`), so exports, backups, the sweeper and sync treat a
  template's pictures exactly like an upload, and a deck never depends on the
  build that made it still shipping the file.

**The budget is checked, not hoped for** (`problems`): at most 30 files, each a
JPEG of at most 400 KB and 1920px on its long edge, 12 MB in all, with a
licence that permits commercial use. JPEG and not WebP because PowerPoint will
not open WebP, and the PPTX exporter refuses it rather than embed a broken
picture.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .ids import new_id
from .paths import resource_root

KEY_PREFIX = "preset-media/"
MAX_FILES = 30
MAX_FILE_BYTES = 400 * 1024
MAX_TOTAL_BYTES = 12 * 1024 * 1024
MAX_LONG_EDGE = 1920
FILE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}\.jpg$")
ROLES = ("hero", "scene")

#: The frames a language draws for a photograph, by element name.
FRAME_NAMES = {"Image frame", "Portrait frame", "Arch frame", "Hologram frame", "Picture blob"}


class PresetMediaError(ValueError):
    """A template picture that cannot be served or adopted."""


def media_dir() -> Path:
    """Where the pictures are. A test or a build may point elsewhere."""
    override = os.environ.get("DECKASTRA_PRESET_MEDIA_DIR")
    if override:
        return Path(override)
    return resource_root() / "packages" / "deck-presets" / "media"


@lru_cache(maxsize=4)
def _load(directory: str) -> dict[str, Any]:
    path = Path(directory) / "MANIFEST.json"
    if not path.exists():
        return {"version": 1, "media": []}
    return json.loads(path.read_text(encoding="utf-8"))


def manifest() -> dict[str, Any]:
    return _load(str(media_dir()))


def entries() -> list[dict[str, Any]]:
    return list(manifest().get("media") or [])


def for_template(template_id: str) -> dict[str, dict[str, Any]]:
    """The pictures a template brings, by role."""
    out: dict[str, dict[str, Any]] = {}
    for entry in entries():
        for use in entry.get("templates") or []:
            if use.get("template") == template_id and use.get("role") in ROLES:
                out[use["role"]] = entry
    return out


def read(file_name: str) -> bytes:
    """A shipped picture's bytes, by file name only: never a path."""
    if not FILE_NAME.match(file_name) or not any(entry.get("file") == file_name for entry in entries()):
        raise PresetMediaError("No such template picture.")
    return (media_dir() / file_name).read_bytes()


# ------------------------------------------------------------------ composition


def _is_title_slide(slide: dict[str, Any]) -> bool:
    template = str((slide.get("layout") or {}).get("templateId") or "")
    return template.endswith(".title") or template.endswith(".section") or template.endswith(".closing") or template.endswith(".thank-you")


def attach(document: dict[str, Any], template_id: str) -> dict[str, Any]:
    """Put the template's pictures in the frames its language drew. Returns the document."""
    chosen = for_template(template_id)
    if not chosen:
        return document
    assets: dict[str, dict[str, Any]] = {}
    for slide in document.get("slides") or []:
        role = "hero" if _is_title_slide(slide) else "scene"
        entry = chosen.get(role) or chosen.get("scene") or chosen.get("hero")
        if entry is None:
            continue
        elements = slide.get("elements") or []
        placed: list[tuple[int, dict[str, Any]]] = []
        for index, element in enumerate(elements):
            if element.get("type") != "shape" or element.get("name") not in FRAME_NAMES:
                continue
            asset = assets.get(entry["file"])
            if asset is None:
                asset = assets[entry["file"]] = _asset_entry(entry)
            placed.append((index + 1, _picture(element, asset, entry)))
        # Each picture directly above its frame, so the frame stays its backing.
        for offset, (at, picture) in enumerate(placed):
            elements.insert(at + offset, picture)
    if assets:
        document.setdefault("assets", []).extend(assets.values())
    return document


def _asset_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": new_id("ast"),
        "type": "image",
        "storageKey": KEY_PREFIX + entry["file"],
        "fileName": entry["file"],
        "mimeType": "image/jpeg",
        "byteSize": int(entry["bytes"]),
        "width": int(entry["width"]),
        "height": int(entry["height"]),
    }


def _picture(frame: dict[str, Any], asset: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    box = dict(frame["transform"])
    radius = (frame.get("style") or {}).get("cornerRadius") or 0
    if frame.get("shape") == "pill":
        # An arch: rounded as far as the shorter side allows, like the pill it fills.
        radius = min(box["width"], box["height"]) / 2
    return {
        "id": new_id("el"),
        "type": "image",
        "name": "Template picture",
        "semanticRole": "supportingVisual",
        "assetId": asset["id"],
        "altText": str(entry.get("alt") or ""),
        "fit": "cover",
        "transform": box,
        "style": {"cornerRadius": radius},
    }


# ------------------------------------------------------------------ adoption


@dataclass
class Adopted:
    asset_ids: dict[str, str]


def adopt(session, document: dict[str, Any], *, workspace_id: str, created_by: str) -> Adopted:
    """Copy a composed template's pictures into the workspace, and point the deck at them.

    Each `preset-media/` asset becomes an ordinary workspace asset: the bytes are
    stored under the workspace's own key and registered, which charges the
    storage quota exactly as an upload would. The document's asset entries and
    every element citing them are rewritten in place to the new ids and keys.
    """
    from . import assets as asset_service
    from . import object_storage

    renamed: dict[str, str] = {}
    for asset in document.get("assets") or []:
        key = str(asset.get("storageKey") or "")
        if not key.startswith(KEY_PREFIX):
            continue
        file_name = key[len(KEY_PREFIX):]
        data = read(file_name)
        digest = hashlib.sha256(data).hexdigest()[:16]
        stored_key = f"workspaces/{workspace_id}/assets/template-{digest}-{new_id('blob')[-10:].lower()}.jpg"
        object_storage.put(stored_key, data, "image/jpeg")
        row = asset_service.register(
            session,
            workspace_id=workspace_id,
            created_by=created_by,
            storage_key=stored_key,
            filename=file_name,
            content_type="image/jpeg",
            size_bytes=len(data),
            width=asset.get("width"),
            height=asset.get("height"),
        )
        renamed[asset["id"]] = row.id
        asset["id"] = row.id
        asset["storageKey"] = stored_key
    if renamed:
        _rewrite(document.get("slides") or [], renamed)
    return Adopted(asset_ids=renamed)


def drop(document: dict[str, Any]) -> int:
    """Take a template's pictures back out, leaving its frames as frames.

    For when they cannot be stored (no object store, a full quota): a deck
    without its pictures is still the deck the person asked for, and refusing
    the whole deck to save a photograph would lose it. Returns how many were
    removed, so the caller can say so.
    """
    ids = {
        asset["id"] for asset in document.get("assets") or []
        if str(asset.get("storageKey") or "").startswith(KEY_PREFIX)
    }
    if not ids:
        return 0
    document["assets"] = [asset for asset in document.get("assets") or [] if asset["id"] not in ids]
    removed = 0
    for slide in document.get("slides") or []:
        before = len(slide.get("elements") or [])
        slide["elements"] = [element for element in slide.get("elements") or [] if element.get("assetId") not in ids]
        removed += before - len(slide["elements"])
    return removed


def _rewrite(nodes: Any, renamed: dict[str, str]) -> None:
    if isinstance(nodes, list):
        for node in nodes:
            _rewrite(node, renamed)
    elif isinstance(nodes, dict):
        if nodes.get("assetId") in renamed:
            nodes["assetId"] = renamed[nodes["assetId"]]
        for value in nodes.values():
            if isinstance(value, (list, dict)):
                _rewrite(value, renamed)


# ------------------------------------------------------------------ the budget


COMMERCIAL_PLANS = {"Plus", "Pro", "Wonder", "Enterprise"}
#: What a picture may be used for. `demo` is non-commercial use, which OpenArt's
#: terms allow on every plan; `commercial` needs a plan that grants it.
USES = ("demo", "commercial")


def demo_only(directory: Path | None = None) -> list[str]:
    """The pictures that may be shown in a demo and may not ship in a release."""
    data = _load(str(directory or media_dir()))
    return [
        str(entry.get("file"))
        for entry in data.get("media") or []
        if (entry.get("license") or {}).get("use") != "commercial"
    ]


def problems(directory: Path | None = None, *, release: bool = False) -> list[str]:
    """Everything wrong with the pictures, as sentences. Empty is usable.

    `release=True` is the bar for a build that will be sold: every picture must
    have been made under terms that allow commercial use. Without it, pictures
    marked for demo use are accepted, because a demo is non-commercial use.
    """
    directory = directory or media_dir()
    data = _load(str(directory))
    media = list(data.get("media") or [])
    out: list[str] = []
    if len(media) > MAX_FILES:
        out.append(f"{len(media)} template pictures; the budget is {MAX_FILES}.")
    total = 0
    seen: set[str] = set()
    for entry in media:
        name = str(entry.get("file") or "")
        label = name or "(no file)"
        if not FILE_NAME.match(name):
            out.append(f"{label}: file names are lower-case words and hyphens ending .jpg.")
            continue
        if name in seen:
            out.append(f"{label} is listed twice.")
        seen.add(name)
        path = directory / name
        if not path.exists():
            out.append(f"{label} is in the manifest and not on disk.")
            continue
        raw = path.read_bytes()
        total += len(raw)
        if len(raw) > MAX_FILE_BYTES:
            out.append(f"{label} is {len(raw) // 1024} KB; each picture may be {MAX_FILE_BYTES // 1024} KB.")
        if hashlib.sha256(raw).hexdigest() != entry.get("sha256"):
            out.append(f"{label} does not match its recorded sha256: the file changed after review.")
        if int(entry.get("bytes") or -1) != len(raw):
            out.append(f"{label}: recorded size {entry.get('bytes')} is not the file's {len(raw)}.")
        if not raw.startswith(b"\xff\xd8"):
            out.append(f"{label} is not a JPEG.")
        if max(int(entry.get("width") or 0), int(entry.get("height") or 0)) > MAX_LONG_EDGE:
            out.append(f"{label} is larger than {MAX_LONG_EDGE}px on its long edge.")
        for field in ("model", "generatedAt", "prompt", "sourceSha256", "alt"):
            if not entry.get(field):
                out.append(f"{label} has no {field}: provenance is incomplete.")
        review = entry.get("review") or {}
        if review.get("result") != "approved" or not review.get("reviewer") or not review.get("date"):
            out.append(f"{label} has no recorded approval by a named reviewer.")
        licence = entry.get("license") or {}
        use = licence.get("use")
        if use not in USES:
            out.append(f"{label} does not say whether it is for demo or commercial use.")
        elif use == "commercial" and (licence.get("commercialUse") is not True or licence.get("plan") not in COMMERCIAL_PLANS):
            out.append(f"{label} is marked for commercial use but was not made under terms that allow it (plan {licence.get('plan')!r}).")
        elif release and use != "commercial":
            out.append(f"{label} was made for demo use (plan {licence.get('plan')!r}) and may not ship in a release.")
        if release and review.get("by") != "person":
            # An agent's look is recorded honestly as one; selling a picture
            # needs a person to have looked at it.
            out.append(f"{label} has not been reviewed by a person, which a release needs.")
        if not licence.get("termsUrl") or not licence.get("termsRetrievedAt") or not licence.get("termsSha256"):
            out.append(f"{label} does not record the terms it was made under.")
        uses = entry.get("templates") or []
        if not uses or any(use.get("role") not in ROLES or not use.get("template") for use in uses):
            out.append(f"{label} names no template and role (hero or scene).")
    if total > MAX_TOTAL_BYTES:
        out.append(f"Template pictures total {total // 1024} KB; the budget is {MAX_TOTAL_BYTES // 1024} KB.")
    return out
