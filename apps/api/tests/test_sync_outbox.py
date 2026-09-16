"""D5.2: the outbox, and the key a change is known by.

D5.0 left one decision and this suite is where it is made: idempotency keys on a
**change key**, not on a version id. The tests below are mostly about things that
cannot happen — a change without its outbox row, an upload applying twice, a log
uploading out of order — because those are the failures that are invisible until
someone else cannot find the work.

There is no cloud server to talk to, so `drain` is exercised against a `send`
that is a function. That is the point of taking one: the ordering, retry and
idempotency behaviour is testable now rather than arriving untested beside a
transport later.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import auth, store, sync  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import (  # noqa: E402
    Project,
    SyncOutboxRow,
    TransactionRow,
    Workspace,
)
from deckastra_api.ids import new_id  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'outbox.db'}")
    monkeypatch.delenv("DECKASTRA_LOCAL_MODE", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client

    db_session.reset_engine()


def sign_in(client: TestClient, email: str = "device@local") -> dict[str, str]:
    body = client.post("/v1/dev/session", json={"email": email}).json()
    return {
        "user_id": body["user_id"],
        "workspace_id": body["workspace_id"],
        "auth": f"Bearer {body['token']}",
    }


def headers(who: dict[str, str]) -> dict[str, str]:
    return {"Authorization": who["auth"]}


def a_syncing_workspace(client: TestClient, who: dict[str, str]) -> str:
    """A workspace whose decks have somewhere to go.

    Nothing writes `origin = "cloud"` in the product yet — there is no sign-in to
    a server and no mirroring — so the column is set here directly. That is the
    honest way to test the branch: the behaviour is real, the way a workspace
    comes to be a mirror is not built.
    """
    created = client.post("/v1/workspaces", headers=headers(who), json={"name": "Acme"}).json()
    with db_session.session_scope() as session:
        session.get(Workspace, created["workspace_id"]).origin = "cloud"
        # And the membership has to be confirmed (D5.4), because in a mirrored
        # workspace the row is a cache and an unconfirmed cache authorizes
        # nothing. A real mirror does this as part of syncing the workspace down;
        # flipping `origin` without it leaves a state no device could be in.
        auth.confirm_membership(
            session,
            user_id=who["user_id"],
            workspace_id=created["workspace_id"],
            role="owner",
        )
    return created["project_id"]


def a_deck(client: TestClient, who: dict[str, str], project_id: str, title="Shared") -> str:
    created = client.post(
        "/v1/presentations",
        headers=headers(who),
        json={"title": title, "project_id": project_id},
    )
    assert created.status_code == 201, created.text
    return created.json()["presentation_id"]


def head_of(client: TestClient, who: dict[str, str], presentation_id: str) -> dict:
    return client.get(f"/v1/presentations/{presentation_id}", headers=headers(who)).json()


def retitle(client, who, presentation_id: str, title: str, **extra):
    """One small, always-valid change, so a test can make several in a row."""
    document = head_of(client, who, presentation_id)
    body = {
        "expected_version_id": document["version_id"],
        "intent": f"Retitle to {title}",
        "operations": [{"op": "replace", "path": "/metadata/title", "value": title}],
    }
    body.update(extra)
    return client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=headers(who),
        json=body,
    )


def outbox(session, presentation_id: str) -> list[SyncOutboxRow]:
    return sync.pending_for(session, presentation_id)


# ------------------------------------------------------- only decks that sync


def test_a_local_deck_owes_nothing_to_anyone(client):
    """A `local` workspace is this machine's own (D5.1).

    Enqueuing its changes would build a queue that can never drain, and a queue
    nobody can read is worse than no queue — it makes "3 changes waiting" a
    permanent fixture of the UI.
    """
    me = sign_in(client)
    project = client.get("/v1/account", headers=headers(me)).json()["workspaces"][0]["projects"][0]["id"]
    deck = a_deck(client, me, project, "Private")

    assert retitle(client, me, deck, "Still private").status_code == 200

    with db_session.session_scope() as session:
        assert outbox(session, deck) == []
        # And no key either: a change key on a deck with nowhere to send it is a
        # value nothing ever reads.
        keys = [row.change_key for row in session.scalars(
            __import__("sqlalchemy").select(TransactionRow).where(
                TransactionRow.presentation_id == deck
            )
        )]
        assert keys and all(key is None for key in keys)


def test_a_deck_in_a_syncing_workspace_owes_the_deck_and_then_each_change(client):
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)

    with db_session.session_scope() as session:
        # The deck itself first. `create_presentation` writes a version and no
        # transaction, so without this the server would receive changes against a
        # deck it had never heard of.
        assert [row.kind for row in outbox(session, deck)] == ["create"]

    assert retitle(client, me, deck, "Second").status_code == 200
    assert retitle(client, me, deck, "Third").status_code == 200

    with db_session.session_scope() as session:
        rows = outbox(session, deck)
        assert [row.kind for row in rows] == ["create", "change", "change"]
        assert all(row.change_key for row in rows)
        # Every key distinct: two changes sharing one would make the second look
        # like a retry of the first and silently never apply.
        assert len({row.change_key for row in rows}) == 3


def test_the_change_and_its_outbox_row_are_written_together(client):
    """The property the outbox is a *table* for.

    A device that committed a version and enqueued it afterwards loses the
    enqueue to any crash in between — silently, because the deck looks right
    locally. Here the commit is rolled back after the fact, and neither the
    transaction nor its outbox row survives: they are one write or none.
    """
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)

    import sqlalchemy

    with db_session.session_scope() as session:
        before = len(outbox(session, deck))

    try:
        with db_session.session_scope() as session:
            loaded = store.load_presentation(session, deck)
            document = dict(loaded.document)
            document["metadata"] = {**document["metadata"], "title": "Doomed"}
            store.commit_transaction(
                session,
                presentation_id=deck,
                operations=[{"op": "replace", "path": "/metadata/title", "value": "Doomed"}],
                inverse_operations=[
                    {"op": "replace", "path": "/metadata/title", "value": loaded.title}
                ],
                document=document,
                parent_version_id=loaded.version_id,
                expected_version_id=loaded.version_id,
                intent="Retitle",
                source="user",
                created_by=me["user_id"],
            )
            # Whatever goes wrong after the commit — a crash, a failed validation
            # somewhere upstream, a dropped connection — takes both rows with it.
            raise RuntimeError("the process died here")
    except RuntimeError:
        pass

    with db_session.session_scope() as session:
        assert len(outbox(session, deck)) == before
        titles = list(
            session.scalars(
                sqlalchemy.select(TransactionRow.intent).where(
                    TransactionRow.presentation_id == deck
                )
            )
        )
        assert "Retitle" not in titles


# ------------------------------------------------------------- draining, in order


def test_draining_sends_a_decks_work_in_the_order_it_was_made(client):
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)
    retitle(client, me, deck, "Second")
    retitle(client, me, deck, "Third")

    seen: list[sync.Outgoing] = []

    with db_session.session_scope() as session:
        report = sync.drain(session, lambda outgoing: (seen.append(outgoing), "ver_remote_1")[1])

    assert report.sent == 3
    assert report.failed == 0
    assert [one.kind for one in seen] == ["create", "change", "change"]
    # The create carries the deck as it was created, not as it is now — every
    # change since is queued behind it, and a current snapshot would apply all of
    # them twice.
    assert seen[0].document["metadata"]["title"] == "Shared"
    assert seen[1].operations[0]["value"] == "Second"
    assert seen[2].operations[0]["value"] == "Third"

    with db_session.session_scope() as session:
        assert outbox(session, deck) == []
        sent = list(
            session.scalars(
                __import__("sqlalchemy").select(SyncOutboxRow).where(
                    SyncOutboxRow.presentation_id == deck
                )
            )
        )
        # Kept rather than deleted: "what did this device send, and when" is the
        # question asked when two sides disagree.
        assert [row.status for row in sent] == ["sent", "sent", "sent"]
        assert all(row.remote_version_id == "ver_remote_1" for row in sent)


def test_a_failure_stops_that_deck_where_it_stands(client):
    """A log is a sequence, not a set (D5.0).

    The change after a failed one may address an element the failed one created,
    so sending it would ask the server to apply an operation against a document
    that never received its predecessor.
    """
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)
    retitle(client, me, deck, "Second")
    retitle(client, me, deck, "Third")

    attempts: list[str] = []

    def send(outgoing: sync.Outgoing) -> str:
        attempts.append(outgoing.kind)
        if len(attempts) == 2:
            raise ConnectionError("the server went away")
        return "ver_remote"

    with db_session.session_scope() as session:
        report = sync.drain(session, send)

    assert attempts == ["create", "change"]
    assert report.sent == 1
    assert report.failed == 1
    assert deck in report.waiting

    with db_session.session_scope() as session:
        waiting = outbox(session, deck)
        assert len(waiting) == 2
        assert waiting[0].attempts == 1
        assert "ConnectionError" in waiting[0].last_error
        # It is waiting, not abandoned. There is no state that means "gave up".
        assert waiting[0].status == "pending"


def test_a_stuck_deck_does_not_hold_up_a_different_one(client):
    """Two decks are two sequences, and one server problem is rarely both."""
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    stuck = a_deck(client, me, project, "Stuck")
    fine = a_deck(client, me, project, "Fine")

    def send(outgoing: sync.Outgoing) -> str:
        if outgoing.presentation_id == stuck:
            raise ConnectionError("not this one")
        return "ver_remote"

    with db_session.session_scope() as session:
        report = sync.drain(session, send)

    assert report.sent == 1
    assert report.failed == 1

    with db_session.session_scope() as session:
        assert len(outbox(session, stuck)) == 1
        assert outbox(session, fine) == []


def test_a_row_waiting_out_its_backoff_holds_its_place(client):
    """Backing off must not let the change behind it overtake it.

    The obvious implementation — "send every row whose `next_attempt_at` has
    passed" — reorders the log the moment one row is delayed, which is the one
    thing replay cannot survive.
    """
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)
    retitle(client, me, deck, "Second")

    failing = True

    def send(outgoing: sync.Outgoing) -> str:
        if failing:
            raise ConnectionError("nope")
        return "ver_remote"

    start = datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)
    with db_session.session_scope() as session:
        sync.drain(session, send, now=lambda: start)

    failing = False
    sent: list[str] = []

    # A second pass one second later: the create is still backing off, so nothing
    # goes — including the change behind it, which would otherwise arrive first.
    with db_session.session_scope() as session:
        report = sync.drain(
            session,
            lambda outgoing: (sent.append(outgoing.kind), "ver_remote")[1],
            now=lambda: start + timedelta(seconds=1),
        )
    assert sent == []
    assert report.sent == 0
    assert deck in report.waiting

    # And once the backoff has passed, in order.
    with db_session.session_scope() as session:
        sync.drain(
            session,
            lambda outgoing: (sent.append(outgoing.kind), "ver_remote")[1],
            now=lambda: start + timedelta(minutes=5),
        )
    assert sent == ["create", "change"]


def test_each_failure_waits_longer_than_the_last(client):
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)

    def refuse(outgoing: sync.Outgoing) -> str:
        raise ConnectionError("still down")

    start = datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)
    waits: list[float] = []
    for attempt in range(4):
        moment = start + timedelta(hours=attempt)
        with db_session.session_scope() as session:
            sync.drain(session, refuse, now=lambda: moment)
            row = outbox(session, deck)[0]
            waits.append((row.next_attempt_at.replace(tzinfo=timezone.utc) - moment).total_seconds())

    assert waits == sorted(waits)
    assert waits[0] < waits[-1]


# ----------------------------------------------------- the receiving half


def test_a_retried_upload_applies_once(client):
    """The whole point of a change key.

    A device that uploaded a change and never heard the answer retries it. Twice
    for a `replace` is harmless; twice for an array `add` is a duplicated element
    nobody asked for.
    """
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)

    key = "chg_from_another_device"
    first = retitle(client, me, deck, "From the plane", change_key=key)
    assert first.status_code == 200, first.text
    assert first.json()["duplicate"] is False

    # The same change again, carrying the version it was authored against — which
    # is now stale precisely *because* the first attempt succeeded.
    again = client.post(
        f"/v1/presentations/{deck}/transactions",
        headers=headers(me),
        json={
            "expected_version_id": first.json()["version_id"],
            "intent": "Retitle to From the plane",
            "operations": [
                {"op": "replace", "path": "/metadata/title", "value": "From the plane"}
            ],
            "change_key": key,
        },
    )

    assert again.status_code == 200, again.text
    assert again.json()["duplicate"] is True
    assert again.json()["transaction_id"] == first.json()["transaction_id"]
    assert again.json()["version_id"] == first.json()["version_id"]

    # Nothing was written the second time.
    assert head_of(client, me, deck)["version_id"] == first.json()["version_id"]


def test_a_retry_is_recognised_before_the_version_check_not_after(client):
    """The subtlety that makes the whole mechanism work or not work.

    Applying a change is what moves the head, so *every* retry of a change that
    landed carries a stale `expected_version_id`. A version check that ran first
    would answer 409 to every one of them and the device could never clear its
    outbox — it would keep retrying a change that had already succeeded, forever.
    """
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)

    stale = head_of(client, me, deck)["version_id"]
    key = "chg_authored_offline"
    assert retitle(client, me, deck, "One", change_key=key).status_code == 200
    # Somebody else edits in between, so the head has moved twice over.
    assert retitle(client, me, deck, "Two").status_code == 200

    again = client.post(
        f"/v1/presentations/{deck}/transactions",
        headers=headers(me),
        json={
            "expected_version_id": stale,
            "intent": "Retitle to One",
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "One"}],
            "change_key": key,
        },
    )

    assert again.status_code == 200, again.text
    assert again.json()["duplicate"] is True
    # The later edit stands — an idempotent answer is not a revert.
    assert again.json()["document"]["metadata"]["title"] == "Two"


def test_a_different_change_with_no_key_is_never_mistaken_for_a_retry(client):
    """The negative control: dedupe must key on the key, not on looking similar."""
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)

    first = retitle(client, me, deck, "Same words")
    second = retitle(client, me, deck, "Same words")

    assert first.json()["transaction_id"] != second.json()["transaction_id"]
    assert second.json()["duplicate"] is False


def test_the_same_key_on_two_decks_is_two_changes(client):
    """A key only has to be unique where it is applied.

    Scoping it to the presentation is what lets two devices mint keys without a
    coordinator; scoping it globally would make an unlucky collision silently
    swallow someone's change.
    """
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    one = a_deck(client, me, project, "One")
    two = a_deck(client, me, project, "Two")

    key = "chg_same_on_both"
    assert retitle(client, me, one, "Edited", change_key=key).status_code == 200
    answer = retitle(client, me, two, "Edited", change_key=key)

    assert answer.status_code == 200, answer.text
    assert answer.json()["duplicate"] is False


# --------------------------------------------------------------- the move hole


def test_a_local_deck_cannot_be_moved_into_a_workspace_that_syncs(client):
    """Closed rather than left open (D5.1's move route, D5.2's reason).

    A deck that has lived its whole life locally has no change keys and no outbox
    rows. Moving it into a syncing workspace would produce a deck that looks
    shared and silently never uploads — invisible until someone else cannot find
    it. Seeding one is an upload of current state rather than a replay of a
    keyless history, and that is its own work.
    """
    me = sign_in(client)
    local_project = client.get("/v1/account", headers=headers(me)).json()["workspaces"][0][
        "projects"
    ][0]["id"]
    deck = a_deck(client, me, local_project, "Private")
    shared = a_syncing_workspace(client, me)

    refused = client.post(
        f"/v1/presentations/{deck}/move",
        headers=headers(me),
        json={"project_id": shared},
    )

    assert refused.status_code == 409
    assert "not supported yet" in refused.json()["detail"]

    with db_session.session_scope() as session:
        assert session.get(Project, local_project) is not None
        assert outbox(session, deck) == []
