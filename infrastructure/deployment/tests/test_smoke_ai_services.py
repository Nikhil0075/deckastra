"""The deploy smoke's per-service AI checks (release 8, 2026-10-17)."""
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from smoke_cloud import check_ai_services  # noqa: E402

PAUSED = {"detail": "Google refused. The Google API this needs is switched off for the cloud project. The monthly budget stop switches off ...", "code": "E_PROVIDER_FAILED"}


def _client(answers):
    def handler(request):
        for prefix, answer in answers.items():
            if request.url.path.startswith(prefix):
                return answer(request) if callable(answer) else answer
        return httpx.Response(404, json={"detail": "nope"})
    return httpx.Client(transport=httpx.MockTransport(handler), base_url="https://api")


GOOD = {
    "/v1/assistant/translate": httpx.Response(200, json={"translations": {"t": "नमस्ते"}}),
    "/v1/speech/voices": httpx.Response(200, json={"voices": [{"name": "en-US-1"}]}),
    "/v1/assistant/speech": httpx.Response(200, json={"audio": {"data": "AAAA"}}),
    "/v1/assistant/quote": httpx.Response(200, json={"credit_cost": 1}),
    "/v1/account/capabilities": httpx.Response(200, json={"tasks": {"video": {"usd_per_second": 0.15}}}),
}


def test_every_service_answered():
    with _client(GOOD) as http:
        assert set(check_ai_services(http, "https://api", {}).values()) == {"ok"}


def test_a_budget_stop_is_reported_not_failed():
    answers = {**GOOD, "/v1/assistant/translate": httpx.Response(502, json=PAUSED)}
    with _client(answers) as http:
        assert check_ai_services(http, "https://api", {})["translation"] == "paused by the budget stop"


def test_a_body_the_desktop_cannot_read_fails_the_check():
    answers = {**GOOD, "/v1/assistant/speech": httpx.Response(500, text="Internal Server Error")}
    with _client(answers) as http, pytest.raises(AssertionError, match="cannot read"):
        check_ai_services(http, "https://api", {})
