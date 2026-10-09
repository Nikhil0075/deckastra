"""The agent HTTP surface (doc 03 §20, §26, doc 02 §31.6).

Externally authored proposals enter the transaction layer here, and people can
inspect, approve, reject, withdraw, or revert them. Run history remains readable
for generation and other long-running workflows.

What is deliberately absent is any way for an agent's output to reach the store
except through `proposals.py`. Doc 03 §28's "agents cannot bypass the transaction
layer" is true here because there is no route that would let them.
"""

from __future__ import annotations
import json
import os
from typing import Any

from deckastra_agents import ProjectMemory
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import agent_store, proposals, store
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.models import Presentation, TransactionRow
from .db.session import get_session

router = APIRouter(prefix="/v1")


# ------------------------------------------------------------------- models


class ProposalSummary(BaseModel):
    id: str
    status: str
    intent: str
    reason: str | None
    risk_tier: str | None
    agent_id: str | None
    run_id: str | None
    created_at: str
    expires_at: str | None
    operation_count: int


class AuthoredProposalResponse(BaseModel):
    run_id: str
    status: str
    #: "applied" for a low-risk change, "pending" when a human must decide.
    outcome: str
    transaction_id: str | None = None
    version_id: str | None = None
    document: dict[str, Any] | None = None
    #: The document the change *would* produce. Returned rather than stored — a
    #: stored preview is a second copy that goes stale.
    preview: dict[str, Any] | None = None
    risk_tier: str = "low"
    reasons: list[str] = Field(default_factory=list)
    changes: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    refusal: str | None = None
    expires_at: str | None = None


class ProposalDecision(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


# ------------------------------------------------------------------- helpers


def _summary(row: TransactionRow) -> ProposalSummary:
    return ProposalSummary(
        id=row.id,
        status=row.status,
        intent=row.intent,
        reason=row.reason,
        risk_tier=row.risk_tier,
        agent_id=row.agent_id,
        run_id=row.run_id,
        created_at=row.created_at.isoformat() if row.created_at else "",
        expires_at=row.expires_at.isoformat() if row.expires_at else None,
        operation_count=len(row.operations_json or []),
    )


def _project_of(session: Session, presentation_id: str) -> str:
    presentation = session.get(Presentation, presentation_id)
    if presentation is None:
        raise HTTPException(status_code=404, detail="No such deck.")
    return presentation.project_id


# ------------------------------------------------- externally authored proposals


class AuthoredProposalRequest(BaseModel):
    """A change an external client worked out for itself (milestone D2.2).

    Deliberately *not* an instruction. The connected client has already authored
    operations, so the workspace only validates, previews, and applies them.

    What is absent from this body is the point: there is no risk tier and no
    `applied` flag. Both are computed here, from the operations.
    """

    #: Bounded because this is a public write surface. The cap is generous — a
    #: whole-deck retheme is a few hundred operations — and a caller that needs
    #: more is describing a document replacement, which is a different request.
    operations: list[dict[str, Any]] = Field(min_length=1, max_length=2_000)
    intent: str = Field(min_length=1, max_length=500)
    #: The version the caller authored these operations against.
    #:
    #: Required, not optional. An external agent reads a deck, thinks for a while
    #: and comes back — and in that gap the person whose deck it is may have been
    #: typing. Without this the operations would apply to whatever is there now,
    #: which is last-write-wins with extra steps. A caller that could omit it
    #: would eventually omit it.
    expected_version_id: str = Field(min_length=1, max_length=64)
    reason: str | None = Field(default=None, max_length=1_000)
    #: Which client authored it, for the approval UI. Namespaced below so it
    #: cannot claim to be one of the product's own agents.
    client_label: str = Field(default="external", max_length=60)


@router.post("/presentations/{presentation_id}/proposals", response_model=AuthoredProposalResponse)
def authored_proposal(
    presentation_id: str,
    request: AuthoredProposalRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> AuthoredProposalResponse:
    """Take operations from an external agent, and treat them like any other.

    This is the whole of the MCP write path, and it is short on purpose. It adds
    no second way into the store: the operations go to `create_proposal`, which
    computes the risk tier from them, applies a low-risk change immediately,
    parks anything else for a human, and gives every applied change an inverse in
    the ordinary history. An MCP edit therefore undoes like a typed one, expires
    like any proposal, and is re-validated against the head on approval.

    Three refusals worth naming:

    - **No model is called.** Not "avoided where possible" — there is no client
      in this function to call.
    - **The caller cannot declare a tier**, so it cannot mark its own change low
      risk and skip the human.
    - **The caller cannot claim to be an internal agent.** The label it gives is
      prefixed, so an approval prompt saying `mcp:codex` cannot be produced by
      anything but this route.
    """
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )

    # Checked before anything is created. The actual write is still conditional
    # on this version in `store.commit_transaction`, so this is the honest error,
    # not the concurrency guarantee.
    head = store.load_presentation(session, presentation_id)
    if head.version_id != request.expected_version_id:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "This deck has changed since you read it. Read it again and re-author "
                    "the change against the current version."
                ),
                "code": "E310",
                "current_version_id": head.version_id,
            },
        )

    try:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=request.operations,
            intent=request.intent,
            created_by=principal.user_id,
            # Prefixed, always. `agent_id` reaches the approval UI, and "editor"
            # there would tell a user the product's own edit agent proposed
            # something an external client did.
            agent_id=f"mcp:{request.client_label}"[:120],
            reason=request.reason,
            # Checked again where the base is loaded. The head check above is a
            # clear early error; this is the one that cannot be raced, because
            # `create_proposal` reads the document itself.
            expected_version_id=request.expected_version_id,
        )
    except proposals.ProposalError as error:
        # 409 rather than 400: the usual cause is that the deck moved under the
        # caller — an operation addressing an element that is no longer there —
        # which is a conflict to re-read and retry, not a malformed request.
        raise HTTPException(
            status_code=409, detail={"message": str(error), "code": error.code}
        ) from error

    return AuthoredProposalResponse(
        run_id="",  # No run: nothing was generated, so there is nothing to trace.
        status="completed",
        outcome=outcome["status"],
        transaction_id=outcome["transaction_id"],
        version_id=outcome.get("version_id"),
        document=outcome.get("document"),
        preview=outcome.get("preview"),
        risk_tier=outcome["risk_tier"],
        reasons=outcome.get("reasons") or [],
        changes=[],
        warnings=[],
        expires_at=outcome.get("expires_at"),
    )


