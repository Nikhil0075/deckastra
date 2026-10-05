"""Adversarial model answers exercise the real tool paths without paid calls."""
import copy
import json
import re
from pathlib import Path
import pytest
from pydantic import BaseModel
from deckastra_agents.budgets import RunBudget
from deckastra_agents.router import ModelResponse, ModelError
from deckastra_agents.nodes._common import NodeContext, ask_model, NodeFailure
from deckastra_agents.tools.registry import ToolRegistry
from deckastra_agents.validation import load_json, scoped_document
from deckastra_agents.vertex_model import runtime_id
from deckastra_api import assistant_tasks, assistant_design
from deckastra_api.patch import apply_patch


ROOT = Path(__file__).resolve().parents[3]


def deck():
    return json.loads((ROOT / "docs/integrations/benchmarks/advanced-deck/advanced/advanced.mydeck.json").read_text(encoding="utf-8"))


def payload(request):
    content = request.messages[0]["content"]
    return json.loads(re.search(r'<untrusted-content[^>]*>\n(.*?)\n</untrusted-content>', content, re.S).group(1))


class Scripted:
    def __init__(self, respond): self.respond, self.calls = respond, []
    def complete(self, request, budget):
        self.calls.append(copy.deepcopy(request))
        value = self.respond(request, len(self.calls))
        return ModelResponse(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))


def request(task, sid, locale="en"):
    return {"task": task, "scope": {"kind": "slide", "slide_ids": [sid], "element_ids": []},
            "locale": locale, "instruction": "Preserve facts and selected scope."}


def snapshot(document, **extra):
    return {"document": document, "images": [], "assets": [], "vision": [], **extra}


@pytest.mark.parametrize("text", ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}'])
def test_ambiguous_json_is_rejected(text):
    with pytest.raises(ValueError): load_json(text)


def test_repair_sees_rejected_answer_and_semantic_failure_counts():
    class Answer(BaseModel): value: int
    client = Scripted(lambda _, n: {"value": 1 if n == 1 else 2})
    budget = RunBudget()
    def validate(answer):
        if answer.value != 2: raise ValueError("Expected two items.")
    result = ask_model(NodeContext(client, budget, lambda e: None, ToolRegistry()), stage="test", task_type="structured",
                       system="", user="", model=Answer, validate=validate)
    assert result.value == 2 and len(client.calls) == 2
    assert client.calls[1].messages[-2]["role"] == "assistant"
    assert '"value": 1' in client.calls[1].messages[-2]["content"]
    assert budget.structured_requests[0]["valid_first_attempt"] is False


def test_provider_failure_is_not_retried():
    class Answer(BaseModel): value: int
    def unavailable(*_): raise ModelError("Uncertain usage")
    client = Scripted(unavailable)
    with pytest.raises(NodeFailure):
        ask_model(NodeContext(client, RunBudget(), lambda e: None, ToolRegistry()), stage="test", task_type="structured", system="", user="", model=Answer)
    assert len(client.calls) == 1


def test_element_snapshot_hides_unselected_content_without_mutation():
    document = deck()
    original = copy.deepcopy(document)
    s = document["slides"][0]
    eid = s["elements"][0]["id"]
    visible = scoped_document(document, {"kind": "elements", "slide_ids": [s["id"]], "element_ids": [eid]})
    assert len(visible["slides"]) == 1 and [e["id"] for e in visible["slides"][0]["elements"]] == [eid]
    assert "metadata" not in visible and document == original
    with pytest.raises(ValueError): scoped_document(document, {"kind": "slide", "slide_ids": []})


def test_missing_image_bytes_never_create_descriptions_or_model_calls():
    document = deck()
    selected = next(s for s in document["slides"] if any(e.get("type") == "image" for e in s["elements"]))
    selected["elements"] = [e for e in selected["elements"] if e.get("type") == "image"]
    for e in selected["elements"]: e.pop("altText", None)
    client = Scripted(lambda *_: pytest.fail("No pixels: no inference."))
    result = assistant_tasks.compute(request("alt_text", selected["id"]), snapshot(document), client, RunBudget(), lambda e: None)
    assert result["operations"] == [] and result["warnings"] and not client.calls


