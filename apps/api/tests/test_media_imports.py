"""Externally generated images enter Media first and slides only after review."""

from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'media-imports.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api.main import app
    with TestClient(app) as value:
        yield value
    db_session.reset_engine()


@pytest.fixture()
def auth(client):
    token = client.post("/v1/dev/session", json={"email": "media-imports@localhost"}).json()["token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def deck(client, auth):
    response = client.post(
        "/v1/decks/from-template", headers=auth,
        json={"template_id": "technical-architecture", "title": "External media"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def png() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (640, 360), "#2864dc").save(output, "PNG")
    return output.getvalue()


def prepare(client, auth, deck, *, prompt="A calm blue operations room"):
    data = png()
    slide_id = deck["document"]["slides"][0]["id"]
    response = client.post(
        "/v1/workspace/assets/uploads", headers=auth,
        json={
            "presentation_id": deck["presentation_id"],
            "expected_version_id": deck["version_id"],
            "slide_id": slide_id,
            "filename": "operations-room.png",
            "content_type": "image/png",
            "size_bytes": len(data),
            "kind": "image",
            "width": 640,
            "height": 360,
            "prompt": prompt,
            "style_source": "deck",
        },
    )
    assert response.status_code == 201, response.text
    begun = response.json()
    assert "/signed-blob/" in begun["upload_url"]
    uploaded = client.put(begun["upload_url"], headers={"Content-Type": "image/png"}, content=data)
    assert uploaded.status_code == 200, uploaded.text
    return begun, slide_id


def test_external_image_is_in_media_and_waits_as_a_visual_proposal(client, auth, deck):
    prompt = "A calm blue operations room"
    begun, slide_id = prepare(client, auth, deck, prompt=prompt)
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/media-imports/complete",
        headers=auth,
        json={"upload_token": begun["upload_token"], "prompt": prompt, "provider": "openai-imagegen", "client_label": "codex"},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "pending"
    assert result["slide_id"] == slide_id
    assert result["asset"]["tags"] == ["generated", "external-tool", "deck"]
    assert "Waiting for you" in result["awaiting"]

    media = client.get("/v1/assets?order=newest&limit=12", headers=auth).json()["assets"]
    assert media[0]["id"] == result["asset"]["id"]
    assert "openai-imagegen" in media[0]["description"]

    # It is available to the Media page, but the deck itself has not changed.
    current = client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth).json()
    assert current["version_id"] == deck["version_id"]
    assert all(item.get("id") != result["asset"]["id"] for item in current["document"].get("assets") or [])

    detail = client.get(
        f"/v1/presentations/{deck['presentation_id']}/proposals/{result['proposal_id']}", headers=auth
    ).json()
    assert detail["agent_id"] == "mcp:codex"
    assert any(op.get("value", {}).get("assetId") == result["asset"]["id"] for op in detail["operations"] if isinstance(op.get("value"), dict))

    approved = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals/{result['proposal_id']}/approve",
        headers=auth, json={"expected_version_id": deck["version_id"]},
    )
    assert approved.status_code == 200, approved.text
    document = approved.json()["document"]
    assert any(item.get("id") == result["asset"]["id"] for item in document["assets"])
    assert any(item.get("assetId") == result["asset"]["id"] for item in document["slides"][0]["elements"])


def test_import_refuses_a_different_prompt_after_the_upload(client, auth, deck):
    begun, _slide_id = prepare(client, auth, deck, prompt="One exact prompt")
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/media-imports/complete",
        headers=auth,
        json={"upload_token": begun["upload_token"], "prompt": "A changed prompt", "provider": "openai-imagegen", "client_label": "codex"},
    )
    assert response.status_code == 409
    assert "does not match" in response.text
    assert client.get("/v1/workspace/assets", headers=auth).json()["assets"] == []


def test_import_refuses_a_deck_that_moved_before_finalization(client, auth, deck):
    begun, _slide_id = prepare(client, auth, deck)
    moved = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transactions", headers=auth,
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "Moved"}],
            "intent": "Retitle", "expected_version_id": deck["version_id"], "client_id": "web-editor",
        },
    )
    assert moved.status_code == 200, moved.text
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/media-imports/complete",
        headers=auth,
        json={"upload_token": begun["upload_token"], "prompt": "A calm blue operations room", "provider": "openai-imagegen", "client_label": "codex"},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "E310"
