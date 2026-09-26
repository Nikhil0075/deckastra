"""The proposal lifecycle (doc 02 §31.6, doc 01 §11.2).

An agent's change does not happen because the agent decided it should. It becomes
a *pending* transaction, a human sees what it would do, and only then does it
apply. That is proposal-before-apply, and it is a property of this module rather
than of an agent's good behaviour — an agent that wanted to bypass it has nothing
to call.

Four rules, each of which exists because the alternative is a real failure:

- **Risk is computed here, from the operations** (doc 02 §31.7). A caller-declared
  tier is a caller-controlled security boundary.
- **A low-risk change applies immediately.** Asking a human to approve a typo fix
  trains them to approve without reading, which is worse than not asking.
- **A proposal expires after 24 hours** and is re-validated on approval. The
  document moves; a patch approved against a week-old preview would apply to
  something the user never saw.
- **Approving re-runs validation, not just the patch.** A patch can still apply
  cleanly and produce an invalid document.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from . import store
from .db.models import TransactionRow
from .ids import new_id
from .patch import PatchError, apply_patch
from .risk import assess_risk
from .schema import validate_document

#: Doc 02 §31.6. Long enough to come back after a meeting, short enough that a
#: forgotten proposal does not apply against a document that has moved on.
PROPOSAL_TTL = timedelta(hours=24)


class ProposalError(RuntimeError):
    """A proposal could not be created, approved or rejected, with the reason."""

    def __init__(self, message: str, *, code: str = "E300") -> None:
        super().__init__(message)
        self.code = code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    """Normalise a timestamp read back from SQLite, which drops the timezone."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def create_proposal(
    session: Session,
    *,
    presentation_id: str,
    operations: list[dict[str, Any]],
    intent: str,
    created_by: str,
    run_id: str | None = None,
    agent_id: str | None = None,
    reason: str | None = None,
    confidence: float | None = None,
    source_ids: list[str] | None = None,
    user_instruction: str | None = None,
    expected_version_id: str | None = None,
) -> dict[str, Any]:
    """Record an agent's change, applying it now or parking it for approval.

    Returns what the caller needs to answer the request: the transaction, whether
    it applied, and — when it did not — the document it *would* produce, so the
    editor can show a preview without a second round trip.

    `expected_version_id` is the version the operations were authored against, and
    it is checked *here* rather than only by the caller. A route that checked the
    head and then called this was checking a different read: this function loads
    the document again, and anything committed in between — a user typing — was
    silently accepted as the base. The check has to live where the base is loaded.
    """
    loaded = store.load_presentation(session, presentation_id)
    if expected_version_id is not None and loaded.version_id != expected_version_id:
        # Before anything is written: a refused proposal must leave no transaction
        # and no version behind for someone to wonder about later.
        raise ProposalError(
            "This deck changed while the change was being prepared. Read it again and "
            "re-author the change against the current version.",
            code="E310",
        )
    assessment = assess_risk(operations)

    # Dry run first, always. A proposal that cannot apply is not a proposal, and
    # discovering that at approval time wastes the user's decision.
    try:
        preview, inverse = apply_patch(loaded.document, operations)
    except PatchError as error:
        raise ProposalError(f"The proposed change does not apply: {error}", code=error.code) from error

    errors = validate_document(preview)
    if errors:
        raise ProposalError(
            "The proposed change would produce an invalid document: " + "; ".join(errors[:3]),
            code="E001",
        )

    if not assessment.requires_approval:
        result = store.commit_transaction(
            session,
            presentation_id=presentation_id,
            operations=operations,
            inverse_operations=inverse,
            document=preview,
            parent_version_id=loaded.version_id,
            expected_version_id=loaded.version_id,
            intent=intent,
            source="agent",
            created_by=created_by,
            agent_id=agent_id,
            reason=reason,
            confidence=confidence,
            risk_tier=assessment.tier,
            user_instruction=user_instruction,
            label=intent[:200],
        )
        transaction = session.get(TransactionRow, result.transaction_id)
        if transaction is not None and run_id:
            transaction.run_id = run_id
        session.flush()

        return {
            "transaction_id": result.transaction_id,
            "status": "applied",
            "risk_tier": assessment.tier,
            "reasons": assessment.reasons,
            "version_id": result.version_id,
            "document": result.document,
            "preview": None,
            "expires_at": None,
        }

    transaction = TransactionRow(
        id=new_id("txn"),
        presentation_id=presentation_id,
        status="pending",
        parent_version_id=loaded.version_id,
        result_version_id=None,
        source="agent",
        agent_id=agent_id,
        intent=intent,
        operations_json=operations,
        inverse_operations_json=inverse,
        reason=reason,
        confidence=confidence,
        source_ids_json=source_ids,
        risk_tier=assessment.tier,
        created_by=created_by,
        user_instruction=user_instruction,
        expires_at=_now() + PROPOSAL_TTL,
        run_id=run_id,
    )
    session.add(transaction)
    session.flush()

    return {
        "transaction_id": transaction.id,
        "status": "pending",
        "risk_tier": assessment.tier,
        "reasons": assessment.reasons,
        "version_id": loaded.version_id,
        "document": None,
        # The preview is returned, not stored. Storing it would be storing a
        # second copy of the document that goes stale the moment anything changes.
        "preview": preview,
        "expires_at": transaction.expires_at.isoformat(),
    }


