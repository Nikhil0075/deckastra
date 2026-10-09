"""The built-in agent's written change, made safe to propose.

`nodes/author.py` writes patch operations the way an external agent does over
MCP. This module is the part of that arrangement that has to live beside the
database and the schema, which an agent must not import:

- **what the agent can see**: the pictures the deck's workspace holds, so "add
  images" can mean something without the agent ever handling bytes;
- **what its answer becomes**: real ids for its placeholders, parsed values,
  and a manifest entry for every picture it placed;
- **whether the answer is any good**: applied to a copy and validated against
  the schema, with the refusal handed back to the agent to repair. A patch
  that does not apply, or leaves a document the renderer would refuse, never
  becomes a proposal a person is asked to judge.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db.models import Asset, Presentation, Project
from .ids import new_id
from .patch import PatchError, apply_patch
from .schema import validate_document
from deckastra_agents.validation import load_json

#: How many attempts the agent gets: the first, and two repairs. A patch that
#: is still wrong after being told exactly why twice is not converging.
MAX_ATTEMPTS = 3
#: Enough to choose from without spending the request's context on a library.
MAX_IMAGES = 40

_PLACEHOLDER = re.compile(r"\b([a-z]{2,4})_new([A-Za-z0-9]*)\b")


def workspace_images(session: Session, presentation_id: str) -> list[dict[str, Any]]:
    """Pictures in the deck's own workspace, newest first. Never another workspace's."""
    presentation = session.get(Presentation, presentation_id)
    if presentation is None:
        return []
    project = session.get(Project, presentation.project_id)
    if project is None:
        return []
    rows = session.scalars(
        select(Asset)
        .where(
            Asset.workspace_id == project.workspace_id,
            Asset.deleted_at.is_(None),
            Asset.kind == "image",
        )
        .order_by(Asset.created_at.desc())
        .limit(MAX_IMAGES)
    ).all()
    return [
        {
            "id": row.id,
            "filename": row.filename,
            "width": row.width,
            "height": row.height,
            "content_type": row.content_type,
            "bytes": row.bytes,
            "storage_key": row.storage_key,
        }
        for row in rows
    ]


def materialise(
    written: list[dict[str, Any]],
    document: dict[str, Any],
    images: list[dict[str, Any]],
    mint: Callable[[str], str] = new_id,
) -> list[dict[str, Any]]:
    """The agent's operations as the applier takes them.

    Placeholders become real ids — the same placeholder the same id everywhere
    it appears, so an element added in one operation can be addressed by the
    next. Values arrive as JSON text and are parsed here; a value that does not
    parse is an error the agent is told about, not something to guess at.
    Every workspace picture the result cites gets its manifest entry, because an
    image element without one is a picture nothing can resolve.
    """
    minted: dict[str, str] = {}

    def real(text: str) -> str:
        def swap(match: re.Match[str]) -> str:
            key = match.group(0)
            if key not in minted:
                minted[key] = mint(match.group(1))
            return minted[key]

        return _PLACEHOLDER.sub(swap, text)

    operations: list[dict[str, Any]] = []
    for index, raw in enumerate(written):
        op = raw.get("op")
        operation: dict[str, Any] = {"op": op, "path": real(str(raw.get("path") or ""))}
        if op in ("add", "replace"):
            text = str(raw.get("value_json") or "")
            try:
                operation["value"] = load_json(real(text))
            except ValueError as error:
                raise ValueError(f"operation {index + 1}: value_json is not valid JSON.") from error
        if op == "move":
            operation["from"] = real(str(raw.get("from_path") or ""))
        operations.append(operation)

    operations.extend(_manifest_entries(operations, document, images))
    _stamp_translations(operations, document)
    return operations


def _stamp_translations(operations: list[dict[str, Any]], document: dict[str, Any]) -> None:
    """Give each translation entry the fingerprint of the words it translates.

    A model cannot compute the hash (integration plan 01 §3.1), and one it made
    up would mark a fresh translation outdated or an outdated one current. So
    whatever it wrote is replaced with the hash of the slot's source text, read
    from the deck as it stands — the same thing the editor does for a typed one.
    """
    from . import locales

    def stamp(slot_path: str, entry: Any) -> None:
        if not isinstance(entry, dict):
            return
        source = None
        for slot in locales.locale_slots(document):
            if slot.path == slot_path:
                source = slot.value
                break
        entry["sourceHash"] = locales.text_hash(source)
        entry.setdefault("origin", "agent:editor")

    for operation in operations:
        if operation.get("op") not in ("add", "replace"):
            continue
        segments = [part.replace("~1", "/").replace("~0", "~") for part in str(operation.get("path", "")).split("/")[1:]]
        value = operation.get("value")
        if not segments or segments[0] != "locales":
            continue
        if len(segments) == 4 and segments[2] == "entries":
            stamp(segments[3], value)
        elif len(segments) == 3 and segments[2] == "entries" and isinstance(value, dict):
            for path, entry in value.items():
                stamp(path, entry)
        elif len(segments) == 2 and isinstance(value, dict):
            for path, entry in (value.get("entries") or {}).items():
                stamp(path, entry)
        elif len(segments) == 1 and isinstance(value, dict):
            for overlay in value.values():
                for path, entry in ((overlay or {}).get("entries") or {}).items():
                    stamp(path, entry)


def _manifest_entries(
    operations: list[dict[str, Any]], document: dict[str, Any], images: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    by_id = {image["id"]: image for image in images}
    known = {asset.get("id") for asset in document.get("assets") or []}
    cited: list[str] = []
    for operation in operations:
        for asset_id in _asset_ids(operation.get("value")):
            if asset_id in by_id and asset_id not in known and asset_id not in cited:
                cited.append(asset_id)
    if not cited:
        return []

    entries = [_entry(by_id[asset_id]) for asset_id in cited]
    if "assets" not in document:
        return [{"op": "add", "path": "/assets", "value": entries}]
    return [{"op": "add", "path": "/assets/-", "value": entry} for entry in entries]


def _entry(image: dict[str, Any]) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": image["id"],
        "type": "image",
        "storageKey": image["storage_key"],
        "mimeType": image.get("content_type") or "image/png",
        "byteSize": image.get("bytes") or 0,
    }
    if image.get("filename"):
        entry["fileName"] = image["filename"]
    if image.get("width"):
        entry["width"] = image["width"]
    if image.get("height"):
        entry["height"] = image["height"]
    return entry


def _asset_ids(value: Any) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        # A video's poster is a first-class asset reference too.  Treating only
        # the moving clip as referenced made scoped video proposals reject their
        # own poster manifest entry and could under-count poster usage.
        for key in ("assetId", "posterAssetId"):
            asset_id = value.get(key)
            if isinstance(asset_id, str):
                found.append(asset_id)
        for child in value.values():
            found.extend(_asset_ids(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_asset_ids(child))
    return found


def check(document: dict[str, Any], operations: list[dict[str, Any]]) -> list[str]:
    """Why these operations cannot be proposed, or nothing when they can."""
    if not operations:
        return ["No operations were written."]
    try:
        candidate, _ = apply_patch(document, operations)
    except PatchError as error:
        where = getattr(error, "operation_index", None)
        prefix = f"operation {where + 1}: " if isinstance(where, int) else ""
        return [f"{prefix}{error}"]
    except (KeyError, TypeError, ValueError, IndexError) as error:
        return [f"The patch could not be applied: {error}"]
    return validate_document(candidate)
