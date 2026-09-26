"""The story checkpoint, reached from the product (editor Phase 6).

The graph could always pause before the story was used; nothing asked it to, and
nothing could resume it. These cases drive the routes a person's "Generate with
an outline first" goes through, on a SQLite file — the desktop's engine, whose
checkpoints live beside the database — so they run on every machine rather than
only where PostgreSQL is up.

- A reviewed generation stops at an outline and makes no deck.
- Revising sends the note to the story stage and stops at a new outline.
- Approving builds the deck exactly once; discarding makes nothing.
- A run is its starter's: nobody else can read or decide its outline.
- One outline, one decision: a second resume is refused, not run twice.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import agent_service  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import WorkspaceQuota  # noqa: E402

from tests.test_checkpoint import ANSWERS, compose  # noqa: E402

from deckastra_agents.budgets import RunBudget  # noqa: E402
from deckastra_agents.router import StubClient  # noqa: E402
from deckastra_agents.runner import AgentRun, paused_state, resume_generation, run_generation  # noqa: E402
from deckastra_agents.state import initial_state  # noqa: E402
from deckastra_agents.tools.registry import ToolRegistry  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'review.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


def session_for(client, email):
    response = client.post("/v1/dev/session", json={"email": email})
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def auth(client):
    return session_for(client, "author@localhost")


BRIEF = {"instruction": "Why our migration needs a control tower", "slide_count": 4}


def start(client, auth):
    response = client.post("/v1/generate/review", headers=auth, json=BRIEF)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "awaiting_story", body
    return body


def deck_count(client, auth):
    account = client.get("/v1/account", headers=auth).json()
    project = account["workspaces"][0]["projects"][0]["id"]
    return len(client.get(f"/v1/projects/{project}/presentations", headers=auth).json()["presentations"])


def quota(workspace_id=None):
    with db_session.session_scope() as session:
        rows = session.query(WorkspaceQuota).all()
        return [(row.used_generations, row.used_tokens) for row in rows]


def test_the_server_says_it_can_pause(client, auth):
    account = client.get("/v1/account", headers=auth).json()
    assert account["capabilities"]["checkpoints"] is True


def test_a_reviewed_generation_stops_at_an_outline_and_makes_no_deck(client, auth):
    before = deck_count(client, auth)
    body = start(client, auth)

    outline = body["outline"]
    assert outline["slides"] and all(slide["headline"] for slide in outline["slides"])
    assert body["generation"] is None
    assert deck_count(client, auth) == before

    # Read back from the checkpoint itself, as a reload would.
    again = client.get(f"/v1/runs/{body['run_id']}/checkpoint", headers=auth)
    assert again.status_code == 200
    assert again.json()["outline"] == outline

    # Tokens are charged for the outline; no generation is counted until a deck exists.
    [(generations, tokens)] = quota()
    assert generations == 0 and tokens > 0


def test_revising_stops_at_a_new_outline(client, auth):
    body = start(client, auth)
    revised = client.post(
        f"/v1/runs/{body['run_id']}/resume",
        headers=auth,
        json={"action": "revise", "note": "Open with the cost of doing nothing."},
    )
    assert revised.status_code == 200, revised.text
    assert revised.json()["status"] == "awaiting_story"
    assert revised.json()["run_id"] == body["run_id"]


def test_a_revision_needs_a_note(client, auth):
    body = start(client, auth)
    refused = client.post(f"/v1/runs/{body['run_id']}/resume", headers=auth, json={"action": "revise"})
    assert refused.status_code == 422
    # Still waiting: a refused request decided nothing.
    assert client.get(f"/v1/runs/{body['run_id']}/checkpoint", headers=auth).status_code == 200


def test_approving_builds_the_deck_once(client, auth):
    before = deck_count(client, auth)
    body = start(client, auth)
    approved = client.post(f"/v1/runs/{body['run_id']}/resume", headers=auth, json={"action": "approve"})
    assert approved.status_code == 200, approved.text
    answer = approved.json()
    assert answer["status"] == "completed"
    generation = answer["generation"]
    assert generation["presentation_id"] and generation["document"]["slides"]
    assert deck_count(client, auth) == before + 1

    stored = client.get(f"/v1/presentations/{generation['presentation_id']}", headers=auth)
    assert stored.status_code == 200
    [(generations, _)] = quota()
    assert generations == 1

    # The run became a deck; there is nothing left to decide.
    again = client.post(f"/v1/runs/{body['run_id']}/resume", headers=auth, json={"action": "approve"})
    assert again.status_code == 404
    assert deck_count(client, auth) == before + 1


def test_discarding_makes_nothing(client, auth):
    before = deck_count(client, auth)
    body = start(client, auth)
    discarded = client.post(f"/v1/runs/{body['run_id']}/resume", headers=auth, json={"action": "reject"})
    assert discarded.status_code == 200
    assert discarded.json()["status"] == "rejected"
    assert deck_count(client, auth) == before
    assert client.get(f"/v1/runs/{body['run_id']}/checkpoint", headers=auth).status_code == 404


def test_an_outline_is_its_starters(client, auth):
    body = start(client, auth)
    stranger = session_for(client, "stranger@localhost")
    assert client.get(f"/v1/runs/{body['run_id']}/checkpoint", headers=stranger).status_code == 404
    refused = client.post(f"/v1/runs/{body['run_id']}/resume", headers=stranger, json={"action": "approve"})
    assert refused.status_code == 404
    assert client.get(f"/v1/runs/{body['run_id']}/checkpoint", headers=auth).status_code == 200


def test_one_outline_takes_one_decision(client, auth):
    body = start(client, auth)
    # Another request has already claimed it, as a second window's Approve would.
    from sqlalchemy import update

    from deckastra_api.db.models import AgentRunRow

    with db_session.session_scope() as session:
        session.execute(update(AgentRunRow).where(AgentRunRow.id == body["run_id"]).values(status="running"))
    refused = client.post(f"/v1/runs/{body['run_id']}/resume", headers=auth, json={"action": "approve"})
    assert refused.status_code == 409
    [(generations, _)] = quota()
    assert generations == 0


def test_a_server_that_cannot_pause_says_so(client, auth, monkeypatch):
    monkeypatch.setattr(agent_service, "checkpoints_available", lambda: False)
    refused = client.post("/v1/generate/review", headers=auth, json=BRIEF)
    assert refused.status_code == 409
    assert "cannot pause" in refused.json()["detail"]
    assert client.get("/v1/account", headers=auth).json()["capabilities"]["checkpoints"] is False


# ------------------------------------------------------- the agent graph itself


def test_the_note_reaches_the_story_stage_with_the_outline_it_replaces(tmp_path):
    from langgraph.checkpoint.sqlite import SqliteSaver

    prompts: list[str] = []

    def planning(request):
        prompts.append(json.dumps(request.messages))
        return ANSWERS["planning"]

    def make_run(saver):
        stub = StubClient()
        for task, payload in ANSWERS.items():
            stub.register(task, payload)
        stub.register("planning", planning)
        return AgentRun(
            client=stub,
            registry=ToolRegistry(),
            compose=compose,
            budget=RunBudget(),
            checkpointer=saver,
            human_checkpoint=True,
        )

    with SqliteSaver.from_conn_string(str(tmp_path / "graph.checkpoints")) as saver:
        state = initial_state(
            run_id="run_note",
            user_id="u",
            project_id="p",
            presentation_id="",
            request={"instruction": "A deck", "slide_count": 1},
            document={"metadata": {"title": "t"}, "slides": []},
        )
        paused = run_generation(make_run(saver), state)
        assert paused.status == "awaiting_approval"
        assert paused_state(saver, "run_note")["story_plan"]["slides"][0]["headline"] == "It works"
        assert len(prompts) == 1

        revised = resume_generation(
            make_run(saver), "run_note", {"action": "revise", "note": "Lead with the price."}
        )
        # Back at the checkpoint, not run on to a deck nobody approved.
        assert revised.status == "awaiting_approval"
        assert len(prompts) == 2
        assert "Lead with the price." in prompts[1]
        assert "It works" in prompts[1], "the previous outline travels with the note"
        assert "Lead with the price." not in prompts[0]
        # Consumed, so nothing loops back to the story stage on its own.
        assert not paused_state(saver, "run_note").get("human_decision")

        approved = resume_generation(make_run(saver), "run_note", {"action": "approve"})
        assert approved.status == "completed"
        assert approved.operations
        assert len(prompts) == 2
        assert paused_state(saver, "run_note") is None

        with pytest.raises(ValueError, match="not paused"):
            resume_generation(make_run(saver), "run_note", {"action": "approve"})
