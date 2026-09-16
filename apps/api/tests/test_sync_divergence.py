"""D5.3: a refused change is not a failed one.

D5.2's outbox could tell a working server from an unreachable one and nothing
else, so a change the server *refused* — because the deck had moved there — was
retried on the same backoff as a dropped connection. That is a loop with no exit,
and worse than useless: it makes the deck look busy rather than stuck, so nobody
is ever told their work is not going anywhere.

The tests here are about the two things that separates: that a refusal stops and
is surfaced, and that everything a person needs in order to decide is already on
this machine. The second one matters more than it looks. The network is usually
what was missing when the divergence happened, and a design that fetched the
other side at reconcile time would make resolving a conflict require the very
thing whose absence caused it.
"""

from __future__ import annotations

import copy
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import sync  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import SyncOutboxRow, Workspace  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'diverge.db'}")
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
    return {"user_id": body["user_id"], "auth": f"Bearer {body['token']}"}


def headers(who: dict[str, str]) -> dict[str, str]:
    return {"Authorization": who["auth"]}


def a_syncing_workspace(client: TestClient, who: dict[str, str]) -> str:
    created = client.post("/v1/workspaces", headers=headers(who), json={"name": "Acme"}).json()
    with db_session.session_scope() as session:
        session.get(Workspace, created["workspace_id"]).origin = "cloud"
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


def retitle(client, who, presentation_id: str, title: str):
    document = head_of(client, who, presentation_id)
    return client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=headers(who),
        json={
            "expected_version_id": document["version_id"],
            "intent": f"Retitle to {title}",
            "operations": [{"op": "replace", "path": "/metadata/title", "value": title}],
        },
    )


def sync_status(client, who, presentation_id: str, documents: bool = False) -> dict:
    query = "?documents=true" if documents else ""
    answer = client.get(
        f"/v1/presentations/{presentation_id}/sync{query}", headers=headers(who)
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


@pytest.fixture()
def diverged(client):
    """A deck the server refused, with what it had at the time.

    Set up by draining against a `send` that refuses — which is what a real
    transport would do on a 409, and is the whole reason `drain` takes the send
    as a callable rather than owning one.
    """
    me = sign_in(client)
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)
    retitle(client, me, deck, "Written on the plane")
    retitle(client, me, deck, "And again")

    # What the other side has: the same deck with somebody else's edit on it.
    theirs = copy.deepcopy(head_of(client, me, deck)["document"])
    theirs["metadata"] = {**theirs["metadata"], "title": "Edited in the office"}

    def send(outgoing: sync.Outgoing) -> str:
        if outgoing.kind == "create":
            return "ver_remote_1"
        raise sync.SyncRefused(
            "This deck changed on the server after that change was written.",
            remote_version_id="ver_remote_7",
            remote_document=theirs,
        )

    with db_session.session_scope() as session:
        report = sync.drain(session, send)

    return {"who": me, "deck": deck, "theirs": theirs, "report": report, "project": project}


# ------------------------------------------------------- refusal is not failure


def test_a_refusal_stops_rather_than_backing_off(diverged):
    report = diverged["report"]

    assert report.sent == 1
    # Not counted as a failure: a failure is something that will be retried.
    assert report.failed == 0
    assert diverged["deck"] in report.blocked

    with db_session.session_scope() as session:
        row = sync.blocking_row(session, diverged["deck"])
        assert row is not None
        assert row.status == "blocked"
        # No attempt counter, no next attempt. Trying again would fail
        # identically, forever, and hide the fact that a person has to act.
        assert row.attempts == 0
        assert row.next_attempt_at is None
        assert "changed on the server" in row.refused_reason


def test_draining_again_does_not_retry_a_refusal_or_overtake_it(diverged):
    """Both halves matter.

    Retrying is a loop with no exit. Skipping past it is worse: the change behind
    a refusal may address an element it created, and the person has not yet said
    what should happen to the one in front.
    """
    attempts: list[str] = []

    with db_session.session_scope() as session:
        report = sync.drain(
            session, lambda outgoing: (attempts.append(outgoing.change_key), "ver")[1]
        )

    assert attempts == []
    assert report.sent == 0
    assert diverged["deck"] in report.blocked

    with db_session.session_scope() as session:
        # The change behind it is still queued, untouched.
        assert len(sync.pending_for(session, diverged["deck"])) == 1


def test_one_diverged_deck_does_not_stop_another(client, diverged):
    me = diverged["who"]
    other = a_deck(client, me, diverged["project"], "Fine")

    sent: list[str] = []
    with db_session.session_scope() as session:
        report = sync.drain(session, lambda outgoing: (sent.append(outgoing.presentation_id), "ver")[1])

    assert sent == [other]
    assert report.sent == 1
    assert diverged["deck"] in report.blocked


# ------------------------------------------------------------- what it reports


