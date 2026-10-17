"""A cloud failure reaches the person as its real cause (release 8, 2026-10-17).

Signed-in desktops saw `JSONDecodeError` for translation, narration, pictures
and video: the hosted routes answered an unhandled provider exception with a
plain-text 500, the desktop bridge labelled it JSON, and the local client
parsed it blindly. These hold each link to "say what went wrong".
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deckastra_api  # noqa: F401  initializes the sibling package paths

from deckastra_agents import gateway_client
from deckastra_agents.router import ModelError, ModelUnavailable
from deckastra_api import gateway_errors, translation
from deckastra_api.db import session as db_session


# ------------------------------------------------------------ the classifier


@pytest.mark.parametrize(("text", "hint"), [
    ("Cloud Translation API has not been used in project 123 before or it is disabled.", "switched off"),
    ("403 PERMISSION_DENIED: Permission 'aiplatform.endpoints.predict' denied", "lacks the role"),
    ("429 RESOURCE_EXHAUSTED: Quota exceeded for aiplatform", "quota"),
    ("404 NOT_FOUND: Publisher Model `veo-x` was not found", "not found"),
    ("401 UNAUTHENTICATED: invalid_grant", "refused"),
])
def test_a_recognised_google_answer_carries_the_fix(text, hint):
    classified = gateway_errors.classify(translation.TranslationError(text))
    assert classified.status == 502 and classified.code == "E_PROVIDER_FAILED"
    assert hint in (classified.hint or "")


def test_each_kind_of_failure_has_its_own_code():
    assert gateway_errors.classify(ModelUnavailable("Configure a pinned Vertex model identifier.")).code == "E_PROVIDER_UNCONFIGURED"
    assert gateway_errors.classify(ModelError("Vertex returned HTTP 500.")).status == 502
    assert gateway_errors.classify(httpx.ReadTimeout("slow")).code == "E_PROVIDER_TIMEOUT"
    assert gateway_errors.classify(KeyError("boom")).code == "E_PROVIDER_INTERNAL"


# ------------------------------------------------------- the hosted routes


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'cloud.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.setenv("DECKASTRA_CREDITS_ENABLED", "1")
    monkeypatch.setenv("DECKASTRA_DEVICE_SECRET", "d" * 40)
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api import gateway_routes
    from deckastra_api.main import app

    monkeypatch.setattr(gateway_routes, "_observer", lambda *args, **kwargs: None)
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def _auth(client):
    token = client.post("/v1/dev/session", json={"email": "cloud@localhost"}).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_a_provider_failure_is_json_with_its_cause_and_a_reference(client, monkeypatch):
    class Refusing:
        def translate(self, items, *, source, target):
            raise translation.TranslationError("Google translation failed: 403 Cloud Translation API has not been used in project 1 or it is disabled")

    monkeypatch.setattr(translation, "GoogleTranslator", Refusing)
    answer = client.post("/v1/assistant/translate", headers=_auth(client),
                         json={"items": [{"id": "a", "text": "Hello"}], "source": "en", "target": "hi"})
    assert answer.status_code == 502
    assert answer.headers["content-type"].startswith("application/json")
    body = answer.json()
    assert body["code"] == "E_PROVIDER_FAILED"
    assert "switched off" in body["detail"]
    assert body["request_id"] == answer.headers["x-request-id"]


def test_an_unexpected_crash_is_still_json(client, monkeypatch):
    class Crashing:
        def translate(self, items, *, source, target):
            raise KeyError("translations")

    monkeypatch.setattr(translation, "GoogleTranslator", Crashing)
    answer = client.post("/v1/assistant/translate", headers=_auth(client),
                         json={"items": [{"id": "a", "text": "Hello"}], "source": "en", "target": "hi"})
    assert answer.status_code == 500
    assert answer.json()["code"] == "E_PROVIDER_INTERNAL"


# ------------------------------------------------------ the desktop client


def _reply(status, content, content_type="application/json", headers=None):
    return httpx.Response(status, content=content, headers={"content-type": content_type, **(headers or {})})


@pytest.mark.parametrize(("reply", "expected"), [
    (_reply(502, b'{"detail": "Google refused: API not enabled", "request_id": "r1"}'), "Google refused: API not enabled (reference r1)"),
    (_reply(409, b'{"detail": {"message": "The deck changed", "code": "E310"}}'), "The deck changed"),
    (_reply(500, b"Internal Server Error", "text/plain"), "Internal Server Error"),
    (_reply(502, b"<html><body>Bad Gateway</body></html>", "text/html"), "Deckastra's cloud service could not complete this right now (HTTP 502)."),
    (_reply(503, b"", "application/json"), "Deckastra's cloud service could not complete this right now (HTTP 503)."),
    (_reply(401, b""), "Sign in to use Deckastra AI credits."),
    (_reply(500, b"{not json", "application/json", {"x-request-id": "r9"}), "Deckastra's cloud service failed (HTTP 500). (reference r9)"),
])
def test_the_desktop_client_reads_any_failure_without_a_parse_error(reply, expected):
    assert gateway_client.error_message(reply) == expected


def test_a_dropped_bridge_is_not_a_sign_in_problem(monkeypatch):
    monkeypatch.setenv("DECKASTRA_GATEWAY_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("DECKASTRA_GATEWAY_SECRET", "s" * 40)

    def refuse(self, method, url, **kwargs):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(httpx.Client, "request", refuse)
    with pytest.raises(ModelUnavailable) as caught:
        gateway_client.GatewayClient()._call("/credits")
    assert "sign in" not in str(caught.value).lower()
    assert "could not reach" in str(caught.value)
