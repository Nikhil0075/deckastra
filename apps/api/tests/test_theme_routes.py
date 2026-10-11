"""An agent sets a deck's palette and faces (2026-10-11)."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "api"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from deckastra_api import office_theme  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'themes.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "themes@localhost"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _deck(client, auth):
    made = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "technical-architecture"})
    assert made.status_code == 200, made.text
    return made.json()


def test_a_palette_becomes_a_reviewable_theme_that_keeps_what_the_deck_owns(client, auth):
    made = _deck(client, auth)
    deck = client.get(f"/v1/presentations/{made['presentation_id']}", headers=auth).json()["document"]
    body = {"expected_version_id": made["version_id"], "name": "AsterLoop", "background": "#1C1F22",
            "foreground": "#F4F1EA", "accent": "#C6FF3D", "secondary": "#2F6BFF",
            "display_font": "Archivo Black", "body_font": "Inter", "dry_run": True}
    planned = client.post(f"/v1/presentations/{made['presentation_id']}/theme", headers=auth, json=body)
    assert planned.status_code == 200, planned.text
    answer = planned.json()
    theme = answer["operations"][0]["value"]
    assert answer["operations"][0] == {"op": "replace", "path": "/theme", "value": theme}
    assert theme["colors"]["background"] == "#1C1F22" and theme["colors"]["accent"] == "#C6FF3D"
    assert theme["colors"]["secondary"] == "#2F6BFF"
    assert theme["typography"]["display"]["fontFamily"] == "Archivo Black"
    assert theme["typography"]["body"]["fontFamily"] == "Inter"
    assert answer["text_contrast"] >= 4.5 and answer["notes"] == []
    # What the deck added to its theme survives a new palette.
    for key in ("objectStyles", "icons", "modes", "table"):
        if key in deck["theme"]:
            assert theme[key] == deck["theme"][key]
    # A dry run writes nothing.
    head = client.get(f"/v1/presentations/{made['presentation_id']}/head", headers=auth).json()
    assert head["version_id"] == made["version_id"]

    body["dry_run"] = False
    applied = client.post(f"/v1/presentations/{made['presentation_id']}/theme", headers=auth, json=body)
    assert applied.status_code == 200, applied.text
    assert applied.json()["risk_tier"] in {"low", "medium", "high"}


def test_unreadable_text_and_a_stale_read_are_refused(client, auth):
    made = _deck(client, auth)
    path = f"/v1/presentations/{made['presentation_id']}/theme"
    low = client.post(path, headers=auth, json={"expected_version_id": made["version_id"], "background": "#777777",
                                                   "foreground": "#888888", "accent": "#C6FF3D"})
    assert low.status_code == 422 and "4.5:1" in low.json()["detail"]
    bad = client.post(path, headers=auth, json={"expected_version_id": made["version_id"], "background": "graphite",
                                                   "foreground": "#FFFFFF", "accent": "#C6FF3D"})
    assert bad.status_code == 422
    stale = client.post(path, headers=auth, json={"expected_version_id": "ver_old", "background": "#000000",
                                                     "foreground": "#FFFFFF", "accent": "#C6FF3D"})
    assert stale.status_code == 409


def test_a_face_that_does_not_ship_is_named():
    _, notes = office_theme.theme_from_palette("x", background="#FFFFFF", foreground="#111111", accent="#1E4BD2",
                                               display_font="Comic Sans MS")
    assert any("Comic Sans MS does not ship" in note for note in notes)


def test_the_bundled_font_list_matches_the_renderer():
    source = (ROOT / "packages" / "renderer" / "src" / "font-library.ts").read_text(encoding="utf-8")
    shipped = set(re.findall(r'\{ family: "([^"]+)", face: "[^"]+", group: "(?!World scripts)', source))
    assert shipped == set(office_theme.BUNDLED_FONTS)
