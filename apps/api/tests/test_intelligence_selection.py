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
from deckastra_agents.model_packs import MODEL_DIR_ENV  # noqa: E402


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    for name in (router.INTELLIGENCE_ENV, router.DISTRIBUTION_ENV, MODEL_DIR_ENV, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
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


def test_health_calls_a_local_install_a_model_install(client, monkeypatch, tmp_path):
    """It used to answer "stub" to anyone without a key.

    The UI reads this to warn someone their deck will be stub-composed before
    they wait for it. Telling a local-model user that is both wrong and the
    opposite of reassuring.
    """
    assert client.get("/health").json()["generation"] == "stub"
    assert client.get("/health").json()["intelligence"] == "stub"

    monkeypatch.setenv(router.INTELLIGENCE_ENV, "local")
    monkeypatch.setenv(MODEL_DIR_ENV, str(tmp_path))

    health = client.get("/health").json()
    assert health["generation"] == "model"
    # Checkable from outside the process, which is what "no cloud traffic in
    # local mode" needs in order to be something anyone can verify.
    assert health["intelligence"] == "local"


def test_a_keyless_cloud_install_is_still_reported_as_a_stub_install(client):
    assert client.get("/health").json()["intelligence"] == "stub"


def test_generating_with_nothing_installed_is_a_503_that_says_what_to_do(
    client, monkeypatch, tmp_path
):
    """Not a 500, and not "the agent run failed".

    Nothing failed and nothing is upstream: the install was told to use something
    that is not there. A user can act on that sentence; they can do nothing with
    a stack trace, and a 502 sends them to look for an outage.
    """
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "local")
    monkeypatch.setenv(MODEL_DIR_ENV, str(tmp_path))

    answer = client.post(
        "/v1/generate",
        headers=session_headers(client),
        json={"instruction": "A deck about local models", "use_graph": True},
    )

    assert answer.status_code == 503, answer.text
    detail = answer.json()["detail"]
    assert "no model pack is installed" in detail
    assert "cloud generation" in detail


def test_the_single_shot_planner_refuses_local_rather_than_stubbing(
    client, monkeypatch, tmp_path
):
    """`use_graph=False` talks to the SDK directly and cannot serve a local model.

    Left alone it would have fallen through to "no key, so use the stub" — a stub
    deck on the one path where the user asked for nothing to leave the machine,
    labelled as though a model had written it badly.
    """
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "local")
    monkeypatch.setenv(MODEL_DIR_ENV, str(tmp_path))

    answer = client.post(
        "/v1/generate",
        headers=session_headers(client),
        json={"instruction": "A deck about local models", "use_graph": False},
    )

    assert answer.status_code == 503, answer.text
    assert "single-shot" in answer.json()["detail"]


def test_a_local_run_is_not_recorded_as_a_stub_run(monkeypatch, tmp_path):
    """What the document says about who wrote it.

    `source` reaches generation provenance, and it was derived from whether a key
    was present. A local model is a model; recording "stub" would put a false
    statement in the deck itself, where it outlives the run.
    """
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "local")
    monkeypatch.setenv(MODEL_DIR_ENV, str(tmp_path))
    assert router.selected_provider() != router.PROVIDER_STUB

    monkeypatch.setenv(router.INTELLIGENCE_ENV, "")
    assert router.selected_provider() == router.PROVIDER_STUB


# --------------------------------------------------- a mode this build does not know


