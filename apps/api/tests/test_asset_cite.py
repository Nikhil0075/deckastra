"""Placing a picture the workspace already holds (2026-10-17).

The editor's Recent media lists uploads and generated pictures; placing one on
a slide needs its storage key, which lists withhold. The cite route hands it
over only to an editor of a deck in the same workspace.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'cite.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


def _session(client, email):
    token = client.post("/v1/dev/session", json={"email": email}).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _deck(client, auth):
    made = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "business-pitch", "title": "Cite"})
    assert made.status_code == 200, made.text
    return made.json()["presentation_id"]


def _asset(client, auth, *, kind="image", deleted=False):
    from deckastra_api.db.models import Asset
    from deckastra_api.ids import new_id

    workspace_id = client.get("/v1/account", headers=auth).json()["workspaces"][0]["id"]
    user_id = client.get("/v1/account", headers=auth).json()["user"]["id"]
    with db_session.session_scope() as session:
        asset = Asset(
            id=new_id("ast"),
            workspace_id=workspace_id,
            created_by=user_id,
            kind=kind,
            storage_key=f"{workspace_id}/pictures/{kind}.png",
            filename=f"{kind}.png",
            content_type="image/png" if kind == "image" else "audio/wav",
            bytes=10,
            width=40,
            height=20,
            deleted_at=datetime.now(timezone.utc) if deleted else None,
        )
        session.add(asset)
        return asset.id


def test_an_editor_gets_what_the_deck_needs_to_cite_the_picture(client):
    auth = _session(client, "owner@localhost")
    deck = _deck(client, auth)
    asset_id = _asset(client, auth)
    cited = client.post(f"/v1/presentations/{deck}/assets/{asset_id}/cite", headers=auth)
    assert cited.status_code == 200, cited.text
    body = cited.json()
    assert body["id"] == asset_id
    assert body["storage_key"].endswith("/pictures/image.png")
    assert (body["width"], body["height"]) == (40, 20)


def test_another_workspaces_picture_is_the_same_404_as_none(client):
    auth = _session(client, "owner@localhost")
    other = _session(client, "other@localhost")
    deck = _deck(client, auth)
    theirs = _asset(client, other)
    assert client.post(f"/v1/presentations/{deck}/assets/{theirs}/cite", headers=auth).status_code == 404
    assert client.post(f"/v1/presentations/{deck}/assets/ast_missing/cite", headers=auth).status_code == 404
    # And a stranger cannot cite into a deck they cannot see.
    mine = _asset(client, auth)
    assert client.post(f"/v1/presentations/{deck}/assets/{mine}/cite", headers=other).status_code == 404


def test_a_deleted_picture_or_a_sound_is_not_placed(client):
    auth = _session(client, "owner@localhost")
    deck = _deck(client, auth)
    gone = _asset(client, auth, deleted=True)
    sound = _asset(client, auth, kind="audio")
    assert client.post(f"/v1/presentations/{deck}/assets/{gone}/cite", headers=auth).status_code == 404
    assert client.post(f"/v1/presentations/{deck}/assets/{sound}/cite", headers=auth).status_code == 422


def _place(client, auth, deck, asset_id):
    from deckastra_api.ids import new_id
    """Cite the asset on the deck's first slide, as the editor does."""
    head = client.get(f"/v1/presentations/{deck}/head", headers=auth).json()
    document = client.get(f"/v1/presentations/{deck}", headers=auth).json()["document"]
    cited = client.post(f"/v1/presentations/{deck}/assets/{asset_id}/cite", headers=auth).json()
    slide = document["slides"][0]["id"]
    operations = [
        {"op": "add", "path": "/assets/-", "value": {"id": asset_id, "type": "image", "storageKey": cited["storage_key"]}},
        {"op": "add", "path": f"/slides/id:{slide}/elements/-", "value": {
            "id": new_id("el"), "type": "image", "assetId": asset_id, "altText": "A picture",
            "transform": {"x": 10, "y": 10, "width": 40, "height": 20, "rotation": 0}}},
    ]
    committed = client.post(f"/v1/presentations/{deck}/transactions", headers=auth, json={
        "operations": operations, "intent": "Place picture", "expected_version_id": head["version_id"], "client_id": "web-editor"})
    assert committed.status_code == 200, committed.text
    return slide


def test_where_a_file_is_used_and_that_a_used_file_is_not_deleted(client):
    auth = _session(client, "owner@localhost")
    deck = _deck(client, auth)
    asset_id = _asset(client, auth)
    assert client.get(f"/v1/assets/{asset_id}/uses", headers=auth).json()["decks"] == []
    slide = _place(client, auth, deck, asset_id)

    uses = client.get(f"/v1/assets/{asset_id}/uses", headers=auth).json()
    assert [(d["presentation_id"], d["slide_ids"], d["deleted"]) for d in uses["decks"]] == [(deck, [slide], False)]

    refused = client.delete(f"/v1/workspace/assets/{asset_id}", headers=auth)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "E_ASSET_IN_USE"
    assert client.get("/v1/assets?filter=deleted", headers=auth).json()["assets"] == []


def test_an_unused_file_goes_to_the_trash_and_comes_back(client):
    auth = _session(client, "owner@localhost")
    asset_id = _asset(client, auth)
    assert client.delete(f"/v1/workspace/assets/{asset_id}", headers=auth).status_code == 200
    assert [a["id"] for a in client.get("/v1/assets?filter=deleted", headers=auth).json()["assets"]] == [asset_id]
    assert asset_id not in [a["id"] for a in client.get("/v1/assets", headers=auth).json()["assets"]]


def test_the_list_filters_by_kind(client):
    auth = _session(client, "owner@localhost")
    picture = _asset(client, auth)
    sound = _asset(client, auth, kind="audio")
    assert [a["id"] for a in client.get("/v1/assets?kind=image", headers=auth).json()["assets"]] == [picture]
    assert [a["id"] for a in client.get("/v1/assets?kind=audio", headers=auth).json()["assets"]] == [sound]
