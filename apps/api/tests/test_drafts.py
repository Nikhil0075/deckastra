"""Draft boards stay cheap, geometry-free and explicitly built by a person."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import drafts, grants  # noqa: E402
from deckastra_api.auth import Principal  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import Draft, TransactionRow  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'drafts.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api.main import app
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def session(client):
    response = client.post("/v1/dev/session", json={"email": "drafts@localhost"}).json()
    return response, {"Authorization": f"Bearer {response['token']}"}


def body():
    return {
        "brief": "Move from the problem to the decision.",
        "cards": [
            {"id": "crd_open", "layout": "title", "blocks": [{"role": "headline", "text": "A decision worth making"}]},
            {"id": "crd_case", "layout": "bullets", "blocks": [
                {"role": "headline", "text": "Three reasons to act"},
                {"role": "bullet", "text": "The first reason"},
                {"role": "bullet", "text": "The second reason"},
            ]},
        ],
    }


def create(client, session):
    account, auth = session
    response = client.post(f"/v1/projects/{account['project_id']}/drafts", headers=auth, json={"title": "Decision", "body": body()})
    assert response.status_code == 200, response.text
    return response.json(), auth


def test_draft_is_outside_the_deck_and_refuses_geometry(client, session):
    draft, auth = create(client, session)
    assert draft["revision"] == 1
    invalid = body()
    invalid["cards"][0]["x"] = 120
    response = client.put(f"/v1/drafts/{draft['id']}", headers=auth, json={"revision": 1, "body": invalid})
    assert response.status_code == 422


def test_stale_revision_is_a_conflict_and_does_not_overwrite(client, session):
    draft, auth = create(client, session)
    first = client.patch(f"/v1/drafts/{draft['id']}", headers=auth, json={"revision": 1, "operations": [{"op": "move", "card_id": "crd_case", "index": 0}]})
    assert first.status_code == 200
    stale = client.patch(f"/v1/drafts/{draft['id']}", headers=auth, json={"revision": 1, "operations": [{"op": "remove", "card_id": "crd_case"}]})
    assert stale.status_code == 409
    assert client.get(f"/v1/drafts/{draft['id']}", headers=auth).json()["body"]["cards"][0]["id"] == "crd_case"


def test_agent_cannot_change_a_locked_card_but_can_change_another(client, session):
    draft, _auth = create(client, session)
    with db_session.session_scope() as db:
        row = db.get(Draft, draft["id"])
        original = drafts.DraftBody.model_validate(row.body_json)
        locked = original.model_copy(update={"cards": [original.cards[0].model_copy(update={"locked": True}), original.cards[1]]})
        row.body_json = locked.model_dump(mode="json", exclude_none=True)
        agent = Principal(user_id=row.created_by, email="agent@localhost", scopes=frozenset({"read", "write"}))
        changed_locked = locked.model_copy(update={"cards": [locked.cards[0].model_copy(update={"blocks": [drafts.DraftBlock(role="headline", text="Changed")]}), locked.cards[1]]})
        with pytest.raises(Exception) as refused:
            drafts._write(row, changed_locked, agent)
        assert getattr(refused.value, "status_code", None) == 409
        changed_elsewhere = locked.model_copy(update={"cards": [locked.cards[0], locked.cards[1].model_copy(update={"blocks": [drafts.DraftBlock(role="headline", text="Changed elsewhere")]})]})
        drafts._write(row, changed_elsewhere, agent)
        assert row.revision == 2


def test_build_new_deck_uses_card_order_and_no_credits(client, session):
    draft, auth = create(client, session)
    result = client.post(f"/v1/drafts/{draft['id']}/build", headers=auth, json={"revision": 1})
    assert result.status_code == 200, result.text
    built = result.json()
    assert built["kind"] == "deck"
    assert [slide["keyMessage"] for slide in built["document"]["slides"]] == ["A decision worth making", "Three reasons to act"]


def test_linked_build_is_one_pending_proposal(client, session):
    account, auth = session
    deck = client.post("/v1/decks/compose", headers=auth, json={"project_id": account["project_id"], "story_plan": {
        "title": "Linked", "audience": "", "objective": "", "narrative_arc": "",
        "slides": [{"layout": "statement", "purpose": "Open", "key_message": "Old", "headline": "Old"}],
    }}).json()
    seeded = client.post(f"/v1/presentations/{deck['presentation_id']}/drafts", headers=auth).json()
    replacement = body()
    saved = client.put(f"/v1/drafts/{seeded['id']}", headers=auth, json={"revision": seeded["revision"], "body": replacement}).json()
    result = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={"revision": saved["revision"]})
    assert result.status_code == 200, result.text
    assert result.json()["kind"] == "proposal"
    with db_session.session_scope() as db:
        rows = db.query(TransactionRow).filter(TransactionRow.presentation_id == deck["presentation_id"]).all()
        assert len(rows) == 1
        assert rows[0].status == "pending"
        assert rows[0].operations_json[0]["path"] == "/slides"



def _linked_deck(client, session, count=4):
    account, auth = session
    deck = client.post("/v1/decks/compose", headers=auth, json={"project_id": account["project_id"], "story_plan": {
        "title": "Linked", "audience": "", "objective": "", "narrative_arc": "",
        "slides": [{"layout": "statement", "purpose": f"Beat {n}", "key_message": f"Point {n}", "headline": f"Point {n}"} for n in range(1, count + 1)],
    }}).json()
    seeded = client.post(f"/v1/presentations/{deck['presentation_id']}/drafts", headers=auth).json()
    return deck, seeded, auth


def _proposed_slides(presentation_id, transaction_id):
    with db_session.session_scope() as db:
        row = db.get(TransactionRow, transaction_id)
        assert row.status == "pending"
        return row.operations_json[0]["value"]


def test_building_selected_cards_changes_only_their_slides(client, session):
    # 2026-10-15: building one card of a ten-slide deck proposed a deck of one
    # slide, with every slide id new. A build of selected cards must leave every
    # other slide exactly as it was.
    deck, seeded, auth = _linked_deck(client, session)
    original = deck["document"]["slides"]
    cards = seeded["body"]["cards"]
    assert [card["source_slide_id"] for card in cards] == [slide["id"] for slide in original]
    edited = client.patch(f"/v1/drafts/{seeded['id']}", headers=auth, json={"revision": seeded["revision"], "operations": [
        {"op": "set_blocks", "card_id": cards[1]["id"], "blocks": [{"role": "headline", "text": "A sharper second point"}]},
        {"op": "add", "index": 2, "card": {"id": "crd_inserted", "layout": "statement", "blocks": [{"role": "headline", "text": "A new beat"}]}},
    ]}).json()
    built = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={
        "revision": edited["revision"], "card_ids": [cards[1]["id"], "crd_inserted"],
    })
    assert built.status_code == 200, built.text
    slides = _proposed_slides(deck["presentation_id"], built.json()["transaction_id"])

    assert len(slides) == len(original) + 1
    # The rebuilt card keeps its slide's id and place; the new one follows it.
    assert slides[1]["id"] == original[1]["id"]
    assert "A sharper second point" in str(slides[1]["elements"])
    assert "A new beat" in str(slides[2]["elements"])
    assert slides[2]["id"] not in {slide["id"] for slide in original}
    # Everything not selected is byte for byte the slide it was.
    assert [slides[0], *slides[3:]] == [original[0], *original[2:]]


def test_building_every_card_keeps_unchanged_slides_and_removes_deleted_ones(client, session):
    deck, seeded, auth = _linked_deck(client, session)
    original = deck["document"]["slides"]
    cards = seeded["body"]["cards"]
    edited = client.patch(f"/v1/drafts/{seeded['id']}", headers=auth, json={"revision": seeded["revision"], "operations": [
        {"op": "remove", "card_id": cards[3]["id"]},
        {"op": "move", "card_id": cards[0]["id"], "index": 2},
    ]}).json()
    built = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={"revision": edited["revision"]})
    assert built.status_code == 200, built.text
    assert any("will be removed" in warning for warning in built.json()["warnings"])
    slides = _proposed_slides(deck["presentation_id"], built.json()["transaction_id"])
    # Board order, each slide untouched, the deleted card's slide gone.
    assert slides == [original[1], original[2], original[0]]


def test_a_board_that_matches_the_deck_has_nothing_to_build(client, session):
    deck, seeded, auth = _linked_deck(client, session, count=2)
    built = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={"revision": seeded["revision"]})
    assert built.status_code == 422


def test_card_request_resolves_targets_and_is_answered_only_after_an_edit(client, session):
    draft, auth = create(client, session)
    made = client.post(f"/v1/drafts/{draft['id']}/requests", headers=auth, json={
        "card_ids": ["crd_case"], "kind": "content", "message": "Make this tighter", "revision": 1,
    })
    assert made.status_code == 200, made.text
    request = made.json()
    assert request["resolved_target"]["cards"][0]["id"] == "crd_case"
    too_soon = client.post(f"/v1/draft-requests/{request['id']}/answer", headers=auth, json={"revision": 1})
    assert too_soon.status_code == 409
    edited = client.patch(f"/v1/drafts/{draft['id']}", headers=auth, json={"revision": 1, "operations": [
        {"op": "set_blocks", "card_id": "crd_case", "blocks": [{"role": "headline", "text": "Tighter"}]},
    ]}).json()
    answered = client.post(f"/v1/draft-requests/{request['id']}/answer", headers=auth, json={"revision": edited["revision"]})
    assert answered.status_code == 200, answered.text
    assert answered.json()["status"] == "answered"


def test_agents_can_edit_drafts_but_cannot_build_or_author_the_request():
    assert grants.required_scope("PATCH", "/v1/drafts/drf_1") == "write"
    assert grants.required_scope("POST", "/v1/drafts/drf_1/build") == "approve"
    assert grants.required_scope("POST", "/v1/drafts/drf_1/requests") == "approve"
    assert grants.required_scope("GET", "/v1/drafts/drf_1/requests") == "read"
    assert grants.required_scope("POST", "/v1/draft-requests/req_1/answer") == "write"
    assert grants.required_scope("POST", "/v1/draft-requests/req_1/close") == "approve"


def test_drafting_changes_to_a_real_deck_seeds_its_words(client, session):
    # 2026-10-15: slide text is rich text, and seeding read only `content.text`,
    # so every card of a real deck came out empty.
    account, auth = session
    deck = client.post("/v1/decks/from-template", headers=auth,
                        json={"project_id": account["project_id"], "template_id": "technical-architecture", "title": "Seeded"}).json()
    seeded = client.post(f"/v1/presentations/{deck['presentation_id']}/drafts", headers=auth).json()
    cards = seeded["body"]["cards"]
    assert len(cards) == len(deck["document"]["slides"])
    assert all(card["blocks"] for card in cards), [card["layout"] for card in cards if not card["blocks"]]
    headlines = [block["text"] for card in cards for block in card["blocks"] if block["role"] == "headline"]
    assert len(headlines) >= len(cards) - 1
    assert any(block["role"] == "bullet" for card in cards for block in card["blocks"])

    # Seeded cards are the deck as it is: building them all changes nothing.
    built = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={"revision": seeded["revision"]})
    assert built.status_code == 422
