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


def test_draft_moves_to_trash_and_restores_without_losing_work(client, session):
    draft, auth = create(client, session)
    project_id = draft["project_id"]

    deleted = client.delete(f"/v1/drafts/{draft['id']}", headers=auth)
    assert deleted.status_code == 200
    assert deleted.json()["deleted_at"]
    assert client.get(f"/v1/drafts/{draft['id']}", headers=auth).status_code == 404
    assert client.get(f"/v1/projects/{project_id}/drafts", headers=auth).json() == []

    trash = client.get(f"/v1/projects/{project_id}/drafts?deleted=true", headers=auth).json()
    assert [item["id"] for item in trash] == [draft["id"]]
    assert trash[0]["body"] == draft["body"]

    restored = client.post(f"/v1/drafts/{draft['id']}/restore", headers=auth)
    assert restored.status_code == 200
    assert restored.json()["deleted_at"] is None
    assert restored.json()["body"] == draft["body"]
    assert client.get(f"/v1/drafts/{draft['id']}", headers=auth).status_code == 200


def test_draft_lifecycle_requires_manage_scope():
    assert grants.required_scope("DELETE", "/v1/drafts/drf_1") == "manage"
    assert grants.required_scope("POST", "/v1/drafts/drf_1/restore") == "manage"


def test_layout_change_converts_blocks_and_keeps_the_previous_content():
    card = drafts.DraftCard(id="crd_convert", layout="statement", blocks=[
        drafts.DraftBlock(role="headline", text="Customer trust"),
        drafts.DraftBlock(role="body", text="Trust is earned in the recovery."),
    ])
    quote = drafts._convert_layout(card, "quote")
    assert quote.layout == "quote"
    assert [(block.role, block.text) for block in quote.blocks] == [
        ("headline", "Customer trust"), ("quote", "Trust is earned in the recovery."),
    ]
    assert quote.alternatives[-1] == card.blocks

    image = drafts._convert_layout(quote, "image")
    assert image.layout == "image"
    picture = next(block for block in image.blocks if block.role == "image")
    assert picture.image.subject == "Trust is earned in the recovery."
    assert image.alternatives[-1] == quote.blocks

    timeline = drafts._convert_layout(card, "timeline")
    stages = next(block.data for block in timeline.blocks if block.role == "timeline")
    assert len(stages) == 2
    assert stages[0]["detail"] == "Trust is earned in the recovery."


def test_set_layout_operation_is_semantic(client, session):
    draft, auth = create(client, session)
    changed = client.patch(f"/v1/drafts/{draft['id']}", headers=auth, json={"revision": 1, "operations": [
        {"op": "set_layout", "card_id": "crd_case", "layout": "quote"},
    ]})
    assert changed.status_code == 200, changed.text
    card = next(card for card in changed.json()["body"]["cards"] if card["id"] == "crd_case")
    assert card["layout"] == "quote"
    assert [block["role"] for block in card["blocks"]] == ["headline", "quote"]
    assert card["alternatives"][0][1]["role"] == "bullet"


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


def test_second_build_waits_for_the_first_review_decision(client, session):
    deck, seeded, auth = _linked_deck(client, session, count=2)
    card = seeded["body"]["cards"][0]
    edited = client.patch(f"/v1/drafts/{seeded['id']}", headers=auth, json={"revision": seeded["revision"], "operations": [
        {"op": "set_blocks", "card_id": card["id"], "blocks": [{"role": "headline", "text": "One proposal at a time"}]},
    ]}).json()
    first = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={"revision": edited["revision"]})
    assert first.status_code == 200, first.text
    second = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={"revision": edited["revision"]})
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "E_DRAFT_BUILD_PENDING"
    assert second.json()["detail"]["proposal_id"] == first.json()["transaction_id"]


def test_build_reports_card_specific_semantic_problem(client, session):
    account, auth = session
    made = client.post(f"/v1/projects/{account['project_id']}/drafts", headers=auth, json={
        "title": "Incomplete", "body": {"cards": [
            {"id": "crd_quote", "layout": "quote", "blocks": [{"role": "headline", "text": "No quotation yet"}]},
        ]},
    }).json()
    built = client.post(f"/v1/drafts/{made['id']}/build", headers=auth, json={"revision": made["revision"]})
    assert built.status_code == 422
    assert built.json()["detail"] == {
        "message": "Fix these cards before building.",
        "issues": [{"card_id": "crd_quote", "layout": "quote", "message": "Add quote text before building."}],
    }


