"""Design languages reach agents (UI audit 2026-10-10, unit 7b).

`deck_compose` takes a language, held to its density; a pattern inserted into
a deck composes in that deck's language; and what the contract tells an agent
a language draws is what the composer draws.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import languages, presets  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'languages.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "languages@localhost"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def story(**slide):
    base = {"layout": "bullets", "purpose": "Check", "key_message": "Three moves", "headline": "Three moves"}
    return {"title": "A plan", "audience": "", "objective": "", "narrative_arc": "", "slides": [{**base, **slide}]}


def test_the_contract_names_exactly_the_layouts_the_composer_draws():
    """Two descriptions of one fact, held to one answer, like the patch appliers."""
    catalog = presets.catalog()["designLanguages"]
    assert set(catalog) == set(languages.LANGUAGE_LAYOUTS)
    for language, drawn in languages.LANGUAGE_LAYOUTS.items():
        assert sorted(catalog[language]["layouts"]) == sorted(layout.value for layout in drawn), language


def test_compose_takes_a_language_and_its_theme(client, auth):
    response = client.post("/v1/decks/compose", headers=auth, json={"story_plan": story(bullets=["One", "Two"]), "design_language": "data-desk"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["document"]["metadata"]["designLanguage"]["id"] == "data-desk"
    assert body["document"]["theme"]["name"] == presets.themes()["civic"]["name"]
    assert any(element.get("name") == "Status dot" for element in body["document"]["slides"][0]["elements"])
    assert body["warnings"] == []


def test_compose_holds_a_plan_to_the_language_and_says_what_it_did(client, auth):
    plan = story(headline="Every one of these words makes this headline far too long", bullets=["A", "B", "C", "D", "E"])
    body = client.post("/v1/decks/compose", headers=auth, json={"story_plan": plan, "design_language": "cinema-noir"}).json()
    # Noir shows three bullets: the other two are dropped, and the caller is told.
    listed = [e for e in body["document"]["slides"][0]["elements"] if e.get("semanticRole") == "body"]
    assert len(listed[0]["content"]["blocks"]) == 3
    assert any("at most 3 bullets" in warning for warning in body["warnings"])
    # A long headline is kept as written and named.
    assert any("reads best at 8 or fewer" in warning for warning in body["warnings"])


def test_compose_refuses_an_unknown_language_by_name(client, auth):
    response = client.post("/v1/decks/compose", headers=auth, json={"story_plan": story(), "design_language": "vaporwave"})
    assert response.status_code == 422
    assert "vaporwave" in response.text


def test_compose_without_a_language_is_neutral_as_before(client, auth):
    body = client.post("/v1/decks/compose", headers=auth, json={"story_plan": story()}).json()
    assert "designLanguage" not in body["document"]["metadata"]
    assert body["document"]["theme"]["name"] == presets.themes()["neo-technical"]["name"]


def test_an_inserted_pattern_composes_in_the_decks_language(client, auth):
    made = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "technical-architecture"}).json()
    response = client.post(
        f"/v1/presentations/{made['presentation_id']}/patterns/insert",
        headers=auth,
        json={"expected_version_id": made["version_id"], "pattern": "statement", "slots": {"headline": "Ship the adapter"}, "dry_run": True},
    )
    assert response.status_code == 200, response.text
    slide = response.json()["operations"][0]["value"]
    # System Terminal's window bar, not the neutral statement.
    assert any(element.get("name") == "Window bar" for element in slide["elements"])
