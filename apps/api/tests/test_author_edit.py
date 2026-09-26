"""The Ask panel with a real model writes the change itself (`nodes/author.py`).

It used to answer in four verbs about selected elements, so "add images and
make the theme light" was refused outright — nothing in those verbs can add an
element or touch a theme. The built-in agent now writes operations the way an
external agent does over MCP, and these tests hold the part that makes that
safe: nothing it writes reaches a person until it applies and validates, a
refusal goes back to it with the reason, and a picture it places is one the
workspace already holds, manifest entry and all.

The model is stood in for by a scripted client. What is under test is ours:
what the route does with an answer, and what it tells the agent when an answer
is wrong.
"""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402  (bootstraps the agents path)
from deckastra_agents.router import ModelResponse  # noqa: E402

ULID_ID = re.compile(r"^el_[0-9A-HJKMNP-TV-Z]{26}$")


class Scripted:
    """Answers each structured request with the next scripted plan, recording every request."""

    def __init__(self, plans: list[dict]) -> None:
        self.plans = list(plans)
        self.requests: list = []

    def complete(self, request, budget):
        self.requests.append(request)
        plan = self.plans.pop(0)
        return ModelResponse(text=json.dumps(plan), input_tokens=10, output_tokens=10, model="scripted")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'author.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "author@localhost"})
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def deck(client, auth):
    response = client.post(
        "/v1/generate", headers=auth, json={"instruction": "A deck about cars", "slide_count": 3}
    )
    assert response.status_code == 200, response.text
    return response.json()


def scripted(monkeypatch, plans: list[dict]) -> Scripted:
    model = Scripted(plans)
    from deckastra_api import agent_routes

    monkeypatch.setattr(agent_routes.model_server, "build_client", lambda fallback=None: model)
    return model


def ask(client, auth, deck, instruction: str, **scope):
    slide_id = deck["document"]["slides"][0]["id"]
    return client.post(
        f"/v1/presentations/{deck['presentation_id']}/agent/edit",
        headers=auth,
        json={
            "instruction": instruction,
            "scope": {"kind": scope.get("kind", "slide"), "slide_ids": [slide_id], "element_ids": scope.get("element_ids", [])},
        },
    )


def op(op_: str, path: str, value=None) -> dict:
    return {"op": op_, "path": path, "value_json": "" if value is None else json.dumps(value), "from_path": ""}


def resulting_document(body: dict) -> dict:
    return body.get("document") or body["preview"]


def a_text_element(document: dict) -> dict:
    for slide in document["slides"]:
        for element in slide["elements"]:
            if element["type"] == "text":
                return element
    raise AssertionError("the deck has no text element")


def test_it_can_add_an_element_and_retheme_with_nothing_selected(client, auth, deck, monkeypatch):
    """The request the four verbs refused: no selection, a new element, a theme change."""
    slide_id = deck["document"]["slides"][0]["id"]
    new_text = copy.deepcopy(a_text_element(deck["document"]))
    new_text["id"] = "el_new1"
    new_text["transform"] = {"x": 120, "y": 900, "width": 800, "height": 80}
    new_text.pop("animations", None)

    model = scripted(
        monkeypatch,
        [
            {
                "summary": "A light theme and a caption.",
                "operations": [
                    op("replace", "/theme/colors/background", "#FFFFFF"),
                    op("add", f"/slides/id:{slide_id}/elements/-", new_text),
                ],
                "refusal": "",
            }
        ],
    )

    response = ask(client, auth, deck, "add a caption and make the theme light")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["outcome"] in ("applied", "pending"), body
    document = resulting_document(body)

    assert document["theme"]["colors"]["background"] == "#FFFFFF"
    added = [e for e in document["slides"][0]["elements"] if e["transform"] == new_text["transform"]]
    assert len(added) == 1
    # The placeholder became a real id: `el_new1` in a stored deck would fail
    # validation the next time anything read it.
    assert ULID_ID.match(added[0]["id"]), added[0]["id"]
    assert body["changes"][0]["reason"] == "A light theme and a caption."
    # The slide the person was on and the empty selection both reached the agent.
    prompt = model.requests[0].messages[0]["content"]
    assert slide_id in prompt and "Selected elements: (none)" in prompt