def expire_stale(session: Session, presentation_id: str) -> int:
    """Mark overdue proposals expired. Called before any read of the pending list.

    Lazily rather than on a schedule: a background sweeper is a second thing to
    deploy and monitor, and the only moment staleness matters is when someone
    looks.
    """
    now = _now()
    stale = (
        session.query(TransactionRow)
        .filter(
            TransactionRow.presentation_id == presentation_id,
            TransactionRow.status == "pending",
        )
        .all()
    )

    expired = 0
    for transaction in stale:
        deadline = _aware(transaction.expires_at)
        if deadline is not None and deadline <= now:
            transaction.status = "expired"
            expired += 1

    if expired:
        session.flush()
    return expired


def pending(session: Session, presentation_id: str) -> list[TransactionRow]:
    expire_stale(session, presentation_id)
    return (
        session.query(TransactionRow)
        .filter(
            TransactionRow.presentation_id == presentation_id,
            TransactionRow.status == "pending",
        )
        .order_by(TransactionRow.created_at.asc())
        .all()
    )


def approve(
    session: Session,
    *,
    presentation_id: str,
    transaction_id: str,
    approved_by: str,
    expected_version_id: str | None = None,
) -> dict[str, Any]:
    """Apply a pending proposal, against the version the approver actually saw.

    Re-validating the patch is necessary and was not sufficient. A patch can still
    apply cleanly to a document that has moved since the preview a human said yes
    to — different words on the slide, a different neighbouring element — and
    applying it then is applying a change to something the approver never saw,
    which is the one thing this whole lifecycle exists to prevent.

    So a head that has moved past the proposal's own base is refused, and the way
    through is to look again: pass `expected_version_id` — the version the
    approver was shown — and it applies only if that is still the head. A blanket
    refusal would have been wrong in the other direction, since an unrelated edit
    elsewhere in the deck would strand every pending proposal with no way to
    accept it.
    """
    transaction = session.get(TransactionRow, transaction_id)
    if transaction is None or transaction.presentation_id != presentation_id:
        raise ProposalError("No such proposal.", code="E404")

    if transaction.status != "pending":
        raise ProposalError(
            f"This proposal is {transaction.status}, not pending.", code="E409"
        )

    deadline = _aware(transaction.expires_at)
    if deadline is not None and deadline <= _now():
        transaction.status = "expired"
        session.flush()
        raise ProposalError(
            "This proposal expired. Ask for the change again against the current deck.",
            code="E410",
        )

    loaded = store.load_presentation(session, presentation_id)

    reviewed = expected_version_id or transaction.parent_version_id
    if reviewed is not None and loaded.version_id != reviewed:
        raise ProposalError(
            "This deck has changed since this proposal was reviewed. Look at it again, "
            "then approve against the version you have seen.",
            code="E310",
        )

    try:
        document, inverse = apply_patch(loaded.document, transaction.operations_json)
    except PatchError as error:
        # Refused rather than half-applied: the alternative is a document in a
        # state nobody asked for (doc 04 §29.3).
        raise ProposalError(
            "This change no longer applies — the deck has changed since it was "
            f"proposed. ({error})",
            code=error.code,
        ) from error

    errors = validate_document(document)
    if errors:
        raise ProposalError(
            "Applying this change would produce an invalid document: " + "; ".join(errors[:3]),
            code="E001",
        )

    result = store.commit_transaction(
        session,
        presentation_id=presentation_id,
        operations=transaction.operations_json,
        inverse_operations=inverse,
        document=document,
        parent_version_id=loaded.version_id,
        # The same version the check above proved the approver was looking at, so
        # the store's conditional UPDATE refuses anything that lands in between.
        expected_version_id=loaded.version_id,
        intent=transaction.intent,
        source="agent",
        created_by=approved_by,
        agent_id=transaction.agent_id,
        reason=transaction.reason,
        confidence=transaction.confidence,
        risk_tier=transaction.risk_tier,
        user_instruction=transaction.user_instruction,
        label=transaction.intent[:200],
    )

    # The pending row records that it was approved and points at the applied one.
    # Deleting it would lose the fact that a human said yes, which is the part
    # worth keeping.
    transaction.status = "applied"
    transaction.result_version_id = result.version_id
    transaction.applied_at = _now()
    session.flush()

    return {
        "transaction_id": result.transaction_id,
        "proposal_id": transaction.id,
        "version_id": result.version_id,
        "document": result.document,
        "risk_tier": transaction.risk_tier or "medium",
    }