def test_narration_preserves_recordings_click_steps_and_other_slides():
    document = deck()
    sid = "sld_01JB8Z9K2QW4RN7F3X04001400"
    slide = next(s for s in document["slides"] if s["id"] == sid)
    old = copy.deepcopy(slide["narration"])
    def respond(req, _):
        return {"changes": [{"target_id": t["target_id"], "text": t["text"] + " Continue."} for t in payload(req)["targets"]], "summary": "Prepared narration."}
    result = assistant_tasks.compute(request("narration", sid), snapshot(document), Scripted(respond), RunBudget(), lambda e: None)
    candidate, _ = apply_patch(document, result["operations"])
    for before, after in zip(old["cues"], next(s for s in candidate["slides"] if s["id"] == sid)["narration"]["cues"]):
        assert {k:v for k,v in before.items() if k != "text"} == {k:v for k,v in after.items() if k != "text"}
    assert [s for s in candidate["slides"] if s["id"] != sid] == [s for s in document["slides"] if s["id"] != sid]


def test_localized_narration_keeps_source_cues_and_recordings():
    document = deck()
    sid = "sld_01JB8Z9K2QW4RN7F3X04001400"
    old = copy.deepcopy(document)
    def respond(req, _):
        return {"changes": [{"target_id": t["target_id"], "text": t["text"] + " प्रस्तुति जारी रखें।"} for t in payload(req)["targets"]], "summary": "वर्णन तैयार है।"}
    result = assistant_tasks.compute(request("narration", sid, "hi"), snapshot(document), Scripted(respond), RunBudget(), lambda e: None)
    candidate, _ = apply_patch(document, result["operations"])
    assert candidate["slides"] == old["slides"]
    assert candidate["metadata"] == old["metadata"]
    entries = candidate["locales"]["hi"]["entries"]
    for cue in next(s for s in old["slides"] if s["id"] == sid)["narration"]["cues"]:
        entry = entries[f"/slides/id:{sid}/narration/cues/id:{cue['id']}/text"]
        from deckastra_api import locales
        assert entry["sourceHash"] == locales.text_hash(cue["text"])
        assert entry["reviewStatus"] == "draft" and "प्रस्तुति" in entry["value"]


def test_word_overlay_cannot_change_another_locale_or_claim_review():
    document = deck()
    sid = "sld_01JB8Z9K2QW4RN7F3X04001400"
    after = copy.deepcopy(document)
    after.setdefault("locales", {})["fr"] = {"locale": "fr", "status": "reviewed", "entries": {}}
    assert assistant_tasks.scope_errors(document, after, request("narration", sid)["scope"], "narration", "hi")


def test_generation_propagates_requested_locale_to_planner_and_composer(monkeypatch):
    from types import SimpleNamespace
    from deckastra_agents import runner
    from deckastra_api.models import GenerateRequest
    from deckastra_api.agent_service import _composer
    from deckastra_api.stub import stub_story_plan
    document = deck()
    generated = {}
    def run(run, state):
        assert state["request"]["locale"] == "hi"
        plan = stub_story_plan(GenerateRequest(instruction="A deck", slide_count=1))
        return SimpleNamespace(status="completed", state={}, warnings=[], operations=run.compose(plan.model_dump(mode="json"), {}, {}))
    monkeypatch.setattr(runner, "run_generation", run)
    monkeypatch.setattr(assistant_design, "check", lambda *a, **kw: {"findings": []})
    req = {"task": "generate", "scope": {"kind": "deck", "slide_ids": [], "element_ids": []}, "locale": "hi", "generation_mode": "replace", "instruction": "A deck", "slide_count": 1, "presentation_id": document["id"]}
    snap = snapshot(document, run_id="fixture", user_id="user", project_id="project")
    result = assistant_tasks.compute(req, snap, object(), RunBudget(), lambda e: None)
    candidate, _ = apply_patch(document, result["operations"])
    assert candidate["metadata"]["language"] == "hi"
    _composer(GenerateRequest(instruction="A deck", locale="hi"), generated)(stub_story_plan(GenerateRequest(instruction="A deck")).model_dump(mode="json"), {}, {})
    assert generated["document"]["metadata"]["language"] == "hi"
    with pytest.raises(assistant_tasks.UserFacingError, match="source language"):
        assistant_tasks.compute({**req, "generation_mode": "append"}, snap, object(), RunBudget(), lambda e: None)