# ---------------------------------------------------------------- proposals


@router.get("/presentations/{presentation_id}/proposals", response_model=list[ProposalSummary])
def list_proposals(
    presentation_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[ProposalSummary]:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.VIEWER
    )
    return [_summary(row) for row in proposals.pending(session, presentation_id)]


class ProposalDetail(ProposalSummary):
    """One pending change with its operations (editor Phase 6).

    The panel shows a proposal as Before and After pictures. It draws both from
    the deck on screen with the editor's own renderer: "after" is the deck the
    person is looking at with this change applied, which is what approving
    means. For that it needs the operations, which the list leaves out so a poll
    stays small.
    """

    operations: list[dict[str, Any]]
    #: The version the change was written against. When the head has moved past
    #: it the change may still apply, but it is not the change as written, and
    #: approval asks for a fresh look.
    base_version_id: str | None


@router.get(
    "/presentations/{presentation_id}/proposals/{proposal_id}", response_model=ProposalDetail
)
def get_proposal(
    presentation_id: str,
    proposal_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ProposalDetail:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.VIEWER
    )
    row = session.get(TransactionRow, proposal_id)
    # Pending only, and only this deck's: an applied transaction is history,
    # read through the version routes, and another deck's is not this caller's.
    if row is None or row.presentation_id != presentation_id or row.status != "pending":
        raise HTTPException(status_code=404, detail="No such pending change.")
    return ProposalDetail(
        **_summary(row).model_dump(),
        operations=list(row.operations_json or []),
        base_version_id=row.parent_version_id,
    )


class ApprovalRequest(BaseModel):
    """Which version the approver was looking at when they said yes.

    Optional, and when it is absent the proposal's own base is used instead — so
    a deck that moved since the proposal was made is refused rather than applied
    to something nobody reviewed. A client that has shown the user the deck as it
    stands sends the version it showed, and the approval goes through.
    """

    expected_version_id: str | None = Field(default=None, max_length=64)


@router.post("/presentations/{presentation_id}/proposals/{proposal_id}/approve")
def approve_proposal(
    presentation_id: str,
    proposal_id: str,
    request: ApprovalRequest | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR
    )

    try:
        return proposals.approve(
            session,
            presentation_id=presentation_id,
            transaction_id=proposal_id,
            approved_by=principal.user_id,
            expected_version_id=(request.expected_version_id if request else None),
        )
    except proposals.ProposalError as error:
        code = 404 if error.code == "E404" else 409
        raise HTTPException(status_code=code, detail={"message": str(error), "code": error.code}) from error


