"""Durable cloud account erasure, with immediate denial of old bearer tokens."""
import hashlib
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Literal
from sqlalchemy import DateTime, String, select, delete, update
from sqlalchemy.orm import Mapped, mapped_column, Session

from .auth import Principal, current_principal
from .db.models import Base, JsonColumn, User, Workspace, WorkspaceMember, Project, Presentation, ExportJob, AuthIdentity
from .db.session import get_session, session_scope
from .assistant_models import AssistantRun
from .credit_models import CreditDailyLimit
from .ids import new_id

router = APIRouter(prefix="/v1")


from .account_models import AccountDeletion


def fingerprint(issuer, subject):
    return hashlib.sha256((issuer + "\0" + subject).encode()).hexdigest()


def blocked(session, issuer, subject):
    wanted = fingerprint(issuer, subject)
    now = datetime.now(timezone.utc)
    for row in session.scalars(select(AccountDeletion).where(
        (AccountDeletion.completed_at.is_(None)) | (AccountDeletion.completed_at > now - timedelta(hours=2)))):
        if wanted in row.fingerprints_json:
            return True
    return False


class DeleteRequest(BaseModel):
    confirm: Literal["DELETE"]


@router.get("/account/deletions/{receipt}")
def deletion_status(receipt: str, session: Session = Depends(get_session)):
    row = session.get(AccountDeletion, receipt)
    if row is None:
        raise HTTPException(404, "No such deletion request.")
    return {"status": row.status}


@router.delete("/account", status_code=202)
def request_deletion(request: DeleteRequest, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    if os.environ.get("DECKASTRA_ACCOUNT_DELETION_ENABLED") != "1":
        raise HTTPException(503, "Cloud account deletion is not configured.")
    session.execute(update(User).where(User.id == principal.user_id).values(id=User.id))
    owned = list(session.scalars(select(Workspace.id).where(Workspace.owner_id == principal.user_id)))
    shared = session.scalar(select(WorkspaceMember.id).where(WorkspaceMember.workspace_id.in_(owned), WorkspaceMember.user_id != principal.user_id))
    if shared:
        raise HTTPException(409, "Transfer ownership of shared workspaces before deleting your account.")
    identities = list(session.scalars(select(AuthIdentity).where(AuthIdentity.user_id == principal.user_id)))
    expected = f"https://securetoken.google.com/{os.environ.get('GOOGLE_CLOUD_PROJECT', '')}"
    if any(i.issuer != expected for i in identities) or not identities:
        raise HTTPException(409, "This account cannot be erased through the configured identity provider.")
    pending = session.scalar(select(AccountDeletion).where(AccountDeletion.user_id == principal.user_id))
    if pending:
        return {"id": pending.id, "status": pending.status}
    row = AccountDeletion(id=new_id("del"), user_id=principal.user_id,
        fingerprints_json=[fingerprint(i.issuer, i.subject) for i in identities],
        identities_json=[i.subject for i in identities], status="queued", requested_at=datetime.now(timezone.utc))
    session.add(row)
    session.execute(update(AssistantRun).where(AssistantRun.workspace_id.in_(owned)).values(cancel_requested=True))
    session.execute(update(ExportJob).where(ExportJob.created_by == principal.user_id).values(cancel_requested=True))
    session.flush()
    return {"id": row.id, "status": "queued", "message": "Cloud data deletion is queued. Local deck files stay on your device."}


def process_one():
    if os.environ.get("DECKASTRA_ACCOUNT_DELETION_ENABLED") != "1":
        return
    with session_scope() as session:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=int(os.environ.get("DECKASTRA_DELETE_GRACE_SECONDS", "960")))
        query = select(AccountDeletion).where(AccountDeletion.status == "queued", AccountDeletion.requested_at < cutoff).limit(1)
        if session.bind.dialect.name == "postgresql":
            query = query.with_for_update(skip_locked=True)
        row = session.scalar(query)
        if row is None:
            return
        erase(session, row)


def erase(session, row):
    """Idempotent external deletion, followed by one SQL cascade transaction."""
    from . import gcs_storage, google_credentials
    import httpx
    user_id = row.user_id
    workspaces = list(session.scalars(select(Workspace.id).where(Workspace.owner_id == user_id)))
    # A cancelling model call may still be completing. Erase after its lease ends.
    active = session.scalar(select(AssistantRun.id).where(AssistantRun.workspace_id.in_(workspaces), AssistantRun.status == "running",
        AssistantRun.lease_until > datetime.now(timezone.utc)))
    if active:
        return
    jobs = list(session.scalars(select(ExportJob).join(Presentation, ExportJob.presentation_id == Presentation.id)
        .join(Project, Presentation.project_id == Project.id).where(Project.workspace_id.in_(workspaces))))
    client = gcs_storage.client()
    assets_bucket = os.environ["DECKASTRA_GCS_ASSETS_BUCKET"]
    for workspace in workspaces:
        for blob in client.list_blobs(assets_bucket, prefix=f"workspaces/{workspace}/"):
            blob.delete()
    exports_bucket = os.environ["DECKASTRA_GCS_EXPORTS_BUCKET"]
    for job in jobs:
        blob = client.bucket(exports_bucket).blob(f"exports/{job.id}.{job.kind}")
        if blob.exists():
            blob.delete()
    project = os.environ["GOOGLE_CLOUD_PROJECT"]
    with httpx.Client(timeout=30) as http:
        for subject in row.identities_json:
            answer = http.post(f"https://identitytoolkit.googleapis.com/v1/projects/{project}/accounts:delete",
                headers={"Authorization": f"Bearer {google_credentials.bearer_token()}", "X-Goog-User-Project": project}, json={"localId": subject})
            if answer.status_code != 200 and "USER_NOT_FOUND" not in answer.text:
                raise RuntimeError("Identity deletion is unavailable; the queued erasure will retry.")
    # Shared documents belong to their remaining owners. Reattribute project ownership.
    for project_row in session.scalars(select(Project).where(Project.created_by == user_id, ~Project.workspace_id.in_(workspaces))):
        project_row.created_by = session.get(Workspace, project_row.workspace_id).owner_id
    session.flush()
    session.execute(delete(Workspace).where(Workspace.id.in_(workspaces)))
    session.execute(delete(CreditDailyLimit).where(CreditDailyLimit.scope == f"account:{user_id}"))
    session.execute(delete(User).where(User.id == user_id))
    row.user_id, row.identities_json = None, []
    row.status, row.completed_at = "completed", datetime.now(timezone.utc)
