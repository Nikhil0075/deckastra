"""Persisted select-and-say requests and their proposal replies."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import AgentRequest, TransactionRow  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'requests.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api.main import app
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "asker@localhost"})
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def deck(client, auth):
    response = client.post(
        "/v1/decks/from-template", headers=auth,
        json={"template_id": "technical-architecture", "title": "Requests"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_request_resolves_current_target_text_and_motion(client, auth, deck):
    slide = deck["document"]["slides"][0]
    element = slide["elements"][0]
    created = client.post(
        f"/v1/presentations/{deck['presentation_id']}/requests", headers=auth,
        json={
            "target": {"slide_ids": [], "element_ids": [element["id"]]},
            "kind": "motion", "message": "Make this entrance clearer.",
            "based_on_version_id": deck["version_id"],
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["status"] == "open"
    assert body["resolved_target"]["elements"][0]["id"] == element["id"]

    listed = client.get(
        f"/v1/presentations/{deck['presentation_id']}/requests?status=open", headers=auth
    )
    assert [item["id"] for item in listed.json()] == [body["id"]]


def test_project_agent_tasks_track_pending_and_completed_work(client, auth, deck):
    slide = deck["document"]["slides"][0]
    request = client.post(
        f"/v1/presentations/{deck['presentation_id']}/requests", headers=auth,
        json={
            "target": {"slide_ids": [slide["id"]], "element_ids": []},
            "kind": "layout", "message": "Simplify this opening.",
            "based_on_version_id": deck["version_id"],
        },
    ).json()
    account = client.get("/v1/account", headers=auth).json()
    project_id = account["workspaces"][0]["projects"][0]["id"]

    pending = client.get(f"/v1/projects/{project_id}/agent-tasks?status=pending", headers=auth)
    assert pending.status_code == 200, pending.text
    assert len(pending.json()) == 1
    task = pending.json()[0]
    assert task | {"created_at": "timestamp"} == {
        "id": request["id"], "project_id": project_id,
        "resource_type": "deck", "resource_id": deck["presentation_id"],
        "resource_title": "Requests", "resource_deleted": False,
        "kind": "layout", "message": "Simplify this opening.", "status": "open",
        "created_at": "timestamp", "completed_at": None,
        "target_summary": {"slides": 1, "objects": 0, "cards": 0},
        "proposal_ids": [],
        "findings": None,
    }
    assert task["created_at"]

    closed = client.post(f"/v1/requests/{request['id']}/close", headers=auth)
    assert closed.status_code == 200
    completed = client.get(f"/v1/projects/{project_id}/agent-tasks?status=completed", headers=auth).json()
    assert [item["id"] for item in completed] == [request["id"]]
    assert completed[0]["status"] == "closed"
    assert completed[0]["completed_at"]


def test_accepting_one_reply_closes_request_and_withdraws_siblings(client, auth, deck):
    presentation_id = deck["presentation_id"]
    slide = deck["document"]["slides"][0]
    request = client.post(
        f"/v1/presentations/{presentation_id}/requests", headers=auth,
        json={
            "target": {"slide_ids": [slide["id"]], "element_ids": []},
            "kind": "layout", "message": "Give me two cleaner options.",
            "based_on_version_id": deck["version_id"],
        },
    ).json()

    proposal_ids = []
    for element in slide["elements"][:2]:
        proposed = client.post(
            f"/v1/presentations/{presentation_id}/proposals", headers=auth,
            json={
                "operations": [{"op": "remove", "path": f"/slides/id:{slide['id']}/elements/id:{element['id']}"}],
                "intent": f"Alternative without {element['id']}",
                "expected_version_id": deck["version_id"],
                "in_reply_to": request["id"],
            },
        )
        assert proposed.status_code == 200, proposed.text
        assert proposed.json()["outcome"] == "pending"
        proposal_ids.append(proposed.json()["transaction_id"])

    answered = client.post(
        f"/v1/requests/{request['id']}/answer", headers=auth,
        json={"proposal_ids": proposal_ids},
    )
    assert answered.status_code == 200, answered.text
    assert answered.json()["status"] == "answered"
    with db_session.session_scope() as session:
        assert session.get(AgentRequest, request["id"]).answered_at is not None

    accepted = client.post(
        f"/v1/presentations/{presentation_id}/proposals/{proposal_ids[0]}/approve",
        headers=auth, json={"expected_version_id": deck["version_id"]},
    )
    assert accepted.status_code == 200, accepted.text

    with db_session.session_scope() as session:
        question = session.get(AgentRequest, request["id"])
        sibling = session.get(TransactionRow, proposal_ids[1])
        assert question is not None and question.status == "closed"
        assert sibling is not None and sibling.status == "rejected"
        assert "Superseded by accepted reply" in (sibling.reason or "")


def test_request_scope_rules_keep_creation_and_closing_human(client):
    from deckastra_api.grants import required_scope

    assert required_scope("GET", "/v1/presentations/p1/requests") == "read"
    assert required_scope("POST", "/v1/requests/r1/answer") == "write"
    assert required_scope("POST", "/v1/presentations/p1/requests") == "approve"
    assert required_scope("POST", "/v1/requests/r1/close") == "approve"



def _ask(client, auth, deck, element_ids, kind="motion"):
    slide = deck["document"]["slides"][0]
    return client.post(
        f"/v1/presentations/{deck['presentation_id']}/requests", headers=auth,
        json={"target": {"slide_ids": [slide["id"]], "element_ids": element_ids}, "kind": kind,
              "message": "Try another entrance.", "based_on_version_id": deck["version_id"]},
    ).json()


def test_a_low_risk_reply_waits_for_the_person_and_can_answer(client, auth, deck):
    # 2026-10-15: a one-object change is low risk, so it applied at once and then
    # could never answer the request ("Only pending proposals can answer").
    slide = deck["document"]["slides"][0]
    element = next(item for item in slide["elements"] if item["type"] == "text")
    request = _ask(client, auth, deck, [element["id"]])
    proposed = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals", headers=auth,
        json={"operations": [{"op": "add", "path": f"/slides/id:{slide['id']}/elements/id:{element['id']}/transform/rotation", "value": 1}],
              "intent": "Tilt it slightly", "expected_version_id": deck["version_id"], "in_reply_to": request["id"]},
    )
    assert proposed.status_code == 200, proposed.text
    assert proposed.json()["outcome"] == "pending"
    answered = client.post(f"/v1/requests/{request['id']}/answer", headers=auth,
                           json={"proposal_ids": [proposed.json()["transaction_id"]]})
    assert answered.status_code == 200, answered.text

    # Without in_reply_to it waits too: since release 8 (2026-10-17) every
    # change from a connected agent does.
    plain = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals", headers=auth,
        json={"operations": [{"op": "add", "path": f"/slides/id:{slide['id']}/elements/id:{element['id']}/transform/rotation", "value": 1}],
              "intent": "Tilt it slightly", "expected_version_id": deck["version_id"]},
    )
    assert plain.json()["outcome"] == "pending"


def test_motion_and_transition_plans_can_reply(client, auth, deck):
    slide = deck["document"]["slides"][0]
    request = _ask(client, auth, deck, [])
    motion = client.post(
        f"/v1/presentations/{deck['presentation_id']}/motion", headers=auth,
        json={"slide_id": slide["id"], "expected_version_id": deck["version_id"], "sequence": ["headline"],
              "entrance": "fade", "in_reply_to": request["id"]},
    )
    assert motion.status_code == 200, motion.text
    assert motion.json()["outcome"] == "pending"
    with db_session.session_scope() as db:
        assert db.get(TransactionRow, motion.json()["transaction_id"]).in_reply_to_request_id == request["id"]

    second = deck["document"]["slides"][1]
    transition = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transition", headers=auth,
        json={"slide_id": second["id"], "expected_version_id": deck["version_id"], "kind": "fade", "in_reply_to": request["id"]},
    )
    assert transition.status_code == 200, transition.text
    assert transition.json()["outcome"] == "pending"


def test_a_closed_request_takes_no_replies_on_any_route(client, auth, deck):
    slide = deck["document"]["slides"][0]
    request = _ask(client, auth, deck, [])
    client.post(f"/v1/requests/{request['id']}/close", headers=auth)
    motion = client.post(
        f"/v1/presentations/{deck['presentation_id']}/motion", headers=auth,
        json={"slide_id": slide["id"], "expected_version_id": deck["version_id"], "sequence": ["headline"],
              "entrance": "fade", "in_reply_to": request["id"]},
    )
    assert motion.status_code == 409


def test_a_review_of_the_whole_deck_is_answered_in_words(client, auth, deck):
    """Release E2E step 9: "review this deck, change nothing, return findings"."""
    asked = client.post(
        f"/v1/presentations/{deck['presentation_id']}/requests", headers=auth,
        json={"target": {}, "kind": "review", "message": "Review for clarity. Change nothing.",
              "based_on_version_id": deck["version_id"]},
    )
    assert asked.status_code == 200, asked.text
    assert asked.json()["target"]["slide_ids"] == [slide["id"] for slide in deck["document"]["slides"]]

    nothing = client.post(f"/v1/requests/{asked.json()['id']}/answer", headers=auth, json={})
    assert nothing.status_code == 422

    answered = client.post(
        f"/v1/requests/{asked.json()['id']}/answer", headers=auth,
        json={"findings": "1. Slide 3 repeats slide 2's layout.\n2. The chart has no source."},
    )
    assert answered.status_code == 200, answered.text
    assert answered.json()["status"] == "answered"
    assert answered.json()["findings"].startswith("1. Slide 3")

    project_id = client.get("/v1/account", headers=auth).json()["workspaces"][0]["projects"][0]["id"]
    done = client.get(f"/v1/projects/{project_id}/agent-tasks?status=completed", headers=auth).json()
    assert [(task["id"], task["findings"][:2]) for task in done] == [(asked.json()["id"], "1.")]


def test_only_a_review_may_name_no_target(client, auth, deck):
    refused = client.post(
        f"/v1/presentations/{deck['presentation_id']}/requests", headers=auth,
        json={"target": {}, "kind": "layout", "message": "Fix it", "based_on_version_id": deck["version_id"]},
    )
    assert refused.status_code == 422