class WithdrawalRequest(BaseModel):
    #: The label the agent proposed under, without the `mcp:` prefix.
    client_label: str = Field(min_length=1, max_length=60)


@router.post("/presentations/{presentation_id}/proposals/{proposal_id}/withdraw")
def withdraw_proposal(
    presentation_id: str,
    proposal_id: str,
    request: WithdrawalRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ProposalSummary:
    """An external agent takes back its own pending change (`proposals.withdraw`).

    `write`, not `approve`: nothing is applied and nobody else's work is
    decided. Nothing is written to project memory either — the agent changed
    its mind, which says nothing about what the person wants.
    """
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR
    )
    try:
        row = proposals.withdraw(
            session,
            presentation_id=presentation_id,
            transaction_id=proposal_id,
            agent_id=f"mcp:{request.client_label}"[:120],
        )
    except proposals.ProposalError as error:
        code = {"E404": 404, "E403": 403}.get(error.code, 409)
        raise HTTPException(status_code=code, detail={"message": str(error), "code": error.code}) from error
    return _summary(row)


@router.post("/presentations/{presentation_id}/proposals/{proposal_id}/reject")
def reject_proposal(
    presentation_id: str,
    proposal_id: str,
    decision: ProposalDecision,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ProposalSummary:
    """Decline a proposal, and remember that it was declined.

    The memory write is the point of recording a reason at all: a Critic that
    proposes the same rejected change every run is a Critic people stop reading
    (gap register doc 03 S2).
    """
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR
    )

    try:
        row = proposals.reject(
            session,
            presentation_id=presentation_id,
            transaction_id=proposal_id,
            reason=decision.reason,
        )
    except proposals.ProposalError as error:
        code = 404 if error.code == "E404" else 409
        raise HTTPException(status_code=code, detail={"message": str(error), "code": error.code}) from error

    memory = ProjectMemory(
        agent_store.SqlMemoryStore(session, principal.user_id), _project_of(session, presentation_id)
    )
    memory.record_rejected_proposal(row.intent, decision.reason or "")

    return _summary(row)


# ----------------------------------------------------------------- streaming


@router.get("/runs/{run_id}/events")
def run_events(
    run_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Watch a run over Server-Sent Events (doc 03 §20).

    Events are relayed from the Redis channel the run publishes to. Without Redis
    the endpoint still answers — with the run's final state — rather than hanging:
    a stream that never produces anything is indistinguishable from a run that
    never started, which is the exact confusion progress events exist to remove.
    """
    run = agent_store.get_run(session, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run.")
    if run.presentation_id:
        resolve_presentation_access(
            session,
            user_id=principal.user_id,
            presentation_id=run.presentation_id,
            require=Role.VIEWER,
        )
    elif run.created_by != principal.user_id:
        raise HTTPException(status_code=404, detail="No such run.")

    redis_url = os.environ.get("REDIS_URL")

    def final_only() -> Any:
        payload = {
            "run_id": run_id,
            "stage": run.stage or "done",
            "status": "completed" if run.status == "completed" else run.status,
            "message": f"Run {run.status}.",
        }
        yield f"event: {payload['status']}\ndata: {json.dumps(payload)}\n\n"

    if not redis_url:
        return StreamingResponse(final_only(), media_type="text/event-stream")

    def relay() -> Any:
        import redis

        client = redis.Redis.from_url(redis_url)
        pubsub = client.pubsub()
        pubsub.subscribe(f"deckastra:run:{run_id}")
        try:
            for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                data = message["data"]
                text = data.decode() if isinstance(data, bytes) else str(data)
                event = json.loads(text)
                yield f"event: {event.get('status', 'progress')}\ndata: {text}\n\n"
                if event.get("stage") in {"propose", "done"} and event.get("status") == "completed":
                    break
        finally:
            pubsub.close()

    return StreamingResponse(relay(), media_type="text/event-stream")


@router.get("/presentations/{presentation_id}/runs")
def list_runs(
    presentation_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.VIEWER
    )

    return [
        {
            "id": run.id,
            "status": run.status,
            "stage": run.stage,
            "intent": run.intent,
            "warnings": run.warnings_json or [],
            "errors": run.errors_json or [],
            "budget": run.budget_json or {},
            "created_at": run.created_at.isoformat() if run.created_at else "",
        }
        for run in agent_store.recent_runs(session, presentation_id)
    ]
