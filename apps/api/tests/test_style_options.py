"""Style options are one expiring decision, not several independent proposals."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import StyleOptionSet, TransactionRow  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'styles.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api.main import app
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "styles@localhost"})
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def deck(client, auth):
    response = client.post(
        "/v1/decks/from-template", headers=auth,
        json={"template_id": "technical-architecture", "title": "Style choices"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def suggestions(deck):
    return {
        "expected_version_id": deck["version_id"],
        "options": [
            {
                "label": "Quiet editorial", "theme_key": "minimal-light",
                "design_language": "quiet-luxe", "motion_style": "restrained",
                "rationale": "Makes the hierarchy calm and typographic.",
            },
            {
                "label": "Night system", "theme_key": "neo-technical",
                "design_language": "system-terminal", "motion_style": "technical",
                "rationale": "Makes the architecture feel precise and operational.",
            },
        ],
    }


def test_suggestions_draw_real_covers_and_store_nothing_in_the_deck(client, auth, deck):
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/style-options",
        headers=auth, json=suggestions(deck),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["options"]) == 2
    assert body["options"][0]["preview_document"]["slides"][0]["id"] == deck["document"]["slides"][0]["id"]
    assert body["options"][0]["preview_document"]["theme"]["name"] != deck["document"]["theme"]["name"]
    read = client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth).json()
    assert read["version_id"] == deck["version_id"]


def test_palette_below_aa_is_refused_with_the_option_named(client, auth, deck):
    body = suggestions(deck)
    body["options"][0] = {
        "label": "Unreadable", "palette": {
            "background": "#777777", "text": "#787878", "accent": "#3366FF",
        }, "rationale": "A deliberately bad contrast check.",
    }
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/style-options", headers=auth, json=body
    )
    assert response.status_code == 422
    assert "Unreadable" in response.text
    assert "4.5" in response.text


@pytest.mark.parametrize(
    "change, phrase",
    [
        ({"theme_key": "not-a-theme"}, "built-in theme"),
        ({"design_language": "not-a-language", "theme_key": "minimal-light"}, "design language"),
        ({"theme_key": "minimal-light", "fonts": {"display": "Remote Sans"}}, "bundled font"),
        ({"theme_key": "minimal-light", "motion_style": "not-motion"}, "motion style"),
    ],
)
def test_unknown_style_vocabulary_is_refused(client, auth, deck, change, phrase):
    body = suggestions(deck)
    body["options"][0] = {
        "label": "Unknown direction", "rationale": "Should be refused.", **change,
    }
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/style-options", headers=auth, json=body
    )
    assert response.status_code == 422
    assert phrase in response.text


def test_choosing_one_style_creates_one_transaction_and_closes_the_set(client, auth, deck):
    created = client.post(
        f"/v1/presentations/{deck['presentation_id']}/style-options",
        headers=auth, json=suggestions(deck),
    ).json()
    chosen = created["options"][1]["id"]
    applied = client.post(
        f"/v1/style-options/{created['id']}/choose", headers=auth,
        json={"option_id": chosen, "expected_version_id": deck["version_id"]},
    )
    assert applied.status_code == 200, applied.text
    # The deck's slides keep their layouts, so it keeps recording their language.
    before = deck["document"]["metadata"].get("designLanguage")
    assert applied.json()["document"]["metadata"].get("designLanguage") == before
    with db_session.session_scope() as session:
        row = session.get(StyleOptionSet, created["id"])
        transactions = session.query(TransactionRow).filter(
            TransactionRow.presentation_id == deck["presentation_id"],
            TransactionRow.client_id == "style-options",
        ).all()
        assert row is not None and row.status == "chosen" and row.chosen_option_id == chosen
        assert len(transactions) == 1
        # The person chose it; the history says whose suggestion it was.
        assert transactions[0].source == "agent" and transactions[0].agent_id == "mcp:external"


def test_a_set_is_marked_stale_and_cannot_apply_after_the_deck_moves(client, auth, deck):
    created = client.post(
        f"/v1/presentations/{deck['presentation_id']}/style-options",
        headers=auth, json=suggestions(deck),
    ).json()
    moved = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transactions", headers=auth,
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "Moved"}],
            "intent": "Retitle", "expected_version_id": deck["version_id"], "client_id": "web-editor",
        },
    )
    assert moved.status_code == 200, moved.text
    listed = client.get(
        f"/v1/presentations/{deck['presentation_id']}/style-options", headers=auth
    ).json()
    assert listed[0]["stale"] is True
    refused = client.post(
        f"/v1/style-options/{created['id']}/choose", headers=auth,
        json={"option_id": created["options"][0]["id"], "expected_version_id": moved.json()["version_id"]},
    )
    assert refused.status_code == 409


def test_an_agent_can_suggest_but_cannot_choose(client):
    from deckastra_api.grants import required_scope

    assert required_scope("POST", "/v1/presentations/p1/style-options") == "write"
    assert required_scope("GET", "/v1/presentations/p1/style-options") == "read"
    assert required_scope("POST", "/v1/style-options/sty_1/choose") == "approve"
