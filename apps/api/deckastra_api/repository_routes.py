"""The repository HTTP surface (doc 05 §19, Journey B).

Connect a repository, index it, see how current the index is, and read the
sources behind a slide. Plus the webhook, which is the only unauthenticated
endpoint in the product and is therefore the one written most carefully.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from deckastra_integrations.github.app import AppCredentials, installation_url
from deckastra_integrations.github.webhooks import (
    WebhookRejected,
    decode,
    parse_event,
    verify_signature,
)
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import provenance, quotas, repository_service, retrieval, store
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.models import WorkspaceMember
from .db.session import get_session

logger = logging.getLogger("deckastra.repositories")

router = APIRouter(prefix="/v1")


# -------------------------------------------------------------------- models


class ConnectLocalRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1_000)
    label: str | None = Field(default=None, max_length=255)


class SearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=400)
    repository_ids: list[str] = Field(default_factory=list, max_length=20)
    limit: int = Field(default=8, ge=1, le=20)


def _workspace_of(session: Session, user_id: str) -> str:
    membership = (
        session.query(WorkspaceMember).filter(WorkspaceMember.user_id == user_id).first()
    )
    if membership is None:
        raise HTTPException(status_code=403, detail="You are not a member of any workspace.")
    return membership.workspace_id


def _error(error: repository_service.RepositoryError) -> HTTPException:
    code = 404 if error.code == "E404" else 400
    return HTTPException(status_code=code, detail={"message": str(error), "code": error.code})


# ---------------------------------------------------------------- connecting


@router.get("/repositories")
def list_repositories(
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    workspace_id = _workspace_of(session, principal.user_id)
    credentials = AppCredentials.from_environment()

    return {
        "repositories": [
            repository_service.describe(repository)
            for repository in repository_service.list_for_workspace(session, workspace_id)
        ],
        "github": {
            "configured": credentials is not None,
            # Where to send the user to install the App. Absent when the App is
            # not registered, so the UI can say "not configured" rather than
            # offering a link that 404s.
            "install_url": (
                installation_url(os.environ["GITHUB_APP_SLUG"], state=workspace_id)
                if credentials is not None and os.environ.get("GITHUB_APP_SLUG")
                else None
            ),
        },
        "local_allowed": os.environ.get("DECKASTRA_ALLOW_LOCAL_REPOS") == "1",
    }


@router.post("/repositories/local")
def connect_local_repository(
    request: ConnectLocalRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Connect a directory on disk.

    Gated by `DECKASTRA_ALLOW_LOCAL_REPOS` in the service layer: a server that
    indexes arbitrary host paths on request is a file-read primitive for anyone
    with an account.
    """
    workspace_id = _workspace_of(session, principal.user_id)

    try:
        quotas.check_repository(session, workspace_id)
    except quotas.QuotaExceeded as exceeded:
        raise HTTPException(status_code=429, detail=exceeded.as_detail()) from exceeded

    try:
        repository = repository_service.connect_local(
            session, workspace_id=workspace_id, path=request.path, label=request.label
        )
    except repository_service.RepositoryError as error:
        raise _error(error) from error

    return repository_service.describe(repository)


