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

from deckastra_api import auth, sync  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import SyncOutboxRow, Workspace  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'diverge.db'}")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
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




def merge(client, who, deck: str, title: str, **override):
    """Commit a merge and acknowledge it in one request.

    That is the contract now (D5.3, corrected 2026-09-17). An acknowledgement
    that arrives *after* the merge is a second operation, and anything committed
    in the gap between them was retired by mistake — three separate ways, each
    found by a review. As one request the gap does not exist.
    """
    state = sync_status(client, who, deck)
    divergence = state.get("diverged") or {}
    opened = head_of(client, who, deck)

    resolves = {
        "change_key": divergence.get("change_key", ""),
        "remote_version_id": divergence.get("remote_version_id") or "",
        "local_version_id": opened["version_id"],
    }
    resolves.update(override.pop("resolves", {}))

    request = {
        "expected_version_id": opened["version_id"],
        "intent": f"Merge: {title}",
        "operations": [{"op": "replace", "path": "/metadata/title", "value": title}],
        "resolves": resolves,
    }
    request.update(override)
    return client.post(
        f"/v1/presentations/{deck}/transactions", headers=headers(who), json=request
    )


def test_a_merge_retires_what_it_replaced_and_keeps_itself(client, diverged):
    """The refused change, plus the one queued behind it — and not the merge.

    Sparing the merge's own row is the older subtlety: retiring it would strand
    the reconciliation on this device, the exact failure the person just did the
    work to avoid.
    """
    me, deck = diverged["who"], diverged["deck"]

    merged = merge(client, me, deck, "Both, resolved")
    assert merged.status_code == 200, merged.text
    assert merged.json()["retired"] == 2

    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is None
        assert len(sync.pending_for(session, deck)) == 1

    sent: list[str] = []
    with db_session.session_scope() as session:
        report = sync.drain(session, lambda outgoing: (sent.append(outgoing.intent), "v")[1])

    assert report.sent == 1
    assert sent == ["Merge: Both, resolved"]
    assert sync_status(client, me, deck)["state"] == "in_sync"


def test_an_ordinary_edit_after_the_refusal_is_not_a_resolution(client, diverged):
    """The correction a review made on 2026-09-17, and the reason this contract
    exists at all.

    Requiring the resolving change to be written *after* the refusal is a
    necessary guard and not a sufficient one: an ordinary edit a minute later
    satisfies it, and so does an MCP client's low-risk change. Time says when; it
    cannot say what the change was declared against.

    So an edit that declares nothing retires nothing, and one that declares a
    remote version that does not match the conflict is refused. What that
    establishes is narrow and worth naming: the change was **explicitly declared
    against validated versions**, not that anyone read the divergence.
    """
    me, deck = diverged["who"], diverged["deck"]

    # An ordinary edit, well after the refusal. It goes through — nothing stops a
    # person editing a deck that has diverged — and it retires nothing.
    ordinary = retitle(client, me, deck, "Just carrying on typing")
    assert ordinary.status_code == 200, ordinary.text
    assert ordinary.json()["retired"] is None

    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is not None
        assert len(sync.pending_for(session, deck)) == 2

    # And one that declares a remote version which does not match the conflict
    # this deck is stopped at is refused.
    claimed = merge(
        client, me, deck, "Pretending", resolves={"remote_version_id": "ver_guessed"}
    )

    assert claimed.status_code == 409, claimed.text
    assert "different version of the server" in claimed.json()["detail"]

    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is not None
        assert len(sync.pending_for(session, deck)) == 2


def test_a_resolution_naming_another_conflict_is_refused(client, diverged):
    """A client resolving a conflict it read about earlier must not retire
    whatever is blocked now."""
    me, deck = diverged["who"], diverged["deck"]

    refused = merge(client, me, deck, "Wrong one", resolves={"change_key": "chg_elsewhere"})

    assert refused.status_code == 409
    assert "different conflict" in refused.json()["detail"]
    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is not None


def test_a_merge_reviewed_against_a_stale_local_version_is_refused(client, diverged):
    """If somebody typed between the review and the commit, the merge did not see
    it — and merging on top of work nobody looked at is how a reconciliation
    quietly loses a change."""
    me, deck = diverged["who"], diverged["deck"]
    stale = head_of(client, me, deck)["version_id"]

    assert retitle(client, me, deck, "Typed during the review").status_code == 200

    refused = merge(client, me, deck, "Merged blind", resolves={"local_version_id": stale})

    assert refused.status_code == 409
    assert "after the version the merge was reviewed against" in refused.json()["detail"]
    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is not None


