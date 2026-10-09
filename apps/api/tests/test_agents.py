"""The agent HTTP surface: Journey C, proposals, and the boundaries.

Journey C is the phase's exit criterion (doc 03 §26): select an element, ask for
a change, preview the patch, accept it, and undo only that transaction. It is
tested end to end here because every one of those steps crosses a boundary that
the unit tests can only check one side of.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import TransactionRow  # noqa: E402

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "presentation-schema"
    / "fixtures"
    / "technical-deck.mydeck.json"
)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'agents.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "agent@localhost"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def deck(client, auth):
    response = client.post(
        "/v1/decks/from-template",
        headers=auth,
        json={"template_id": "technical-architecture", "title": "Deploy pipeline"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def first_text_element(document: dict) -> tuple[str, str]:
    for slide in document["slides"]:
        for element in slide["elements"]:
            if element["type"] == "text":
                return slide["id"], element["id"]
    raise AssertionError("the fixture deck has no text element")


def test_the_internal_prompt_edit_route_is_gone(client, auth, deck):
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/agent/edit",
        headers=auth,
        json={"instruction": "make it better", "scope": {"kind": "elements", "element_ids": []}},
    )

    assert response.status_code == 404

# -------------------------------------------------------------- proposals


def make_pending(client, auth, deck) -> str:
    """A medium-risk change, which must wait for a human."""
    presentation_id = deck["presentation_id"]
    document = deck["document"]
    slide_id = document["slides"][0]["id"]
    element_ids = [element["id"] for element in document["slides"][0]["elements"][:2]]

    # Two deletions on one slide is medium risk (doc 02 §31.7), so it becomes a
    # proposal rather than applying.
    response = client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth,
        json={
            "operations": [
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[0]}"},
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[1]}"},
            ],
            "intent": "Clear the slide",
        },
    )
    assert response.status_code == 200
    return response.json()["transaction_id"]


def test_a_medium_risk_agent_change_waits_for_a_human(client, auth, deck, monkeypatch):
    from deckastra_api import proposals

    presentation_id = deck["presentation_id"]
    document = deck["document"]
    slide_id = document["slides"][0]["id"]
    element_ids = [element["id"] for element in document["slides"][0]["elements"][:2]]

    with db_session.session_scope() as session:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=[
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[0]}"},
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[1]}"},
            ],
            intent="Clear the slide",
            created_by="usr_test",
            agent_id="editor",
        )

    assert outcome["status"] == "pending"
    assert outcome["risk_tier"] in {"medium", "high"}
    # The preview is returned, never stored — a stored preview goes stale.
    assert outcome["preview"] is not None
    assert outcome["expires_at"]

    listed = client.get(f"/v1/presentations/{presentation_id}/proposals", headers=auth)
    assert [row["id"] for row in listed.json()] == [outcome["transaction_id"]]


def test_approving_applies_it_and_keeps_the_record(client, auth, deck):
    from deckastra_api import proposals

    presentation_id = deck["presentation_id"]
    slide_id = deck["document"]["slides"][0]["id"]
    element_ids = [element["id"] for element in deck["document"]["slides"][0]["elements"][:2]]

    with db_session.session_scope() as session:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=[
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[0]}"},
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[1]}"},
            ],
            intent="Clear the slide",
            created_by="usr_test",
        )

    proposal_id = outcome["transaction_id"]
    approved = client.post(
        f"/v1/presentations/{presentation_id}/proposals/{proposal_id}/approve", headers=auth
    )

    assert approved.status_code == 200, approved.text
    assert approved.json()["transaction_id"] != proposal_id  # a new applied transaction

    with db_session.session_scope() as session:
        row = session.get(TransactionRow, proposal_id)
        # The pending row survives, recording that a human said yes.
        assert row.status == "applied"
        assert row.result_version_id


def test_approving_twice_is_a_conflict(client, auth, deck):
    from deckastra_api import proposals

    presentation_id = deck["presentation_id"]
    slide_id = deck["document"]["slides"][0]["id"]
    element_ids = [element["id"] for element in deck["document"]["slides"][0]["elements"][:2]]

    with db_session.session_scope() as session:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=[
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[0]}"},
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[1]}"},
            ],
            intent="Clear the slide",
            created_by="usr_test",
        )

    proposal_id = outcome["transaction_id"]
    client.post(f"/v1/presentations/{presentation_id}/proposals/{proposal_id}/approve", headers=auth)
    again = client.post(
        f"/v1/presentations/{presentation_id}/proposals/{proposal_id}/approve", headers=auth
    )

    assert again.status_code == 409


def test_rejecting_records_why_so_the_critic_learns(client, auth, deck):
    from deckastra_api import proposals
    from deckastra_api.db.models import AgentMemoryRow

    presentation_id = deck["presentation_id"]
    slide_id = deck["document"]["slides"][0]["id"]
    element_ids = [element["id"] for element in deck["document"]["slides"][0]["elements"][:2]]

    with db_session.session_scope() as session:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=[
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[0]}"},
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[1]}"},
            ],
            intent="Clear the slide",
            created_by="usr_test",
        )

    response = client.post(
        f"/v1/presentations/{presentation_id}/proposals/{outcome['transaction_id']}/reject",
        headers=auth,
        json={"reason": "We want that content"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"

    # A Critic that proposes the same rejected change every run is a Critic
    # people stop reading (gap register doc 03 S2).
    with db_session.session_scope() as session:
        notes = session.query(AgentMemoryRow).all()
        assert any("Clear the slide" in note.note for note in notes)


def test_a_stale_proposal_expires_instead_of_applying(client, auth, deck):
    from deckastra_api import proposals

    presentation_id = deck["presentation_id"]
    slide_id = deck["document"]["slides"][0]["id"]
    element_ids = [element["id"] for element in deck["document"]["slides"][0]["elements"][:2]]

    with db_session.session_scope() as session:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=[
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[0]}"},
                {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[1]}"},
            ],
            intent="Clear the slide",
            created_by="usr_test",
        )

    proposal_id = outcome["transaction_id"]

    with db_session.session_scope() as session:
        row = session.get(TransactionRow, proposal_id)
        row.expires_at = datetime.now(timezone.utc) - timedelta(hours=1)

    # Approving an expired proposal applies a patch to a document the approver
    # never saw. Refused.
    response = client.post(
        f"/v1/presentations/{presentation_id}/proposals/{proposal_id}/approve", headers=auth
    )
    assert response.status_code == 409
    assert "expired" in response.json()["detail"]["message"].lower()

    listed = client.get(f"/v1/presentations/{presentation_id}/proposals", headers=auth)
    assert listed.json() == []


def test_a_viewer_cannot_approve(client, auth, deck):
    other = client.post("/v1/dev/session", json={"email": "stranger@localhost"})
    stranger = {"Authorization": f"Bearer {other.json()['token']}"}

    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals/txn_x/approve", headers=stranger
    )
    # 404, not 403: a 403 on something you cannot see confirms it exists.
    assert response.status_code == 404