def test_qualification_fingerprint_ignores_tool_caches_but_tracks_schema(tmp_path, monkeypatch):
    from deckastra_agents import vertex_model
    source = tmp_path / "agents/deckastra_agents/vertex_model.py"
    source.parent.mkdir(parents=True)
    source.write_text("# stable implementation", encoding="utf-8")
    monkeypatch.setattr(vertex_model, "__file__", str(source))
    schema = tmp_path / "packages/presentation-schema/generated/document.json"
    schema.parent.mkdir(parents=True)
    schema.write_text('{"type":"object"}', encoding="utf-8")
    first = vertex_model.implementation_digest()
    cache = tmp_path / "packages/presentation-schema/node_modules/.vite/results.json"
    cache.parent.mkdir(parents=True)
    cache.write_text('{"transient":"first run"}', encoding="utf-8")
    assert vertex_model.implementation_digest() == first
    cache.write_text('{"transient":"second run"}', encoding="utf-8")
    assert vertex_model.implementation_digest() == first
    schema.write_text('{"type":"array"}', encoding="utf-8")
    assert vertex_model.implementation_digest() != first


def test_read_only_critique_accepts_read_credential_but_edit_requires_write(monkeypatch):
    from fastapi import BackgroundTasks, HTTPException
    from deckastra_api import assistant_routes
    from deckastra_api.auth import Principal, Role
    checks = []
    def access(*args, **kwargs):
        checks.append(kwargs["require"])
        raise HTTPException(404, "Synthetic inaccessible presentation")
    monkeypatch.setattr(assistant_routes, "resolve_presentation_access", access)
    principal = Principal(user_id="synthetic", email="synthetic@example.test", scopes=frozenset({"read"}))
    req = assistant_routes.AssistantRequest(task="critique", presentation_id="synthetic", expected_version_id="synthetic", operation_key="synthetic-critique")
    with pytest.raises(HTTPException) as missing:
        assistant_routes.create_run(req, BackgroundTasks(), principal, object())
    assert missing.value.status_code == 404 and checks == [Role.VIEWER]
    req.task = "edit"
    with pytest.raises(HTTPException) as forbidden:
        assistant_routes.create_run(req, BackgroundTasks(), principal, object())
    assert forbidden.value.status_code == 403 and checks == [Role.VIEWER]


def test_selected_group_includes_child_words_and_design_evidence(monkeypatch):
    from deckastra_api.assistant_intents import wording_targets
    from deckastra_api.ids import new_id
    from deckastra_agents.validation import selected_element_ids
    document = deck()
    slide = document["slides"][0]
    child = copy.deepcopy(next(e for e in slide["elements"] if e.get("type") == "text"))
    child["content"]["blocks"][0]["spans"][0]["text"] = "Selected child paragraph."
    group_id = new_id("el")
    sibling = next(e for e in slide["elements"] if e["id"] != child["id"])
    slide["elements"] = [{"id": group_id, "type": "group", "transform": {"x": 0, "y": 0, "width": 1920, "height": 1080}, "children": [child]}, sibling]
    req = request("critique", slide["id"])
    req["scope"].update(kind="elements", element_ids=[group_id])
    assert selected_element_ids(document, req["scope"]) == {group_id, child["id"]}
    targets = wording_targets(document, req["scope"])
    assert targets and all(f"id:{group_id}/children/id:{child['id']}" in t["path"] for t in targets)
    monkeypatch.setattr(assistant_design, "check", lambda *_: {"findings": [{"slideId": slide["id"], "elementId": child["id"], "code": "W103", "severity": "error", "message": "Child overflow"}]})
    def respond(model_request, _):
        data = payload(model_request)
        assert data["required_finding_ids"] == ["finding-000"]
        assert not any(f"id:{sibling['id']}/" in fact["path"] for fact in data["facts"])
        return {"summary": "Review selected child layout.", "verdict": "revise_layout", "claim_checks": [],
                "issues": [{"slide_id": slide["id"], "category": "layout", "severity": "major", "message": "Selected child overflows.", "suggested_fix": "Adjust selected child's text box.", "evidence_ids": ["finding-000"]}],
                "scores": {k: (.5 if k != "motion_quality" else None) for k in ("hierarchy", "readability", "contrast", "alignment", "density", "consistency", "narrative_clarity", "motion_quality")}}
    result = assistant_tasks.compute(req, snapshot(document), Scripted(respond), RunBudget(), lambda e: None)
    assert result["critique"]["issues"] and result["operations"] == []