def test_the_deck_says_it_diverged_and_why(client, diverged):
    answer = sync_status(client, diverged["who"], diverged["deck"])

    assert answer["state"] == "diverged"
    # The blocked change counts as owed. Reporting only the ones behind it would
    # say "1 waiting" about a deck with two changes that have not gone anywhere.
    assert answer["pending"] == 2
    assert "changed on the server" in answer["diverged"]["reason"]
    assert answer["diverged"]["remote_version_id"] == "ver_remote_7"
    assert answer["diverged"]["intent"] == "Retitle to Written on the plane"


def test_a_waiting_deck_is_not_a_diverged_one(client):
    """The distinction the four states exist for.

    A queue that is merely waiting clears itself and needs nobody; conflating the
    two would either alarm people about nothing or hide a real conflict inside a
    spinner.
    """
    me = sign_in(client)
    deck = a_deck(client, me, a_syncing_workspace(client, me))

    assert sync_status(client, me, deck)["state"] == "waiting"

    with db_session.session_scope() as session:
        sync.drain(session, lambda outgoing: "ver_remote")

    assert sync_status(client, me, deck)["state"] == "in_sync"


def test_a_local_deck_says_local_rather_than_in_sync(client):
    """"In sync with nothing" is a claim about a relationship that does not exist."""
    me = sign_in(client)
    project = client.get("/v1/account", headers=headers(me)).json()["workspaces"][0][
        "projects"
    ][0]["id"]
    deck = a_deck(client, me, project, "Private")

    assert sync_status(client, me, deck)["state"] == "local"


def test_the_documents_are_not_sent_on_every_poll(client, diverged):
    """An editor polls this. Three whole documents per poll, forever, is not a
    status endpoint — it is a download loop."""
    polled = sync_status(client, diverged["who"], diverged["deck"])
    assert "merge" not in polled

    asked = sync_status(client, diverged["who"], diverged["deck"], documents=True)
    assert "merge" in asked


def test_everything_a_merge_needs_is_already_on_this_machine(client, diverged):
    """The property that makes reconciling offline possible.

    Three documents: the base the refused change was written against, this
    device's head, and what the server had when it refused. The first two are
    ordinary local reads and the third was kept at the moment of refusal — so
    resolving needs no network, which is the point, because the network is
    usually what was missing when the divergence happened.
    """
    merge = sync_status(client, diverged["who"], diverged["deck"], documents=True)["merge"]

    assert merge["base"] is not None
    assert merge["local"] is not None
    assert merge["remote"] == diverged["theirs"]

    # And they are genuinely three different documents, or the merge below would
    # be reconciling a deck with itself.
    assert merge["base"]["metadata"]["title"] == "Shared"
    assert merge["local"]["metadata"]["title"] == "And again"
    assert merge["remote"]["metadata"]["title"] == "Edited in the office"

    # The base is the version the refused change was authored against, not
    # whatever happens to be oldest: a merge against the wrong base silently
    # reports edits as conflicts that nobody made.
    assert merge["base"]["id"] == merge["local"]["id"]


# --------------------------------------------------------------- resolving it


def reconcile(client, who, deck: str, resolving_version_id: str):
    return client.post(
        f"/v1/presentations/{deck}/sync/reconciled",
        headers=headers(who),
        json={"resolving_version_id": resolving_version_id},
    )


def test_resolving_retires_what_it_replaced_and_keeps_itself(client, diverged):
    """The subtlety of `reconciled`.

    The merged document was made from the local head, so it already contains the
    effect of every change queued behind the block — sending those afterwards
    applies each of them twice. But the merge's *own* change must survive, or the
    reconciliation is stranded on this device, which is the exact failure the
    person just did the work to avoid.
    """
    me, deck = diverged["who"], diverged["deck"]

    # The editor merges and commits through the ordinary transaction path. There
    # is no second write path, and a reconciliation undoes like any other edit.
    merged = retitle(client, me, deck, "Both, resolved")
    assert merged.status_code == 200, merged.text

    answer = reconcile(client, me, deck, merged.json()["version_id"])
    assert answer.status_code == 200, answer.text
    # The refused change, plus the one queued behind it.
    assert answer.json()["retired"] == 2
    assert answer.json()["state"] == "waiting"

    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is None
        waiting = sync.pending_for(session, deck)
        assert len(waiting) == 1

    sent: list[str] = []
    with db_session.session_scope() as session:
        report = sync.drain(session, lambda outgoing: (sent.append(outgoing.intent), "ver_remote")[1])

    assert report.sent == 1
    assert sent == ["Retitle to Both, resolved"]

    assert sync_status(client, me, deck)["state"] == "in_sync"


