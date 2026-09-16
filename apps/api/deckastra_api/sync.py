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
    Asset,
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
class OutgoingAsset:
    """One uploaded file, described well enough to be re-registered elsewhere."""

    asset_id: str
    storage_key: str
    kind: str
    bytes: int
    filename: str | None = None
    content_type: str | None = None
    width: int | None = None
    height: int | None = None


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
    #: `asset` only — the file to upload, by reference rather than by value.
    #:
    #: The bytes are not in here on purpose: a transport that was handed a 20MB
    #: image inline would hold every queued picture in memory to send one. It gets
    #: the storage key and reads the bytes itself, the same way the exporter and
    #: the blob route do.
    asset: OutgoingAsset | None = None


class SyncRefused(Exception):
    """The server will not take this change as it stands (D5.3).

    Distinct from every other exception a transport can raise, and the
    distinction is the whole of divergence handling: an unreachable server is a
    retry, and a refusal is a question for a person. Retrying a refusal on a
    backoff is a loop with no exit — it will fail identically forever — and worse,
    it makes the deck look busy rather than stuck, so nobody is ever told that
    their work is not going anywhere.

    It carries what the server had, because reconciling needs three documents and
    two of them are already here. Keeping the third means a person who diverged
    with no network can still resolve it with no network, which is the behaviour a
    local-first product owes them.
    """

    def __init__(
        self,
        reason: str,
        *,
        remote_version_id: str | None = None,
        remote_document: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(reason)
        self.reason = reason
        self.remote_version_id = remote_version_id
        self.remote_document = remote_document


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
    asset_id: str | None = None,
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
        asset_id=asset_id,
        change_key=change_key,
        status="pending",
        attempts=0,
    )
    session.add(row)
    return row


def blocking_row(session: Session, presentation_id: str) -> SyncOutboxRow | None:
    """The refused change this deck is stopped at, if it has one (D5.3)."""
    return session.scalar(
        select(SyncOutboxRow).where(
            SyncOutboxRow.presentation_id == presentation_id,
            SyncOutboxRow.status == "blocked",
        )
    )


