"""The export HTTP surface (doc 04 §32.4).

Three endpoints and one rule between them: **the report is available before the
artifact.** Doc 04 §32.2 is specific that the user sees what was degraded before
they download, not after they have handed the file to a client, so the status
response carries the report and the download is a separate call they make after
reading it.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import export_service, store
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.models import ExportJob
from .db.session import get_session

logger = logging.getLogger("deckastra.exports")

router = APIRouter(prefix="/v1")


class ExportRequest(BaseModel):
    kind: Literal["pdf", "pptx"]
    slide_ids: list[str] = Field(default_factory=list, max_length=500)
    include_hidden_slides: bool = False
    include_notes: bool = False
    #: Which frame of each slide's motion to freeze (doc 04 §32.3). `final` is
    #: right for a deck someone will read; `initial` is for a handout of a
    #: click-reveal deck, where the final state gives every answer away at once.
    at_time: Literal["final", "initial"] = "final"


@router.post("/presentations/{presentation_id}/exports")
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
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.VIEWER,
    )

    loaded = store.load_presentation(session, presentation_id)

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
            },
        )
    except export_service.ExportError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    try:
        export_service.run_job(session, job, loaded.document)
    except export_service.ExportError as error:
        # 502 rather than 500: the failure is in the exporter subprocess, and the
        # message is the useful part. The row keeps the failure either way.
        logger.warning("Export %s failed: %s", job.id, error)
        raise HTTPException(status_code=502, detail=str(error)) from error

    return export_service.describe(job)


@router.get("/exports/{export_id}")
def export_status(
    export_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    return export_service.describe(_authorised(session, principal, export_id))


@router.get("/exports/{export_id}/download")
def download_export(
    export_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> FileResponse:
    job = _authorised(session, principal, export_id)

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
