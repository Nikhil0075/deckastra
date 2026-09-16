"""The outbox: what this device owes a server, and the order it owes it in (D5.2).

D5.0 asked whether a transaction log replays onto another store and answered yes
for content and **no for version identity** — `commit_transaction` mints its own
`ver_…` and takes none from a caller. That left one decision, and this module is
it: idempotency keys on a **change key**, not on a version id.

The reason is divergence, which is the case sync exists for. Two devices edit the
same deck offline; one uploads first, and the second's change is applied behind
it and lands at a different version than it did locally. A key naming the version
is wrong the moment that happens — the retry would look like a new change and
apply twice. A key naming the *change* survives being rebased, because the change
is the same change wherever it ends up.

Three rules hold the rest together:

* **The outbox row is written in the same database transaction as the change it
  describes.** A device that committed a version and enqueued it afterwards loses
  the enqueue to any crash in between, silently — the deck looks right locally and
  simply never reaches anyone. `store.commit_transaction` writes both inside its
  own savepoint, so there is no path that produces a syncable change without its
  row.
* **A deck's changes upload in order, and a stuck deck blocks only itself.** The
  log is a sequence, not a set: an operation can address an element an earlier one
  created, and an array `move` means whatever the array held at that moment. So a
  failure stops that deck's queue where it stands. Another deck is a different
  sequence and keeps going.
* **Nothing is ever abandoned.** There is no `failed` state. A change that cannot
  upload is something a person has to be shown (D5.3), and a queue that quietly
  gave up would lose exactly what it exists to protect.

What is deliberately *not* here: a client that talks to a cloud server. There is
no such server yet and no sign-in to reach one, so `drain` takes the send as a
callable. That keeps the ordering, retry and idempotency behaviour testable now
rather than arriving untested alongside a transport later.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db.models import (
    Presentation,
    PresentationVersion,
    Project,
    SyncOutboxRow,
    TransactionRow,
    Workspace,
)
from .ids import new_id

#: Workspaces whose decks have somewhere to go. A `local` workspace is this
#: machine's own (D5.1) and its decks are never enqueued: an outbox full of
#: changes for decks that will never sync is a queue nobody can read.
SYNCING_ORIGIN = "cloud"

#: How long to wait after each failed attempt. The last entry repeats forever,
#: because a change that has failed twenty times is usually waiting on something
#: only a person can fix — a revoked membership, a deck deleted upstream — and
#: retrying it every five seconds until then is just noise in a log.
BACKOFF_SECONDS = (5, 30, 120, 600, 1800)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(moment: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; comparing one to an aware one raises."""
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=timezone.utc)


# ------------------------------------------------------------------ what to send


@dataclass(frozen=True)
class Outgoing:
    """One thing to upload, assembled from local rows.

    Deliberately a value rather than the ORM row: a transport is handed what to
    send, not a live session it could write through. It also means the retry and
    ordering behaviour can be exercised against a list of these.
    """

    change_key: str
    kind: str
    presentation_id: str
    #: `create` only — the deck as its first version holds it.
    document: dict[str, Any] | None = None
    #: `change` only.
    operations: list[dict[str, Any]] = field(default_factory=list)
    inverse_operations: list[dict[str, Any]] = field(default_factory=list)
    intent: str = ""
    source: str = "user"
    #: The version this change was authored against, in *local* ids. The server
    #: cannot resolve it — the two chains share no version identity — so it
    #: travels as evidence for divergence review rather than as an address.
    local_parent_version_id: str | None = None


class Send(Protocol):
    """Hand one change to a server and answer where it landed.

    Raising is the failure signal, because that is what a transport does. The
    answer is the *remote* version id: recording it is how this device can later
    say "the change I called X is version Y over there", which is the only way
    two chains that share no version identity can be talked about at all.
    """

    def __call__(self, outgoing: Outgoing) -> str | None: ...


# ---------------------------------------------------------------- does it sync


def workspace_origin(session: Session, workspace_id: str) -> str | None:
    """Where one workspace keeps its authority (D5.1), or None if it is gone."""
    return session.scalar(
        select(Workspace.origin).where(Workspace.id == workspace_id)
    )


def origin_of(session: Session, presentation_id: str) -> str | None:
    """Where the deck's workspace keeps its authority, or None if it is gone."""
    return session.scalar(
        select(Workspace.origin)
        .join(Project, Project.workspace_id == Workspace.id)
        .join(Presentation, Presentation.project_id == Project.id)
        .where(Presentation.id == presentation_id)
    )


def syncs(session: Session, presentation_id: str) -> bool:
    return origin_of(session, presentation_id) == SYNCING_ORIGIN


def new_change_key() -> str:
    return new_id("chg")


# -------------------------------------------------------------------- enqueuing


