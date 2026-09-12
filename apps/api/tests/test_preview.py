"""Seeing a slide: `POST /presentations/{id}/preview` (milestone D2).

An agent that cannot look at its own change has to ask the person whose deck it
is to look — which is the review the preview was meant to support. Two real
sessions ended that way before this existed.

The refusals are the interesting part, and they are the same refusals approval
makes: a proposal that no longer applies is a conflict, not a rendered guess;
unapplied work needs editor access; and nothing here commits anything.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402

needs_exporter = pytest.mark.skipif(
    shutil.which("npx") is None, reason="the renderer runs through npx"
)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'preview.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.setenv("DECKASTRA_EXPORT_DIR", str(tmp_path))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


def session_for(client, email: str) -> dict[str, str]:
    response = client.post("/v1/dev/session", json={"email": email})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def auth(client):
    return session_for(client, "preview@localhost")


@pytest.fixture()
def deck(client, auth):
    generated = client.post(
        "/v1/generate", headers=auth, json={"instruction": "A deck to look at", "slide_count": 3}
    )
    assert generated.status_code == 200, generated.text
    return generated.json()


def pending_proposal(client, auth, deck, operations, intent="Clear the slide") -> str:
    """A proposal the risk tier parks rather than applies."""
    head = client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth).json()
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals",
        headers=auth,
        json={
            "operations": operations,
            "intent": intent,
            "expected_version_id": head["version_id"],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["outcome"] == "pending", response.json()
    return response.json()["transaction_id"]


def removals(document, count=2):
    slide = document["slides"][0]
    return slide["id"], [
        {"op": "remove", "path": f"/slides/id:{slide['id']}/elements/id:{element['id']}"}
        for element in slide["elements"][:count]
    ]


# ------------------------------------------------------------------ refusals


def test_a_slide_that_is_not_there_is_named_rather_than_rendered_blank(client, auth, deck):
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/preview",
        headers=auth,
        json={"slide_id": "sld_not_here"},
    )
    assert response.status_code == 404
    assert "sld_not_here" in response.json()["detail"]


def test_a_proposal_that_no_longer_applies_is_a_conflict(client, auth, deck):
    """The same answer approval gives, for the same reason.

    A preview of a patch that cannot apply would be a picture of a deck that
    cannot exist — worse than no picture, because someone would approve it.
    """
    presentation_id = deck["presentation_id"]
    slide_id, operations = removals(deck["document"])
    proposal = pending_proposal(client, auth, deck, operations)

    # The user removes the same elements first.
    head = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()
    typed = client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth,
        json={
            "operations": operations,
            "intent": "Clear it myself",
            "expected_version_id": head["version_id"],
            "client_id": "web-editor",
        },
    )
    assert typed.status_code == 200, typed.text

    response = client.post(
        f"/v1/presentations/{presentation_id}/preview",
        headers=auth,
        json={"slide_id": slide_id, "proposal_id": proposal},
    )
    assert response.status_code == 409, response.text
    assert "no longer applies" in response.json()["detail"]["message"]


def test_someone_outside_the_workspace_cannot_preview_a_slide(client, auth, deck):
    # A rendered slide is the deck's content, in the most literal possible form.
    stranger = session_for(client, "stranger@localhost")
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/preview",
        headers=stranger,
        json={"slide_id": deck["document"]["slides"][0]["id"]},
    )
    assert response.status_code == 404


def test_previewing_a_proposal_does_not_apply_it(client, auth, deck):
    """A second way to apply an unapproved change would defeat the first."""
    presentation_id = deck["presentation_id"]
    slide_id, operations = removals(deck["document"])
    proposal = pending_proposal(client, auth, deck, operations)
    before = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()

    # The render itself may be unavailable here; what must not change is the deck.
    client.post(
        f"/v1/presentations/{presentation_id}/preview",
        headers=auth,
        json={"slide_id": slide_id, "proposal_id": proposal},
    )

    after = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()
    assert after["version_id"] == before["version_id"]
    assert after["document"] == before["document"]
    listed = client.get(f"/v1/presentations/{presentation_id}/proposals", headers=auth).json()
    assert [row["id"] for row in listed] == [proposal], "the proposal must still be pending"


# ------------------------------------------------------------------- the image


@needs_exporter
@pytest.mark.slow
def test_a_preview_is_a_png_of_that_slide_at_the_mcp_size(client, auth, deck):
    import base64
    import struct

    slide_id = deck["document"]["slides"][0]["id"]
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/preview",
        headers=auth,
        json={"slide_id": slide_id},
    )
    assert response.status_code == 200, response.text
    body = response.json()

    image = base64.b64decode(body["image_base64"])
    assert image[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    # Dimensions from the IHDR chunk, read rather than taken from the answer.
    width, height = struct.unpack(">II", image[16:24])
    assert (width, height) == (body["width"], body["height"])
    # Doc 04 §41.4's MCP size: 1024 wide, whatever the deck's own viewport is.
    assert width == 1024 and height == 576
    assert body["version_id"]


@needs_exporter
@pytest.mark.slow
def test_a_proposal_preview_shows_the_change_and_names_the_other_slides(client, auth, deck):
    import base64

    presentation_id = deck["presentation_id"]
    slide_id, operations = removals(deck["document"])
    proposal = pending_proposal(client, auth, deck, operations)

    stored = client.post(
        f"/v1/presentations/{presentation_id}/preview", headers=auth, json={"slide_id": slide_id}
    )
    proposed = client.post(
        f"/v1/presentations/{presentation_id}/preview",
        headers=auth,
        json={"slide_id": slide_id, "proposal_id": proposal},
    )
    assert stored.status_code == 200 and proposed.status_code == 200, proposed.text

    # Two elements fewer: the pictures must differ, or the preview is showing the
    # deck as it stands and quietly ignoring the proposal.
    assert base64.b64decode(stored.json()["image_base64"]) != base64.b64decode(
        proposed.json()["image_base64"]
    )
    assert proposed.json()["changed_slide_ids"] == [slide_id]
