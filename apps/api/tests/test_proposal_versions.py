"""Version identity, from proposal to approval (D2 closure audit, 2026-09-12).

Optimistic concurrency was enforced where a *transaction* is written and nowhere
else, which left two holes an audit found and these tests keep shut:

1. **Approval applied against a head nobody reviewed.** `approve` reloaded the
   document and used that as both parent and expected version, so a proposal
   reviewed against version A applied cleanly on version B as long as the patch
   still fitted. "The patch still applies" is not "this is the change that was
   approved": the slide it lands on can say something else entirely.

2. **A route's check and the write's base were two different reads.** The route
   compared the caller's `expected_version_id` against the head, then
   `create_proposal` loaded the document *again* and committed against whatever
   it found. Anything committed in between — a user typing — became the silent
   base of the agent's change.

Both now refuse with 409 and write nothing. The second pair of tests is the
other half of the requirement: refusing everything would stop an unrelated edit
from ever being approvable, so an approver who has looked at the current deck
can still say yes by naming the version they saw.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import TransactionRow  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'versions.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "versions@localhost"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def deck(client, auth):
    generated = client.post(
        "/v1/decks/from-template", headers=auth, json={"template_id": "business-pitch", "title": "A deck to review"}
    )
    assert generated.status_code == 200, generated.text
    return generated.json()


def head_version(client, auth, presentation_id: str) -> str:
    return client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()["version_id"]


def user_edit(client, auth, presentation_id: str, base: str, title: str):
    return client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth,
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": title}],
            "intent": "User edit",
            "expected_version_id": base,
            "client_id": "web-editor",
        },
    )


def pending_removal(client, auth, deck, base: str) -> str:
    """A change the risk tier parks rather than applies."""
    slide = deck["document"]["slides"][0]
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals",
        headers=auth,
        json={
            "operations": [
                {"op": "remove", "path": f"/slides/id:{slide['id']}/elements/id:{element['id']}"}
                for element in slide["elements"][:2]
            ],
            "intent": "Remove two elements",
            "expected_version_id": base,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["outcome"] == "pending", response.json()
    return response.json()["transaction_id"]


# ------------------------------------------------------------------ refusals


def test_approving_a_proposal_whose_deck_has_moved_is_refused(client, auth, deck):
    """The audit's first reproduction.

    The operations still apply here — that is the point. A check that only asks
    "does the patch fit" says yes to applying a change to a deck the approver
    never saw.
    """
    presentation_id = deck["presentation_id"]
    base = head_version(client, auth, presentation_id)
    proposal = pending_removal(client, auth, deck, base)

    moved = user_edit(client, auth, presentation_id, base, "New user work")
    assert moved.status_code == 200, moved.text

    approved = client.post(
        f"/v1/presentations/{presentation_id}/proposals/{proposal}/approve", headers=auth
    )
    assert approved.status_code == 409, approved.text

    # And nothing was written: the proposal is still pending, the head is still
    # the user's edit, and no version exists for a change nobody accepted.
    assert head_version(client, auth, presentation_id) == moved.json()["version_id"]
    with db_session.session_scope() as session:
        assert session.get(TransactionRow, proposal).status == "pending"


def test_a_write_landing_between_the_check_and_the_base_is_refused(client, auth, deck, monkeypatch):
    """The audit's second reproduction: two reads, one of them unguarded.

    The route's check passed against version A while `create_proposal` went on to
    load version B and commit against it. The version now travels with the
    operations and is compared where the base is actually loaded.
    """
    from deckastra_api import proposals

    presentation_id = deck["presentation_id"]
    base = head_version(client, auth, presentation_id)
    original = proposals.create_proposal

    def intervening(session, **kwargs):
        typed = user_edit(client, auth, presentation_id, base, "User concurrent title")
        assert typed.status_code == 200, typed.text
        session.expire_all()  # a fresh read, as a separate process would have
        return original(session, **kwargs)

    monkeypatch.setattr(proposals, "create_proposal", intervening)

    response = client.post(
        f"/v1/presentations/{presentation_id}/proposals",
        headers=auth,
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "Agent title"}],
            "intent": "Agent title",
            "expected_version_id": base,
        },
    )
    assert response.status_code == 409, response.text

    document = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()["document"]
    assert document["metadata"]["title"] == "User concurrent title"


def test_a_preview_against_a_version_that_has_moved_is_refused(client, auth, deck):
    presentation_id = deck["presentation_id"]
    base = head_version(client, auth, presentation_id)
    assert user_edit(client, auth, presentation_id, base, "Moved").status_code == 200

    response = client.post(
        f"/v1/presentations/{presentation_id}/preview",
        headers=auth,
        json={"slide_id": deck["document"]["slides"][0]["id"], "expected_version_id": base},
    )
    # A picture labelled with a version the caller did not ask about is a picture
    # of a different deck.
    assert response.status_code == 409, response.text


# ------------------------------------------------- and still usable afterwards


def test_an_approver_who_has_seen_the_current_deck_can_still_approve(client, auth, deck):
    """Refusing everything would be the other kind of wrong.

    An unrelated edit elsewhere in the deck must not strand a pending proposal
    with no way to accept it. The way through is to look: name the version you
    were shown, and it applies against exactly that.
    """
    presentation_id = deck["presentation_id"]
    base = head_version(client, auth, presentation_id)
    proposal = pending_removal(client, auth, deck, base)

    moved = user_edit(client, auth, presentation_id, base, "Unrelated title edit")
    assert moved.status_code == 200, moved.text
    current = moved.json()["version_id"]

    approved = client.post(
        f"/v1/presentations/{presentation_id}/proposals/{proposal}/approve",
        headers=auth,
        json={"expected_version_id": current},
    )
    assert approved.status_code == 200, approved.text

    # Applied on top of the user's edit, keeping it.
    document = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()["document"]
    assert document["metadata"]["title"] == "Unrelated title edit"
    assert len(document["slides"][0]["elements"]) == len(deck["document"]["slides"][0]["elements"]) - 2


def test_an_approver_naming_a_version_that_is_also_stale_is_refused(client, auth, deck):
    presentation_id = deck["presentation_id"]
    base = head_version(client, auth, presentation_id)
    proposal = pending_removal(client, auth, deck, base)

    first = user_edit(client, auth, presentation_id, base, "First edit")
    assert first.status_code == 200
    second = user_edit(client, auth, presentation_id, first.json()["version_id"], "Second edit")
    assert second.status_code == 200

    # Approving against the version *between* the two: seen, but no longer the head.
    approved = client.post(
        f"/v1/presentations/{presentation_id}/proposals/{proposal}/approve",
        headers=auth,
        json={"expected_version_id": first.json()["version_id"]},
    )
    assert approved.status_code == 409, approved.text


def test_an_ordinary_unmoved_approval_still_works(client, auth, deck):
    """The common case: nobody touched the deck, and no version has to be named."""
    presentation_id = deck["presentation_id"]
    proposal = pending_removal(client, auth, deck, head_version(client, auth, presentation_id))

    approved = client.post(
        f"/v1/presentations/{presentation_id}/proposals/{proposal}/approve", headers=auth
    )
    assert approved.status_code == 200, approved.text