def test_linked_draft_is_marked_built_only_after_approval(client, session):
    deck, seeded, auth = _linked_deck(client, session, count=2)
    card = seeded["body"]["cards"][0]
    edited = client.patch(f"/v1/drafts/{seeded['id']}", headers=auth, json={"revision": seeded["revision"], "operations": [
        {"op": "set_blocks", "card_id": card["id"], "blocks": [{"role": "headline", "text": "Approved, not merely proposed"}]},
    ]}).json()

    proposed = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={"revision": edited["revision"]})
    assert proposed.status_code == 200, proposed.text
    while_pending = client.get(f"/v1/drafts/{seeded['id']}", headers=auth).json()
    assert while_pending["built_revision"] == seeded["revision"]
    assert while_pending["changed_since_build"] is True

    approved = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals/{proposed.json()['transaction_id']}/approve",
        headers=auth,
        json={"expected_version_id": deck["version_id"]},
    )
    assert approved.status_code == 200, approved.text
    after = client.get(f"/v1/drafts/{seeded['id']}", headers=auth).json()
    assert after["built_revision"] == edited["revision"]
    assert after["built_version_id"] == approved.json()["version_id"]
    assert after["changed_since_build"] is False


def test_partial_build_does_not_claim_the_whole_board_matches(client, session):
    deck, seeded, auth = _linked_deck(client, session, count=2)
    card = seeded["body"]["cards"][0]
    edited = client.patch(f"/v1/drafts/{seeded['id']}", headers=auth, json={"revision": seeded["revision"], "operations": [
        {"op": "set_blocks", "card_id": card["id"], "blocks": [{"role": "headline", "text": "Only this card"}]},
    ]}).json()
    proposed = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={"revision": edited["revision"], "card_ids": [card["id"]]}).json()
    approved = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals/{proposed['transaction_id']}/approve",
        headers=auth,
        json={"expected_version_id": deck["version_id"]},
    )
    assert approved.status_code == 200, approved.text
    after = client.get(f"/v1/drafts/{seeded['id']}", headers=auth).json()
    assert after["built_revision"] == seeded["revision"]
    assert after["changed_since_build"] is True



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


def test_opening_draft_changes_reuses_the_latest_board(client, session):
    deck, seeded, auth = _linked_deck(client, session, count=2)
    card = seeded["body"]["cards"][0]
    edited = client.patch(f"/v1/drafts/{seeded['id']}", headers=auth, json={"revision": seeded["revision"], "operations": [
        {"op": "set_blocks", "card_id": card["id"], "blocks": [{"role": "headline", "text": "Keep this board"}]},
    ]}).json()
    # Simulate the stale revision-1 board created by the old open-on-every-click
    # route. Revision wins before creation time, so this ghost cannot take over.
    account, _auth = session
    ghost = client.post(f"/v1/projects/{account['project_id']}/drafts", headers=auth, json={
        "title": "Draft changes — ghost", "presentation_id": deck["presentation_id"], "body": body(),
    })
    assert ghost.status_code == 200, ghost.text
    reopened = client.post(f"/v1/presentations/{deck['presentation_id']}/drafts", headers=auth)
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["id"] == seeded["id"]
    assert reopened.json()["revision"] == edited["revision"]
    assert reopened.json()["body"]["cards"][0]["blocks"][0]["text"] == "Keep this board"


