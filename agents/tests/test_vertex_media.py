import json

import httpx
import pytest

from deckastra_agents.budgets import BudgetExceeded, RunBudget
from deckastra_agents.router import ImageInput, ModelError, ModelRequest
from deckastra_agents.vertex_model import VertexClient, image_model_id


def vertex_config():
    return {
        "project": "test-project",
        "location": "us-central1",
        "ceiling": 1,
        "prices": {"gemini-pinned": {"input": 1, "output": 2, "image_output": 60}},
    }


def test_image_model_is_one_explicit_pin(monkeypatch):
    monkeypatch.delenv("DECKASTRA_VERTEX_IMAGE_MODEL", raising=False)
    with pytest.raises(ModelError, match="DECKASTRA_VERTEX_IMAGE_MODEL"):
        image_model_id()
    monkeypatch.setenv("DECKASTRA_VERTEX_IMAGE_MODEL", "gemini-image-pinned")
    assert image_model_id() == "gemini-image-pinned"


def test_pooled_vertex_media_requests_refresh_identity_and_keep_separate_usage():
    calls = []
    tokens = iter(["first-identity", "refreshed-identity"])

    def respond(request):
        calls.append(request)
        payload = {
            "candidates": [{"content": {"parts": [{"text": ""}]}}],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5},
        }
        return httpx.Response(200, text="data: " + json.dumps(payload) + "\n\n")

    client = VertexClient(
        "gemini-pinned", vertex_config(), lambda: next(tokens), httpx.MockTransport(respond)
    )
    first = RunBudget(max_cost_usd=1)
    second = RunBudget(max_cost_usd=1, max_wall_clock_seconds=10)
    request = ModelRequest("media", "", [], stage="image", image_output=True)
    client.complete(request, first)
    pool = client._http
    client.complete(request, second)
    assert client._http is pool
    assert [item.headers["Authorization"] for item in calls] == [
        "Bearer first-identity",
        "Bearer refreshed-identity",
    ]
    assert calls[1].extensions["timeout"]["read"] <= 10
    assert first.used_tokens == second.used_tokens == 15
    client.close()
    assert pool.is_closed


def test_image_input_and_output_use_media_pricing():
    captured = []

    def respond(request):
        captured.append(json.loads(request.content))
        payload = {
            "candidates": [],
            "usageMetadata": {
                "promptTokenCount": 10,
                "candidatesTokenCount": 1100,
                "candidatesTokensDetails": [
                    {"modality": "IMAGE", "tokenCount": 1000},
                    {"modality": "TEXT", "tokenCount": 100},
                ],
            },
        }
        return httpx.Response(200, text="data: " + json.dumps(payload) + "\n\n")

    client = VertexClient(
        "gemini-pinned", vertex_config(), lambda: "token", httpx.MockTransport(respond)
    )
    budget = RunBudget()
    client.complete(
        ModelRequest(
            "media",
            "Create one presentation image.",
            [{"role": "user", "content": "A calm blue abstract background"}],
            images=[ImageInput("aW1hZ2U=")],
            image_output=True,
        ),
        budget,
    )
    assert captured[0]["contents"][0]["parts"][1]["inlineData"]["mimeType"] == "image/png"
    assert budget.used_cost_usd == pytest.approx(0.06021)
    assert budget.reserved_cost_usd == 0


def test_missing_usage_retains_media_reservation_without_retry():
    calls = []
    client = VertexClient(
        "gemini-pinned",
        vertex_config(),
        lambda: "token",
        httpx.MockTransport(
            lambda request: (
                calls.append(request),
                httpx.Response(200, text='data: {"candidates":[]}\n\n'),
            )[1]
        ),
    )
    budget = RunBudget()
    with pytest.raises(ModelError, match="usage"):
        client.complete(
            ModelRequest("media", "", [{"role": "user", "content": "Draw"}], image_output=True),
            budget,
        )
    assert len(calls) == 1 and budget.reserved_cost_usd > 0


def test_cost_reservations_enforce_total_including_uncertain_calls():
    budget = RunBudget(max_cost_usd=0.1)
    budget.reserve_cost("first", 0.08)
    with pytest.raises(BudgetExceeded):
        budget.reserve_cost("retry", 0.03)
    budget.reconcile_cost("first", 0.08, 0.02)
    budget.reserve_cost("second", 0.08)
    assert budget.used_cost_usd + budget.reserved_cost_usd == pytest.approx(0.1)


def test_connection_failure_refunds_but_read_timeout_retains_reservation():
    def connect(request):
        raise httpx.ConnectTimeout("Before HTTP", request=request)

    def read(request):
        raise httpx.ReadTimeout("After HTTP", request=request)

    for handler, reserved in ((connect, False), (read, True)):
        client = VertexClient(
            "gemini-pinned", vertex_config(), lambda: "token", httpx.MockTransport(handler)
        )
        budget = RunBudget()
        with pytest.raises(ModelError):
            client.complete(
                ModelRequest("media", "", [{"role": "user", "content": "Draw"}], image_output=True),
                budget,
            )
        assert bool(budget.reserved_cost_usd) is reserved
        assert budget.used_cost_usd == 0
