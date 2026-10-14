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
    # The desk rules every page with hairlines (design-system v3).
    assert any(element.get("name") == "Desk rule" for element in body["document"]["slides"][0]["elements"])
    assert body["warnings"] == []


def test_compose_holds_a_plan_to_the_language_and_says_what_it_did(client, auth):
    plan = story(headline="Every one of these words makes this headline far too long", bullets=["A", "B", "C", "D", "E"])
    body = client.post("/v1/decks/compose", headers=auth, json={"story_plan": plan, "design_language": "cinema-noir"}).json()
    # Noir shows three bullets: the other two are dropped, and the caller is told.
    listed = [e for e in body["document"]["slides"][0]["elements"] if e.get("semanticRole") == "body"]
    # One row per item since design-system v3, so the count is the rows.
    assert len(listed) == 3
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
    assert any(element.get("name") == "Status light" for element in slide["elements"])


def test_pattern_previews_are_every_pattern_composed_in_the_language_and_store_nothing(client, auth):
    """The Add library draws each pattern as the slide Insert would add."""
    from deckastra_api.db.models import Presentation
    from deckastra_api.db import session as db_session

    with db_session.session_scope() as session:
        before = session.query(Presentation).count()
    swiss = client.get("/v1/patterns/preview?language=system-terminal", headers=auth)
    assert swiss.status_code == 200, swiss.text
    body = swiss.json()
    assert body["language"] == "system-terminal"
    assert set(body["slides"]) == set(presets.catalog()["slidePatterns"])
    # The language's own grammar, not the neutral statement.
    assert any(e.get("name") == "Status light" for e in body["slides"]["statement"]["elements"])
    # An unknown language is drawn neutral rather than refused.
    assert client.get("/v1/patterns/preview?language=nope", headers=auth).json()["language"] == "neutral"
    with db_session.session_scope() as session:
        assert session.query(Presentation).count() == before


def test_a_composed_deck_moves_in_its_languages_transitions_with_accents_by_slide_kind(client, auth):
    """Agent decks used to arrive with no transitions; now the language decides, by slide kind."""
    slides = [
        {"layout": "title", "purpose": "p", "key_message": "k", "headline": "Grid demand"},
        {"layout": "bullets", "purpose": "p", "key_message": "k", "headline": "Three causes", "bullets": ["One", "Two"]},
        {"layout": "chart", "purpose": "p", "key_message": "k", "headline": "Demand rose",
         "chart": {"categories": ["2025", "2026"], "series": [{"name": "GW", "values": [3, 5]}]}},
    ]
    plan = {"title": "T", "audience": "", "objective": "", "narrative_arc": "", "slides": slides}
    body = client.post("/v1/decks/compose", headers=auth, json={"story_plan": plan, "design_language": "data-desk"}).json()
    kinds = [slide.get("transition", {}).get("type") for slide in body["document"]["slides"]]
    # Data Desk fades by default and pushes into a chart.
    assert kinds[1] == "fade" and kinds[2] == "push"
    neutral = client.post("/v1/decks/compose", headers=auth, json={"story_plan": plan}).json()
    assert {slide.get("transition", {}).get("type") for slide in neutral["document"]["slides"][1:]} == {"fade"}


def test_deck_compose_says_when_a_deck_repeats_one_structure(client, auth):
    bullets = {"layout": "bullets", "purpose": "p", "key_message": "k", "bullets": ["One", "Two"]}
    plan = {"title": "T", "audience": "", "objective": "", "narrative_arc": "",
            "slides": [{**bullets, "headline": f"Point {n}"} for n in range(1, 5)]}
    warnings = client.post("/v1/decks/compose", headers=auth, json={"story_plan": plan}).json()["warnings"]
    assert any("Slides 1–4 all use the bullets structure" in w for w in warnings), warnings
    varied = {**plan, "slides": [
        {"layout": "statement", "purpose": "p", "key_message": "k", "headline": "One claim"},
        {**bullets, "headline": "Two points"},
        {"layout": "chart", "purpose": "p", "key_message": "k", "headline": "It grew",
         "chart": {"categories": ["A", "B"], "series": [{"name": "S", "values": [1, 2]}]}},
    ]}
    assert client.post("/v1/decks/compose", headers=auth, json={"story_plan": varied}).json()["warnings"] == []
