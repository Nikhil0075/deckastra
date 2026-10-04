"""Bounded asset reads and reversible metadata edits. No caller-supplied paths."""
from __future__ import annotations
import base64
import hashlib
import io
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from PIL import Image, ImageOps, UnidentifiedImageError
from . import assets, object_storage
from .auth import Principal, Role, role_in_workspace, current_principal, resolve_workspace_access
from .db.models import Asset
from .db.session import get_session
from .assistant_models import AssetMetadataChange
from .ids import new_id

router = APIRouter(prefix="/v1")


def asset_access(session, principal, asset_id, require=Role.VIEWER):
    if require >= Role.EDITOR and "write" not in principal.scopes:
        raise HTTPException(403, "Asset metadata edits require write scope.")
    asset = session.get(Asset, asset_id)
    if asset is None or asset.deleted_at is not None:
        raise HTTPException(404, "No such asset.")
    role = role_in_workspace(session, principal.user_id, asset.workspace_id)
    if role is None or role < require:
        raise HTTPException(404, "No such asset.")
    return asset


def fingerprints(data: bytes, content_type: str) -> tuple[str, str | None]:
    digest = hashlib.sha256(data).hexdigest()
    if not content_type.startswith("image/"):
        return digest, None
    try:
        with Image.open(io.BytesIO(data)) as original:
            image = ImageOps.exif_transpose(original).convert("L").resize((9, 8))
            pixels = image.tobytes()
            bits = sum((pixels[y * 9 + x] > pixels[y * 9 + x + 1]) << (y * 8 + x) for y in range(8) for x in range(8))
            return digest, f"{bits:016x}"
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        return digest, None


def describe(asset):
    return {**assets.describe(asset), "tags": asset.tags or [], "description": asset.description,
            "sha256": asset.sha256, "dhash64": asset.dhash64, "metadata_version": asset.metadata_version}


def selected(session, principal, workspace_id, role=Role.VIEWER):
    if workspace_id:
        actual = role_in_workspace(session, principal.user_id, workspace_id)
        if actual is None or actual < role:
            raise HTTPException(404, "No such workspace.")
        return workspace_id
    return resolve_workspace_access(session, user_id=principal.user_id, require=role).workspace_id


