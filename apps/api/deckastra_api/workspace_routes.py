"""Sharing, quotas, assets and themes — the launch surfaces (Phase 9).

Four small route groups in one module because they share the same shape: a
workspace-scoped resource, an authorisation check through the existing chain, and
a description the UI renders. Splitting them into four files would be four copies
of the same six lines of plumbing.

The one that is not like the others is `/v1/shared/{token}`. It is the only
endpoint in the product that takes a **bearer credential in a URL** rather than a
session, because that is what a share link is. What it returns is deliberately
narrow: the document and nothing else. No workspace, no project, no sibling
decks, no user list — a link to one deck is not a foothold in a workspace.
"""

from __future__ import annotations

import logging
import hashlib
import os
import time
from typing import Any, Literal

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import assets as asset_service
from . import local_mode
from . import object_storage, quotas, sharing, store, telemetry, themes
from .auth import (
    Principal,
    Role,
    current_principal,
    resolve_presentation_access,
    resolve_workspace_access,
    ensure_workspace_membership,
    membership_status,
)
from .db.models import (
    Asset,
    PresentationShare,
    Project,
    Theme,
    User,
    Workspace,
    WorkspaceMember,
)
from .db.session import get_session
from .ids import new_id
from .patch import PatchError, apply_patch
from .schema import validate_document

logger = logging.getLogger("deckastra.workspace")

router = APIRouter(prefix="/v1")


class NameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)

    @field_validator("name")
    @classmethod
    def name_is_not_whitespace(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Name cannot be blank.")
        return normalized


class CreateProjectRequest(NameRequest):
    description: str | None = Field(default=None, max_length=2000)


def _account_context(session: Session, principal: Principal) -> dict[str, Any]:
    user = session.get(User, principal.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Unknown user.")

    memberships = session.scalars(
        select(WorkspaceMember)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(WorkspaceMember.workspace_id)
    ).all()
    workspaces: list[dict[str, Any]] = []
    for membership in memberships:
        workspace = session.get(Workspace, membership.workspace_id)
        if workspace is None:
            continue

        # D5.4. What this membership actually grants right now, which for a
        # mirrored workspace is not the same as what the row says. A picker that
        # listed a lapsed workspace like any other would offer someone a door
        # that opens onto a 404, with nothing anywhere saying why.
        access = membership_status(session, user.id, workspace.id)

        projects = (
            session.scalars(
                select(Project)
                .where(Project.workspace_id == workspace.id)
                .order_by(Project.name, Project.id)
            ).all()
            if access.authorizes
            # Named but empty rather than hidden. The person knows this workspace
            # exists — it is on their machine — so removing it from the list
            # would look like data loss, and telling them nothing is worse than
            # telling them their access could not be confirmed.
            else []
        )
        workspaces.append(
            {
                "id": workspace.id,
                "name": workspace.name,
                "role": membership.role,
                "access": access.state,
                "confirmed_at": (
                    access.confirmed_at.isoformat() if access.confirmed_at else None
                ),
                # D5.1. A picker that cannot tell this machine's own workspace
                # from a mirrored one makes "move this deck to the company
                # workspace" a choice nobody can see they are making.
                "origin": workspace.origin,
                "projects": [
                    {
                        "id": project.id,
                        "name": project.name,
                        "description": project.description,
                    }
                    for project in projects
                ],
            }
        )
    return {
        "user": {"id": user.id, "email": user.email, "name": user.name},
        "workspaces": workspaces,
        # What this *deployment* can do, so a surface can be absent rather than
        # broken. Sharing is refused wholesale in local mode — a link this machine
        # mints leads nowhere — and the editor used to discover that by calling
        # the route and rendering the 404 as "Not found.", which reads as a bug in
        # a feature that was never available.
        #
        # Deployment-wide rather than per workspace, because that is what the
        # refusal keys on. A cloud server's own workspaces are `local` in the
        # D5.1 sense and share perfectly well, so deriving this from
        # `workspace.origin` would switch sharing off for every deck in the
        # product.
        "capabilities": {"sharing": not local_mode.enabled()},
    }


# ------------------------------------------------------ account/workspace journey


@router.get("/account")
def account_context(
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """The complete picker context; no implicit first-workspace ambiguity."""
    return _account_context(session, principal)


@router.post("/workspaces", status_code=201)
def create_workspace(
    request: NameRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    workspace = Workspace(
        id=new_id("wsp"), name=request.name, owner_id=principal.user_id
    )
    session.add(workspace)
    session.add(
        WorkspaceMember(
            id=new_id("mbr"),
            workspace_id=workspace.id,
            user_id=principal.user_id,
            role="owner",
        )
    )
    project = Project(
        id=new_id("prj"),
        workspace_id=workspace.id,
        name="My first project",
        created_by=principal.user_id,
    )
    session.add(project)
    session.flush()
    return {"workspace_id": workspace.id, "project_id": project.id}


@router.get("/workspaces/{workspace_id}/projects")
def list_projects(
    workspace_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    ensure_workspace_membership(
        session, user_id=principal.user_id, workspace_id=workspace_id
    )
    projects = session.scalars(
        select(Project)
        .where(Project.workspace_id == workspace_id)
        .order_by(Project.name, Project.id)
    ).all()
    return {
        "projects": [
            {"id": project.id, "name": project.name, "description": project.description}
            for project in projects
        ]
    }


@router.post("/workspaces/{workspace_id}/projects", status_code=201)
def create_project(
    workspace_id: str,
    request: CreateProjectRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    ensure_workspace_membership(
        session,
        user_id=principal.user_id,
        workspace_id=workspace_id,
        require=Role.EDITOR,
    )
    project = Project(
        id=new_id("prj"),
        workspace_id=workspace_id,
        name=request.name,
        description=request.description.strip() if request.description else None,
        created_by=principal.user_id,
    )
    session.add(project)
    session.flush()
    return {"id": project.id, "name": project.name, "description": project.description}


def _workspace_of(session: Session, user_id: str, require: Role = Role.VIEWER) -> str:
    """The caller's workspace, at the role this route needs.

    A thin wrapper on `resolve_workspace_access` so the role is visible at every
    call site. It used to return the first membership and check nothing, which
    let a viewer write a workspace-wide theme and run the asset sweeper.
    """
    return resolve_workspace_access(session, user_id=user_id, require=require).workspace_id


def _selected_workspace(
    session: Session, user_id: str, workspace_id: str | None, require: Role
) -> str:
    if workspace_id is None:
        return _workspace_of(session, user_id, require)
    ensure_workspace_membership(
        session, user_id=user_id, workspace_id=workspace_id, require=require
    )
    return workspace_id


# ------------------------------------------------------------------ sharing


class CreateShareRequest(BaseModel):
    # Viewer only: see `sharing.create_share`. Narrowed here as well so the
    # refusal is a 422 naming the field rather than a 400 from the service.
    role: Literal["viewer"] = "viewer"
    label: str | None = Field(default=None, max_length=255)
    expires_in_days: int | None = Field(default=None, ge=1, le=sharing.MAX_EXPIRY_DAYS)
    #: Pin the link to one version (D5.5). Omit it to follow the deck.
    #:
    #: The presenting case: a link handed to a room must keep showing what the
    #: presenter rehearsed, whoever edits the deck in the meantime.
    version_id: str | None = Field(default=None, max_length=64)


def _refuse_sharing_when_local() -> None:
    """Sharing needs a server the recipient can reach.

    A local install has no public address, so a link it minted would be a
    credential for a deck nobody else can open — and `/v1/shared/{token}` is the
    product's only unauthenticated read, which is not a surface to expose on a
    developer's machine for a feature that cannot work. Refused with the same 404
    every other unavailable resource gives.
    """
    if local_mode.enabled():
        raise HTTPException(status_code=404, detail="Not found.")


@router.post("/presentations/{presentation_id}/shares")
def create_share(
    presentation_id: str,
    request: CreateShareRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Mint a link.

    Editor, not viewer: giving other people access to a deck is a change to who
    can read it, and someone who can only look at it should not be able to widen
    that.
    """
    _refuse_sharing_when_local()
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )

    try:
        share, token = sharing.create_share(
            session,
            presentation_id=presentation_id,
            created_by=principal.user_id,
            role=request.role,
            label=request.label,
            expires_in_days=request.expires_in_days,
            version_id=request.version_id,
        )
    except sharing.ShareError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    # The only response that ever carries the plaintext.
    return sharing.describe(share, token=token)


@router.get("/presentations/{presentation_id}/shares")
def list_shares(
    presentation_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _refuse_sharing_when_local()
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )
    return {
        "shares": [
            sharing.describe(share)
            for share in sharing.list_for_presentation(session, presentation_id)
        ]
    }


@router.delete("/shares/{share_id}")
def revoke_share(
    share_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _refuse_sharing_when_local()
    share = session.get(PresentationShare, share_id)
    if share is None:
        raise HTTPException(status_code=404, detail="No such link.")

    # Authorised through the presentation, not the share's creator: a colleague
    # who can edit the deck should be able to close a link someone else opened.
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=share.presentation_id,
        require=Role.EDITOR,
    )

    return sharing.describe(sharing.revoke(session, share))


@router.get("/shared/{token}")
def open_shared(token: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Open a deck from a link. The only unauthenticated read in the product.

    Returns the document and the deck's own name, and nothing about the workspace
    it lives in. A link to one deck is not a foothold: no project, no sibling
    presentations, no members, no repository list.
    """
    _refuse_sharing_when_local()
    try:
        resolved = sharing.resolve_share(session, token, record_view=True)
    except sharing.ShareError as error:
        # 404 rather than 401. A 401 says "that link is real but not for you",
        # which is information a holder of a guessed token should not get.
        raise HTTPException(status_code=404, detail=str(error)) from error

    # A pinned link shows one version and keeps showing it (D5.5). The audience
    # of a talk must not have a slide change under them because someone edited
    # the deck while it was on screen.
    loaded = store.load_presentation(
        session, resolved.presentation.id, at_version=resolved.share.version_id
    )
    telemetry.SHARE_VIEWS.add(1, {"role": resolved.share.role})

    return {
        "presentation_id": resolved.presentation.id,
        "title": resolved.presentation.title,
        "document": loaded.document,
        "version_id": loaded.version_id,
        # So a viewer can tell a photograph from a window. A presenter handing
        # this link round needs to know which one they sent.
        "pinned": resolved.share.version_id is not None,
        # So the client knows whether to offer an editor or only present mode.
        "role": resolved.share.role,
    }


@router.get("/shared/{token}/assets/{asset_id}")
def open_shared_asset(
    token: str, asset_id: str, session: Session = Depends(get_session)
) -> Response:
    """The pictures in a shared deck (D5.5).

    Without this a share link was only half a link. The blob route requires a
    session and a membership, so on any install storing files locally — every
    desktop one — an audience opening a shared deck got the text and a row of
    broken images. Sharing exists to show a deck to people, and a deck with no
    pictures is not the deck.

    The rule that keeps it from being a foothold: **only what this document
    cites.** The token authorises one deck, so it reaches the files in that deck
    and nothing else in the workspace — not the other decks' images, not an
    orphan somebody deleted from a slide last week. The check is against the
    document the link actually serves, so a *pinned* link reaches the pictures of
    the version it is pinned to and not whatever the deck cites now.

    Deliberately no signed URL. There is nothing to sign that the token does not
    already say, and a second credential for the same access is a second thing to
    get wrong.
    """
    _refuse_sharing_when_local()
    try:
        resolved = sharing.resolve_share(session, token)
    except sharing.ShareError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error

    loaded = store.load_presentation(
        session, resolved.presentation.id, at_version=resolved.share.version_id
    )
    if asset_id not in asset_service.referenced_ids(loaded.document):
        # The same 404 an unknown asset gets. "That file exists but is not in
        # this deck" tells a probing holder what the workspace contains.
        raise HTTPException(status_code=404, detail="No such object.")

    asset = session.get(Asset, asset_id)
    if asset is None or asset.deleted_at is not None:
        raise HTTPException(status_code=404, detail="No such object.")

    if object_storage.local_root() is None:
        # With a real object store there is already a way to hand out one file
        # for a short time, and re-serving the bytes through the API would put
        # every shared deck's images through the application.
        return RedirectResponse(
            object_storage.presigned_get(asset.storage_key), status_code=307
        )

    try:
        data, content_type = object_storage.read_local(asset.storage_key)
    except object_storage.ObjectStorageError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Response(content=data, media_type=content_type or asset.content_type)


# ------------------------------------------------------------------- quotas


@router.get("/workspace/usage")
def workspace_usage(
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """What this workspace has spent, and what it is allowed.

    Readable by any member. A user who cannot see why generation was refused has
    no way to tell a limit from a bug.
    """
    workspace_id = _workspace_of(session, principal.user_id, Role.VIEWER)
    return quotas.usage(session, workspace_id).as_dict()


# ------------------------------------------------------------------- assets


ASSET_CONTENT_PREFIXES = {
    "image": ("image/",),
    "video": ("video/",),
    "audio": ("audio/",),
    "font": ("font/", "application/font", "application/vnd.ms-font"),
    "document": ("application/pdf", "text/plain", "text/csv"),
}
MAX_ASSET_BYTES = 100 * 1024 * 1024
UPLOAD_TOKEN_TTL = 15 * 60


class BeginAssetUpload(BaseModel):
    workspace_id: str
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=128)
    size_bytes: int = Field(gt=0, le=MAX_ASSET_BYTES)
    kind: Literal["image", "video", "audio", "font", "document"] = "image"
    width: int | None = Field(default=None, gt=0, le=100_000)
    height: int | None = Field(default=None, gt=0, le=100_000)


class CompleteAssetUpload(BaseModel):
    upload_token: str = Field(min_length=20)


def _upload_secret() -> bytes:
    secret = os.environ.get("DECKASTRA_UPLOAD_SECRET")
    if secret:
        return hashlib.sha256(secret.encode()).digest()
    if os.environ.get("DECKASTRA_ENV", "development").lower() == "production":
        raise HTTPException(status_code=503, detail="Asset uploads are not configured.")
    development = os.environ.get("DECKASTRA_DEV_SECRET", "deckastra-dev-secret") + ":uploads"
    return hashlib.sha256(development.encode()).digest()


def _content_type_allowed(kind: str, content_type: str) -> bool:
    normalized = content_type.split(";", 1)[0].strip().lower()
    return any(normalized.startswith(prefix) for prefix in ASSET_CONTENT_PREFIXES[kind])


@router.post("/workspace/assets/uploads", status_code=201)
def begin_asset_upload(
    request: BeginAssetUpload,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    workspace_id = _selected_workspace(
        session, principal.user_id, request.workspace_id, Role.EDITOR
    )
    if not _content_type_allowed(request.kind, request.content_type):
        raise HTTPException(
            status_code=422,
            detail=f"{request.content_type!r} is not an allowed {request.kind} content type.",
        )
    try:
        quotas.recount_storage(session, workspace_id)
        quotas.check_storage(session, workspace_id, request.size_bytes)
    except quotas.QuotaExceeded as error:
        raise HTTPException(status_code=429, detail=error.as_detail()) from error

    key = f"workspaces/{workspace_id}/assets/{new_id('obj')}"
    now = int(time.time())
    claims = {
        "iss": "deckastra-upload",
        "aud": "deckastra-upload",
        "iat": now,
        "exp": now + UPLOAD_TOKEN_TTL,
        "sub": principal.user_id,
        "workspace_id": workspace_id,
        "key": key,
        "filename": request.filename,
        "content_type": request.content_type.split(";", 1)[0].strip().lower(),
        "size_bytes": request.size_bytes,
        "kind": request.kind,
        "width": request.width,
        "height": request.height,
    }
    try:
        url = object_storage.presigned_put(key, claims["content_type"], expires_seconds=UPLOAD_TOKEN_TTL)
    except object_storage.ObjectStorageError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "method": "PUT",
        "upload_url": url,
        "headers": {"Content-Type": claims["content_type"]},
        "upload_token": jwt.encode(claims, _upload_secret(), algorithm="HS256"),
        "expires_at": now + UPLOAD_TOKEN_TTL,
    }


def _require_local_blob_store() -> None:
    """These two routes exist only where there is no object store to talk to."""
    if object_storage.local_root() is None:
        raise HTTPException(status_code=404, detail="Not found.")


def _read_body(request: Request) -> bytes:
    """Read an upload body from a synchronous route.

    The API is deliberately synchronous (`db/session.py` explains why), so the
    request body has to be pulled off the async transport here. Bounded by the
    same ceiling the upload request declares, because an unbounded read is a way
    to fill a user's disk from inside their own editor.
    """
    import anyio

    body = anyio.from_thread.run(request.body)
    if len(body) > MAX_ASSET_BYTES:
        raise HTTPException(status_code=413, detail="That file is too large.")
    return body


@router.put("/workspace/assets/blob/{key:path}")
def put_asset_blob(
    key: str,
    request: Request,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Receive asset bytes, for an install with no object store.

    Only exists locally. In the deployed product the client PUTs straight to S3
    with a presigned URL and these bytes never touch the API — routing them
    through it would put every upload through one process for no benefit.

    The key is checked against the caller's own workspace rather than trusted,
    because it arrives in the URL. Everything after that is the same completion
    flow S3 uploads take: the bytes are verified against the upload token before
    a row exists.
    """
    _require_local_blob_store()
    workspace_id = _workspace_of(session, principal.user_id, Role.EDITOR)
    if not key.startswith(f"workspaces/{workspace_id}/assets/"):
        raise HTTPException(status_code=404, detail="No such upload.")

    body = _read_body(request)
    try:
        meta = object_storage.put_local(
            key, body, request.headers.get("content-type", "application/octet-stream")
        )
    except object_storage.ObjectStorageError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {"bytes": meta.bytes, "etag": meta.etag}


@router.get("/workspace/assets/blob/{key:path}")
def get_asset_blob(
    key: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> Response:
    """Serve asset bytes for an install with no object store."""
    _require_local_blob_store()
    workspace_id = _workspace_of(session, principal.user_id, Role.VIEWER)
    if not key.startswith(f"workspaces/{workspace_id}/assets/"):
        raise HTTPException(status_code=404, detail="No such object.")

    try:
        data, content_type = object_storage.read_local(key)
    except object_storage.ObjectStorageError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Response(content=data, media_type=content_type)


@router.post("/workspace/assets/uploads/complete", status_code=201)
def complete_asset_upload(
    request: CompleteAssetUpload,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    try:
        claims = jwt.decode(
            request.upload_token,
            _upload_secret(),
            algorithms=["HS256"],
            audience="deckastra-upload",
            issuer="deckastra-upload",
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError as error:
        raise HTTPException(status_code=400, detail="This upload token is invalid or expired.") from error
    if claims.get("sub") != principal.user_id:
        raise HTTPException(status_code=404, detail="No such upload.")

    workspace_id = str(claims.get("workspace_id") or "")
    _selected_workspace(session, principal.user_id, workspace_id, Role.EDITOR)
    key = str(claims.get("key") or "")
    if not key.startswith(f"workspaces/{workspace_id}/assets/"):
        raise HTTPException(status_code=400, detail="This upload token has an invalid storage target.")

    try:
        meta = object_storage.metadata(key)
    except object_storage.ObjectStorageError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    expected_bytes = int(claims.get("size_bytes") or 0)
    expected_type = str(claims.get("content_type") or "")
    actual_type = (meta.content_type or "").split(";", 1)[0].strip().lower()
    if meta.bytes != expected_bytes or actual_type != expected_type:
        try:
            object_storage.delete(key)
        except object_storage.ObjectStorageError:
            logger.exception("Could not clean invalid upload %s", key)
        raise HTTPException(status_code=422, detail="Uploaded bytes or content type do not match the upload request.")

    try:
        asset = asset_service.register(
            session,
            workspace_id=workspace_id,
            created_by=principal.user_id,
            storage_key=key,
            kind=str(claims.get("kind")),
            filename=str(claims.get("filename")),
            content_type=expected_type,
            size_bytes=meta.bytes,
            width=claims.get("width"),
            height=claims.get("height"),
        )
    except quotas.QuotaExceeded as error:
        try:
            object_storage.delete(key)
        except object_storage.ObjectStorageError:
            logger.exception("Could not clean quota-rejected upload %s", key)
        raise HTTPException(status_code=429, detail=error.as_detail()) from error

    # The storage key, which `describe` deliberately withholds — a *list* has no
    # reason to hand out paths into a bucket. Completing your own upload does:
    # the caller is about to reference it from a document, and doc 02 stores the
    # opaque `storageKey` there by design. Narrow enough to stay consistent with
    # that refusal rather than relax it.
    return {**asset_service.describe(asset), "storage_key": asset.storage_key}


@router.get("/workspace/assets")
def list_assets(
    workspace_id: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    workspace_id = _selected_workspace(session, principal.user_id, workspace_id, Role.VIEWER)
    asset_service.recount_references(session, workspace_id)

    rows = (
        session.query(Asset)
        .filter(Asset.workspace_id == workspace_id)
        .order_by(Asset.created_at.desc())
        .all()
    )

    return {
        "assets": [asset_service.describe(asset) for asset in rows],
        "orphans": [asset.id for asset in rows if asset.reference_count == 0],
        "grace_days": asset_service.ORPHAN_GRACE_DAYS,
    }


@router.delete("/workspace/assets/{asset_id}")
def delete_asset(
    asset_id: str,
    workspace_id: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    selected = _selected_workspace(session, principal.user_id, workspace_id, Role.EDITOR)
    asset = session.get(Asset, asset_id)
    if asset is None or asset.workspace_id != selected:
        raise HTTPException(status_code=404, detail="No such asset.")
    return asset_service.describe(asset_service.soft_delete(session, asset))


@router.post("/workspace/assets/{asset_id}/restore")
def restore_asset(
    asset_id: str,
    workspace_id: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    selected = _selected_workspace(session, principal.user_id, workspace_id, Role.EDITOR)
    asset = session.get(Asset, asset_id)
    if asset is None or asset.workspace_id != selected:
        raise HTTPException(status_code=404, detail="No such asset.")
    try:
        object_storage.metadata(asset.storage_key)
    except object_storage.ObjectStorageError as error:
        raise HTTPException(status_code=409, detail="The asset bytes have already been removed.") from error
    return asset_service.describe(asset_service.restore(session, asset))


@router.get("/workspace/assets/{asset_id}/download")
def download_asset(
    asset_id: str,
    workspace_id: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    selected = _selected_workspace(session, principal.user_id, workspace_id, Role.VIEWER)
    asset = session.get(Asset, asset_id)
    if asset is None or asset.workspace_id != selected or asset.deleted_at is not None:
        raise HTTPException(status_code=404, detail="No such asset.")
    try:
        return {"url": object_storage.presigned_get(asset.storage_key), "expires_in": 900}
    except object_storage.ObjectStorageError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.post("/workspace/assets/sweep")
def sweep_assets(
    dry_run: bool = True,
    workspace_id: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Remove assets nothing has referenced for the grace period.

    `dry_run` defaults to true. This deletes user data by inference — "nothing
    points at it" — and the counting is worth looking at before acting on it.
    """
    # ADMIN: this deletes bytes, and the deletion is inferred rather than
    # asked for. An editor can remove an image from a deck; deciding that
    # nothing in the workspace needs it any more is a different act.
    workspace_id = _selected_workspace(session, principal.user_id, workspace_id, Role.ADMIN)
    result = asset_service.sweep(
        session,
        workspace_id,
        dry_run=dry_run,
        remove=None if dry_run else object_storage.delete,
    )

    return {
        "dry_run": dry_run,
        "scanned": result.scanned,
        "deleted": result.deleted,
        "reclaimed_bytes": result.reclaimed_bytes,
    }


# ------------------------------------------------------------------- themes


class SaveThemeRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    definition: dict[str, Any]
    is_default: bool = False


@router.get("/workspace/themes")
def list_themes(
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    workspace_id = _workspace_of(session, principal.user_id, Role.VIEWER)
    return {
        "themes": [themes.describe(theme) for theme in themes.list_for_workspace(session, workspace_id)]
    }


@router.post("/workspace/themes")
def save_theme(
    request: SaveThemeRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    # A theme is workspace-wide: saving one restyles every deck that adopts
    # it, so it is an edit to the workspace, not a read of it.
    workspace_id = _workspace_of(session, principal.user_id, Role.EDITOR)

    try:
        theme = themes.save(
            session,
            workspace_id=workspace_id,
            created_by=principal.user_id,
            name=request.name,
            description=request.description,
            definition=request.definition,
            is_default=request.is_default,
        )
    except themes.ThemeError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return themes.describe(theme)


@router.get("/presentations/{presentation_id}/themes")
def presentation_themes(
    presentation_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id)
    return {"themes": [themes.describe(theme) for theme in themes.list_for_workspace(session, access.workspace_id)]}


@router.get("/presentations/{presentation_id}/themes/{theme_id}")
def theme_proposal(
    presentation_id: str, theme_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    # Read-only: the editor applies this patch to its current local document,
    # preserving pending changes and its ordinary undo/autosave history.
    access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR)
    theme = session.get(Theme, theme_id)
    if theme is None or theme.workspace_id != access.workspace_id or theme.archived_at is not None:
        raise HTTPException(status_code=404, detail="No such theme.")
    return {"theme": themes.describe(theme), "operations": themes.apply_operations(theme)}


@router.post("/presentations/{presentation_id}/themes")
def save_presentation_theme(
    presentation_id: str, request: SaveThemeRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR)
    try:
        theme = themes.save(session, workspace_id=access.workspace_id, created_by=principal.user_id,
                            name=request.name, description=request.description, definition=request.definition, is_default=request.is_default)
    except themes.ThemeError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return themes.describe(theme)


@router.post("/presentations/{presentation_id}/theme/{theme_id}")
def apply_theme(
    presentation_id: str,
    theme_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Re-apply a workspace theme to a deck.

    Through the transaction path like every other change, so it undoes the same
    way. A theme applied by writing the document directly would be the one edit
    in the product with no inverse.
    """
    access = resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )

    theme = session.get(Theme, theme_id)
    if theme is None or theme.workspace_id != access.workspace_id or theme.archived_at is not None:
        raise HTTPException(status_code=404, detail="No such theme.")

    loaded = store.load_presentation(session, presentation_id)
    operations = themes.apply_operations(theme)

    # Through the one mutation path, like every other change: apply, capture the
    # inverse against the pre-state, validate, commit. A theme written straight
    # into the document would be the single edit in the product with no undo.
    try:
        document, inverse = apply_patch(loaded.document, operations)
    except PatchError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    errors = validate_document(document)
    if errors:
        # A theme that validates on its own but breaks the document it is applied
        # to. Loud rather than stored: doc 04 §6.4 refuses to render an invalid
        # document, so storing one moves the failure somewhere less diagnosable.
        raise HTTPException(
            status_code=422,
            detail={"message": "This theme would produce an invalid document.", "errors": errors},
        )

    result = store.commit_transaction(
        session,
        presentation_id=presentation_id,
        operations=operations,
        inverse_operations=inverse,
        document=document,
        parent_version_id=loaded.version_id,
        expected_version_id=loaded.version_id,
        intent=f"Apply theme {theme.name}",
        source="system",
        created_by=principal.user_id,
        label=f"Apply theme “{theme.name}”",
    )

    return {"version_id": result.version_id, "document": result.document}
