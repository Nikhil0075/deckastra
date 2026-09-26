"""A person's editor preferences follow them (design review, 2026-09-27).

The Add library's recent and favourite items were kept in one browser. They
are kept per user now, under an allowlisted key and a size limit, and one
person never reads another's.
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
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'prefs.db'}")
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


def test_a_preference_starts_empty_is_kept_and_replaced(client):
    auth = session_for(client, "one@localhost")
    assert client.get("/v1/me/preferences/library", headers=auth).json() == {"key": "library", "value": None}

    first = {"recent": ["icon:database"], "favourites": ["shape:star"]}
    assert client.put("/v1/me/preferences/library", json={"value": first}, headers=auth).status_code == 200
    assert client.get("/v1/me/preferences/library", headers=auth).json()["value"] == first

    second = {"recent": ["icon:cloud", "icon:database"], "favourites": []}
    client.put("/v1/me/preferences/library", json={"value": second}, headers=auth)
    assert client.get("/v1/me/preferences/library", headers=auth).json()["value"] == second


def test_one_person_never_reads_anothers(client):
    one = session_for(client, "one@localhost")
    two = session_for(client, "two@localhost")
    client.put("/v1/me/preferences/library", json={"value": {"favourites": ["icon:lock"]}}, headers=one)
    assert client.get("/v1/me/preferences/library", headers=two).json()["value"] is None


def test_refuses_an_unknown_key_a_large_value_and_no_session(client):
    auth = session_for(client, "one@localhost")
    assert client.get("/v1/me/preferences/anything", headers=auth).status_code == 404
    assert client.put("/v1/me/preferences/anything", json={"value": 1}, headers=auth).status_code == 404
    huge = {"recent": ["x" * 20_000]}
    assert client.put("/v1/me/preferences/library", json={"value": huge}, headers=auth).status_code == 413
    assert client.get("/v1/me/preferences/library").status_code == 401
