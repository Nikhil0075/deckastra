"""HTTP surface for documents, transactions and history (doc 05 §28).

The shape worth noticing: **the server does not compose patches.** A client sends
operations it has already decided on; the server validates, applies, versions and
attributes them. That is the same path an agent will take in Phase 5, which is
what keeps "human and AI editing are equal citizens" (doc 01 §4.7) from becoming
two code paths that drift.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import store
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.session import get_session
from .patch import PatchError, apply_patch, disturbs
from .risk import assess_risk
from .schema import validate_document

router = APIRouter(prefix="/v1")


# ---------------------------------------------------------------- request models


class PatchOperationModel(BaseModel):
    op: Literal["add", "remove", "replace", "move", "copy", "test"]
    path: str
    value: Any = None
    from_: str | None = Field(default=None, alias="from")

    model_config = {"populate_by_name": True}

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"op": self.op, "path": self.path}
        if self.op in {"add", "replace", "test"}:
            out["value"] = self.value
        if self.op in {"move", "copy"}:
            out["from"] = self.from_
        return out


class ApplyTransactionRequest(BaseModel):
    operations: list[PatchOperationModel] = Field(min_length=1, max_length=500)
    intent: str = Field(min_length=1, max_length=500)
    # Optimistic concurrency (doc 02 §31.2). Optional, but a client that omits it
    # is opting into last-write-wins and should mean it.
    expected_version_id: str | None = None
    client_id: str | None = None
    source: Literal["user", "agent", "system", "import"] = "user"
    agent_id: str | None = None
    user_instruction: str | None = None
    reason: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)


class TransactionSummary(BaseModel):
    id: str
    status: str
    source: str
    intent: str
    agent_id: str | None
    reason: str | None
    risk_tier: str | None
    parent_version_id: str
    result_version_id: str | None
    created_by: str
    created_at: str
    operation_count: int


class ApplyTransactionResponse(BaseModel):
    transaction_id: str
    version_id: str
    document: dict[str, Any]
    risk_tier: str
    snapshotted: bool


def _summary(row) -> TransactionSummary:
    return TransactionSummary(
        id=row.id,
        status=row.status,
        source=row.source,
        intent=row.intent,
        agent_id=row.agent_id,
        reason=row.reason,
        risk_tier=row.risk_tier,
        parent_version_id=row.parent_version_id,
        result_version_id=row.result_version_id,
        created_by=row.created_by,
        created_at=row.created_at.isoformat(),
        operation_count=len(row.operations_json or []),
    )


# --------------------------------------------------------------------- routes


@router.get("/presentations/{presentation_id}")
def get_presentation(
    presentation_id: str,
    at_version: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    access = resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id
    )

    loaded = store.load_presentation(session, presentation_id, at_version=at_version)
    return {
        "presentation_id": loaded.presentation_id,
        "version_id": loaded.version_id,
        "document": loaded.document,
        "role": access.role.name.lower(),
        "can_edit": access.can_edit,
    }


@router.post("/presentations/{presentation_id}/transactions", response_model=ApplyTransactionResponse)
def apply_transaction(
    presentation_id: str,
    request: ApplyTransactionRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ApplyTransactionResponse:
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )

    loaded = store.load_presentation(session, presentation_id)
    operations = [operation.to_dict() for operation in request.operations]

    # Risk is computed here, from the operations, never taken from the caller — a
    # caller-declared tier is a caller-controlled security boundary (doc 02 §31.7).
    risk = assess_risk(operations)

    try:
        document, inverse = apply_patch(loaded.document, operations)
    except PatchError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(error),
                "code": error.code,
                "operation_index": error.operation_index,
                "path": error.path,
            },
        ) from error

    # Validate before committing. Doc 04 §6.4 refuses to render an invalid
    # document, so storing one only moves the failure somewhere less diagnosable.
    errors = validate_document(document)
    if errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"message": "The patch would produce an invalid document.", "errors": errors},
        )

    try:
        result = store.commit_transaction(
            session,
            presentation_id=presentation_id,
            operations=operations,
            inverse_operations=inverse,
            document=document,
            parent_version_id=loaded.version_id,
            expected_version_id=request.expected_version_id,
            intent=request.intent,
            source=request.source,
            created_by=principal.user_id,
            agent_id=request.agent_id,
            client_id=request.client_id,
            user_instruction=request.user_instruction,
            reason=request.reason,
            confidence=request.confidence,
            risk_tier=risk.tier,
        )
    except store.VersionConflict as conflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(conflict),
                "code": "E304",
                "expected_version_id": conflict.expected,
                "current_version_id": conflict.actual,
            },
        ) from conflict

    return ApplyTransactionResponse(
        transaction_id=result.transaction_id,
        version_id=result.version_id,
        document=result.document,
        risk_tier=risk.tier,
        snapshotted=result.snapshotted,
    )


@router.get("/presentations/{presentation_id}/transactions", response_model=list[TransactionSummary])
def list_transactions(
    presentation_id: str,
    limit: int = 50,
    transaction_status: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[TransactionSummary]:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id
    )
    rows = store.transaction_history(
        session, presentation_id, limit=min(limit, 200), status=transaction_status
    )
    return [_summary(row) for row in rows]


def _later_conflicts(session: Session, original) -> set[str]:
    """Ids that a transaction applied after `original` would make its undo unsafe."""
    conflicts: set[str] = set()

    for row in store.transaction_history(session, original.presentation_id, limit=500):
        if row.id == original.id or row.status != "applied":
            continue
        if row.created_at <= original.created_at:
            continue
        conflicts |= disturbs(original.operations_json, row.operations_json)

    return conflicts


@router.post(
    "/presentations/{presentation_id}/transactions/{transaction_id}/revert",
    response_model=ApplyTransactionResponse,
)
def revert_transaction(
    presentation_id: str,
    transaction_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ApplyTransactionResponse:
    """Undo one specific change, including an AI one (doc 01 §4.2).

    Reverting appends a new transaction rather than deleting the original: "this
    was undone" is a fact worth keeping, and a version lineage with holes in it
    cannot be replayed.
    """
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )

    original = store.get_transaction(session, transaction_id)
    if original.presentation_id != presentation_id:
        raise HTTPException(status_code=404, detail="No such transaction.")
    if original.status != "applied":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Only an applied transaction can be reverted; this one is {original.status}.",
        )

    # An inverse is computed against one specific state. Some of it can only be
    # index-addressed — restoring a removed element has to name a position — so
    # replaying it after an unrelated structural change can land on whatever now
    # occupies that index. Refusing is the only safe answer; the alternative is
    # silently editing the wrong thing (doc 04 §29.3).
    conflicts = _later_conflicts(session, original)
    if conflicts:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": (
                    "This change can no longer be undone on its own — a later edit "
                    "changed what it depends on. Undo the later changes first."
                ),
                "code": "E303",
                "conflicting_ids": sorted(conflicts),
            },
        )

    loaded = store.load_presentation(session, presentation_id)

    try:
        document, inverse = apply_patch(loaded.document, original.inverse_operations_json)
    except PatchError as error:
        # The inverse no longer applies because a later edit moved what it depends
        # on. Refused with a reason rather than half-applied.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": (
                    "This change can no longer be undone on its own — a later edit "
                    f"changed what it depends on. ({error})"
                ),
                "code": error.code,
            },
        ) from error

    result = store.commit_transaction(
        session,
        presentation_id=presentation_id,
        operations=original.inverse_operations_json,
        inverse_operations=inverse,
        document=document,
        parent_version_id=loaded.version_id,
        expected_version_id=None,
        intent=f"Undo: {original.intent}",
        source="user",
        created_by=principal.user_id,
        label=f"Undo: {original.intent}"[:200],
    )

    original.status = "reverted"
    session.flush()

    return ApplyTransactionResponse(
        transaction_id=result.transaction_id,
        version_id=result.version_id,
        document=result.document,
        risk_tier="low",
        snapshotted=result.snapshotted,
    )


class VersionSummary(BaseModel):
    id: str
    parent_version_id: str | None
    source: str
    label: str | None
    created_by: str
    created_at: str
    is_snapshot: bool


@router.get("/presentations/{presentation_id}/versions", response_model=list[VersionSummary])
def list_versions(
    presentation_id: str,
    limit: int = 50,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[VersionSummary]:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id
    )

    return [
        VersionSummary(
            id=version.id,
            parent_version_id=version.parent_version_id,
            source=version.source,
            label=version.label,
            created_by=version.created_by,
            created_at=version.created_at.isoformat(),
            is_snapshot=version.snapshot_json is not None,
        )
        for version in store.version_history(session, presentation_id, limit=min(limit, 200))
    ]
