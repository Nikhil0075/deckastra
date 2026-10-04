"""Scoped upload and durable import. Agent grants never admit external files."""
import base64
import copy
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import or_, select, func
from sqlalchemy.orm import Session

from . import assets, deck_copy, object_storage, quotas, store, local_mode
from .auth import Principal, Role, current_principal, resolve_project_access, resolve_presentation_access
from .db.models import Asset, Presentation
from .db.session import get_session, session_scope, supports_row_locks
from .ids import new_id
from .import_models import ImportJob, PackageExtras
from .mydeck import MIME, MAX_TOTAL, PackageError, read_package

router = APIRouter(prefix="/v1")


def human(principal):
    if principal.scopes != local_mode.FULL_SCOPES:
        raise HTTPException(403, "An agent grant cannot import external deck files.")


class Begin(BaseModel):
    size_bytes: int = Field(gt=0, le=MAX_TOTAL)
    import_as_copy: bool = Field(default=False, alias="copy")


@router.post("/projects/{project_id}/imports", status_code=201)
def begin(project_id: str, request: Begin, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    human(principal)
    if request.size_bytes > int(os.environ.get("DECKASTRA_PACKAGE_MAX_BYTES", str(128 * 1024 ** 2))):
        raise HTTPException(413, "This installation supports deck packages up to 128MB.")
    project, _ = resolve_project_access(session, user_id=principal.user_id, project_id=project_id, require=Role.EDITOR)
    pending = session.scalar(select(func.count()).select_from(ImportJob).where(ImportJob.created_by == principal.user_id,
        ImportJob.status.in_(["uploading", "queued", "running"])))
    if pending >= 3: raise HTTPException(429, "Finish your pending file imports before uploading another.")
    identifier = new_id("imp")
    key = f"workspaces/{project.workspace_id}/imports/{identifier}/source"
    row = ImportJob(id=identifier, project_id=project_id, created_by=principal.user_id, storage_key=key,
        expected_bytes=request.size_bytes, status="uploading", copy=request.import_as_copy, created_at=datetime.now(timezone.utc))
    session.add(row)
    session.flush()
    url = object_storage.presigned_put(key, MIME)
    # Local imports use their own bounded route, rather than the 100MB asset route.
    if object_storage.local_root() is not None: url = f"/v1/imports/{identifier}/blob"
    return {"id": identifier, "upload_url": url, "method": "PUT", "headers": {"Content-Type": MIME}, "status": row.status}


def owned(session, identifier, principal):
    human(principal)
    row = session.get(ImportJob, identifier)
    if row is None or row.created_by != principal.user_id: raise HTTPException(404, "No such import.")
    resolve_project_access(session, user_id=principal.user_id, project_id=row.project_id, require=Role.EDITOR)
    return row


@router.put("/imports/{identifier}/blob")
async def put_blob(identifier: str, request: Request, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    if object_storage.local_root() is None: raise HTTPException(404, "Not found.")
    row = owned(session, identifier, principal)
    if row.status != "uploading": raise HTTPException(409, "This upload has already completed.")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > row.expected_bytes: raise HTTPException(413, "Upload exceeds its declared size.")
        data.extend(chunk)
    if len(data) != row.expected_bytes: raise HTTPException(422, "Upload size does not match.")
    from starlette.concurrency import run_in_threadpool
    await run_in_threadpool(object_storage.put_local, row.storage_key, bytes(data), MIME)
    return {"bytes": len(data)}


@router.post("/imports/{identifier}/complete", status_code=202)
def complete(identifier: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    row = owned(session, identifier, principal)
    if row.status != "uploading": return describe(row)
    meta = object_storage.metadata(row.storage_key)
    if meta.bytes != row.expected_bytes or meta.content_type != MIME: raise HTTPException(422, "Upload metadata does not match.")
    row.status = "queued"
    return describe(row)


@router.get("/imports/{identifier}")
def status(identifier: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    return describe(owned(session, identifier, principal))


def describe(row):
    return {"id": row.id, "status": row.status, "presentation_id": row.presentation_id, "error": row.error, "warnings": row.warnings_json or []}


def process_one():
    now = datetime.now(timezone.utc)
    with session_scope() as session:
        abandoned = session.scalar(select(ImportJob).where(ImportJob.status == "uploading", ImportJob.created_at < now - timedelta(days=1)).limit(1))
        if abandoned:
            object_storage.delete(abandoned.storage_key)
            abandoned.status, abandoned.error = "failed", "The file upload expired. Upload it again."
        query = select(ImportJob).where(or_(ImportJob.status == "queued", (ImportJob.status == "running") & (ImportJob.lease_until < now))).order_by(ImportJob.created_at).limit(1)
        if supports_row_locks(session): query = query.with_for_update(skip_locked=True)
        row = session.scalar(query)
        if row is None: return False
        row.status, row.lease_until = "running", now + timedelta(minutes=10)
        identifier, key = row.id, row.storage_key
    created = []
    try:
        with session_scope() as session:
            row = session.get(ImportJob, identifier)
            project, _ = resolve_project_access(session, user_id=row.created_by, project_id=row.project_id, require=Role.EDITOR)
            meta = object_storage.metadata(key)
            if meta.bytes != row.expected_bytes or meta.bytes > MAX_TOTAL: raise PackageError("M003: Upload size changed.")
            package = read_package(object_storage.read(key)[0])
            from .export_service import _invoke_worker, ExportError
            from pathlib import Path
            try:
                report = _invoke_worker("check-package-document", package.document, Path("unused"), {}, timeout=60)
                row.warnings_json = report.get("warnings", [])[:100]
            except ExportError as error:
                raise PackageError("M009: " + str(error)) from error
            document = copy.deepcopy(package.document)
            existing = session.get(Presentation, document["id"])
            if existing is not None:
                visible = True
                try: resolve_presentation_access(session, user_id=row.created_by, presentation_id=existing.id)
                except HTTPException: visible = False
                if visible and not row.copy:
                    row.presentation_id, row.status = existing.id, "existing"
                    return True
                document, _ = deck_copy.duplicate_document(document, title=document["metadata"]["title"])
            remap, storage = {}, {}
            incoming = sum(len(package.files[spec["path"]]) for _, spec, _, _ in package.assets) + sum(map(len, package.extras.values()))
            quotas.recount_storage(session, project.workspace_id)
            quotas.check_storage(session, project.workspace_id, incoming)
            for old, spec, mime, kind in package.assets:
                target = f"workspaces/{project.workspace_id}/assets/{identifier}/{old}"
                payload = package.files[spec["path"]]
                created.append(target)
                object_storage.put(target, payload, mime)
                asset = assets.register(session, workspace_id=project.workspace_id, created_by=row.created_by, storage_key=target,
                    kind=kind, content_type=mime, size_bytes=len(payload), filename=old)
                remap[old], storage[old] = asset.id, target
            def rewrite(value):
                if isinstance(value, str): return remap.get(value, value)
                if isinstance(value, list): return [rewrite(v) for v in value]
                if isinstance(value, dict): return {remap.get(k, k): rewrite(v) for k, v in value.items()}
                return value
            for ref in document["assets"]:
                ref["storageKey"] = storage[ref["id"]]
            document = rewrite(document)
            result = store.create_presentation(session, project_id=project.id, document=document, created_by=row.created_by)
            extras = {}
            for path, payload in sorted(package.extras.items()):
                target = f"workspaces/{project.workspace_id}/assets/{identifier}/{new_id('obj')}"
                created.append(target)
                object_storage.put(target, payload, "application/octet-stream")
                asset = assets.register(session, workspace_id=project.workspace_id, created_by=row.created_by, storage_key=target,
                    kind="document", content_type="application/octet-stream", size_bytes=len(payload), filename=path)
                extras[path] = asset.id
            if extras: session.add(PackageExtras(presentation_id=result.presentation_id, assets_json=extras))
            row.presentation_id, row.status, row.lease_until = result.presentation_id, "completed", None
    except Exception as error:
        for target in created:
            try: object_storage.delete(target)
            except object_storage.ObjectStorageError: pass
        with session_scope() as session:
            row = session.get(ImportJob, identifier)
            if row:
                row.status, row.lease_until = "failed", None
                row.error = str(error)[:2000] if isinstance(error, (PackageError, assets.AssetError, quotas.QuotaExceeded)) else "Import could not complete. Upload and try again."
    finally:
        try: object_storage.delete(key)
        except object_storage.ObjectStorageError: pass
    return True