def test_a_patch_that_does_not_apply_goes_back_to_the_agent_with_the_reason(client, auth, deck, monkeypatch):
    slide_id = deck["document"]["slides"][0]["id"]
    model = scripted(
        monkeypatch,
        [
            {"summary": "Bad path.", "operations": [op("replace", f"/slides/id:{slide_id}/elements/id:el_missing/transform/x", 10)], "refusal": ""},
            {"summary": "Fixed.", "operations": [op("replace", "/theme/colors/background", "#F5F5F0")], "refusal": ""},
        ],
    )

    response = ask(client, auth, deck, "make it light")
    assert response.status_code == 200, response.text
    assert resulting_document(response.json())["theme"]["colors"]["background"] == "#F5F5F0"

    assert len(model.requests) == 2
    repair = model.requests[1].messages[0]["content"]
    assert "refused before they reached the person" in repair
    assert "el_missing" in repair


def test_a_change_that_never_validates_is_refused_rather_than_proposed(client, auth, deck, monkeypatch):
    slide_id = deck["document"]["slides"][0]["id"]
    broken = {"summary": "Broken.", "operations": [op("replace", f"/slides/id:{slide_id}/elements", "not a list")], "refusal": ""}
    scripted(monkeypatch, [broken, broken, broken])

    response = ask(client, auth, deck, "break it")
    body = response.json()
    assert body["outcome"] == "none"
    assert "could not write a valid change" in body["refusal"]
    assert body["transaction_id"] is None


def test_it_places_a_workspace_picture_and_the_deck_gains_its_manifest_entry(client, auth, deck, monkeypatch):
    from deckastra_api.db.models import Asset, Presentation, Project
    from deckastra_api.ids import new_id

    with db_session.session_scope() as session:
        presentation = session.get(Presentation, deck["presentation_id"])
        project = session.get(Project, presentation.project_id)
        asset_id = new_id("ast")
        session.add(
            Asset(
                id=asset_id,
                workspace_id=project.workspace_id,
                created_by="author@localhost",
                kind="image",
                storage_key="workspace/cars/roadster.png",
                filename="roadster.png",
                content_type="image/png",
                bytes=2048,
                width=1600,
                height=900,
            )
        )

    slide_id = deck["document"]["slides"][0]["id"]
    image = {
        "id": "el_new1",
        "type": "image",
        "transform": {"x": 960, "y": 200, "width": 800, "height": 450},
        "assetId": asset_id,
        "fit": "cover",
        "altText": "A red roadster",
    }
    model = scripted(
        monkeypatch,
        [{"summary": "Added the roadster.", "operations": [op("add", f"/slides/id:{slide_id}/elements/-", image)], "refusal": ""}],
    )

    response = ask(client, auth, deck, "add an image of a car")
    assert response.status_code == 200, response.text
    document = resulting_document(response.json())

    placed = [e for e in document["slides"][0]["elements"] if e.get("assetId") == asset_id]
    assert len(placed) == 1
    manifest = [a for a in document.get("assets") or [] if a["id"] == asset_id]
    assert manifest and manifest[0]["storageKey"] == "workspace/cars/roadster.png"
    # The agent was told the picture exists, by id and by name.
    assert asset_id in model.requests[0].messages[0]["content"]
    assert "roadster.png" in model.requests[0].messages[0]["content"]


def test_a_refusal_reaches_the_person_as_one(client, auth, deck, monkeypatch):
    scripted(monkeypatch, [{"summary": "", "operations": [], "refusal": "There is nothing on this deck to animate."}])
    body = ask(client, auth, deck, "animate the video").json()
    assert body["outcome"] == "none"
    assert body["refusal"] == "There is nothing on this deck to animate."