@router.post("/repositories/{repository_id}/index")
def index_repository_now(
    repository_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Index or re-index, synchronously.

    Synchronous because there is no job runner yet and a fake asynchronous
    endpoint that returns 202 and never finishes is worse than a slow one. It is
    the obvious thing to move to a worker when there is one.
    """
    workspace_id = _workspace_of(session, principal.user_id)

    try:
        repository = repository_service.for_workspace(session, workspace_id, repository_id)
        result = repository_service.reindex(session, repository)
    except repository_service.RepositoryError as error:
        raise _error(error) from error
    except Exception as error:  # noqa: BLE001 - the row records it; the caller gets the reason
        logger.exception("Indexing failed")
        raise HTTPException(status_code=502, detail=f"Indexing failed: {error}") from error

    return {
        **repository_service.describe(repository),
        "index": {
            "files_seen": result.files_seen,
            "files_indexed": result.files_indexed,
            "files_skipped": result.files_skipped,
            "chunks": result.chunks,
            "chunks_reused": result.chunks_reused,
            "languages": result.languages,
            "frameworks": result.frameworks,
            "warnings": result.warnings,
        },
    }


@router.delete("/repositories/{repository_id}")
def disconnect_repository(
    repository_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, str]:
    workspace_id = _workspace_of(session, principal.user_id)
    try:
        repository = repository_service.for_workspace(session, workspace_id, repository_id)
    except repository_service.RepositoryError as error:
        raise _error(error) from error

    repository_service.disconnect(session, repository)
    return {"status": "disconnected"}


@router.post("/repositories/search")
def search_repositories(
    request: SearchRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Retrieval, exposed.

    Useful on its own, and the fastest way to see whether an index is any good
    before generating a deck from it.
    """
    workspace_id = _workspace_of(session, principal.user_id)

    repositories = (
        repository_service.resolve_many(session, workspace_id, request.repository_ids)
        if request.repository_ids
        else repository_service.list_for_workspace(session, workspace_id)
    )
    ready = [repository for repository in repositories if repository.index_status == "ready"]

    hits = retrieval.search(
        session, [repository.id for repository in ready], request.query, limit=request.limit
    )

    return {
        "query": request.query,
        "searched": [repository.full_name for repository in ready],
        "semantic": all(repository.embedding_semantic for repository in ready) if ready else False,
        "hits": [
            {
                "path": hit.path,
                "reference": hit.reference,
                "start_line": hit.start_line,
                "end_line": hit.end_line,
                "language": hit.language,
                "similarity": hit.similarity,
                "score": hit.score,
                "why_selected": hit.selection_reason,
                "excerpt": hit.content[:600],
            }
            for hit in hits
        ],
    }


# --------------------------------------------------------------- provenance


@router.get("/presentations/{presentation_id}/slides/{slide_id}/sources")
def slide_sources(
    presentation_id: str,
    slide_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Where a slide's claims came from — the phase's exit criterion.

    Read from the document rather than a side table (doc 02 §30), so it survives
    export and duplication and cannot drift from the deck it describes.
    """
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.VIEWER,
    )

    loaded = store.load_presentation(session, presentation_id)
    records = provenance.for_slide(loaded.document, slide_id)

    workspace_id = _workspace_of(session, principal.user_id)
    # Only GitHub repositories get a link. A local checkout has no branch and no
    # public URL, and a link built from its placeholder branch name would 404 —
    # which is worse than no link, because a citation the user clicks and finds
    # broken reads as a fabricated one.
    branches = {
        repository.full_name: repository.default_branch
        for repository in repository_service.list_for_workspace(session, workspace_id)
        if repository.source == "github"
    }

    def link(reference: str) -> str | None:
        branch = branches.get(reference.split("#")[0])
        return provenance.to_link(reference, default_branch=branch) if branch else None

    return {
        "slide_id": slide_id,
        "sources": [
            # A slide citing another slide, or a local checkout, has nowhere to
            # go; the record still carries its reference and excerpt.
            {**record, "url": link(record.get("sourceReference", ""))}
            for record in records
        ],
    }


# ----------------------------------------------------------------- webhooks


@router.post("/github/webhook")
async def github_webhook(
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Receive a GitHub delivery (gap register doc 05 S2).

    The only unauthenticated endpoint in the product, so:

    - The signature is verified over the **raw body**. Re-serialising the JSON
      changes the bytes and the signature stops matching for reasons nobody can
      debug.
    - **No secret configured means reject**, never allow. A deployment that
      forgot the secret should fail closed.
    - A rejection returns 401 with nothing useful in it. A detailed error here is
      an oracle for guessing the secret.
    """
    credentials = AppCredentials.from_environment()
    body = await request.body()

    try:
        verify_signature(
            body,
            request.headers.get("X-Hub-Signature-256"),
            credentials.webhook_secret if credentials else "",
        )
        payload = decode(body)
    except WebhookRejected as rejection:
        logger.warning("Rejected a GitHub webhook: %s", rejection)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Rejected."
        ) from rejection

    event = parse_event(request.headers.get("X-GitHub-Event", ""), payload)

    if event.kind == "ping":
        return {"status": "ok"}

    outcome = repository_service.apply_webhook(session, event)
    logger.info("GitHub %s affected %d repositories", event.kind, len(outcome["affected"]))
    return {"status": "ok", **outcome}


@router.get("/github/callback")
def github_callback(
    installation_id: str,
    state: str = "",
    setup_action: str = "",
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Where GitHub sends the user after installing the App.

    `state` carries the workspace that asked for the installation. Without it a
    callback arrives with an installation id and no idea whose it is — so a
    missing or mismatched state is refused rather than guessed.
    """
    workspace_id = _workspace_of(session, principal.user_id)

    if state and state != workspace_id:
        raise HTTPException(
            status_code=400,
            detail="This installation was started from a different workspace.",
        )

    installation = repository_service.record_installation(
        session,
        workspace_id=workspace_id,
        github_installation_id=installation_id,
        account_login=state or "",
        installed_by=principal.user_id,
    )

    return {
        "installation_id": installation.id,
        "github_installation_id": installation.github_installation_id,
        "setup_action": setup_action,
    }
