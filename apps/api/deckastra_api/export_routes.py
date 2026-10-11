"""The export HTTP surface (doc 04 §32.4).

Three endpoints and one rule between them: **the report is available before the
artifact.** Doc 04 §32.2 is specific that the user sees what was degraded before
they download, not after they have handed the file to a client, so the status
response carries the report and the download is a separate call they make after
reading it.
"""

from __future__ import annotations

import os
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import export_service, locales, store
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.models import ExportJob
from .db.session import get_session

router = APIRouter(prefix="/v1")


class ExportRequest(BaseModel):
    kind: Literal["pdf", "pptx", "mydeck"]
    slide_ids: list[str] = Field(default_factory=list, max_length=500)
    include_hidden_slides: bool = False
    include_notes: bool = False
    #: Which frame of each slide's motion to freeze (doc 04 §32.3). `final` is
    #: right for a deck someone will read; `initial` is for a handout of a
    #: click-reveal deck, where the final state gives every answer away at once.
    at_time: Literal["final", "initial"] = "final"
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=128)
    #: The version the caller means to export — the editor passes the one its
    #: save queue has just been acknowledged at. Without it an export takes
    #: whatever is stored, which can be older than what is on screen (an edit
    #: still in the autosave debounce) or newer (an agent's change landing in
    #: between). Optional, because an agent exporting "the deck as it stands"
    #: means exactly the stored head.
    expected_version_id: str | None = Field(default=None, max_length=64)
    #: The language to export (integration plan 01 §3.10): the deck's own when
    #: absent, or one of its overlays. Recorded on the job, because an export is
    #: of a version *in a language*, and a retry must not change which.
    locale: str | None = Field(default=None, min_length=2, max_length=35)


@router.post("/presentations/{presentation_id}/exports", status_code=status.HTTP_202_ACCEPTED)
def start_export(
    presentation_id: str,
    request: ExportRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Export a presentation.

    Synchronous for now: there is no queue, and a fake asynchronous endpoint that
    returns 202 and never finishes is worse than a slow one. The *shape* is a job
    — a row exists before the work starts and survives it — so putting a queue in
    front later changes this function and nothing that calls it.
    """
    # An export reads the whole deck, so viewer is the right bar: anyone who can
    # see it can take a copy away.
    access = resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.VIEWER,
    )

    loaded = store.load_presentation(session, presentation_id)
    if request.expected_version_id is not None and request.expected_version_id != loaded.version_id:
        # A different version from the one the caller saw is a different file.
        # Refused rather than exported, so "export" never quietly means "export
        # something other than what I was looking at".
        raise HTTPException(
            status_code=409,
            detail="The deck changed after it was saved for this export. Export again to include the latest version.",
        )

    if request.locale is not None:
        if not locales.valid_locale(request.locale):
            raise HTTPException(status_code=422, detail=f"{request.locale!r} is not a language tag.")
        own = locales.same_language(request.locale, locales.source_locale(loaded.document))
        if not own and request.locale not in (loaded.document.get("locales") or {}):
            raise HTTPException(status_code=422, detail=f"This deck has no {request.locale} translation to export.")

    try:
        job = export_service.create_job(
            session,
            presentation_id=presentation_id,
            version_id=loaded.version_id,
            created_by=principal.user_id,
            kind=request.kind,
            options={
                "slideIds": request.slide_ids or None,
                "includeHiddenSlides": request.include_hidden_slides,
                "includeNotes": request.include_notes,
                "atTime": request.at_time,
                **({"locale": request.locale} if request.locale else {}),
            },
            idempotency_key=request.idempotency_key,
        )
    except export_service.ExportError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    # Compatibility mode for local acceptance tests. Production leaves work in
    # the durable queue for `python -m deckastra_api.export_worker`.
    if os.environ.get("DECKASTRA_EXPORT_INLINE") == "1" and job.status == "queued":
        export_service.run_job(session, job, loaded.document)

    return export_service.describe(job)


@router.post("/exports/{export_id}/cancel")
def cancel_export(
    export_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    return export_service.describe(
        export_service.request_cancel(session, _authorised(session, principal, export_id))
    )


@router.post("/exports/{export_id}/retry", status_code=status.HTTP_202_ACCEPTED)
def retry_export(
    export_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    try:
        job = export_service.retry(session, _authorised(session, principal, export_id))
    except export_service.ExportError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return export_service.describe(job)


@router.get("/exports/{export_id}")
def export_status(
    export_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    return export_service.describe(_authorised(session, principal, export_id))


@router.get("/exports/{export_id}/download", response_model=None)
def download_export(
    export_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> FileResponse | RedirectResponse:
    job = _authorised(session, principal, export_id)

    if job.status == "completed" and (job.artifact_path or "").startswith("gs://"):
        from .gcs_storage import export_url
        try:
            return RedirectResponse(export_url(job.artifact_path), status_code=307)
        except (ValueError, FileNotFoundError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=503, detail="Cloud export storage is unavailable.") from error

    try:
        path = export_service.artifact_of(job)
    except export_service.ExportError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error

    return FileResponse(
        path,
        media_type=job.content_type or "application/octet-stream",
        filename=job.filename or f"{job.id}.{job.kind}",
    )


def _authorised(session: Session, principal: Principal, export_id: str) -> ExportJob:
    """The job, if this user may see the presentation it belongs to.

    Authorisation runs through the presentation, not the job's `created_by`. A
    colleague with access to the deck should be able to read an export of it, and
    someone who lost access to the deck must not keep a door to its contents
    through an export id they still remember.
    """
    job = session.get(ExportJob, export_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No such export.")

    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=job.presentation_id,
        require=Role.VIEWER,
    )
    return job
