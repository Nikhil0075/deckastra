"""The version history drawer's backend (editor Phase 5).

- A version row says what changed it and who: the producing transaction's
  intent, source and agent ride along, in one query.
- Restore is an ordinary change: it appends a version, reproduces the chosen
  one exactly, keeps every version before it, and its own revert undoes it.
- It is refused when the deck moved after the drawer was opened, for the current
  version, and for a version that belongs to another deck.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import version_restore  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'versions.db'}")
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
    response = client.post("/v1/dev/session", json={"email": "editor@localhost"})
    return {"Authorization": f"Bearer {response.json()['token']}"}


def create(client, auth, title="History"):
    created = client.post("/v1/presentations", headers=auth, json={"title": title})
    assert created.status_code == 201, created.text
    return created.json()["presentation_id"], created.json()["version_id"]


def rename(client, auth, presentation_id, version_id, title, **extra):
    applied = client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth,
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": title}],
            "intent": f"Rename to {title}",
            "expected_version_id": version_id,
            "client_id": "test",
            **extra,
        },
    )
    assert applied.status_code == 200, applied.text
    return applied.json()["version_id"]


def read(client, auth, presentation_id, **params):
    return client.get(f"/v1/presentations/{presentation_id}", headers=auth, params=params).json()


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def test_each_version_says_what_changed_it_and_who(client, auth):
    presentation_id, first = create(client, auth)
    second = rename(client, auth, presentation_id, first, "Second", source="agent", agent_id="layout")

    versions = client.get(f"/v1/presentations/{presentation_id}/versions", headers=auth).json()
    by_id = {version["id"]: version for version in versions}
    assert by_id[second]["intent"] == "Rename to Second"
    assert by_id[second]["change_source"] == "agent"
    assert by_id[second]["agent_id"] == "layout"
    assert by_id[second]["transaction_id"]
    # The first version was produced by no transaction.
    assert by_id[first]["transaction_id"] is None and by_id[first]["intent"] is None


def test_restore_appends_a_version_that_reproduces_the_chosen_one(client, auth):
    presentation_id, first = create(client, auth, "Original")
    second = rename(client, auth, presentation_id, first, "Changed")
    before = read(client, auth, presentation_id, at_version=first)["document"]

    restored = client.post(
        f"/v1/presentations/{presentation_id}/versions/{first}/restore",
        headers=auth,
        json={"expected_version_id": second},
    )
    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert body["version_id"] not in (first, second)

    head = read(client, auth, presentation_id)
    assert head["version_id"] == body["version_id"]
    assert canonical(head["document"]) == canonical(before)

    # Nothing was deleted: both older versions are still in the history.
    ids = [version["id"] for version in client.get(f"/v1/presentations/{presentation_id}/versions", headers=auth).json()]
    assert {first, second, body["version_id"]} <= set(ids)

    # And the restore undoes like any change: its revert brings back "Changed".
    reverted = client.post(
        f"/v1/presentations/{presentation_id}/transactions/{body['transaction_id']}/revert", headers=auth
    )
    assert reverted.status_code == 200, reverted.text
    assert read(client, auth, presentation_id)["document"]["metadata"]["title"] == "Changed"


def test_restore_is_refused_when_the_deck_moved_after_the_drawer_opened(client, auth):
    presentation_id, first = create(client, auth)
    second = rename(client, auth, presentation_id, first, "Second")
    rename(client, auth, presentation_id, second, "Third")

    stale = client.post(
        f"/v1/presentations/{presentation_id}/versions/{first}/restore",
        headers=auth,
        json={"expected_version_id": second},
    )
    assert stale.status_code == 409
    assert "changed since" in stale.json()["detail"]["message"]
    assert read(client, auth, presentation_id)["document"]["metadata"]["title"] == "Third"


def test_restoring_the_current_version_or_another_decks_is_refused(client, auth):
    presentation_id, first = create(client, auth, "One")
    second = rename(client, auth, presentation_id, first, "Two")
    other_id, other_first = create(client, auth, "Other")

    current = client.post(
        f"/v1/presentations/{presentation_id}/versions/{second}/restore",
        headers=auth,
        json={"expected_version_id": second},
    )
    assert current.status_code == 409

    foreign = client.post(
        f"/v1/presentations/{presentation_id}/versions/{other_first}/restore",
        headers=auth,
        json={"expected_version_id": second},
    )
    assert foreign.status_code == 404
    # The historical read the conflict review uses answers the same way; it
    # used to escape as a 500.
    assert client.get(
        f"/v1/presentations/{presentation_id}", headers=auth, params={"at_version": other_first}
    ).status_code == 404


def test_restore_operations_are_top_level_and_deterministic():
    head = {"id": "doc_1", "metadata": {"title": "B"}, "slides": [1, 2], "extra": True}
    target = {"id": "doc_1", "metadata": {"title": "A"}, "slides": [1, 2], "theme": {"x": 1}}
    operations = version_restore.restore_operations(head, target)
    assert operations == [
        {"op": "remove", "path": "/extra"},
        {"op": "replace", "path": "/metadata", "value": {"title": "A"}},
        {"op": "add", "path": "/theme", "value": {"x": 1}},
    ]
    assert version_restore.restore_operations(target, target) == []
