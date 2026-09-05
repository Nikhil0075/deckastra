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
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import assets as asset_service
from . import quotas, sharing, store, telemetry, themes
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.models import Asset, PresentationShare, Theme, WorkspaceMember
from .db.session import get_session
from .patch import PatchError, apply_patch
from .schema import validate_document

logger = logging.getLogger("deckastra.workspace")

router = APIRouter(prefix="/v1")


def _workspace_of(session: Session, user_id: str) -> str:
    membership = (
        session.query(WorkspaceMember).filter(WorkspaceMember.user_id == user_id).first()
    )
    if membership is None:
        raise HTTPException(status_code=403, detail="You are not a member of any workspace.")
    return membership.workspace_id


# ------------------------------------------------------------------ sharing


class CreateShareRequest(BaseModel):
    role: Literal["viewer", "editor"] = "viewer"
    label: str | None = Field(default=None, max_length=255)
    expires_in_days: int | None = Field(default=None, ge=1, le=sharing.MAX_EXPIRY_DAYS)


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
    try:
        resolved = sharing.resolve_share(session, token, record_view=True)
    except sharing.ShareError as error:
        # 404 rather than 401. A 401 says "that link is real but not for you",
        # which is information a holder of a guessed token should not get.
        raise HTTPException(status_code=404, detail=str(error)) from error

    loaded = store.load_presentation(session, resolved.presentation.id)
    telemetry.SHARE_VIEWS.add(1, {"role": resolved.share.role})

    return {
        "presentation_id": resolved.presentation.id,
        "title": resolved.presentation.title,
        "document": loaded.document,
        "version_id": loaded.version_id,
        # So the client knows whether to offer an editor or only present mode.
        "role": resolved.share.role,
    }


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
    workspace_id = _workspace_of(session, principal.user_id)
    return quotas.usage(session, workspace_id).as_dict()


# ------------------------------------------------------------------- assets


@router.get("/workspace/assets")
def list_assets(
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    workspace_id = _workspace_of(session, principal.user_id)
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


@router.post("/workspace/assets/sweep")
def sweep_assets(
    dry_run: bool = True,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Remove assets nothing has referenced for the grace period.

    `dry_run` defaults to true. This deletes user data by inference — "nothing
    points at it" — and the counting is worth looking at before acting on it.
    """
    workspace_id = _workspace_of(session, principal.user_id)
    result = asset_service.sweep(session, workspace_id, dry_run=dry_run)

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
    workspace_id = _workspace_of(session, principal.user_id)
    return {
        "themes": [themes.describe(theme) for theme in themes.list_for_workspace(session, workspace_id)]
    }


@router.post("/workspace/themes")
def save_theme(
    request: SaveThemeRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    workspace_id = _workspace_of(session, principal.user_id)

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
    if theme is None or theme.workspace_id != access.workspace_id:
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
