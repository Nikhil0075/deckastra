"""Every picture a change cites resolves, or the change is refused (release 8, 2026-10-17).

An element names a file by `assetId`; the bytes are found through the
document's asset manifest (`document.assets`), whose `storageKey` the
renderers, exporters and the asset recount all read. The editor's insert and
the media tools write both in one patch. An agent writing operations by hand
could write only the element, and the picture then drew as a labelled gap
everywhere: the canvas, previews, both presentation screens and exports.

`create_proposal` runs this on every agent change, low-risk or not, before
anything is stored. Only references a change *introduces* are checked: a deck
that already cites something missing (an import, an old build) can still take
unrelated changes. Each message names the file and the slide and says how to
fix it, because the reader is usually an agent that will try again.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from .db.models import Asset

_REFERENCE_KEYS = ("assetId", "posterAssetId")


def _citations(value: Any, where: str | None, found: dict[str, str | None]) -> None:
    """Asset ids cited by elements, with the slide each first appears on."""
    if isinstance(value, dict):
        for key in _REFERENCE_KEYS:
            asset_id = value.get(key)
            if isinstance(asset_id, str):
                found.setdefault(asset_id, where)
        for child in value.values():
            _citations(child, where, found)
    elif isinstance(value, list):
        for child in value:
            _citations(child, where, found)


def cited(document: dict[str, Any]) -> dict[str, str | None]:
    """asset id -> the first slide citing it (None for deck-level uses: theme, logo)."""
    found: dict[str, str | None] = {}
    for slide in document.get("slides") or []:
        if isinstance(slide, dict):
            _citations(slide, str(slide.get("id") or "") or None, found)
    rest = {key: value for key, value in document.items() if key not in ("slides", "assets")}
    _citations(rest, None, found)
    return found


def problems(session: Session, workspace_id: str, before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """Why the media in `after` would not resolve, for what this change introduced."""
    old_manifest = {entry.get("id"): entry for entry in before.get("assets") or [] if isinstance(entry, dict)}
    manifest = {entry.get("id"): entry for entry in after.get("assets") or [] if isinstance(entry, dict)}
    slides = [slide.get("id") for slide in after.get("slides") or [] if isinstance(slide, dict)]

    def place(slide_id: str | None) -> str:
        if slide_id and slide_id in slides:
            return f"slide {slides.index(slide_id) + 1}"
        return "the deck"

    found: list[str] = []
    # A manifest entry this change added or altered must be a real file of
    # this workspace, at the path the registry holds: an entry is a pointer
    # into storage, and a hand-written one could point anywhere.
    for asset_id, entry in manifest.items():
        if old_manifest.get(asset_id) == entry:
            continue
        row = session.get(Asset, asset_id) if isinstance(asset_id, str) else None
        if row is None or row.deleted_at is not None or row.workspace_id != workspace_id:
            found.append(f"The asset list names {asset_id}, which is not a file in this workspace's Media.")
        elif entry.get("storageKey") != row.storage_key:
            found.append(f"The asset list entry for {asset_id} has a storage key that does not match the file. Use media_place to cite it.")
    before_cited = cited(before)
    for asset_id, slide_id in cited(after).items():
        if asset_id in before_cited:
            continue
        if asset_id not in manifest:
            found.append(
                f"{place(slide_id).capitalize()} cites {asset_id}, which is not in the deck's asset list, so it would draw as a gap. "
                "Place media with the media_place tool, or add its asset entry in the same change."
            )
            continue
        row = session.get(Asset, asset_id)
        if row is None or row.deleted_at is not None or row.workspace_id != workspace_id:
            found.append(f"{place(slide_id).capitalize()} cites {asset_id}, which is not a file in this workspace's Media.")
    return found