@router.get("/assets")
def asset_list(workspace_id: str | None = None, filter: Literal["all", "unused", "untagged"] = "all", cursor: str | None = None, q: str = Query("", max_length=200), limit: int = Query(50, ge=1, le=100), principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    workspace_id = selected(session, principal, workspace_id)
    if filter == "unused":
        assets.recount_references(session, workspace_id)
    query = select(Asset).where(Asset.workspace_id == workspace_id, Asset.deleted_at.is_(None))
    if cursor:
        query = query.where(Asset.id > cursor)
    if filter == "unused":
        query = query.where(Asset.reference_count == 0)
    if filter == "untagged":
        query = query.where((Asset.tags.is_(None)) | (Asset.tags == []))
    if q:
        query = query.where(Asset.filename.contains(q, autoescape=True) | Asset.description.contains(q, autoescape=True))
    rows = session.scalars(query.order_by(Asset.id).limit(limit + 1)).all()
    return {"assets": [describe(row) for row in rows[:limit]], "next_cursor": rows[limit - 1].id if len(rows) > limit else None, "untrusted_fields": ["filename", "tags", "description"]}


@router.get("/assets/duplicates")
def asset_duplicates(workspace_id: str | None = None, cursor: str | None = None, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    workspace_id = selected(session, principal, workspace_id)
    query = select(Asset).where(Asset.workspace_id == workspace_id, Asset.deleted_at.is_(None))
    if cursor:
        query = query.where(Asset.id > cursor)
    rows = session.scalars(query.order_by(Asset.id).limit(501)).all()
    pairs = []
    for i, left in enumerate(rows[:500]):
        for right in rows[i + 1:500]:
            exact = bool(left.sha256 and left.sha256 == right.sha256)
            distance = (int(left.dhash64, 16) ^ int(right.dhash64, 16)).bit_count() if left.dhash64 and right.dhash64 else None
            if exact or (distance is not None and distance <= 6):
                pairs.append({"asset_ids": [left.id, right.id], "kind": "exact" if exact else "candidate", "distance": distance})
            if len(pairs) == 100:
                break
        if len(pairs) == 100:
            break
    return {"groups": pairs, "next_cursor": rows[499].id if len(rows) > 500 else None, "partial": len(rows) > 500 or len(pairs) == 100}


@router.get("/assets/{asset_id}/view")
def asset_view(asset_id: str, max_px: int = Query(512, ge=64, le=1024), x: int | None = Query(None, ge=0), y: int | None = Query(None, ge=0), width: int | None = Query(None, ge=1, le=32768), height: int | None = Query(None, ge=1, le=32768), principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    asset = asset_access(session, principal, asset_id)
    if not (asset.content_type or "").startswith("image/"):
        raise HTTPException(422, "This asset is not an image.")
    try:
        data, _ = object_storage.read(asset.storage_key)
        with Image.open(io.BytesIO(data)) as original:
            image = ImageOps.exif_transpose(original).convert("RGBA")
            coordinates = (x, y, width, height)
            # Direct internal calls use no crop; FastAPI supplies parsed query values.
            if any(isinstance(v, int) for v in coordinates):
                if not all(isinstance(v, int) for v in coordinates) or x + width > image.width or y + height > image.height:
                    raise HTTPException(422, "The crop must be a complete rectangle inside the image.")
                image = image.crop((x, y, x + width, y + height))
            image.thumbnail((max_px, max_px))
            output = io.BytesIO()
            image.save(output, "PNG")
    except (object_storage.ObjectStorageError, OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise HTTPException(422, "The image could not be decoded.") from exc
    return {"asset_id": asset.id, "mime_type": "image/png", "base64": base64.b64encode(output.getvalue()).decode(), "width": image.width, "height": image.height}


class MetadataUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_metadata_version: int = Field(ge=0)
    filename: str | None = Field(default=None, min_length=1, max_length=255)
    tags: list[str] | None = Field(default=None, max_length=30)
    description: str | None = Field(default=None, max_length=500)


def update_metadata(session, principal, asset, request):
    changes = request.model_dump(exclude_unset=True, exclude={"expected_metadata_version"})
    if "tags" in changes and (changes["tags"] is None or any(not tag.strip() or len(tag) > 50 for tag in changes["tags"])):
        raise HTTPException(422, "Use at most 30 nonempty tags of up to 50 characters.")
    if "filename" in changes and changes["filename"] is None:
        raise HTTPException(422, "Filename cannot be null.")
    before = {k: getattr(asset, k) for k in ("filename", "tags", "description")}
    before["tags"] = before["tags"] or []
    result = session.execute(update(Asset).where(Asset.id == asset.id, Asset.metadata_version == request.expected_metadata_version).values(**changes, metadata_version=Asset.metadata_version + 1))
    if result.rowcount != 1:
        raise HTTPException(409, "Asset metadata changed. Read it again.")
    session.refresh(asset)
    change = AssetMetadataChange(id=new_id("amc"), asset_id=asset.id, created_by=principal.user_id, before_json=before, after_json={k: getattr(asset, k) for k in before}, result_version=asset.metadata_version)
    session.add(change)
    session.flush()
    return {**describe(asset), "change_id": change.id}


@router.patch("/assets/{asset_id}")
def asset_update(asset_id: str, request: MetadataUpdate, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    return update_metadata(session, principal, asset_access(session, principal, asset_id, Role.EDITOR), request)


@router.post("/assets/{asset_id}/changes/{change_id}/revert")
def asset_revert(asset_id: str, change_id: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    asset = asset_access(session, principal, asset_id, Role.EDITOR)
    change = session.get(AssetMetadataChange, change_id)
    if change is None or change.asset_id != asset_id:
        raise HTTPException(404, "No such metadata change.")
    if change.reverted or asset.metadata_version != change.result_version:
        raise HTTPException(409, "Newer metadata exists; this change cannot be reverted.")
    result = update_metadata(session, principal, asset, MetadataUpdate(expected_metadata_version=change.result_version, **change.before_json))
    change.reverted = True
    return result