def enqueue(
    session: Session,
    *,
    presentation_id: str,
    kind: str,
    change_key: str,
    transaction_id: str | None = None,
) -> SyncOutboxRow | None:
    """Add one row, or nothing if this deck has nowhere to send it.

    Callers do not check `syncs()` first on purpose. A caller that had to ask
    before enqueuing is a caller that can forget to, and this is the function
    every write path goes through.
    """
    if not syncs(session, presentation_id):
        return None

    row = SyncOutboxRow(
        id=new_id("out"),
        presentation_id=presentation_id,
        kind=kind,
        transaction_id=transaction_id,
        change_key=change_key,
        status="pending",
        attempts=0,
    )
    session.add(row)
    return row


def pending_for(session: Session, presentation_id: str) -> list[SyncOutboxRow]:
    """This deck's unsent rows, oldest first."""
    return list(
        session.scalars(
            select(SyncOutboxRow)
            .where(
                SyncOutboxRow.presentation_id == presentation_id,
                SyncOutboxRow.status == "pending",
            )
            # `id` breaks ties: two changes committed in the same instant still
            # have one order, and a log replayed in another order is a different
            # deck (D5.0).
            .order_by(SyncOutboxRow.created_at, SyncOutboxRow.id)
        )
    )



# ------------------------------------------------------------------- assembling


def _outgoing(session: Session, row: SyncOutboxRow) -> Outgoing:
    if row.kind == "create":
        # The deck **as it was created**, not as it is now. Every change since is
        # its own row queued behind this one, so uploading the current state here
        # would apply all of them twice — once inside the snapshot and once as
        # themselves. The first version always carries a full snapshot
        # (`create_presentation`), so there is nothing to replay to find it.
        document = session.scalar(
            select(PresentationVersion.snapshot_json).where(
                PresentationVersion.presentation_id == row.presentation_id,
                PresentationVersion.parent_version_id.is_(None),
            )
        )
        if document is None:
            raise LookupError(f"Outbox row {row.id} names a deck with no first version.")
        return Outgoing(
            change_key=row.change_key,
            kind="create",
            presentation_id=row.presentation_id,
            document=document,
        )

    transaction = session.get(TransactionRow, row.transaction_id)
    if transaction is None:
        raise LookupError(f"Outbox row {row.id} names a transaction that is gone.")

    return Outgoing(
        change_key=row.change_key,
        kind="change",
        presentation_id=row.presentation_id,
        operations=list(transaction.operations_json or []),
        inverse_operations=list(transaction.inverse_operations_json or []),
        intent=transaction.intent,
        source=transaction.source,
        local_parent_version_id=transaction.parent_version_id,
    )


# ----------------------------------------------------------------- the draining


@dataclass
class DrainReport:
    sent: int = 0
    failed: int = 0
    #: Decks left with work, either because one failed or because it is waiting
    #: out a backoff. Named rather than counted: the UI that shows "3 changes
    #: waiting" has to be able to say which deck.
    waiting: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def drain(
    session: Session,
    send: Send,
    *,
    now: Callable[[], datetime] = _now,
    limit_per_deck: int = 100,
) -> DrainReport:
    """Upload what is waiting, in order, stopping each deck at its first failure.

    One pass. A caller decides how often to make one; this has no timer in it,
    because a loop in here would be a second scheduler beside the one the desktop
    already runs.
    """
    report = DrainReport()
    moment = now()

    decks = list(
        session.scalars(
            select(SyncOutboxRow.presentation_id)
            .where(SyncOutboxRow.status == "pending")
            .distinct()
            .order_by(SyncOutboxRow.presentation_id)
        )
    )

    for presentation_id in decks:
        rows = pending_for(session, presentation_id)[:limit_per_deck]
        for row in rows:
            ready_at = _aware(row.next_attempt_at)
            if ready_at is not None and ready_at > moment:
                # Not this row, and therefore not this deck: everything behind it
                # is behind it for a reason.
                report.waiting.append(presentation_id)
                break

            try:
                remote_version_id = send(_outgoing(session, row))
            except Exception as error:  # noqa: BLE001 - any transport failure is a retry
                row.attempts += 1
                row.last_error = f"{type(error).__name__}: {error}"[:2000]
                delay = BACKOFF_SECONDS[min(row.attempts - 1, len(BACKOFF_SECONDS) - 1)]
                row.next_attempt_at = moment + timedelta(seconds=delay)
                report.failed += 1
                report.errors.append(row.last_error)
                report.waiting.append(presentation_id)
                # Stop this deck here. The next change may address something this
                # one created, so sending it now would ask the server to apply an
                # operation against a document that never received its predecessor.
                break

            row.status = "sent"
            row.sent_at = moment
            row.last_error = None
            row.next_attempt_at = None
            row.remote_version_id = remote_version_id
            report.sent += 1

    session.flush()
    return report