def test_seed_preserves_chart_diagram_timeline_and_image_data():
    def text(role, words, x=0, y=0, width=100):
        return {"type": "text", "semanticRole": role, "transform": {"x": x, "y": y, "width": width, "height": 40},
                "content": {"blocks": [{"type": "paragraph", "spans": [{"text": words}]}]}}

    document = {"slides": [
        {"id": "s_chart", "layout": {"styleLabel": "chart"}, "elements": [
            text("headline", "Revenue"),
            {"type": "chart", "chartType": "bar", "data": {"type": "inline", "rows": [{"category": "A", "Sales": 10}, {"category": "B", "Sales": 20}]},
             "encoding": {"category": "category", "value": "Sales"}, "chartStyle": {"numberFormat": {"suffix": "%"}}},
        ]},
        {"id": "s_diagram", "layout": {"styleLabel": "diagram"}, "elements": [
            text("headline", "Flow"),
            {"type": "diagram", "diagramType": "flow", "layoutHint": {"direction": "LR", "mode": "managed"},
             "nodes": [{"id": "a", "label": "Start"}, {"id": "b", "label": "Finish"}],
             "edges": [{"id": "e", "from": "a", "to": "b", "label": "then"}]},
        ]},
        {"id": "s_timeline", "layout": {"styleLabel": "timeline"}, "elements": [
            text("headline", "Roadmap"),
            {"type": "shape", "name": "Milestone 1", "transform": {"x": 100, "y": 500, "width": 20, "height": 20}},
            {"type": "shape", "name": "Milestone 2", "transform": {"x": 500, "y": 500, "width": 20, "height": 20}},
            text("label", "Q1", 50, 420, 120), text("body", "Pilot", 50, 550, 120), text("body", "Learn", 50, 620, 120),
            text("label", "Q2", 450, 420, 120), text("body", "Scale", 450, 550, 120), text("body", "Grow", 450, 620, 120),
        ]},
        {"id": "s_image", "layout": {"styleLabel": "image"}, "background": {"assetId": "ast_existing"}, "elements": [text("headline", "A real image")]},
    ]}

    seeded = drafts._seed_body(document)
    chart = next(block for block in seeded.cards[0].blocks if block.role == "chart")
    assert chart.data["categories"] == ["A", "B"]
    assert chart.data["series"][0] == {"name": "Sales", "values": [10.0, 20.0]}
    diagram = next(block for block in seeded.cards[1].blocks if block.role == "diagram")
    assert diagram.data["nodes"][0]["label"] == "Start"
    assert diagram.data["edges"][0]["label"] == "then"
    timeline = next(block for block in seeded.cards[2].blocks if block.role == "timeline")
    assert timeline.data == [
        {"when": "Q1", "label": "Pilot", "detail": "Learn"},
        {"when": "Q2", "label": "Scale", "detail": "Grow"},
    ]
    image = next(block for block in seeded.cards[3].blocks if block.role == "image")
    assert image.image.asset_id == "ast_existing"


def test_existing_untouched_board_is_enriched_without_overwriting_edited_cards():
    chart_slide = {
        "id": "s_chart", "layout": {"styleLabel": "chart"}, "elements": [
            {"type": "text", "semanticRole": "headline", "content": {"blocks": [{"type": "paragraph", "spans": [{"text": "Revenue"}]}]}},
            {"type": "chart", "chartType": "bar", "data": {"type": "inline", "rows": [{"category": "A", "Sales": 10}, {"category": "B", "Sales": 20}]},
             "encoding": {"category": "category", "value": "Sales"}},
        ],
    }
    untouched = drafts.DraftCard(id="c1", layout="chart", blocks=[drafts.DraftBlock(role="headline", text="Revenue")], source_slide_id="s_chart")
    untouched = untouched.model_copy(update={"source_fingerprint": drafts._fingerprint(untouched)})
    edited = drafts.DraftCard(id="c2", layout="chart", blocks=[drafts.DraftBlock(role="headline", text="Authored change")], source_slide_id="s_chart", source_fingerprint="old")
    row = Draft(
        id="drf_legacy", project_id="prj_legacy", presentation_id="prs_legacy", title="Legacy",
        body_json=drafts.DraftBody(cards=[untouched, edited]).model_dump(mode="json", exclude_none=True),
        created_by="usr_legacy", revision=5,
    )

    assert drafts._upgrade_seeded_structure(row, {"slides": [chart_slide]}) is True
    upgraded = drafts.DraftBody.model_validate(row.body_json)
    assert row.revision == 6
    assert any(block.role == "chart" for block in upgraded.cards[0].blocks)
    assert upgraded.cards[1].blocks[0].text == "Authored change"
    assert not any(block.role == "chart" for block in upgraded.cards[1].blocks)


