import json
import httpx
import pytest
from pydantic import BaseModel
from deckastra_agents.budgets import RunBudget, BudgetExceeded, RunCancelled
from deckastra_agents.hybrid_model import HybridClient
from deckastra_agents.qualification import qualifies
from deckastra_agents.router import ModelRequest, ModelResponse, ModelError, ImageInput, ModelTool
from deckastra_agents.vertex_model import VertexClient
from deckastra_agents.nodes._common import NodeContext, ask_model
from deckastra_agents.tools.registry import ToolRegistry


def record(task="cleanup"):
    return dict(qualification_contract="assistant-v2-functional", review={"independent_of_system_author": True}, coverage={"distinct_slides": 6, "feature_groups": 5}, task=task, model_id="e2b", runtime_id="r1", hardware_id="gpu", dataset_sha256="fixture-hash", metrics=dict(samples=20, functional_first_attempt_validity=.95, first_attempt_validity=.95, task_success=.9, p95_seconds=20, safety_failures=0, severe_regressions=0))


class Scripted:
    def __init__(self, answers): self.answers, self.calls = iter(answers), 0
    def complete(self, request, budget):
        self.calls += 1
        return ModelResponse(next(self.answers))


def hybrid(local, vertex, *, report=None, local_only=False):
    return HybridClient(lambda: local, lambda task: vertex, report or {}, "e2b", "r1", "gpu", local_only=local_only)


def test_qualification_is_per_deployment_and_requires_samples():
    item = record()
    assert qualifies(item, model_id="e2b", runtime_id="r1", hardware_id="gpu")
    assert not qualifies(item, model_id="e2b", runtime_id="r2", hardware_id="gpu")
    item["metrics"]["samples"] = 1
    assert not qualifies(item, model_id="e2b", runtime_id="r1", hardware_id="gpu")


def test_narrow_or_self_reviewed_evidence_does_not_qualify():
    for changes in ({"qualification_contract": "legacy"}, {"review": {"independent_of_system_author": False}}, {"coverage": {"distinct_slides": 2, "feature_groups": 1}}):
        assert not qualifies({**record(), **changes}, model_id="e2b", runtime_id="r1", hardware_id="gpu")


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


def test_one_local_repair_then_one_vertex_escalation():
    class Output(BaseModel): value: str
    local, vertex = Scripted(["{}", "bad JSON"]), Scripted(['{"value":"valid"}'])
    client = hybrid(local, vertex, report={"tasks": {"cleanup": record()}})
    ctx = NodeContext(client, RunBudget(), lambda e: None, ToolRegistry())
    answer = ask_model(ctx, stage="cleanup", task_type="structured", system="", user="", model=Output)
    assert answer.value == "valid"
    assert (local.calls, vertex.calls) == (2, 1)


def test_unqualified_task_goes_directly_to_vertex():
    local, vertex = Scripted([]), Scripted(["ok"])
    assert hybrid(local, vertex).complete(ModelRequest("structured", "", [], stage="cleanup"), RunBudget()).text == "ok"
    assert local.calls == 0


def test_local_only_never_calls_vertex_and_cancellation_never_escalates():
    local, vertex = Scripted(["local"]), Scripted([])
    client = hybrid(local, vertex, local_only=True)
    request = ModelRequest("structured", "", [], stage="cleanup")
    assert client.complete(request, RunBudget()).text == "local"
    with pytest.raises(ModelError): client.escalate(request, RunBudget(), "bad")
    with pytest.raises(RunCancelled): client.complete(request, RunBudget(cancelled=lambda: True))
    assert vertex.calls == 0


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
