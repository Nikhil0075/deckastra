"""Agent-added pictures always resolve (release 8, 2026-10-17).

An agent could add an image element whose `assetId` was not in the deck's
asset manifest; the picture then drew as a gap on the canvas, in previews,
on both presentation screens and in exports. Every agent change is now
checked, and `media/place` registers and places a picture as one change.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.ids import new_id  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'media.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    token = client.post("/v1/dev/session", json={"email": "media@localhost"}).json()["token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def deck(client, auth):
    made = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "business-pitch", "title": "Media"})
    assert made.status_code == 200, made.text
    return made.json()


def _picture(client, auth) -> str:
    from deckastra_api.db.models import Asset

    account = client.get("/v1/account", headers=auth).json()
    with db_session.session_scope() as session:
        asset = Asset(id=new_id("ast"), workspace_id=account["workspaces"][0]["id"], created_by=account["user"]["id"],
                      kind="image", storage_key=f"{account['workspaces'][0]['id']}/p.png", filename="photo.png",
                      content_type="image/png", bytes=10, width=400, height=200)
        session.add(asset)
        return asset.id


def _head(client, auth, deck) -> str:
    return client.get(f"/v1/presentations/{deck['presentation_id']}/head", headers=auth).json()["version_id"]


def _propose(client, auth, deck, operations):
    return client.post(f"/v1/presentations/{deck['presentation_id']}/proposals", headers=auth, json={
        "operations": operations, "intent": "Add a picture", "expected_version_id": _head(client, auth, deck),
    })


def _element(asset_id):
    return {"id": new_id("el"), "type": "image", "assetId": asset_id, "altText": "A photo",
            "transform": {"x": 100, "y": 100, "width": 400, "height": 200, "rotation": 0}}


def test_a_picture_the_manifest_does_not_list_is_refused_by_name(client, auth, deck):
    asset_id = _picture(client, auth)
    slide = deck["document"]["slides"][1]["id"]
    refused = _propose(client, auth, deck, [{"op": "add", "path": f"/slides/id:{slide}/elements/-", "value": _element(asset_id)}])
    assert refused.status_code == 409, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == "E_MEDIA_UNRESOLVED"
    assert "Slide 2 cites " + asset_id in detail["message"] and "media_place" in detail["message"]


def test_a_manifest_entry_pointing_somewhere_else_is_refused(client, auth, deck):
    asset_id = _picture(client, auth)
    slide = deck["document"]["slides"][0]["id"]
    refused = _propose(client, auth, deck, [
        {"op": "add", "path": "/assets/-", "value": {"id": asset_id, "type": "image", "storageKey": "another-workspace/secret.png"}},
        {"op": "add", "path": f"/slides/id:{slide}/elements/-", "value": _element(asset_id)},
    ])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "E_MEDIA_UNRESOLVED"


def test_media_place_registers_and_places_in_one_reviewable_change(client, auth, deck):
    asset_id = _picture(client, auth)
    slide = deck["document"]["slides"][0]["id"]
    placed = client.post(f"/v1/presentations/{deck['presentation_id']}/media/place", headers=auth, json={
        "asset_id": asset_id, "slide_id": slide, "expected_version_id": _head(client, auth, deck),
        "client_label": "codex", "alt_text": "The team at the launch", "placement": "center",
    })
    assert placed.status_code == 200, placed.text
    assert placed.json()["status"] == "pending"
    approved = client.post(f"/v1/presentations/{deck['presentation_id']}/proposals/{placed.json()['proposal_id']}/approve",
                           headers=auth, json={"expected_version_id": _head(client, auth, deck)})
    assert approved.status_code == 200, approved.text
    document = approved.json()["document"]
    assert any(entry["id"] == asset_id and entry["storageKey"].endswith("/p.png") for entry in document["assets"])
    pictures = [element for element in document["slides"][0]["elements"] if element.get("assetId") == asset_id]
    assert len(pictures) == 1 and pictures[0]["altText"] == "The team at the launch"
    # The Media page shows it, used on that slide.
    uses = client.get(f"/v1/assets/{asset_id}/uses", headers=auth).json()["decks"]
    assert [deck_use["slide_ids"] for deck_use in uses] == [[slide]]


def test_a_second_placement_does_not_list_the_file_twice(client, auth, deck):
    asset_id = _picture(client, auth)
    slides = deck["document"]["slides"]
    for slide in slides[:2]:
        placed = client.post(f"/v1/presentations/{deck['presentation_id']}/media/place", headers=auth, json={
            "asset_id": asset_id, "slide_id": slide["id"], "expected_version_id": _head(client, auth, deck),
            "client_label": "codex", "alt_text": "Photo", "placement": "center",
        })
        assert placed.status_code == 200, placed.text
        client.post(f"/v1/presentations/{deck['presentation_id']}/proposals/{placed.json()['proposal_id']}/approve",
                    headers=auth, json={"expected_version_id": _head(client, auth, deck)})
    document = client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth).json()["document"]
    assert [entry["id"] for entry in document["assets"]].count(asset_id) == 1


def test_a_deck_already_citing_a_missing_file_still_takes_other_changes(client, auth, deck):
    """Only what a change introduces is checked."""
    from deckastra_api.media_integrity import problems

    before = {"slides": [{"id": "sld_a", "elements": [{"assetId": "ast_gone"}]}], "assets": []}
    after = {"slides": [{"id": "sld_a", "elements": [{"assetId": "ast_gone"}, {"type": "text"}]}], "assets": []}
    with db_session.session_scope() as session:
        assert problems(session, "wsp_x", before, after) == []
