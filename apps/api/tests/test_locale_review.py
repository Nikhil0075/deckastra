"""A language is marked reviewed only once all of it is translated (2026-10-11).

"Reviewed" claims a person read the whole language through. A review of an
agent-built deck found a language called translated while a third of its slots
were still in the original, so an agent's change that marks a language reviewed
is refused while anything is missing or outdated.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "api"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from deckastra_api import locales  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'review.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "review@localhost"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _deck(client, auth):
    made = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "technical-architecture"})
    assert made.status_code == 200, made.text
    return made.json()


def _overlay(document, *, every_slot: bool, status: str = "draft"):
    slots = [slot for slot in locales.locale_slots(document) if locales.worth_translating(slot.value)]
    chosen = slots if every_slot else slots[: len(slots) // 2]
    return {
        "locale": "hi",
        "status": status,
        "entries": {
            slot.path: {"value": slot.value, "sourceHash": locales.text_hash(slot.value), "origin": "human"}
            for slot in chosen
        },
    }


def _propose(client, auth, deck, operations):
    return client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals",
        headers=auth,
        json={"operations": operations, "intent": "Translate", "expected_version_id": deck["version_id"]},
    )


def test_coverage_counts_what_the_editor_counts():
    document = {"metadata": {"title": "Hello"}, "slides": []}
    assert locales.coverage(document, "hi") == {"translated": 0, "outdated": 0, "missing": 1}


def test_an_agent_cannot_mark_a_half_translated_language_reviewed(client, auth):
    deck = _deck(client, auth)
    response = _propose(client, auth, deck, [
        {"op": "add", "path": "/locales", "value": {"hi": _overlay(deck["document"], every_slot=False, status="reviewed")}},
    ])
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "E_LOCALE_INCOMPLETE"
    assert "hi cannot be marked reviewed" in detail["message"] and "still missing" in detail["message"]


def test_a_draft_half_translation_and_a_complete_review_are_both_accepted(client, auth):
    deck = _deck(client, auth)
    draft = _propose(client, auth, deck, [
        {"op": "add", "path": "/locales", "value": {"hi": _overlay(deck["document"], every_slot=False)}},
    ])
    assert draft.status_code == 200, draft.text
    complete = _propose(client, auth, deck, [
        {"op": "add", "path": "/locales", "value": {"hi": _overlay(deck["document"], every_slot=True, status="reviewed")}},
    ])
    assert complete.status_code == 200, complete.text


def test_only_a_change_to_reviewed_is_judged():
    """A language already reviewed whose source has since moved is outdated, not refused."""
    before = {"metadata": {"title": "Hello"}, "slides": [],
              "locales": {"hi": {"locale": "hi", "status": "reviewed", "entries": {}}}}
    after = {**before, "metadata": {"title": "Hello again"}}
    assert locales.premature_reviews(before, after) == []
    fresh = {**after, "locales": {"hi": {"locale": "hi", "status": "draft", "entries": {}}}}
    assert locales.premature_reviews(fresh, after) != []
