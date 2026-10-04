"""Which intelligence this install uses, from the product's side (D3).

The unit tests beside the router cover the choice itself. These cover the places
that used to ask a *different* question — `api_key_available()` — and would have
answered wrongly the moment a keyless install stopped meaning a stub install:
what `/health` reports, what the document records about who wrote it, and what a
generation does when the thing it was told to use is not installed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# `deckastra_api` first: importing it is what puts `agents/` on the path (doc 05
# §17 keeps the two trees separate, and the bootstrap lives in its __init__).
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_agents import router  # noqa: E402


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    for name in (router.INTELLIGENCE_ENV, router.DISTRIBUTION_ENV, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'intelligence.db'}")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


def session_headers(client) -> dict[str, str]:
    created = client.post("/v1/dev/session", json={"email": "local@localhost"})
    assert created.status_code == 200, created.text
    return {"Authorization": f"Bearer {created.json()['token']}"}


def test_keyless_development_uses_the_stub(client):
    assert client.get("/health").json()["generation"] == "stub"


@pytest.mark.parametrize("mode", ["local", "cloud", "hybrid", "locla"])
def test_retired_or_mistyped_modes_fail_closed(client, monkeypatch, mode):
    monkeypatch.setenv(router.INTELLIGENCE_ENV, mode)
    report = client.get("/health").json()
    assert report["generation"] == "unavailable"
    assert report["intelligence"] == "misconfigured"
    result = client.post("/v1/generate", headers=session_headers(client), json={"instruction": "Caching", "slide_count": 3})
    assert result.status_code == 503


def test_installed_product_never_uses_the_stub(client, monkeypatch):
    monkeypatch.setenv(router.DISTRIBUTION_ENV, "1")
    assert client.get("/health").json()["generation"] == "unavailable"
    assert router.selected_provider() == router.PROVIDER_NONE
    with pytest.raises(router.ModelUnavailable):
        router.default_client()


def test_explicit_vertex_without_evaluation_is_unavailable(client, monkeypatch):
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "vertex")
    report = client.get("/health").json()
    assert report["intelligence"] == "vertex" and report["generation"] == "unavailable"


def test_production_cannot_enable_the_stub(monkeypatch):
    monkeypatch.setenv("DECKASTRA_ENV", "production")
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "stub")
    with pytest.raises(router.ModelUnavailable, match="development"):
        router.default_client()