def test_nothing_can_arrive_between_the_merge_and_the_retirement(client, diverged):
    """The property atomicity buys, stated directly.

    The earlier design committed the merge and acknowledged it separately, and
    every edit in that gap was retired. Now the commit carries the
    acknowledgement — and the commit is refused if the head moved, so an edit
    made after the review cannot be in the queue at the moment of retirement. The
    boundary is provable rather than arithmetic.
    """
    me, deck = diverged["who"], diverged["deck"]

    state = sync_status(client, me, deck)
    divergence = state["diverged"]
    reviewed = head_of(client, me, deck)["version_id"]

    # Somebody saves while the person is still reading the conflict.
    assert retitle(client, me, deck, "Saved mid-review").status_code == 200

    # The merge, authored against what the reviewer saw, is now stale and refused
    # by the ordinary concurrency check — before anything is retired.
    late = client.post(
        f"/v1/presentations/{deck}/transactions",
        headers=headers(me),
        json={
            "expected_version_id": reviewed,
            "intent": "Merge",
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "Merged"}],
            "resolves": {
                "change_key": divergence["change_key"],
                "remote_version_id": divergence["remote_version_id"],
                "local_version_id": reviewed,
            },
        },
    )

    assert late.status_code == 409
    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is not None
        assert len(sync.pending_for(session, deck)) == 2


def test_resolving_a_deck_that_has_not_diverged_is_refused(client):
    me = sign_in(client, "nothing-wrong@local")
    deck = a_deck(client, me, a_syncing_workspace(client, me))
    opened = head_of(client, me, deck)

    answer = client.post(
        f"/v1/presentations/{deck}/transactions",
        headers=headers(me),
        json={
            "expected_version_id": opened["version_id"],
            "intent": "Merge nothing",
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "x"}],
            "resolves": {
                "change_key": "chg_imaginary",
                "remote_version_id": "ver_imaginary",
                "local_version_id": opened["version_id"],
            },
        },
    )

    assert answer.status_code == 409
    assert "not diverged" in answer.json()["detail"]


def test_a_viewer_cannot_resolve_someone_elses_divergence(client, diverged):
    """Reading that a deck diverged is not deciding what happens to the work."""
    import sqlalchemy

    me, deck = diverged["who"], diverged["deck"]
    guest = sign_in(client, "guest@local")

    with db_session.session_scope() as session:
        workspace_id = session.scalar(
            sqlalchemy.select(Workspace.id).where(Workspace.name == "Acme")
        )
        auth.confirm_membership(
            session, user_id=guest["user_id"], workspace_id=workspace_id, role="viewer"
        )

    assert sync_status(client, guest, deck)["state"] == "diverged"

    refused = merge(client, guest, deck, "Not yours to resolve")

    assert refused.status_code == 404
    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is not None


def test_the_pictures_a_merged_deck_still_needs_are_not_retired(client, diverged):
    """An `asset` row is bytes the server has never received, not a change the
    merge could have incorporated. Retiring one leaves the reconciled document
    citing a picture that will never be uploaded."""
    import sqlalchemy

    from deckastra_api import object_storage
    from deckastra_api.db.models import Asset
    from deckastra_api.ids import new_id

    me, deck = diverged["who"], diverged["deck"]

    asset_id = new_id("ast")
    with db_session.session_scope() as session:
        workspace_id = session.scalar(
            sqlalchemy.select(Workspace.id).where(Workspace.name == "Acme")
        )
        key = f"workspaces/{workspace_id}/assets/{asset_id}.png"
        object_storage.put_local(key, b"not really a png", "image/png")
        session.add(
            Asset(
                id=asset_id,
                workspace_id=workspace_id,
                created_by=me["user_id"],
                kind="image",
                storage_key=key,
                filename="pixel.png",
                content_type="image/png",
                bytes=16,
            )
        )

    opened = head_of(client, me, deck)
    slide_id = opened["document"]["slides"][0]["id"]
    placed = client.post(
        f"/v1/presentations/{deck}/transactions",
        headers=headers(me),
        json={
            "expected_version_id": opened["version_id"],
            "intent": "Place the picture",
            "operations": [
                {
                    "op": "add",
                    "path": f"/slides/id:{slide_id}/elements/-",
                    "value": {
                        "id": new_id("el"),
                        "type": "image",
                        "assetId": asset_id,
                        "transform": {"x": 1, "y": 1, "width": 10, "height": 10},
                    },
                }
            ],
        },
    )
    assert placed.status_code == 200, placed.text

    merged = merge(client, me, deck, "Resolved with the picture still on it")
    assert merged.status_code == 200, merged.text

    sent: list[str] = []
    with db_session.session_scope() as session:
        sync.drain(session, lambda outgoing: (sent.append(outgoing.kind), "v")[1])

    assert "asset" in sent, "the bytes the merged deck still cites were retired"