def test_story_locale_checks_body_but_preserves_original_code_and_quote():
    from deckastra_agents.validation import require_story_locale
    plan = {"title": "डेटाबेस का परिचय", "narrative_arc": "बदलाव की कहानी", "slides": [{"headline": "बदलाव दर्ज करें", "key_message": "समीक्षा ज़रूरी है", "body": "English prose was left untranslated.", "code": "SELECT 1", "quote": "An original English quote"}]}
    with pytest.raises(ValueError, match="requested locale"):
        require_story_locale(plan, "hi")
    plan["slides"][0]["body"] = "बदलाव लागू करने से पहले समीक्षा करें।"
    require_story_locale(plan, "hi")


def test_wording_summary_uses_ui_locale_while_source_words_stay_unchanged():
    document = deck()
    req = request("edit", document["slides"][0]["id"], "hi")
    req["instruction"] = "Shorten the first text paragraph."
    def respond(model_request, attempt):
        return {"changes": [{"target_id": t["target_id"], "text": t["text"]} for t in payload(model_request)["targets"]], "summary": "English summary" if attempt == 1 else "चयनित पाठ पहले से संक्षिप्त है।"}
    client = Scripted(respond)
    result = assistant_tasks.compute(req, snapshot(document), client, RunBudget(), lambda e: None)
    assert len(client.calls) == 2 and not result["operations"] and "चयनित" in result["summary"]


@pytest.mark.parametrize("source, changed", [("p95 is 16ms", "p50 is 12ms"), ("1,250ms", "1,250MB"), ("₹1,250", "₹1,500"), ("FY27 rollout", "FY28 rollout"), ("500MB", "500GB"), ("COVID-19", "COVID-20")])
def test_protected_values_cover_units_currency_and_digit_identifiers(source, changed):
    from deckastra_api.assistant_intents import protected_values
    protected_values(source, source, preserve=True)
    with pytest.raises(ValueError): protected_values(source, changed, preserve=True)


def test_wording_rejects_invented_numbers_then_preserves_rich_text():
    document = deck()
    slide = next(s for s in document["slides"] if any(e.get("type") == "text" for e in s["elements"]))
    req = request("edit", slide["id"])
    req["instruction"] = "Shorten the first text paragraph."
    def respond(req, n):
        t = payload(req)["targets"][0]
        return {"changes": [{"target_id": t["target_id"], "text": t["text"] + (" 999999" if n == 1 else " — concise.")}], "summary": "Prepared wording."}
    budget = RunBudget()
    client = Scripted(respond)
    result = assistant_tasks.compute(req, snapshot(document), client, budget, lambda e: None)
    assert len(client.calls) == 2 and len(result["operations"]) == 1
    assert result["operations"][0]["path"].endswith("/spans/0/text")
    assert not budget.structured_requests[0]["valid_first_attempt"]