def test_structured_cards_survive_a_linked_edit_and_rebuild(client, session):
    account, auth = session
    deck = client.post("/v1/decks/compose", headers=auth, json={"project_id": account["project_id"], "story_plan": {
        "title": "Structured", "audience": "", "objective": "", "narrative_arc": "",
        "slides": [
            {"layout": "chart", "purpose": "Evidence", "key_message": "Revenue", "headline": "Revenue",
             "chart": {"type": "bar", "categories": ["A", "B"], "series": [{"name": "Sales", "values": [10, 20]}]}},
            {"layout": "diagram", "purpose": "Flow", "key_message": "System", "headline": "System",
             "diagram": {"kind": "flow", "nodes": [{"key": "a", "label": "Start"}, {"key": "b", "label": "Finish"}],
                         "edges": [{"source": "a", "target": "b", "label": "then"}]}},
            {"layout": "timeline", "purpose": "Roadmap", "key_message": "Roadmap", "headline": "Roadmap",
             "timeline": [{"when": "Q1", "label": "Pilot", "detail": "Learn"}, {"when": "Q2", "label": "Scale", "detail": "Grow"}]},
        ],
    }})
    assert deck.status_code == 200, deck.text
    deck = deck.json()
    seeded = client.post(f"/v1/presentations/{deck['presentation_id']}/drafts", headers=auth).json()
    roles = [{block["role"] for block in card["blocks"]} for card in seeded["body"]["cards"]]
    assert "chart" in roles[0]
    assert "diagram" in roles[1]
    assert "timeline" in roles[2]

    first = seeded["body"]["cards"][0]
    blocks = [{**block, "text": "Revenue is accelerating"} if block["role"] == "headline" else block for block in first["blocks"]]
    edited = client.patch(f"/v1/drafts/{seeded['id']}", headers=auth, json={"revision": seeded["revision"], "operations": [
        {"op": "set_blocks", "card_id": first["id"], "blocks": blocks},
    ]}).json()
    proposed = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={"revision": edited["revision"]})
    assert proposed.status_code == 200, proposed.text
    slides = _proposed_slides(deck["presentation_id"], proposed.json()["transaction_id"])
    assert any(element.get("type") == "chart" for element in slides[0]["elements"])
    assert any(element.get("type") == "diagram" for element in slides[1]["elements"])
    assert len([element for element in slides[2]["elements"] if str(element.get("name") or "").startswith("Milestone ")]) == 2


def test_a_build_that_would_lose_a_deck_edit_is_refused_and_the_card_can_be_synced(client, session):
    # Release E2E step 7 (2026-10-17): the deck changed after the board took
    # its slides. A card the board left alone keeps the deck's edit; a card
    # changed on both sides is refused by name until the person chooses.
    deck, seeded, auth = _linked_deck(client, session, count=3)
    cards = seeded["body"]["cards"]
    slides = deck["document"]["slides"]
    edited = client.patch(f"/v1/drafts/{seeded['id']}", headers=auth, json={"revision": seeded["revision"], "operations": [
        {"op": "set_blocks", "card_id": cards[1]["id"], "blocks": [{"role": "headline", "text": "Board words"}]},
    ]}).json()
    head = client.get(f"/v1/presentations/{deck['presentation_id']}/head", headers=auth).json()["version_id"]
    for slide in slides[:2]:
        moved = client.post(f"/v1/presentations/{deck['presentation_id']}/transactions", headers=auth, json={
            "operations": [{"op": "add", "path": f"/slides/id:{slide['id']}/speakerNotes", "value": "Deck note"}],
            "intent": "Note", "expected_version_id": head, "client_id": "web-editor",
        })
        assert moved.status_code == 200, moved.text
        head = moved.json()["version_id"]

    read = client.get(f"/v1/drafts/{seeded['id']}", headers=auth).json()
    assert read["deck_changed_card_ids"] == sorted([cards[0]["id"], cards[1]["id"]])
    assert read["deck_conflict_card_ids"] == [cards[1]["id"]]

    refused = client.post(f"/v1/drafts/{seeded['id']}/build", headers=auth, json={"revision": edited["revision"]})
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == "E_DRAFT_DECK_MOVED"
    assert refused.json()["detail"]["card_ids"] == [cards[1]["id"]]

    synced = client.post(f"/v1/drafts/{seeded['id']}/sync", headers=auth, json={"revision": edited["revision"], "card_ids": [cards[1]["id"]]})
    assert synced.status_code == 200, synced.text
    card = next(item for item in synced.json()["body"]["cards"] if item["id"] == cards[1]["id"])
    assert card["notes"] == "Deck note"
    assert client.get(f"/v1/drafts/{seeded['id']}", headers=auth).json()["deck_conflict_card_ids"] == []
