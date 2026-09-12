"""Externally authored proposals: the MCP write path (milestone D2.2).

An external agent — Claude Code, Codex — is already a model. It reads a deck,
works out what to change, and arrives with operations in hand. Everything here
tests the endpoint that accepts them, and the four properties that make accepting
them safe:

- **No model is called.** Not "avoided where possible": there is no client in the
  function to call, and the test proves it by making any model call an error.
- **The caller cannot declare its own risk tier**, so it cannot mark a destructive
  change low-risk and skip the human who would have caught it.
- **A stale base version is a 409**, never a silent overwrite of the work the user
  did while the agent was thinking.
- **The caller cannot claim to be one of the product's own agents**, because the
  label reaching the approval prompt decides whether a user trusts what they are
  approving.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import TransactionRow  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'authored.db'}")
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
    response = client.post("/v1/dev/session", json={"email": "agent@localhost"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def deck(client, auth):
    response = client.post(
        "/v1/generate",
        headers=auth,
        json={"instruction": "Explain the deploy pipeline", "slide_count": 3},
    )
    assert response.status_code == 200, response.text
    return response.json()


def head_version(client, auth, presentation_id: str) -> str:
    read = client.get(f"/v1/presentations/{presentation_id}", headers=auth)
    assert read.status_code == 200, read.text
    return read.json()["version_id"]


def propose(client, auth, presentation_id: str, **body):
    return client.post(
        f"/v1/presentations/{presentation_id}/proposals",
        headers=auth,
        json=body,
    )


# ------------------------------------------------------------------ the cost


def test_an_authored_change_never_calls_a_model(client, auth, deck, monkeypatch):
    """The whole reason this endpoint exists rather than reusing `agent/edit`.

    `agent/edit` takes an instruction and pays a model to turn it into operations.
    A caller that has already done that work would be billed twice for one edit,
    and the second bill buys a worse answer — the model re-deriving intent from a
    sentence rather than acting on the operations the first one chose.
    """
    from deckastra_agents import router

    def refuse(*args, **kwargs):  # pragma: no cover - the point is that it never runs
        raise AssertionError("an authored proposal must not call a model")

    monkeypatch.setattr(router, "default_client", refuse)

    presentation_id = deck["presentation_id"]
    response = propose(
        client,
        auth,
        presentation_id,
        operations=[{"op": "replace", "path": "/metadata/title", "value": "Deploys"}],
        intent="Retitle the deck",
        expected_version_id=head_version(client, auth, presentation_id),
    )

    assert response.status_code == 200, response.text
    assert response.json()["outcome"] == "applied"
    # No run row either. A trace of a generation that did not happen would make
    # the run list unreadable and the cost accounting wrong.
    assert response.json()["run_id"] == ""


# ---------------------------------------------------------- concurrency


def test_a_change_authored_against_a_stale_version_is_refused(client, auth, deck):
    """The exit gate: the user edits, then the agent commits what it read before.

    This is not a rare race. An agent reads a deck, thinks for thirty seconds and
    comes back — and the person whose deck it is has been typing the whole time.
    Applying against the head would silently discard their words.
    """
    presentation_id = deck["presentation_id"]
    stale = head_version(client, auth, presentation_id)

    # The user edits in the app.
    typed = client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth,
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "Typed by the user"}],
            "intent": "Retitle",
            "expected_version_id": stale,
            "client_id": "web-editor",
        },
    )
    assert typed.status_code == 200, typed.text

    # The agent arrives with what it read before that.
    refused = propose(
        client,
        auth,
        presentation_id,
        operations=[{"op": "replace", "path": "/metadata/title", "value": "Chosen by the agent"}],
        intent="Retitle the deck",
        expected_version_id=stale,
    )

    assert refused.status_code == 409, refused.text
    # And the refusal names the current version, so the agent can re-read rather
    # than poll.
    assert refused.json()["detail"]["current_version_id"] != stale

    # The user's words are still there. This is the assertion the endpoint exists
    # for; the status code is only how it is reported.
    document = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()["document"]
    assert document["metadata"]["title"] == "Typed by the user"


def test_the_base_version_is_required_rather_than_optional(client, auth, deck):
    # A caller that could omit it would eventually omit it, and the failure mode
    # is silent data loss rather than an error anyone sees.
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals",
        headers=auth,
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "X"}],
            "intent": "Retitle",
        },
    )
    assert response.status_code == 422


# ------------------------------------------------------------------ control


def test_a_destructive_change_waits_for_a_human_even_though_the_caller_wanted_it(
    client, auth, deck
):
    """Risk is computed from the operations, and the caller has no say.

    A caller-declared tier is a caller-controlled security boundary: any agent
    that wanted to skip approval would simply declare its change low-risk.
    """
    presentation_id = deck["presentation_id"]
    document = deck["document"]
    slide_id = document["slides"][0]["id"]
    element_ids = [element["id"] for element in document["slides"][0]["elements"][:2]]

    response = propose(
        client,
        auth,
        presentation_id,
        operations=[
            {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[0]}"},
            {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[1]}"},
        ],
        intent="Clear the opening slide",
        expected_version_id=head_version(client, auth, presentation_id),
        # Not a field the request model has. Sent anyway, because the check worth
        # making is that an unknown key cannot become one by being supplied.
        risk_tier="low",
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["outcome"] == "pending"
    assert body["risk_tier"] in {"medium", "high"}
    assert body["expires_at"]

    # And the deck is untouched until a human says so.
    document_now = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()["document"]
    assert len(document_now["slides"][0]["elements"]) == len(document["slides"][0]["elements"])


def test_an_external_client_cannot_claim_to_be_the_products_own_agent(client, auth, deck):
    """`agent_id` reaches the approval prompt, and a user reads it to decide.

    "editor" there would say the product's own edit agent proposed something an
    external client did — which is the one piece of context that decides whether
    approving is reasonable.
    """
    presentation_id = deck["presentation_id"]
    document = deck["document"]
    slide_id = document["slides"][0]["id"]
    element_ids = [element["id"] for element in document["slides"][0]["elements"][:2]]

    response = propose(
        client,
        auth,
        presentation_id,
        operations=[
            {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[0]}"},
            {"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{element_ids[1]}"},
        ],
        intent="Clear the opening slide",
        expected_version_id=head_version(client, auth, presentation_id),
        client_label="editor",
    )
    assert response.status_code == 200, response.text

    with db_session.session_scope() as session:
        row = session.get(TransactionRow, response.json()["transaction_id"])
        assert row is not None
        assert row.agent_id == "mcp:editor"


def test_an_applied_change_undoes_like_any_other_edit(client, auth, deck):
    """An MCP edit is an ordinary transaction, with an inverse, in one history."""
    presentation_id = deck["presentation_id"]
    original = deck["document"]["metadata"]["title"]

    applied = propose(
        client,
        auth,
        presentation_id,
        operations=[{"op": "replace", "path": "/metadata/title", "value": "Renamed by an agent"}],
        intent="Retitle the deck",
        expected_version_id=head_version(client, auth, presentation_id),
    )
    assert applied.json()["outcome"] == "applied"
    transaction_id = applied.json()["transaction_id"]

    reverted = client.post(
        f"/v1/presentations/{presentation_id}/transactions/{transaction_id}/revert",
        headers=auth,
    )
    assert reverted.status_code == 200, reverted.text
    assert reverted.json()["document"]["metadata"]["title"] == original


# --------------------------------------------------------------- refusals


def test_a_change_that_would_not_apply_is_a_conflict_not_a_500(client, auth, deck):
    presentation_id = deck["presentation_id"]
    response = propose(
        client,
        auth,
        presentation_id,
        operations=[{"op": "remove", "path": "/slides/id:sld_nothing_here"}],
        intent="Remove a slide that is not there",
        expected_version_id=head_version(client, auth, presentation_id),
    )
    # A conflict to re-read and retry, not a malformed request and not a crash.
    assert response.status_code == 409, response.text
    assert "code" in response.json()["detail"]


def test_someone_outside_the_workspace_cannot_author_a_change(client, auth, deck):
    """The authorization ladder is the same one every other write goes through.

    Nothing here is MCP-specific, and that is the point: the route resolves access
    through `resolve_presentation_access` like every other write, so a new write
    surface cannot forget the check by omission.
    """
    presentation_id = deck["presentation_id"]

    other = client.post("/v1/dev/session", json={"email": "onlooker@localhost"})
    stranger = {"Authorization": f"Bearer {other.json()['token']}"}
    base = head_version(client, auth, presentation_id)

    response = propose(
        client,
        stranger,
        presentation_id,
        operations=[{"op": "replace", "path": "/metadata/title", "value": "Mine now"}],
        intent="Retitle",
        expected_version_id=base,
    )
    # 404 rather than 403: a 403 on something you cannot see confirms it exists.
    assert response.status_code == 404

    # And the deck is unchanged, which is the claim the status code stands for.
    document = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()["document"]
    assert document["metadata"]["title"] != "Mine now"
