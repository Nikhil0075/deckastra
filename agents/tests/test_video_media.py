import base64
import json

import httpx
import pytest

from deckastra_agents.budgets import RunBudget
from deckastra_agents.gateway_client import GatewayClient
from deckastra_agents.video_model import VeoClient, quote


def config():
    return {"project": "test-project", "location": "us-central1", "identity": "attached",
            "credentials": "", "model": "veo-3.1-fast-generate-001", "rate": .15, "ceiling": 5}


def test_quote_is_exact_per_second_and_expressed_in_account_credits():
    assert quote(4, config()) == {"model": "veo-3.1-fast-generate-001", "duration_seconds": 4,
                                  "usd": .6, "credits": 120}


def test_veo_long_running_operation_is_bounded_muted_and_reconciled():
    calls = []
    clip = b"small-mp4"

    def respond(request):
        calls.append(request)
        body = json.loads(request.content)
        if request.url.path.endswith(":predictLongRunning"):
            assert body["parameters"] == {"durationSeconds": 4, "aspectRatio": "16:9", "resolution": "720p",
                                            "sampleCount": 1, "generateAudio": False, "personGeneration": "disallow"}
            return httpx.Response(200, json={"name": "projects/test/operations/one"})
        return httpx.Response(200, json={"done": True, "response": {"videos": [{
            "bytesBase64Encoded": base64.b64encode(clip).decode(), "mimeType": "video/mp4"}]}})

    http = httpx.Client(transport=httpx.MockTransport(respond))
    client = VeoClient(config(), token=lambda: "token", transport=http)
    budget = RunBudget(max_cost_usd=1)
    result = client.generate("A calm abstract blue wave", duration_seconds=4, aspect_ratio="16:9", budget=budget)
    assert result.data == clip and result.duration_ms == 4000 and result.width == 1280
    assert len(calls) == 2 and budget.used_cost_usd == pytest.approx(.6) and budget.reserved_cost_usd == 0
    http.close()


def test_veo_refuses_unquoted_shapes_before_calling_provider():
    client = VeoClient(config(), token=lambda: "token", transport=object())
    with pytest.raises(Exception, match="4, 6 or 8"):
        client.generate("clip", duration_seconds=5, aspect_ratio="16:9", budget=RunBudget(max_cost_usd=5))


def test_desktop_gateway_implements_the_video_provider_interface(monkeypatch):
    monkeypatch.setenv("DECKASTRA_GATEWAY_URL", "http://127.0.0.1:51888")
    monkeypatch.setenv("DECKASTRA_GATEWAY_SECRET", "s" * 32)
    client = GatewayClient()
    monkeypatch.setattr(client, "_call", lambda path, body=None: {
        "video": {"data": base64.b64encode(b"mp4").decode(), "content_type": "video/mp4",
                  "duration_ms": 4000, "width": 1280, "height": 720, "model": "veo-pinned"},
        "usage": {"used_cost_usd": .6},
    })
    budget = RunBudget(max_wall_clock_seconds=10, max_cost_usd=1)
    result = client.generate("calm loop", duration_seconds=4, aspect_ratio="16:9", budget=budget)
    assert result.data == b"mp4" and result.model == "veo-pinned"
    assert budget.used_cost_usd == pytest.approx(.6)