def withdraw(
    session: Session, *, presentation_id: str, transaction_id: str, agent_id: str
) -> TransactionRow:
    """An external agent takes back a change it proposed and the person has not yet decided.

    Declining is the person's (`reject`, which needs `approve`); taking back
    one's own offer is not a decision about someone else's work, so it needs
    only `write`. Two rules keep it that narrow:

    - **Only an external agent's proposal**, never one the product's own agents
      made: those are the person's to decide, and an MCP client withdrawing one
      would be deciding on their behalf.
    - **Only the agent that proposed it**, by label. The label is not an
      authenticated identity — anything holding a grant can claim any label —
      so this stops one agent tidying away another's work by mistake rather than
      by design; the grant is the security boundary, and it cannot approve.

    Recorded as `rejected` with the reason saying who withdrew it, rather than
    as a status of its own: a withdrawn offer is a declined one, and a new
    status would mean rebuilding the transactions table on every install for a
    distinction the reason already carries. Kept, not deleted: "an agent
    offered this and took it back" is history someone may want to read.
    """
    transaction = session.get(TransactionRow, transaction_id)
    if transaction is None or transaction.presentation_id != presentation_id:
        raise ProposalError("No such proposal.", code="E404")
    if transaction.status != "pending":
        raise ProposalError(f"This proposal is {transaction.status}, not pending.", code="E409")
    if not (transaction.agent_id or "").startswith("mcp:"):
        raise ProposalError(
            "Only a proposal an external agent made can be withdrawn by one; the person decides this one.",
            code="E403",
        )
    if transaction.agent_id != agent_id:
        raise ProposalError("This proposal was made by a different agent.", code="E403")

    transaction.status = "rejected"
    transaction.reason = f"{transaction.reason or ''}\nWithdrawn by {agent_id}.".strip()
    session.flush()
    return transaction


def reject(
    session: Session, *, presentation_id: str, transaction_id: str, reason: str | None = None
) -> TransactionRow:
    transaction = session.get(TransactionRow, transaction_id)
    if transaction is None or transaction.presentation_id != presentation_id:
        raise ProposalError("No such proposal.", code="E404")

    if transaction.status != "pending":
        raise ProposalError(f"This proposal is {transaction.status}, not pending.", code="E409")

    transaction.status = "rejected"
    if reason:
        # Appended rather than overwritten: the agent's reason for proposing and
        # the human's reason for declining are different facts, and the second
        # one is what the Critic should learn from.
        transaction.reason = f"{transaction.reason or ''}\nRejected: {reason}".strip()
    session.flush()
    return transaction