def test_a_retired_change_is_superseded_not_deleted(client, diverged):
    """"What did this device decide, and when" is asked after a bad merge."""
    me, deck = diverged["who"], diverged["deck"]
    merged = retitle(client, me, deck, "Resolved")
    reconcile(client, me, deck, merged.json()["version_id"])

    import sqlalchemy

    with db_session.session_scope() as session:
        rows = list(
            session.scalars(
                sqlalchemy.select(SyncOutboxRow).where(SyncOutboxRow.presentation_id == deck)
            )
        )
        statuses = sorted(row.status for row in rows)
        # The create went; the refusal and the change behind it were retired; the
        # merge itself is queued.
        assert statuses == ["pending", "sent", "superseded", "superseded"]

        retired = next(row for row in rows if row.refused_reason)
        assert retired.status == "superseded"
        # The refusal is kept as the record of why; the whole remote document is
        # not, because one per disagreement forever is a database that grows with
        # every argument anyone ever had.
        assert retired.refused_reason
        assert retired.remote_document_json is None


def test_reconciling_a_deck_that_has_not_diverged_is_refused(client):
    me = sign_in(client)
    deck = a_deck(client, me, a_syncing_workspace(client, me))
    document = head_of(client, me, deck)

    answer = reconcile(client, me, deck, document["version_id"])

    assert answer.status_code == 409
    assert "not diverged" in answer.json()["detail"]


def test_a_version_from_somewhere_else_cannot_retire_a_queue(client, diverged):
    """Retiring work on the strength of an id nobody checked discards it with no
    record of why."""
    me, deck = diverged["who"], diverged["deck"]
    elsewhere = a_deck(client, me, diverged["project"], "Another")
    other_version = head_of(client, me, elsewhere)["version_id"]

    answer = reconcile(client, me, deck, other_version)

    assert answer.status_code == 404
    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is not None


def test_a_viewer_cannot_retire_someone_elses_queue(client, diverged):
    """Reading that a deck diverged is not deciding what happens to the work."""
    from deckastra_api.db.models import WorkspaceMember
    from deckastra_api.ids import new_id

    me, deck = diverged["who"], diverged["deck"]
    guest = sign_in(client, "guest@local")

    with db_session.session_scope() as session:
        workspace_id = session.scalar(
            __import__("sqlalchemy").select(Workspace.id).where(Workspace.name == "Acme")
        )
        session.add(
            WorkspaceMember(
                id=new_id("mbr"),
                workspace_id=workspace_id,
                user_id=guest["user_id"],
                role="viewer",
            )
        )

    # They can see the state — that is a read.
    assert sync_status(client, guest, deck)["state"] == "diverged"

    merged = retitle(client, me, deck, "Resolved by the owner")
    refused = reconcile(client, guest, deck, merged.json()["version_id"])

    assert refused.status_code == 404
    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is not None


def test_the_queue_moves_again_once_it_is_resolved(client, diverged):
    """The end state: a deck that diverged and came back is an ordinary deck."""
    me, deck = diverged["who"], diverged["deck"]
    merged = retitle(client, me, deck, "Resolved")
    reconcile(client, me, deck, merged.json()["version_id"])

    with db_session.session_scope() as session:
        sync.drain(session, lambda outgoing: "ver_remote")

    assert retitle(client, me, deck, "And life goes on").status_code == 200

    sent: list[str] = []
    with db_session.session_scope() as session:
        report = sync.drain(session, lambda outgoing: (sent.append(outgoing.intent), "ver")[1])

    assert report.sent == 1
    assert report.blocked == []
    assert sync_status(client, me, deck)["state"] == "in_sync"


def test_a_transport_failure_after_a_resolution_is_still_only_a_retry(client, diverged):
    """Resolving a divergence does not make the network work.

    Worth its own case because the two paths now share a queue: a deck that came
    back from `blocked` must still be able to sit in an ordinary backoff without
    that being read as a second divergence.
    """
    me, deck = diverged["who"], diverged["deck"]
    merged = retitle(client, me, deck, "Resolved")
    reconcile(client, me, deck, merged.json()["version_id"])

    start = datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)

    def refuse(outgoing: sync.Outgoing) -> str:
        raise ConnectionError("still no network")

    with db_session.session_scope() as session:
        report = sync.drain(session, refuse, now=lambda: start)

    assert report.failed == 1
    # Waiting, not diverged. A deck that came back from `blocked` must be able to
    # sit in an ordinary backoff without that reading as a second divergence.
    assert report.blocked == []
    assert report.waiting == [deck]

    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is None
        row = sync.pending_for(session, deck)[0]
        assert row.attempts == 1
        assert row.next_attempt_at is not None

    assert sync_status(client, me, deck)["state"] == "waiting"

    with db_session.session_scope() as session:
        report = sync.drain(
            session, lambda outgoing: "ver_remote", now=lambda: start + timedelta(minutes=5)
        )
    assert report.sent == 1