def enqueue_new_assets(session: Session, *, presentation_id: str, document: dict[str, Any]) -> int:
    """Queue the bytes of anything this deck cites that has not been queued yet.

    Called just **before** the change that made the document look like this, so
    the file is ahead of the operation naming it. That ordering is the whole
    point: a document arriving with an `assetId` the server has never received is
    a deck that is broken for everyone except the person who uploaded it, and it
    is broken in the way that looks like the product losing their picture.

    Diffed against what is already queued rather than derived from the patch.
    An operation can introduce a reference indirectly — a slide pasted whole, a
    group moved in, an undo restoring a removed image — and a differ that read
    only the operations would miss every one of those. `referenced_ids` walks the
    document, which is the same reason the asset recount does.
    """
    if not syncs(session, presentation_id):
        return 0

    from . import assets as asset_service

    cited = asset_service.referenced_ids(document)
    if not cited:
        return 0

    already = set(
        session.scalars(
            select(SyncOutboxRow.asset_id).where(
                SyncOutboxRow.presentation_id == presentation_id,
                SyncOutboxRow.kind == "asset",
            )
        )
    )

    queued = 0
    # Sorted, so two decks citing the same set queue them in one order and a
    # replayed log is reproducible.
    for asset_id in sorted(cited - already):
        if session.get(Asset, asset_id) is None:
            # A document can name an asset this workspace does not hold — an
            # imported deck, a stale manifest entry. Not an error: the renderer
            # already draws a placeholder for it, and refusing the whole change
            # would make one bad reference block every later edit to the deck.
            continue
        enqueue(
            session,
            presentation_id=presentation_id,
            kind="asset",
            change_key=new_change_key(),
            asset_id=asset_id,
        )
        queued += 1
    return queued


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

    if row.kind == "asset":
        asset = session.get(Asset, row.asset_id)
        if asset is None:
            raise LookupError(f"Outbox row {row.id} names a file that is gone.")
        return Outgoing(
            change_key=row.change_key,
            kind="asset",
            presentation_id=row.presentation_id,
            asset=OutgoingAsset(
                asset_id=asset.id,
                storage_key=asset.storage_key,
                kind=asset.kind,
                bytes=asset.bytes,
                filename=asset.filename,
                content_type=asset.content_type,
                width=asset.width,
                height=asset.height,
            ),
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
    #: Decks the server refused. Not a count, because the only useful thing to do
    #: with one is show the person which deck has diverged.
    blocked: list[str] = field(default_factory=list)
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
        if blocking_row(session, presentation_id) is not None:
            # Everything queued behind a refusal stays there. Sending the next
            # change would ask the server to apply an operation against a
            # document that never received its predecessor — and the person has
            # not yet said what should happen to the predecessor.
            report.blocked.append(presentation_id)
            continue

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
            except SyncRefused as refusal:
                # No attempt count, no backoff, no next attempt. This will not
                # succeed by being tried again, and a queue that keeps trying is
                # a queue that never tells anyone.
                row.status = "blocked"
                row.refused_reason = refusal.reason
                row.remote_version_id = refusal.remote_version_id
                row.remote_document_json = refusal.remote_document
                report.blocked.append(presentation_id)
                break
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


# ------------------------------------------------------------------- divergence


@dataclass(frozen=True)
class Divergence:
    """What a person needs in order to decide, assembled from local rows only."""

    change_key: str
    reason: str
    remote_version_id: str | None
    #: The local version the refused change was authored against — the **base**
    #: of the three-way merge. It is a local id, and it resolves locally, which is
    #: the only reason reconciling offline is possible at all.
    base_version_id: str | None
    intent: str


@dataclass(frozen=True)
class SyncState:
    """Where this deck stands with the server.

    Four states rather than a boolean, because "not in sync" covers two very
    different situations and only one of them needs a person: a queue that is
    merely waiting will clear itself, and a diverged one never will.
    """

    presentation_id: str
    #: `local` — this deck syncs nowhere (D5.1) and none of the rest applies.
    #: `in_sync` — nothing owed.
    #: `waiting` — changes queued, and they will go when the server answers.
    #: `diverged` — the server refused one, and it stays refused until someone
    #: decides what should happen.
    state: str
    pending: int
    diverged: Divergence | None = None


def status(session: Session, presentation_id: str) -> SyncState:
    if not syncs(session, presentation_id):
        return SyncState(presentation_id=presentation_id, state="local", pending=0)

    blocked = blocking_row(session, presentation_id)
    waiting = len(pending_for(session, presentation_id))

    if blocked is None:
        return SyncState(
            presentation_id=presentation_id,
            state="waiting" if waiting else "in_sync",
            pending=waiting,
        )

    transaction = (
        session.get(TransactionRow, blocked.transaction_id)
        if blocked.transaction_id
        else None
    )
    return SyncState(
        presentation_id=presentation_id,
        state="diverged",
        # The blocked change is owed too, and counting it with the rest is what
        # makes "5 changes waiting" true rather than "4 waiting and one you have
        # not been told about".
        pending=waiting + 1,
        diverged=Divergence(
            change_key=blocked.change_key,
            reason=blocked.refused_reason or "The server refused this change.",
            remote_version_id=blocked.remote_version_id,
            base_version_id=transaction.parent_version_id if transaction else None,
            intent=transaction.intent if transaction else "Create this deck",
        ),
    )


def remote_document(session: Session, presentation_id: str) -> dict[str, Any] | None:
    """The deck as the server had it when it refused, or None if not diverged.

    The third document of the merge. The other two — the base version and the
    local head — are ordinary local reads, so a reconciliation needs nothing from
    the network. That is deliberate: requiring the network to resolve a conflict
    caused by not having the network is backwards.
    """
    blocked = blocking_row(session, presentation_id)
    return blocked.remote_document_json if blocked is not None else None


class NotAResolution(Exception):
    """The version offered does not resolve this deck's divergence (D5.3)."""


def reconciled(
    session: Session, presentation_id: str, *, resolving_version_id: str
) -> int:
    """A person decided; let the queue move on (D5.3).

    The merged document is committed first, through the ordinary transaction
    path — there is no second write path, and a reconciliation undoes like any
    other edit. That commit enqueues itself normally. This then retires what it
    replaced.

    **What it may retire is bounded by the resolving change**, and the first
    version of this function got that wrong in three ways that a review found
    (2026-09-16), each of them silent loss:

    * It accepted any version belonging to the deck. The deck's own *pre-*
      divergence version belongs to the deck, so handing that back — with no
      merge made and nothing resolved — retired the whole queue and answered
      "in sync". The work stayed in the local document, which is what made it so
      bad: nothing looked wrong, and the changes were simply no longer owed to
      anyone. A resolution must be a change that sits **after** the refusal.
    * It retired everything queued at the moment of acknowledgement. But the
      merge happened earlier, and between the two a person can type, another
      window can save, an MCP client can apply a low-risk change. A merge cannot
      incorporate work that did not exist when it was made, so the boundary is
      the resolving change and not the wall clock.
    * It retired queued **assets**. Bytes the server has never received are not a
      change a merge could have incorporated, so retiring one leaves the
      reconciled deck citing a picture that will never be uploaded — whole for
      its author and broken for everyone else. They are never retired here. An
      upload for a picture the merge removed is then sent needlessly, which costs
      bytes once; the other way costs someone their image.

    The resolving change's own row is spared, which is the older subtlety:
    superseding it would strand the reconciliation on this device, the exact
    failure the person just did the work to avoid.
    """
    blocked = blocking_row(session, presentation_id)
    if blocked is None:
        raise NotAResolution("That deck has not diverged, so there is nothing to resolve.")

    resolving = session.scalar(
        select(SyncOutboxRow)
        .join(TransactionRow, TransactionRow.id == SyncOutboxRow.transaction_id)
        .where(
            SyncOutboxRow.presentation_id == presentation_id,
            TransactionRow.result_version_id == resolving_version_id,
        )
    )
    if resolving is None:
        raise NotAResolution(
            "That version is not a change this device still owes the server, so it "
            "cannot be the one that resolved the conflict. Commit the merged deck "
            "first, then say which version it produced."
        )

    def position(row: SyncOutboxRow) -> tuple:
        return (row.created_at, row.id)

    if position(resolving) <= position(blocked):
        # A change made before the refusal cannot have resolved it — it is one of
        # the things that needs resolving.
        raise NotAResolution(
            "That version predates the change the server refused, so it cannot be "
            "the resolution. Merge the two versions, commit the result, and name "
            "that version instead."
        )

    boundary = position(resolving)
    rows = session.scalars(
        select(SyncOutboxRow).where(
            SyncOutboxRow.presentation_id == presentation_id,
            SyncOutboxRow.status.in_(("pending", "blocked")),
        )
    )

    retired = 0
    for row in rows:
        if row.id == resolving.id:
            continue
        if row.kind == "asset":
            continue
        if position(row) > boundary:
            # Later than the merge, so the merge did not contain it. Still owed.
            continue
        row.status = "superseded"
        # The remote snapshot has done its job. It is a whole document, and
        # keeping one per resolved conflict forever is a database that grows with
        # every disagreement anyone ever had.
        row.remote_document_json = None
        retired += 1

    session.flush()
    return retired