def test_the_queue_moves_again_once_it_is_resolved(client, diverged):
    """A deck that diverged and came back is an ordinary deck."""
    me, deck = diverged["who"], diverged["deck"]
    assert merge(client, me, deck, "Resolved").status_code == 200

    with db_session.session_scope() as session:
        sync.drain(session, lambda outgoing: "ver_remote")

    assert retitle(client, me, deck, "And life goes on").status_code == 200

    sent: list[str] = []
    with db_session.session_scope() as session:
        report = sync.drain(session, lambda outgoing: (sent.append(outgoing.intent), "v")[1])

    assert report.sent == 1
    assert report.blocked == []
    assert sync_status(client, me, deck)["state"] == "in_sync"


def test_a_transport_failure_after_a_resolution_is_still_only_a_retry(client, diverged):
    """Resolving a divergence does not make the network work.

    A deck that came back from `blocked` must still be able to sit in an ordinary
    backoff without that being read as a second divergence.
    """
    me, deck = diverged["who"], diverged["deck"]
    assert merge(client, me, deck, "Resolved").status_code == 200

    start = datetime(2026, 9, 17, 12, 0, tzinfo=timezone.utc)

    def refuse(outgoing: sync.Outgoing) -> str:
        raise ConnectionError("still no network")

    with db_session.session_scope() as session:
        report = sync.drain(session, refuse, now=lambda: start)

    assert report.failed == 1
    assert report.blocked == []
    assert report.waiting == [deck]
    assert sync_status(client, me, deck)["state"] == "waiting"

    with db_session.session_scope() as session:
        report = sync.drain(
            session, lambda outgoing: "ver_remote", now=lambda: start + timedelta(minutes=5)
        )
    assert report.sent == 1


def test_there_is_no_way_to_acknowledge_a_merge_separately(client, diverged):
    """The unsafe path is gone, not merely discouraged.

    A separate acknowledgement cannot be atomic with the commit it acknowledges,
    and every version of it retired something it should not have. Leaving it
    beside the safe one would be leaving the bug behind a second door.
    """
    me, deck = diverged["who"], diverged["deck"]
    opened = head_of(client, me, deck)

    gone = client.post(
        f"/v1/presentations/{deck}/sync/reconciled",
        headers=headers(me),
        json={"resolving_version_id": opened["version_id"]},
    )

    assert gone.status_code == 404
    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is not None


def test_a_change_authored_before_the_conflict_cannot_resolve_it(client):
    """`refused_at` stays as a guard even though it is no longer the whole rule.

    A change queued before the drain that refused anything cannot have merged the
    other side, and its `resolves` claim would have to name a remote version it
    never saw. Both refusals apply; this checks the deck survives either way.
    """
    me = sign_in(client, "queued-first@local")
    project = a_syncing_workspace(client, me)
    deck = a_deck(client, me, project)

    retitle(client, me, deck, "One")
    retitle(client, me, deck, "Two")

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
        sync.drain(session, send)
        assert sync.blocking_row(session, deck) is not None
        assert len(sync.pending_for(session, deck)) == 1

    # A change authored before the refusal can only declare a remote version that
    # is not the one this deck is stopped at, and that is refused.
    refused = merge(client, me, deck, "Three", resolves={"remote_version_id": "ver_remote_1"})

    assert refused.status_code == 409
    with db_session.session_scope() as session:
        assert sync.blocking_row(session, deck) is not None
        assert len(sync.pending_for(session, deck)) == 1
