"""Presentation persistence: snapshot + operation log (doc 05 §22).

Saving a full copy of a 12 MB document for every nudge of an element is the thing
this design exists to avoid. Instead:

* every applied transaction produces a *version* row carrying only its operations,
* a full `snapshot_json` is written periodically and around agent runs,
* reading a document means loading the nearest snapshot and replaying forward.

The replay is what makes it trustworthy: the same patch code that applied the
operations the first time applies them again, so a reconstructed document cannot
diverge from what the editor saw.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .db.models import Presentation, PresentationVersion, TransactionRow
from .ids import new_id
from .patch import PatchError, apply_patch

# How many operation-only versions may accumulate before the next full snapshot.
# Low enough that a cold read replays a handful of patches, high enough that the
# snapshot column is not written on every keystroke.
SNAPSHOT_EVERY = 25


class StoreError(RuntimeError):
    """Base for store failures that the API turns into 4xx rather than 500."""


class NotFound(StoreError):
    pass


class VersionConflict(StoreError):
    """The caller's `expectedVersionId` is not the current head.

    Raised rather than last-write-wins. Silently overwriting someone else's change
    is the worst possible failure for a document product (doc 04 §30.2), so a
    conflict is surfaced and the caller re-reads.
    """

    def __init__(self, expected: str | None, actual: str | None) -> None:
        super().__init__(
            f"This deck has changed since you loaded it "
            f"(you have {expected or 'nothing'}, the current version is {actual or 'nothing'}). "
            f"Reload and try again."
        )
        self.expected = expected
        self.actual = actual


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class LoadedPresentation:
    document: dict[str, Any]
    version_id: str
    presentation_id: str
    title: str


def create_presentation(
    session: Session,
    *,
    project_id: str,
    document: dict[str, Any],
    created_by: str,
    source: str = "user",
) -> LoadedPresentation:
    """Insert a presentation and its first version.

    The first version always carries a full snapshot — there is nothing to replay
    from otherwise.
    """
    presentation_id = document["id"]
    version_id = new_id("ver")

    session.add(
        Presentation(
            id=presentation_id,
            project_id=project_id,
            title=document["metadata"]["title"],
            current_version_id=version_id,
            schema_version=document["schemaVersion"],
        )
    )
    session.add(
        PresentationVersion(
            id=version_id,
            presentation_id=presentation_id,
            parent_version_id=None,
            snapshot_json=document,
            ops_since_snapshot=0,
            created_by=created_by,
            source=source,
            label="Created",
        )
    )
    session.flush()

    return LoadedPresentation(
        document=document,
        version_id=version_id,
        presentation_id=presentation_id,
        title=document["metadata"]["title"],
    )


def load_presentation(
    session: Session,
    presentation_id: str,
    *,
    at_version: str | None = None,
) -> LoadedPresentation:
    """Read a document, replaying forward from the nearest snapshot.

    `at_version` reads a historical state — the same walk, stopping earlier. That
    is the whole point of keeping the operation log rather than only the head.
    """
    presentation = session.get(Presentation, presentation_id)
    if presentation is None:
        raise NotFound(f"No presentation {presentation_id}")

    target = at_version or presentation.current_version_id
    if target is None:
        raise NotFound(f"Presentation {presentation_id} has no versions")

    chain = _chain_to_snapshot(session, presentation_id, target)
    snapshot_version = chain[0]

    if snapshot_version.snapshot_json is None:
        raise StoreError(
            f"Version {snapshot_version.id} should carry a snapshot but does not. "
            f"The version chain for {presentation_id} is broken."
        )

    document: dict[str, Any] = snapshot_version.snapshot_json

    # Replay through the same patch code that produced these versions. Any other
    # implementation here could drift from what the editor actually saw.
    for version in chain[1:]:
        transaction = session.scalar(
            select(TransactionRow).where(TransactionRow.result_version_id == version.id)
        )
        if transaction is None:
            raise StoreError(
                f"Version {version.id} has no transaction to replay. "
                f"The history for {presentation_id} is incomplete."
            )
        try:
            document, _ = apply_patch(document, transaction.operations_json)
        except PatchError as error:  # pragma: no cover - corruption, not a normal path
            raise StoreError(
                f"Replaying transaction {transaction.id} failed: {error}"
            ) from error

    return LoadedPresentation(
        document=document,
        version_id=target,
        presentation_id=presentation_id,
        title=presentation.title,
    )


def _chain_to_snapshot(
    session: Session, presentation_id: str, target_version_id: str
) -> list[PresentationVersion]:
    """Walk back to the nearest snapshot, returning [snapshot, ..., target]."""
    versions_by_id = {
        version.id: version
        for version in session.scalars(
            select(PresentationVersion).where(
                PresentationVersion.presentation_id == presentation_id
            )
        )
    }

    chain: list[PresentationVersion] = []
    cursor: str | None = target_version_id

    while cursor is not None:
        version = versions_by_id.get(cursor)
        if version is None:
            raise NotFound(f"Version {cursor} is missing from {presentation_id}")

        chain.append(version)
        if version.snapshot_json is not None:
            break
        cursor = version.parent_version_id

    if chain and chain[-1].snapshot_json is None:
        raise StoreError(
            f"Walked to the root of {presentation_id} without finding a snapshot."
        )

    chain.reverse()
    return chain


@dataclass(frozen=True)
class CommitResult:
    document: dict[str, Any]
    version_id: str
    transaction_id: str
    snapshotted: bool


def commit_transaction(
    session: Session,
    *,
    presentation_id: str,
    operations: list[dict[str, Any]],
    inverse_operations: list[dict[str, Any]],
    document: dict[str, Any],
    parent_version_id: str,
    expected_version_id: str | None,
    intent: str,
    source: str,
    created_by: str,
    agent_id: str | None = None,
    client_id: str | None = None,
    user_instruction: str | None = None,
    reason: str | None = None,
    confidence: float | None = None,
    risk_tier: str | None = None,
    label: str | None = None,
) -> CommitResult:
    """Record an already-applied patch as a new version.

    The patch is applied by the caller (which holds the document); this writes the
    result. `expected_version_id` is checked here because only the store knows the
    current head.
    """
    presentation = session.get(Presentation, presentation_id)
    if presentation is None:
        raise NotFound(f"No presentation {presentation_id}")

    parent = session.get(PresentationVersion, parent_version_id)
    if parent is None or parent.presentation_id != presentation_id:
        raise NotFound(f"No version {parent_version_id} for {presentation_id}")

    # A snapshot every N operations keeps a cold read to a handful of replays, and
    # writing one around an agent run means a bad generation can be rolled back to
    # a known-good state without replaying through it.
    ops_since = parent.ops_since_snapshot + 1
    take_snapshot = ops_since >= SNAPSHOT_EVERY or source == "agent"

    # The loaded ORM head can be stale while another request commits. Advance
    # it with one conditional UPDATE, including the actual composition base even
    # when the caller omitted its optional expected-version token. A savepoint
    # removes the losing candidate/history if the caller catches the conflict
    # and commits other work in its outer transaction.
    connection = session.connection()
    if connection.dialect.name == "sqlite" and not connection.connection.driver_connection.in_transaction:
        # sqlite3's legacy transaction mode does not BEGIN on SELECT/SAVEPOINT.
        # Without an actual outer transaction, releasing the savepoint commits
        # the write even if the request subsequently rolls back.
        connection.exec_driver_sql("BEGIN")
    with session.begin_nested():
        version_id = new_id("ver")
        session.add(
            PresentationVersion(
                id=version_id,
                presentation_id=presentation_id,
                parent_version_id=parent_version_id,
                snapshot_json=document if take_snapshot else None,
                ops_since_snapshot=0 if take_snapshot else ops_since,
                created_by=created_by,
                source=source,
                label=label or intent[:200],
            )
        )

        transaction_id = new_id("txn")
        session.add(
            TransactionRow(
                id=transaction_id,
                presentation_id=presentation_id,
                status="applied",
                parent_version_id=parent_version_id,
                result_version_id=version_id,
                source=source,
                agent_id=agent_id,
                client_id=client_id,
                user_instruction=user_instruction,
                intent=intent,
                operations_json=operations,
                inverse_operations_json=inverse_operations,
                reason=reason,
                confidence=confidence,
                risk_tier=risk_tier,
                created_by=created_by,
                applied_at=_now(),
            )
        )

        session.flush()
        advance = update(Presentation).where(
            Presentation.id == presentation_id,
            Presentation.current_version_id == parent_version_id,
        )
        if expected_version_id is not None:
            advance = advance.where(Presentation.current_version_id == expected_version_id)
        changed = session.execute(advance.values(
            current_version_id=version_id, title=document["metadata"]["title"],
        ).execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            actual = session.scalar(select(Presentation.current_version_id).where(
                Presentation.id == presentation_id,
            ))
            raise VersionConflict(expected_version_id or parent_version_id, actual)
    session.expire(presentation, ["current_version_id", "title"])

    return CommitResult(
        document=document,
        version_id=version_id,
        transaction_id=transaction_id,
        snapshotted=take_snapshot,
    )


def create_pending_transaction(
    session: Session,
    *,
    presentation_id: str,
    operations: list[dict[str, Any]],
    inverse_operations: list[dict[str, Any]],
    parent_version_id: str,
    intent: str,
    created_by: str,
    agent_id: str | None = None,
    reason: str | None = None,
    confidence: float | None = None,
    risk_tier: str | None = None,
) -> str:
    """Store a proposal without applying it (doc 02 §31.6).

    No version row: nothing happened to the document yet. That is the distinction
    the `status` column exists to record.
    """
    transaction_id = new_id("txn")
    session.add(
        TransactionRow(
            id=transaction_id,
            presentation_id=presentation_id,
            status="pending",
            parent_version_id=parent_version_id,
            result_version_id=None,
            source="agent",
            agent_id=agent_id,
            intent=intent,
            operations_json=operations,
            inverse_operations_json=inverse_operations,
            reason=reason,
            confidence=confidence,
            risk_tier=risk_tier,
            created_by=created_by,
        )
    )
    session.flush()
    return transaction_id


def transaction_history(
    session: Session,
    presentation_id: str,
    *,
    limit: int = 50,
    status: str | None = None,
) -> list[TransactionRow]:
    query = select(TransactionRow).where(TransactionRow.presentation_id == presentation_id)
    if status:
        query = query.where(TransactionRow.status == status)
    return list(
        session.scalars(query.order_by(TransactionRow.created_at.desc()).limit(limit))
    )


def get_transaction(session: Session, transaction_id: str) -> TransactionRow:
    row = session.get(TransactionRow, transaction_id)
    if row is None:
        raise NotFound(f"No transaction {transaction_id}")
    return row


def version_history(
    session: Session, presentation_id: str, *, limit: int = 50
) -> list[PresentationVersion]:
    return list(
        session.scalars(
            select(PresentationVersion)
            .where(PresentationVersion.presentation_id == presentation_id)
            .order_by(PresentationVersion.created_at.desc())
            .limit(limit)
        )
    )
