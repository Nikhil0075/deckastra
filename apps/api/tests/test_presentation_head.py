"""`GET /presentations/{id}/head`: what an open editor polls (milestone D2).

An editor learns about a change made somewhere else — an agent over MCP, a
second window — by asking which version is current every few seconds. The full
read replays the version chain, which is the wrong thing to run on a timer when
the answer is almost always "nothing changed". These cases pin that the cheap
answer is the *same* answer, and that it is guarded like every other read.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'head.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
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
    return session_for(client, "editor@localhost")


@pytest.fixture()
def presentation_id(client, auth) -> str:
    created = client.post("/v1/presentations", headers=auth, json={"title": "Head"})
    assert created.status_code == 201, created.text
    return created.json()["presentation_id"]


def test_the_head_is_the_version_a_full_read_returns(client, auth, presentation_id):
    head = client.get(f"/v1/presentations/{presentation_id}/head", headers=auth)
    read = client.get(f"/v1/presentations/{presentation_id}", headers=auth)

    assert head.status_code == 200, head.text
    # The whole contract. If these ever disagree, an editor either misses a
    # change or adopts one that is not there.
    assert head.json()["version_id"] == read.json()["version_id"]
    # And nothing else: this is polled, and a document here would be the full
    # read on a timer after all.
    assert "document" not in head.json()


def test_the_head_moves_when_someone_else_commits(client, auth, presentation_id):
    before = client.get(f"/v1/presentations/{presentation_id}/head", headers=auth).json()["version_id"]

    committed = client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth,
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "Moved"}],
            "intent": "Retitle",
            "expected_version_id": before,
            "client_id": "mcp:test",
        },
    )
    assert committed.status_code == 200, committed.text

    after = client.get(f"/v1/presentations/{presentation_id}/head", headers=auth).json()["version_id"]
    assert after == committed.json()["version_id"]
    assert after != before


def test_someone_who_cannot_see_the_deck_cannot_learn_its_head(client, presentation_id):
    # A version id is not the document, but "this deck exists and changed at
    # 14:02" is still something the product only tells people who can see it.
    # 404 rather than 403, like every other read: a 403 confirms it exists.
    stranger = session_for(client, "stranger@localhost")
    response = client.get(f"/v1/presentations/{presentation_id}/head", headers=stranger)
    assert response.status_code == 404


# ------------------------------------------------------ the project deck list


def project_of(client, auth) -> str:
    account = client.get("/v1/account", headers=auth)
    assert account.status_code == 200, account.text
    return account.json()["workspaces"][0]["projects"][0]["id"]


def test_a_project_lists_its_decks_newest_first_without_content(client, auth, presentation_id):
    """What an agent asked "which decks do I have" needs, and nothing more."""
    second = client.post("/v1/presentations", headers=auth, json={"title": "Second"})
    assert second.status_code == 201, second.text

    listed = client.get(f"/v1/projects/{project_of(client, auth)}/presentations", headers=auth)
    assert listed.status_code == 200, listed.text
    decks = listed.json()["presentations"]

    assert {deck["id"] for deck in decks} == {presentation_id, second.json()["presentation_id"]}
    # Most recently changed first — the order an agent should read them in.
    assert decks[0]["id"] == second.json()["presentation_id"]
    # Rows, not documents. Listing a project must not replay every deck in it.
    assert all("document" not in deck for deck in decks)
    assert all(deck["version_id"] for deck in decks)


def test_someone_outside_the_workspace_cannot_list_its_decks(client, auth, presentation_id):
    # Titles are content. "Acquisition of X" in a list is the leak, whether or
    # not the deck behind it can be opened.
    stranger = session_for(client, "outsider@localhost")
    response = client.get(f"/v1/projects/{project_of(client, auth)}/presentations", headers=stranger)
    assert response.status_code == 404
