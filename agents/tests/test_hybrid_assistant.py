import json
import httpx
import pytest
from pydantic import BaseModel
from deckastra_agents.budgets import RunBudget, BudgetExceeded, RunCancelled
from deckastra_agents.qualification import qualifies
from deckastra_agents.router import ModelRequest, ModelResponse, ModelError, ImageInput, ModelTool
from deckastra_agents.vertex_model import VertexClient
from deckastra_agents.nodes._common import NodeContext, ask_model
from deckastra_agents.tools.registry import ToolRegistry


def record(task="cleanup"):
    return dict(qualification_contract="assistant-v2-functional", review={"independent_of_system_author": True}, coverage={"distinct_slides": 6, "feature_groups": 5}, task=task, model_id="e2b", runtime_id="r1", location="global", dataset_sha256="fixture-hash", metrics=dict(samples=20, functional_first_attempt_validity=.95, first_attempt_validity=.95, task_success=.9, p95_seconds=20, safety_failures=0, severe_regressions=0))


class Scripted:
    def __init__(self, answers): self.answers, self.calls = iter(answers), 0
    def complete(self, request, budget):
        self.calls += 1
        return ModelResponse(next(self.answers))


def test_qualification_is_per_deployment_and_requires_samples():
    item = record()
    assert qualifies(item, model_id="e2b", runtime_id="r1", location="global")
    assert not qualifies(item, model_id="e2b", runtime_id="r2", location="global")
    item["metrics"]["samples"] = 1
    assert not qualifies(item, model_id="e2b", runtime_id="r1", location="global")


def test_pooled_vertex_requests_refresh_identity_and_keep_separate_usage():
    calls = []
    tokens = iter(["first-identity", "refreshed-identity"])
    def respond(request):
        calls.append(request)
        payload = {"candidates": [{"content": {"parts": [{"text": "{}"}]}}],
                   "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5}}
        return httpx.Response(200, text="data: " + json.dumps(payload) + "\n\n")
    client = VertexClient("gemini-pinned", vertex_config(), lambda: next(tokens), httpx.MockTransport(respond))
    first = RunBudget(max_cost_usd=1)
    second = RunBudget(max_cost_usd=1, max_wall_clock_seconds=10)
    request = ModelRequest("structured", "", [], stage="authoring")
    assert client.complete(request, first).text == "{}"
    pool = client._http
    assert client.complete(request, second).text == "{}" and client._http is pool
    assert [r.headers["Authorization"] for r in calls] == ["Bearer first-identity", "Bearer refreshed-identity"]
    assert calls[1].extensions["timeout"]["read"] <= 10
    assert first.used_tokens == second.used_tokens == 15
    assert first.reserved_cost_usd == second.reserved_cost_usd == 0
    client.close()
    assert pool.is_closed


def test_narrow_or_self_reviewed_evidence_does_not_qualify():
    for changes in ({"qualification_contract": "legacy"}, {"review": {"independent_of_system_author": False}}, {"coverage": {"distinct_slides": 2, "feature_groups": 1}}):
        assert not qualifies({**record(), **changes}, model_id="e2b", runtime_id="r1", location="global")


def test_qualification_requires_task_identity_scope_coverage_and_numeric_metrics():
    item = record("critique")
    assert not qualifies(item, model_id="e2b", runtime_id="r1", location="global", task="critique")
    item["coverage"]["scope_kinds"] = ["slide", "elements"]
    assert qualifies(item, model_id="e2b", runtime_id="r1", location="global", task="critique")
    assert not qualifies(item, model_id="e2b", runtime_id="r1", location="global", task="planning")
    item["metrics"]["first_attempt_validity"] = True
    assert not qualifies(item, model_id="e2b", runtime_id="r1", location="global", task="critique")


def test_uncertain_cost_requires_audited_authoritative_evidence(tmp_path):
    from deckastra_agents.cost_ledger import CostLedger
    ledger = CostLedger(5, tmp_path / "ledger.sqlite")
    ledger.observe("unknown", .2, -1)
    with pytest.raises(ValueError):
        ledger.reconcile_evidence({"operation_id": "unknown", "actual_usd": 0, "authority": "guessed", "reviewed_by": "operator", "explanation": "old request"})
    assert ledger.snapshot()["reserved_usd"] == .2
    evidence = {"operation_id": "unknown", "actual_usd": .03, "authority": "provider_usage", "provider_request_id": "receipt-123", "reviewed_by": "operator", "explanation": "Usage receipt confirms the charge"}
    ledger.reconcile_evidence(evidence)
    ledger.reconcile_evidence(evidence)  # idempotent operator reconciliation
    assert not ledger.outstanding()
    assert ledger.snapshot()["used_usd"] == .03


def test_cost_reservations_enforce_total_including_uncertain_calls():
    budget = RunBudget(max_cost_usd=.1)
    budget.reserve_cost("first", .08)
    with pytest.raises(BudgetExceeded): budget.reserve_cost("retry", .03)
    budget.reconcile_cost("first", .08, .02)
    budget.reserve_cost("second", .08)
    assert budget.used_cost_usd + budget.reserved_cost_usd == pytest.approx(.1)
    with pytest.raises(BudgetExceeded): RunBudget().reserve_cost("paid", .01)


def test_durable_total_ceiling_spans_jobs_and_restarts(tmp_path):
    from deckastra_agents.cost_ledger import CostLedger
    path = tmp_path / "cost.sqlite"
    first = CostLedger(5, path)
    first.observe("paid-first", 4, -1)
    restarted = CostLedger(5, path)
    with pytest.raises(BudgetExceeded): restarted.observe("paid-next", 2, -1)
    first.observe("paid-first", 4, 1)
    assert restarted.snapshot() == {"ceiling_usd": 5, "used_usd": 1, "reserved_usd": 0, "remaining_usd": 4, "calls": 1}
    restarted.observe("paid-next", 4, -1)
    with pytest.raises(BudgetExceeded): CostLedger(5, path).observe("another-job", .01, -1)
    with pytest.raises(ValueError): restarted.observe("paid-next", 4, -1)


def vertex_config():
    return dict(project="test-project", location="us-central1", ceiling=1, prices={"gemini-pinned": {"input": 1, "output": 2}})


def test_native_vertex_images_tools_signatures_and_accounting():
    captured = []
    def respond(request):
        captured.append(json.loads(request.content))
        payload = {"candidates": [{"content": {"parts": [{"functionCall": {"name": "inspect", "args": {"id": "s1"}}, "thoughtSignature": "opaque"}]}}], "usageMetadata": {"promptTokenCount": 20, "candidatesTokenCount": 10, "thoughtsTokenCount": 5}}
        return httpx.Response(200, text="data: " + json.dumps(payload) + "\n\n")
    client = VertexClient("gemini-pinned", vertex_config(), lambda: "test-token", httpx.MockTransport(respond))
    budget = RunBudget()
    result = client.complete(ModelRequest("structured", "system", [{"role": "user", "content": "inspect"}], images=[ImageInput("aW1hZ2U=")], tools=[ModelTool("inspect", "Read", {"type": "object", "properties": {"id": {"type": "string"}}})]), budget)
    assert result.tool_calls[0].arguments == {"id": "s1"}
    assert result.provider_parts[0]["thoughtSignature"] == "opaque"
    assert captured[0]["contents"][0]["parts"][1]["inlineData"]["mimeType"] == "image/png"
    assert budget.used_tokens == 35 and budget.reserved_cost_usd == 0
    assert budget.used_cost_usd == pytest.approx(.00005)


def test_vertex_missing_usage_retains_reservation_without_retry():
    calls = []
    client = VertexClient("gemini-pinned", vertex_config(), lambda: "token", httpx.MockTransport(lambda request: (calls.append(request), httpx.Response(200, text='data: {"candidates":[]}\n\n'))[1]))
    budget = RunBudget()
    with pytest.raises(ModelError, match="usage"): client.complete(ModelRequest("fast", "", [{"role": "user", "content": "hi"}]), budget)
    assert len(calls) == 1 and budget.reserved_cost_usd > 0


def test_image_output_uses_its_own_price_and_reservation():
    config = vertex_config()
    config["prices"]["gemini-pinned"]["image_output"] = 60
    payload = {"candidates": [], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 1100, "candidatesTokensDetails": [{"modality": "IMAGE", "tokenCount": 1000}, {"modality": "TEXT", "tokenCount": 100}]}}
    client = VertexClient("gemini-pinned", config, lambda: "token", httpx.MockTransport(lambda request: httpx.Response(200, text="data: " + json.dumps(payload) + "\n\n")))
    budget = RunBudget()
    client.complete(ModelRequest("structured", "", [{"role": "user", "content": "Draw"}], image_output=True), budget)
    assert budget.used_cost_usd == pytest.approx(.06021)
    assert budget.reserved_cost_usd == 0