def test_critique_rejects_wrong_locale_and_scope_and_requires_engine_evidence():
    document = deck()
    sid = document["slides"][0]["id"]
    outside = document["slides"][1]["id"]
    def respond(req, n):
        data = payload(req)
        assert outside not in json.dumps(data)
        local = next(f["id"] for f in data["facts"] if f["path"].startswith(f"/slides/id:{sid}/"))
        refs = data["required_finding_ids"] or [local]
        issues = [{"slide_id": sid, "severity": "major", "category": "layout", "message": "लेआउट की जाँच आवश्यक है।", "suggested_fix": "दिए गए निष्कर्ष ठीक करें।", "evidence_ids": refs}]
        if n == 1: issues[0]["slide_id"] = outside
        claims = [{"fact_id": ref, "support": "unverifiable", "source_evidence_ids": [], "explanation": "स्रोत उपलब्ध नहीं है।"} for ref in data["required_claim_ids"]]
        for ref in data["required_claim_ids"]:
            issues.append({"slide_id": sid, "severity": "major", "category": "content", "message": "दावे का स्रोत उपलब्ध नहीं है।", "suggested_fix": "स्रोत की पुष्टि करें।", "evidence_ids": [ref]})
        return {"summary": "चयनित स्लाइड की समीक्षा पूरी हुई।", "verdict": "revise_layout", "issues": issues, "claim_checks": claims,
                "scores": {k: (.5 if k != "motion_quality" else None) for k in ("hierarchy","readability","contrast","alignment","density","consistency","narrative_clarity","motion_quality")}}
    client = Scripted(respond)
    result = assistant_tasks.compute(request("critique", sid, "hi"), snapshot(document), client, RunBudget(), lambda e: None)
    assert len(client.calls) == 2 and not result["operations"]
    assert all(i["slide_id"] == sid for i in result["critique"]["issues"])


def test_unknown_target_never_becomes_a_patch():
    document = deck()
    sid = "sld_01JB8Z9K2QW4RN7F3X04001400"
    client = Scripted(lambda *_: {"changes": [{"target_id": "outside", "text": "Invented."}], "summary": "Prepared."})
    with pytest.raises(NodeFailure):
        assistant_tasks.compute(request("narration", sid), snapshot(document), client, RunBudget(), lambda e: None)
    assert len(client.calls) == 2


def test_wording_does_not_silently_translate_source_text():
    document = deck()
    slide = next(s for s in document["slides"] if any(e.get("type") == "text" for e in s["elements"]))
    req = request("edit", slide["id"], "hi")
    req["instruction"] = "Shorten the first text paragraph."
    def respond(req, _):
        targets = payload(req)["targets"]
        return {"changes": [{"target_id": t["target_id"], "text": t["text"] + " बदला हुआ"} for t in targets], "summary": "समीक्षा पूरी।"}
    with pytest.raises(NodeFailure, match="source language"):
        assistant_tasks.compute(req, snapshot(document), Scripted(respond), RunBudget(), lambda e: None)


def test_critique_cannot_claim_support_from_a_source_id_alone():
    document = deck()
    sid = json.loads((ROOT / "docs/integrations/benchmarks/advanced-deck/advanced/ids.json").read_text())["faults"]
    def respond(req, _):
        data = payload(req)
        assert data["required_claim_ids"]
        claims = [{"fact_id": ref, "support": "supported", "source_evidence_ids": [], "explanation": "A citation exists."} for ref in data["required_claim_ids"]]
        return {"summary": "Ready.", "verdict": "pass", "issues": [], "claim_checks": claims,
                "scores": {k: (.9 if k != "motion_quality" else None) for k in ("hierarchy","readability","contrast","alignment","density","consistency","narrative_clarity","motion_quality")}}
    with pytest.raises(NodeFailure, match="actual source-text evidence"):
        assistant_tasks.compute(request("critique", sid), snapshot(document), Scripted(respond), RunBudget(), lambda e: None)


def test_asset_organization_never_invents_tags_without_pixels():
    client = Scripted(lambda *_: pytest.fail("No pixels: no model call."))
    result = assistant_tasks.compute({"task": "organise", "scope": {"kind": "deck"}},
                                     snapshot({"slides": []}, assets=[{"id": "a", "filename": "Paris.png"}]),
                                     client, RunBudget(), lambda e: None)
    assert result["metadata"] == [] and result["warnings"] and not client.calls


def test_runtime_qualification_changes_with_implementation_or_thinking(monkeypatch):
    import deckastra_agents.vertex_model as vertex
    config = {"thinking": {"pinned": "LOW"}}
    monkeypatch.setattr(vertex, "implementation_digest", lambda: "first")
    first = runtime_id("pinned", config)
    monkeypatch.setattr(vertex, "implementation_digest", lambda: "changed")
    assert runtime_id("pinned", config) != first
    assert runtime_id("pinned", {"thinking": {"pinned": "HIGH"}}) != runtime_id("pinned", config)