def test_a_mistyped_mode_is_reported_by_health_and_not_read_as_cloud(client, monkeypatch):
    """Final package review, item 04: `locla` with a key present used to mean cloud."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-a-real-looking-key")
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "locla")

    health = client.get("/health")
    assert health.status_code == 200
    body = health.json()
    assert body["intelligence"] == "misconfigured"
    assert body["generation"] == "unavailable"
    assert "'locla'" in body["intelligence_error"]


def test_a_mistyped_mode_refuses_generation_and_ask_with_a_503(client, monkeypatch):
    headers = session_headers(client)
    # Made while the mode is valid, so there is a deck to Ask about.
    made = client.post("/v1/generate", headers=headers, json={"instruction": "A deck about typos"})
    assert made.status_code == 200, made.text
    document = made.json()["document"]
    slide = document["slides"][0]
    element = next(el for el in slide["elements"] if el["type"] == "text")

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-a-real-looking-key")
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "Cloudy")

    for path, body in (
        ("/v1/generate", {"instruction": "Another deck", "use_graph": True}),
        ("/v1/generate", {"instruction": "Single shot", "use_graph": False}),
        (
            f"/v1/presentations/{made.json()['presentation_id']}/agent/edit",
            {"instruction": "Shorter", "scope": {"kind": "elements", "slide_ids": [slide["id"]], "element_ids": [element["id"]]}},
        ),
    ):
        answer = client.post(path, headers=headers, json=body)
        assert answer.status_code == 503, (path, answer.text)
        assert "'Cloudy'" in answer.json()["detail"]


# ------------------------------------------------------ an installed product (item 20)


def test_an_installed_product_reports_generation_as_not_set_up(client, monkeypatch):
    monkeypatch.setenv(router.DISTRIBUTION_ENV, "1")
    body = client.get("/health").json()
    assert body["generation"] == "unavailable"
    assert body["intelligence"] == "none"
    assert "not set up" in body["intelligence_error"]


def test_an_installed_product_refuses_every_generation_path_instead_of_stubbing(client, monkeypatch):
    headers = session_headers(client)
    made = client.post("/v1/generate", headers=headers, json={"instruction": "Made in a checkout"})
    assert made.status_code == 200, made.text
    slide = made.json()["document"]["slides"][0]
    element = next(el for el in slide["elements"] if el["type"] == "text")

    monkeypatch.setenv(router.DISTRIBUTION_ENV, "1")
    for path, body in (
        ("/v1/generate", {"instruction": "Graph", "use_graph": True}),
        ("/v1/generate", {"instruction": "Single shot", "use_graph": False}),
        (
            f"/v1/presentations/{made.json()['presentation_id']}/agent/edit",
            {"instruction": "Shorter", "scope": {"kind": "elements", "slide_ids": [slide["id"]], "element_ids": [element["id"]]}},
        ),
    ):
        answer = client.post(path, headers=headers, json=body)
        assert answer.status_code == 503, (path, answer.text)
        assert "not set up" in answer.json()["detail"]


# ------------------------------------------ what the account says about generation (item 19)


def generation_capability(client):
    answer = client.get("/v1/account", headers=session_headers(client))
    assert answer.status_code == 200, answer.text
    return answer.json()["capabilities"]["generation"]


def test_the_account_says_which_provider_will_write_a_deck(client, monkeypatch):
    """Read before anyone writes a brief, so "not set up" is a sentence in the
    drawer rather than a failure after the work of describing a deck."""
    assert generation_capability(client) == {"provider": "stub", "available": True, "reason": None}

    monkeypatch.setenv(router.DISTRIBUTION_ENV, "1")
    unset = generation_capability(client)
    assert unset["provider"] == "none" and unset["available"] is False
    assert "not set up" in unset["reason"]

    monkeypatch.setenv(router.INTELLIGENCE_ENV, "cloud")
    keyless = generation_capability(client)
    assert keyless["provider"] == "cloud" and keyless["available"] is False
    assert "no API key" in keyless["reason"]

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-a-real-looking-key")
    assert generation_capability(client) == {"provider": "cloud", "available": True, "reason": None}

    monkeypatch.setenv(router.INTELLIGENCE_ENV, "locla")
    mistyped = generation_capability(client)
    assert mistyped["provider"] == "misconfigured" and mistyped["available"] is False


def test_a_release_without_local_models_says_so_rather_than_offering_them(client, monkeypatch):
    monkeypatch.setenv(router.DISTRIBUTION_ENV, "1")
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "local")
    status = generation_capability(client)
    assert status["provider"] == "unavailable" and status["available"] is False
    assert "not included in this release" in status["reason"]