def test_pinned_thinking_configuration_is_sent():
    config = vertex_config(); config["thinking"] = {"gemini-pinned": "LOW"}
    client = VertexClient("gemini-pinned", config, lambda: "token")
    assert client._body(ModelRequest("structured", "", [{"role": "user", "content": "Edit"}]))["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "LOW"}


def test_gemini_three_uses_supported_thinking_without_legacy_sampling():
    config = vertex_config()
    config["prices"]["gemini-3.8-flash"] = {"input": 1.5, "output": 7.5}
    config["thinking"] = {"gemini-3.8-flash": "LOW"}
    client = VertexClient("gemini-3.8-flash", config, lambda: "token")
    body = client._body(ModelRequest("structured", "", [{"role": "user", "content": "Edit"}], response_schema={"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}))
    assert "temperature" not in body["generationConfig"]
    assert body["generationConfig"]["responseSchema"]["propertyOrdering"] == ["answer"]


def test_connection_failure_refunds_but_read_timeout_retains_reservation():
    def connect(request): raise httpx.ConnectTimeout("Before HTTP", request=request)
    def read(request): raise httpx.ReadTimeout("After HTTP", request=request)
    for handler, reserved in ((connect, False), (read, True)):
        client = VertexClient("gemini-pinned", vertex_config(), lambda: "token", httpx.MockTransport(handler))
        budget = RunBudget()
        with pytest.raises(ModelError): client.complete(ModelRequest("structured", "", [{"role": "user", "content": "Hello"}]), budget)
        assert bool(budget.reserved_cost_usd) is reserved
        assert budget.used_cost_usd == 0
