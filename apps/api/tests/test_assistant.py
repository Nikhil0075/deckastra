import copy
import io
import json
import sys
import threading
from pathlib import Path
import pytest
from PIL import Image
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deckastra_api.db import session as db_session
from deckastra_api import assistant_routes, assistant_tasks
from deckastra_api.assistant_models import AssistantRun, AssistantReservation
from deckastra_api.assistant_assets import fingerprints
from deckastra_api.db.models import Asset
from deckastra_api.ids import new_id


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'assistant.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.setenv("DECKASTRA_ASSISTANT_COST_LEDGER", str(tmp_path / "cost.sqlite"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("DECKASTRA_INTELLIGENCE", raising=False)
    monkeypatch.setattr(assistant_routes, "start_dispatcher", lambda: threading.Event())
    monkeypatch.setattr(assistant_routes._executor, "submit", lambda *args: None)
    tasks = assistant_routes.AssistantRequest.model_fields["task"].annotation.__args__
    monkeypatch.setattr(assistant_routes, "capabilities", lambda: {"provider": "test", "available": True, "reason": None, "tasks": {task: {"available": True, "provider": "test", "reason": None} for task in tasks}})
    db_session.reset_engine(); db_session.create_all()
    from deckastra_api.main import app
    with TestClient(app) as value: yield value
    db_session.reset_engine()


@pytest.fixture()
def auth(client):
    return {"Authorization": "Bearer " + client.post("/v1/dev/session", json={"email": "assistant@localhost"}).json()["token"]}


@pytest.fixture()
def deck(client, auth):
    result = client.post("/v1/generate", headers=auth, json={"instruction": "A presentation about databases", "slide_count": 3})
    assert result.status_code == 200, result.text
    return result.json()


def payload(deck):
    return {"task": "tidy", "presentation_id": deck["presentation_id"], "expected_version_id": deck["version_id"], "operation_key": "unique-request-123", "scope": {"kind": "deck", "slide_ids": [], "element_ids": []}}


def advanced_fixture():
    folder = Path(__file__).resolve().parents[3] / "docs/integrations/benchmarks/advanced-deck/advanced"
    return json.loads((folder / "advanced.mydeck.json").read_text(encoding="utf-8")), json.loads((folder / "ids.json").read_text())


def persisted_advanced(deck):
    from deckastra_api import store
    from deckastra_api.db.models import Presentation, PresentationVersion, Project
    document, ids = advanced_fixture()
    document["id"] = new_id("doc")
    with db_session.session_scope() as session:
        parent = session.get(Presentation, deck["presentation_id"])
        owner = session.get(PresentationVersion, deck["version_id"]).created_by
        workspace = session.get(Project, parent.project_id).workspace_id
        loaded = store.create_presentation(session, project_id=parent.project_id, document=document, created_by=owner)
        session.add(Asset(id=ids["IMG_ID"], workspace_id=workspace, created_by=owner, kind="image", storage_key="fixture/chart.png", filename="chart.png", content_type="image/png", bytes=10, width=1200, height=600))
        return {"presentation_id": loaded.presentation_id, "version_id": loaded.version_id, "document": loaded.document}, ids


def test_missing_image_is_skipped_and_other_visual_inputs_are_kept(client, auth, deck, monkeypatch):
    from fastapi import HTTPException
    from deckastra_api import assistant_assets
    advanced, ids = persisted_advanced(deck)
    body = {**payload(advanced), "task": "alt_text", "scope": {"kind": "slide", "slide_ids": [ids["images"]], "element_ids": []}}
    run_id = client.post("/v1/assistant/runs", headers=auth, json=body).json()["id"]
    def view(asset_id, **kwargs):
        if asset_id == ids["MISSING_ID"]: raise HTTPException(404, "No such asset")
        return {"asset_id": asset_id, "base64": "image"}
    monkeypatch.setattr(assistant_assets, "asset_view", view)
    monkeypatch.setattr(assistant_routes, "model_client", lambda emit: object())
    def compute(request, snapshot, *args):
        assert [v["asset_id"] for v in snapshot["vision"]] == [ids["IMG_ID"]]
        assert snapshot["unavailable_assets"] == [ids["MISSING_ID"]]
        return {"operations": [], "warnings": snapshot["warnings"]}
    monkeypatch.setattr(assistant_tasks, "compute", compute)
    assistant_routes.execute(run_id)
    detail = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert detail["status"] == "completed", detail
    assert "image bytes are unavailable" in detail["result"]["warnings"][0]


@pytest.mark.parametrize("conflict", [False, True])
def test_organise_proposes_then_approves_metadata_with_conflict_and_undo(client, auth, deck, monkeypatch, conflict):
    advanced, ids = persisted_advanced(deck)
    body = {**payload(advanced), "task": "organise"}
    run_id = client.post("/v1/assistant/runs", headers=auth, json=body).json()["id"]
    monkeypatch.setattr(assistant_routes, "model_client", lambda emit: object())
    from deckastra_api import assistant_assets
    from fastapi import HTTPException
    monkeypatch.setattr(assistant_assets, "asset_view", lambda *args, **kw: (_ for _ in ()).throw(HTTPException(404, "Missing fixture bytes")))
    monkeypatch.setattr(assistant_tasks, "compute", lambda *args: {"metadata": [{"asset_id": ids["IMG_ID"], "tags": ["chart", "adoption"], "description": "Regional adoption chart"}], "metadata_versions": {ids["IMG_ID"]: 0}})
    assistant_routes.execute(run_id)
    detail = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert detail["status"] == "completed" and detail["result"]["status"] == "pending_metadata", detail
    with db_session.session_scope() as session:
        assert not session.get(Asset, ids["IMG_ID"]).tags
    if conflict:
        client.patch(f"/v1/assets/{ids['IMG_ID']}", headers=auth, json={"expected_metadata_version": 0, "tags": ["human"]})
    applied = client.post(f"/v1/assistant/runs/{run_id}/approve-metadata", headers=auth)
    assert applied.status_code == (409 if conflict else 200), applied.text
    if not conflict:
        assert applied.json()["result"]["status"] == "applied_metadata"
        assert client.post(f"/v1/assistant/runs/{run_id}/approve-metadata", headers=auth).json() == applied.json()
        change = applied.json()["result"]["assets"][0]["change_id"]
        assert client.post(f"/v1/assets/{ids['IMG_ID']}/changes/{change}/revert", headers=auth).status_code == 200


def test_resized_images_are_duplicate_candidates_without_deletion(client, auth, deck):
    advanced, ids = persisted_advanced(deck)
    from deckastra_api.db.models import Project, Presentation
    with db_session.session_scope() as session:
        original = session.get(Asset, ids["IMG_ID"])
        original.sha256, original.dhash64 = "a" * 64, "0123456789abcdef"
        resized_id = new_id("ast")
        session.add(Asset(id=resized_id, workspace_id=original.workspace_id, created_by=original.created_by, kind="image", storage_key="fixture/resized.png", filename="resized.png", content_type="image/png", bytes=7, width=800, height=400, sha256="b" * 64, dhash64=original.dhash64))
    result = client.get("/v1/assets/duplicates", headers=auth)
    assert result.status_code == 200
    assert any(set(g["asset_ids"]) == {ids["IMG_ID"], resized_id} and g["kind"] == "candidate" for g in result.json()["groups"])
    with db_session.session_scope() as session: assert session.get(Asset, resized_id).deleted_at is None


def test_csv_growth_uses_records_and_keeps_instructions_out_of_arithmetic():
    from deckastra_api.research_calculations import csv_growth
    source = Path(__file__).resolve().parents[3] / "docs/integrations/benchmarks/advanced-deck/advanced/revenue.csv"
    results = csv_growth([{"id": "revenue", "title": "revenue.csv", "text": source.read_text(encoding="utf-8")}])
    india = next(r for r in results if r["group"] == "India")
    assert india["last_value"] == "498.9" and india["growth_percent"] == "20.95"
    assert india["period_total"] == "1797.6"


def test_advanced_cleanup_and_motion_reuse_engines_and_preserve_scope(monkeypatch):
    from deckastra_agents.budgets import RunBudget
    from deckastra_api.patch import apply_patch
    from deckastra_api import assistant_design
    document, ids = advanced_fixture()
    monkeypatch.setattr(assistant_tasks, "ask_model", lambda *args, **kwargs: pytest.fail("Engine tasks must not infer"))
    snapshot = {"document": document, "images": [], "assets": [], "vision": []}
    scope = {"kind": "slide", "slide_ids": [ids["faults"]], "element_ids": []}
    before = assistant_design.check(document, ids["faults"])
    fixed = assistant_tasks.compute({"task": "tidy", "scope": scope}, snapshot, None, RunBudget(), lambda e: None)
    candidate, _ = apply_patch(document, fixed["operations"])
    after = assistant_design.check(candidate, ids["faults"])
    assert len(before["findings"]) - len(after["findings"]) >= 3
    assert not assistant_tasks.scope_errors(document, candidate, scope, "tidy")
    assert not assistant_design.regressions(assistant_design.check(document), assistant_design.check(candidate))
    assert fixed["findings"] and fixed["warnings"]  # residual issues remain visible
    scope["slide_ids"] = [ids["data"]]
    planned = assistant_tasks.compute({"task": "motion", "scope": scope}, snapshot, None, RunBudget(), lambda e: None)
    assert planned["operations"]
    animated, _ = apply_patch(document, planned["operations"])
    assert not assistant_tasks.scope_errors(document, animated, scope, "motion")
    assert all("/animations" in op["path"] for op in planned["operations"])


THREE_STEPS = "sld_01JB8Z9K2QW4RN7F3X04001400"  # 3 click reveals, narration on steps 0-3
CLICK_TO_REVEAL = "sld_01JB8Z9K2QW4RN7F3X03002300"  # staggerReveal + drawPath on click


def test_motion_keeps_authored_animation_unless_asked_to_replace(monkeypatch):
    """The 2026-10-04 recheck: re-planning replaced click reveals with entrances."""
    document, _ = advanced_fixture()
    monkeypatch.setattr(assistant_tasks, "ask_model", lambda *a, **k: pytest.fail("Motion must not infer"))
    scope = {"kind": "slide", "slide_ids": [THREE_STEPS, CLICK_TO_REVEAL], "element_ids": []}
    kept = assistant_tasks.plan_motion({"task": "motion", "scope": scope}, document)
    assert kept["operations"] == []
    assert len(kept["warnings"]) == 2 and all("Kept the" in w for w in kept["warnings"])
    assert "requires_review" not in kept


SEQUENCED = "sld_01JB8Z9K2QW4RN7F3X03000500"  # authored entrances, no clicks


def test_motion_replacement_of_authored_entrances_needs_review():
    from deckastra_api import assistant_design
    from deckastra_api.patch import apply_patch
    document, _ = advanced_fixture()
    scope = {"kind": "slide", "slide_ids": [SEQUENCED], "element_ids": []}
    planned = assistant_tasks.plan_motion({"task": "motion", "scope": scope, "motion_replace": True}, document)
    assert planned["operations"] and planned["requires_review"].startswith("Replaces existing animation")
    candidate, _ = apply_patch(document, planned["operations"])
    assert not assistant_design.regressions(assistant_design.check(document), assistant_design.check(candidate))


@pytest.mark.parametrize("slide_id", [THREE_STEPS, CLICK_TO_REVEAL])
def test_motion_replacement_never_drops_click_reveals(slide_id):
    """Both slides' clicks share roles, so the planner cannot rebuild them all; a
    replacement that turned click reveals into entrances is refused per slide."""
    document, _ = advanced_fixture()
    scope = {"kind": "slide", "slide_ids": [slide_id], "element_ids": []}
    kept = assistant_tasks.plan_motion({"task": "motion", "scope": scope, "motion_replace": True}, document)
    assert kept["operations"] == [] and "click reveals" in kept["warnings"][-1]


def test_motion_refuses_a_chosen_count_that_orphans_narration():
    """Choosing no clicks on a narrated slide would leave its lines playing nowhere."""
    from fastapi import HTTPException
    document, _ = advanced_fixture()
    scope = {"kind": "slide", "slide_ids": [THREE_STEPS], "element_ids": []}
    with pytest.raises(HTTPException) as refused:
        assistant_tasks.plan_motion({"task": "motion", "scope": scope, "motion_replace": True, "motion_click_reveals": 0}, document)
    assert refused.value.status_code == 422 and "narration" in refused.value.detail


def test_engine_change_marked_for_review_is_pending(client, auth, deck, monkeypatch):
    from deckastra_api import store
    body = {**payload(deck), "task": "motion", "motion_replace": True}
    run_id = client.post("/v1/assistant/runs", headers=auth, json=body).json()["id"]
    sid = deck["document"]["slides"][0]["id"]
    monkeypatch.setattr(assistant_tasks, "compute", lambda *a: {"operations": [{"op": "add", "path": f"/slides/id:{sid}/animations", "value": []}], "requires_review": "Replaces existing animation on \"Title\""})
    assistant_routes.execute(run_id)
    detail = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert detail["result"]["status"] == "pending", detail
    assert "Replaces existing animation" in " ".join(detail["result"]["reasons"])
    with db_session.session_scope() as session:
        assert store.load_presentation(session, deck["presentation_id"]).version_id == deck["version_id"]


def test_model_edit_requires_review_and_history_omits_deck(client, auth, deck, monkeypatch):
    from deckastra_api import store
    body = {**payload(deck), "task": "edit"}
    run_id = client.post("/v1/assistant/runs", headers=auth, json=body).json()["id"]
    sid = deck["document"]["slides"][0]["id"]
    monkeypatch.setattr(assistant_routes, "model_client", lambda emit: object())
    monkeypatch.setattr(assistant_tasks, "compute", lambda *a: {"operations": [{"op": "replace", "path": f"/slides/id:{sid}/name", "value": "A clearer title"}]})
    assistant_routes.execute(run_id)
    detail = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert detail["status"] == "completed", detail
    assert detail["result"]["status"] == "pending", detail
    with db_session.session_scope() as session:
        assert store.load_presentation(session, deck["presentation_id"]).version_id == deck["version_id"]
    summaries = client.get("/v1/assistant/runs", params={"presentation_id": deck["presentation_id"]}, headers=auth).json()["runs"]
    assert all(row["result"] is None for row in summaries)


def test_attribution_and_consistency_geometry_are_preserved():
    before, ids = advanced_fixture()
    scope = {"kind": "deck", "slide_ids": [], "element_ids": []}
    after = copy.deepcopy(before)
    after["extensions"] = {"deckastra.sourceIds": ["fake"]}
    before["extensions"] = {"deckastra.sourceIds": ["original"]}
    assert assistant_tasks.scope_errors(before, after, scope, "edit")
    after = copy.deepcopy(before)
    after["slides"][0]["elements"][0]["transform"]["x"] += 1
    assert assistant_tasks.scope_errors(before, after, scope, "consistency")
    assert assistant_tasks.scope_errors(before, after, scope, "motion")


def test_generation_appends_sources_and_ignores_existing_layout_faults(monkeypatch):
    from types import SimpleNamespace
    from deckastra_agents import runner
    from deckastra_agents.budgets import RunBudget
    from deckastra_api.patch import apply_patch
    document, ids = advanced_fixture()
    new_slide = copy.deepcopy(document["slides"][0]); new_slide["id"] = new_id("sld")
    new_slide["extensions"] = {"deckastra.sourceIds": ["source-one"]}
    sources = [{"id": "source-one", "title": "Uploaded brief", "text": "Supported facts"}]
    def generated(run, state):
        assert state["source_inputs"] == sources
        return SimpleNamespace(status="completed", state={}, warnings=[], operations=[{"op": "replace", "path": "/slides", "value": [new_slide]}, {"op": "add", "path": "/extensions", "value": {"deckastra.sources": sources}}])
    monkeypatch.setattr(runner, "run_generation", generated)
    monkeypatch.setattr(assistant_tasks.assistant_design, "check", lambda *args, **kw: {"findings": [{"code": "W103", "severity": "error", "slideId": ids["faults"], "message": "Existing fault"}]})
    snapshot = {"document": document, "images": [], "assets": [], "sources": sources, "run_id": "fixture", "user_id": "user", "project_id": "project"}
    result = assistant_tasks.compute({"task": "generate", "scope": {"kind": "deck", "slide_ids": [], "element_ids": []}, "instruction": "Use the uploaded sources", "slide_count": 1, "presentation_id": document["id"]}, snapshot, object(), RunBudget(), lambda e: None)
    after, _ = apply_patch(document, result["operations"])
    assert len(after["slides"]) == 22 and after["slides"][:21] == document["slides"]
    assert after["extensions"]["deckastra.sources"] == sources


def test_deck_model_calls_contain_one_slide_at_a_time(monkeypatch):
    from deckastra_agents.budgets import RunBudget
    from deckastra_agents.contracts import AuthorPlan
    import re
    document, ids = advanced_fixture()
    seen = []
    def model(ctx, **kwargs):
        scope = json.loads(re.search(r"Requested scope: (.+)\n", kwargs["user"])[1])
        sid = scope["slide_ids"][0]
        seen.append(sid)
        other_ids = {s["id"] for s in document["slides"]} - {sid}
        assert not any(other in kwargs["user"] for other in other_ids)
        return AuthorPlan(summary="An unsupported summary", refusal="", operations=[{"op": "replace", "path": f"/slides/id:{sid}/name", "value_json": json.dumps("Revised slide label")}])
    monkeypatch.setattr(assistant_tasks, "ask_model", model)
    monkeypatch.setattr(assistant_tasks.assistant_design, "check", lambda *args, **kw: {"findings": []})
    result = assistant_tasks.compute({"task": "edit", "scope": {"kind": "deck", "slide_ids": [], "element_ids": []}, "instruction": "Revise slide labels"}, {"document": document, "images": [], "assets": [], "vision": []}, object(), RunBudget(max_total_tokens=250000), lambda e: None)
    assert len(seen) == 21 and len(set(seen)) == 21
    assert len(result["operations"]) == 21
    assert "unsupported" not in result["summary"]


def test_partial_translation_preserves_other_reviewed_entries_and_export_warns():
    from deckastra_api import locales, translation, export_service
    from deckastra_api.patch import apply_patch
    document, ids = advanced_fixture()
    first, second = document["slides"][:2]
    slots = [s for s in locales.locale_slots(document) if s.slide_id in {first["id"], second["id"]} and locales.worth_translating(s.value)]
    document["locales"] = {"hi": {"locale": "hi", "status": "reviewed", "entries": {s.path: {"value": s.value, "sourceHash": locales.text_hash(s.value), "origin": "human", "reviewStatus": "reviewed"} for s in slots}}}
    class Translator:
        name, origin = "test", "machine"
        def translate(self, items, **kwargs): return {item.id: item.text for item in items}
    chosen = [s for s in slots if s.slide_id == first["id"]]
    plan = translation.plan_translation(document, "hi", chosen, Translator())
    after, _ = apply_patch(document, plan.operations)
    assert after["locales"]["hi"]["status"] == "reviewed"
    for slot in slots:
        assert after["locales"]["hi"]["entries"][slot.path]["reviewStatus"] == ("draft" if slot.slide_id == first["id"] else "reviewed")
    warnings = export_service.translation_export_warnings(after, {"locale": "hi"})
    assert len({warning["slideId"] for warning in warnings}) >= 18
    assert not export_service.translation_export_warnings(after, {"locale": "hi", "slideIds": [first["id"]]})


def test_idempotency_conflict_and_cancel_before_execution(client, auth, deck, monkeypatch):
    body = payload(deck)
    first = client.post("/v1/assistant/runs", headers=auth, json=body)
    assert first.status_code == 202, first.text
    run_id = first.json()["id"]
    assert client.post("/v1/assistant/runs", headers=auth, json=body).json()["id"] == run_id
    assert client.post("/v1/assistant/runs", headers=auth, json={**body, "instruction": "different"}).status_code == 409
    client.post(f"/v1/assistant/runs/{run_id}/cancel", headers=auth)
    monkeypatch.setattr(assistant_tasks, "compute", lambda *args: pytest.fail("Cancelled work must not run"))
    assistant_routes.execute(run_id)
    assert client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()["status"] == "cancelled"


def test_validated_result_events_replay_and_stale_version(client, auth, deck, monkeypatch):
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]
    monkeypatch.setattr(assistant_routes, "model_client", lambda emit: object())
    monkeypatch.setattr(assistant_tasks, "compute", lambda *args: {"operations": [], "warnings": ["No changes needed"]})
    assistant_routes.execute(run_id)
    output = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert output["status"] == "completed", output
    events = client.get(f"/v1/assistant/runs/{run_id}/events", headers=auth).json()["events"]
    assert events[-1]["status"] == "completed"
    assert client.get(f"/v1/assistant/runs/{run_id}/events?after={events[-1]['sequence']}", headers=auth).json()["events"] == []
    assert client.post("/v1/assistant/runs", headers=auth, json={**payload(deck), "operation_key": "new-request-123", "expected_version_id": "stale"}).status_code == 409


def test_resume_refuses_uncertain_paid_request(client, auth, deck):
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]
    with db_session.session_scope() as session:
        row = session.get(AssistantRun, run_id); row.status = "interrupted"
        session.add(AssistantReservation(operation_id="paid-operation", run_id=run_id, reserved_usd=.1))
    assert client.post(f"/v1/assistant/runs/{run_id}/resume", headers=auth).status_code == 409


def test_status_poll_recovers_loaded_sqlite_run_with_expired_lease(client, auth, deck):
    from datetime import timedelta
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]
    with db_session.session_scope() as session:
        row = session.get(AssistantRun, run_id)
        row.status, row.lease_until = "running", assistant_routes.now() - timedelta(seconds=60)
    response = client.get(f"/v1/assistant/runs/{run_id}", headers=auth)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "interrupted"


def test_export_retains_selected_slides_and_rejects_missing_translation(client, auth, deck):
    from deckastra_api.db.models import ExportJob
    sid = deck["document"]["slides"][0]["id"]
    body = {**payload(deck), "task": "export", "scope": {"kind": "slide", "slide_ids": [sid], "element_ids": []}}
    rejected = client.post("/v1/assistant/runs", headers=auth, json={**body, "locale": "fr"})
    assert rejected.status_code == 422
    run_id = client.post("/v1/assistant/runs", headers=auth, json=body).json()["id"]
    assistant_routes.execute(run_id)
    output = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert output["status"] == "completed", output
    with db_session.session_scope() as session:
        job = session.get(ExportJob, output["result"]["export"]["id"])
        assert job.version_id == deck["version_id"]
        assert job.options_json == {"slideIds": [sid], "locale": "en"}


@pytest.mark.parametrize("refusal", ["", "None"])
def test_cleanup_uses_deterministic_fixes_without_model_calls(deck, monkeypatch, refusal):
    from deckastra_agents.budgets import RunBudget
    from deckastra_agents.contracts import AuthorPlan
    from deckastra_agents.router import ModelError
    document = copy.deepcopy(deck["document"])
    document["slides"][0]["elements"][0]["transform"]["x"] = -25
    calls = []
    def unchanged(*args, **kwargs):
        calls.append(kwargs["user"])
        return AuthorPlan(summary="No changes", operations=[], refusal=refusal)
    monkeypatch.setattr(assistant_tasks, "ask_model", unchanged)
    snapshot = {"document": document, "images": [], "assets": [], "sources": [], "vision": []}
    result = assistant_tasks.compute({**payload(deck), "instruction": "Fix layout findings"}, snapshot, None, RunBudget(), lambda event: None)
    assert result["operations"]
    assert result["provider"] == "engine"
    assert not calls


def test_scope_comparison_rejects_wholesale_outside_edits(deck):
    document = deck["document"]
    candidate = copy.deepcopy(document)
    candidate["slides"][1]["name"] = "Outside"
    assert assistant_tasks.scope_errors(document, candidate, {"kind": "slide", "slide_ids": [document["slides"][0]["id"]], "element_ids": []}, "edit")


def test_cleanup_qualification_does_not_enable_other_job_contracts(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from deckastra_agents.router import ModelUnavailable
    class Configured:
        def route(self, request): return "vertex"
        def vertex_factory(self, stage):
            if stage not in {"cleanup", "narration", "image"}:
                raise ModelUnavailable(f"No qualified Vertex model configured for {stage}.")
            return SimpleNamespace(model="qualified-model", estimate_reservation=lambda request: .1)
    monkeypatch.setenv("DECKASTRA_ASSISTANT_MODE", "vertex")
    monkeypatch.setenv("DECKASTRA_ASSISTANT_MAX_COST_USD", "5")
    monkeypatch.setenv("DECKASTRA_ASSISTANT_COST_LEDGER", str(tmp_path / "ledger.sqlite"))
    monkeypatch.setattr(assistant_routes, "configured_client", lambda **kwargs: Configured())
    tasks = assistant_routes.capabilities()["tasks"]
    assert tasks["tidy"]["available"] and tasks["narration"]["available"]
    assert not tasks["organise"]["available"] and not tasks["consistency"]["available"]


def test_translation_scope_accepts_new_overlay_and_preserves_source(deck):
    before = deck["document"]; after = copy.deepcopy(before)
    sid = before["slides"][0]["id"]
    scope = {"kind": "slide", "slide_ids": [sid], "element_ids": []}
    after["locales"] = {"hi": {"locale": "hi", "status": "draft", "entries": {f"/slides/id:{sid}/name": {"value": "शीर्षक", "origin": "machine", "sourceHash": "fixture", "reviewStatus": "draft"}}}}
    assert not assistant_tasks.scope_errors(before, after, scope, "translation", "hi")
    after["slides"][0]["name"] = "Source changed"
    assert assistant_tasks.scope_errors(before, after, scope, "translation", "hi")


def test_narration_scope_rejects_changes_to_slide_text(deck):
    before = deck["document"]; after = copy.deepcopy(before)
    scope = {"kind": "deck", "slide_ids": [], "element_ids": []}
    after["slides"][0]["narration"] = {"cues": []}
    assert not assistant_tasks.scope_errors(before, after, scope, "narration")
    after["slides"][0]["name"] = "Unrequested heading"
    assert assistant_tasks.scope_errors(before, after, scope, "narration")
    before["slides"][0]["narration"] = {"cues": [{"id": "nar_existing", "step": 1, "text": "Original"}]}
    after = copy.deepcopy(before)
    after["slides"][0]["narration"]["cues"][0]["text"] = "Shorter script"
    assert not assistant_tasks.scope_errors(before, after, scope, "narration")
    after["slides"][0]["narration"]["cues"][0]["step"] = 0
    assert assistant_tasks.scope_errors(before, after, scope, "narration")


def test_locale_preview_has_same_fallback_before_first_translation():
    from pathlib import Path
    from deckastra_api import assistant_design, translation, locales
    from deckastra_api.patch import apply_patch
    document = json.loads((Path(__file__).resolve().parents[3] / "packages/presentation-schema/fixtures/technical-deck.mydeck.json").read_text(encoding="utf-8"))
    slide_id = document["slides"][0]["id"]
    slots = [slot for slot in locales.locale_slots(document) if slot.slide_id == slide_id]
    class ShortTranslator:
        name, origin = "test", "machine"
        def translate(self, items, **kwargs):
            return {item.id: "नमस्ते" for item in items}
    plan = translation.plan_translation(document, "hi", slots, ShortTranslator())
    after, _ = apply_patch(document, plan.operations)
    assert not assistant_design.regressions(assistant_design.check(document, locale="hi"), assistant_design.check(after, locale="hi"))


def test_saved_candidate_is_revalidated_at_the_write_boundary(client, auth, deck, monkeypatch):
    body = payload(deck)
    body["scope"] = {"kind": "slide", "slide_ids": [deck["document"]["slides"][0]["id"]], "element_ids": []}
    run_id = client.post("/v1/assistant/runs", headers=auth, json=body).json()["id"]
    monkeypatch.setattr(assistant_routes, "model_client", lambda emit: object())
    outside = deck["document"]["slides"][1]["id"]
    monkeypatch.setattr(assistant_tasks, "compute", lambda *args: {"operations": [{"op": "add", "path": f"/slides/id:{outside}/name", "value": "Unauthorized change"}]})
    assistant_routes.execute(run_id)
    result = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert result["status"] == "failed" and "Out-of-scope" in result["error"]
    with db_session.session_scope() as session:
        from deckastra_api import store
        assert store.load_presentation(session, deck["presentation_id"]).version_id == deck["version_id"]


def test_resume_checkpoint_avoids_repeating_computation(client, auth, deck, monkeypatch):
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]
    with db_session.session_scope() as session:
        row = session.get(AssistantRun, run_id); row.status = "interrupted"; row.checkpoint_json = {"operations": [], "warnings": ["Saved result"]}
    assert client.post(f"/v1/assistant/runs/{run_id}/resume", headers=auth).status_code == 202
    monkeypatch.setattr(assistant_tasks, "compute", lambda *args: pytest.fail("Checkpoint must not repeat inference"))
    assistant_routes.execute(run_id)
    assert client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()["result"]["warnings"] == ["Saved result"]


def test_completed_model_response_is_replayed_from_checkpoint(client, auth, deck):
    from deckastra_agents.router import ModelRequest, ModelResponse
    from deckastra_agents.budgets import RunBudget
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]
    with db_session.session_scope() as session:
        row = session.get(AssistantRun, run_id); row.status = "running"; row.owner_id = assistant_routes._owner
    class Inner:
        calls = 0
        def complete(self, request, budget):
            self.calls += 1
            return ModelResponse(text='{"saved":true}', model="test")
    inner = Inner(); checkpointed = assistant_routes.CheckpointClient(inner, run_id)
    request = ModelRequest("structured", "", [{"role": "user", "content": "Same request"}])
    assert checkpointed.complete(request, RunBudget()).text == '{"saved":true}'
    assert checkpointed.complete(request, RunBudget()).text == '{"saved":true}'
    assert inner.calls == 1


def test_cancellation_during_compute_prevents_writes(client, auth, deck, monkeypatch):
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]
    monkeypatch.setattr(assistant_routes, "model_client", lambda emit: object())
    def compute(*args):
        with db_session.session_scope() as session:
            session.get(AssistantRun, run_id).cancel_requested = True
        return {"operations": [{"op": "replace", "path": "/metadata/title", "value": "Must not apply"}]}
    monkeypatch.setattr(assistant_tasks, "compute", compute)
    assistant_routes.execute(run_id)
    result = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert result["status"] == "cancelled" and result["result"] is None


def test_asset_fingerprints_metadata_conflict_and_revert(client, auth, deck):
    image = Image.new("RGB", (16, 16), "red"); output = io.BytesIO(); image.save(output, "PNG")
    sha, dhash = fingerprints(output.getvalue(), "image/png")
    assert len(sha) == 64 and len(dhash) == 16
    from deckastra_api.db.models import Presentation, Project
    with db_session.session_scope() as session:
        presentation = session.get(Presentation, deck["presentation_id"]); project = session.get(Project, presentation.project_id)
        asset = Asset(id=new_id("ast"), workspace_id=project.workspace_id, created_by=auth["Authorization"].split()[1].split(".")[0], kind="image", storage_key="test", filename="Old", content_type="image/png", bytes=10, sha256=sha, dhash64=dhash)
        session.add(asset); session.flush(); asset_id = asset.id
    response = client.patch(f"/v1/assets/{asset_id}", headers=auth, json={"expected_metadata_version": 0, "tags": ["chart"], "description": "Quarterly chart"})
    assert response.status_code == 200, response.text
    assert client.patch(f"/v1/assets/{asset_id}", headers=auth, json={"expected_metadata_version": 0, "tags": []}).status_code == 409
    reverted = client.post(f"/v1/assets/{asset_id}/changes/{response.json()['change_id']}/revert", headers=auth)
    assert reverted.status_code == 200, reverted.text
    assert reverted.json()["tags"] == []


def test_generated_media_is_registered_and_checkpointed(client, auth, deck, monkeypatch):
    import base64
    body = {**payload(deck), "task": "image", "instruction": "A red square"}
    run_id = client.post("/v1/assistant/runs", headers=auth, json=body).json()["id"]
    monkeypatch.setattr(assistant_routes, "model_client", lambda emit: object())
    output = io.BytesIO(); Image.new("RGB", (20, 20), "red").save(output, "PNG")
    monkeypatch.setattr(assistant_tasks, "compute", lambda *args: {"media": [{"base64": base64.b64encode(output.getvalue()).decode(), "kind": "image", "extension": "png", "content_type": "image/png", "width": 20, "height": 20, "provider": "fixture"}]})
    puts = []
    monkeypatch.setattr(assistant_routes.object_storage, "put", lambda key, data, mime: puts.append((key, data, mime)))
    assistant_routes.execute(run_id)
    result = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert result["status"] == "completed", result
    assert len(puts) == 1 and len(result["result"]["assets"]) == 1
    assert result["result"]["status"] == "pending"
    assert result["result"]["transaction_id"]
    with db_session.session_scope() as session:
        from deckastra_api.db.models import TransactionRow
        proposal = session.get(TransactionRow, result["result"]["transaction_id"])
        placed = [op["value"] for op in proposal.operations_json if op["path"].endswith("/elements/-")]
        assert len(placed) == 1 and placed[0]["type"] == "image" and placed[0]["altText"]
        media = session.get(AssistantRun, run_id).checkpoint_json["computed"]["media"][0]
        assert "base64" not in media and media["size_bytes"] == len(output.getvalue())


def test_speech_clip_cache_reuses_completed_calls(monkeypatch):
    from deckastra_agents.budgets import RunBudget
    from deckastra_api import speech
    document = json.loads((Path(__file__).resolve().parents[3] / "packages/presentation-schema/fixtures/multilingual-narrated.mydeck.json").read_text(encoding="utf-8"))
    for slide in document["slides"]:
        for cue in slide.get("narration", {}).get("cues", []): cue.pop("takes", None)
    monkeypatch.setenv("DECKASTRA_SPEECH", "stub")
    calls = []
    monkeypatch.setattr(speech, "synthesize", lambda script, **kwargs: (calls.append(script), speech.Synthesis(b"fixture", "audio/mpeg", "mp3", 1000, "fixture", None))[1])
    cache = {}
    snapshot = {"document": document, "speech_cached": cache.get, "speech_save": lambda key, media, operation: cache.update({key: media})}
    request = {"task": "speech", "scope": {"kind": "deck"}, "locale": "en", "voice": "default"}
    first = assistant_tasks.compute(request, snapshot, None, RunBudget(), lambda e: None)
    count = len(calls)
    second = assistant_tasks.compute(request, snapshot, None, RunBudget(), lambda e: None)
    assert count > 0 and len(calls) == count and first == second


# ---- Error messages people read (2026-10-04 recheck: one vague sentence for every failure)

REPAIR_PROMPT = "Your response failed the output schema. Return corrected JSON."
MODEL_TEXT = "SECRET deck text the model echoed"


def _failure_cases():
    import httpx, json as _json
    from deckastra_agents.budgets import BudgetExceeded, RunCancelled
    from deckastra_agents.nodes._common import NodeFailure
    from deckastra_agents.router import ContextTooLarge, ModelError, ModelUnavailable
    from fastapi import HTTPException
    def node(cause, message=REPAIR_PROMPT):
        failure = NodeFailure("cleanup", "model_failure", message + " " + MODEL_TEXT, fallback="x")
        failure.__cause__ = cause
        return failure
    def chained(outer, inner):
        outer.__cause__ = inner
        return outer
    timeout = chained(ModelError("Gemma did not answer within 4s. On this machine the model may be too large"), httpx.ReadTimeout("read"))
    return [
        ("local timeout", node(timeout), ["did not answer before the job's time limit", "Try again"], ["4s", "too large"]),
        ("vertex timeout", chained(ModelError("Vertex request interrupted; uncertain usage remains reserved"), httpx.ReadTimeout("read")), ["time limit"], ["Vertex request interrupted"]),
        ("job time limit", BudgetExceeded("time", 180, 181.4), ["180-second time limit", "fewer slides"], []),
        ("token limit", BudgetExceeded("token", 60000, 61000), ["token allowance"], []),
        ("cost ceiling", BudgetExceeded("total assistant cost", 5, 5.0748), ["US$5.0748", "US$5.0000", "raise the ceiling"], ["(5 of 5)", "is kept"]),
        ("context", node(ContextTooLarge("Gemma needs 16403 prompt tokens. Measure a larger context before qualifying")), ["too large for the model to read at once", "fewer slides"], ["16403", "qualifying"]),
        ("not installed", ModelUnavailable("Install the verified Gemma pack."), ["Install the verified Gemma pack.", "not changed"], []),
        ("format", node(_json.JSONDecodeError("Expecting value", "x", 0)), ["not in the required format"], []),
        ("refusal", node(None, "The model declined this request (I will not)."), ["declined this request", "rewording"], ["I will not"]),
        ("provider error", node(ModelError("The local model server answered 500: " + MODEL_TEXT)), ["model service returned an error"], ["500"]),
        ("rejected", assistant_tasks.AssistantFailure("rejected", assistant_tasks.rejection_reasons(["Out-of-scope slide: sld_ABC", "Existing source attribution and citation references must be preserved."])), ["outside the selection", "source attribution", "select less"], ["sld_ABC"]),
        ("all format", assistant_tasks.AssistantFailure("format"), ["not in the required format, even after a retry"], []),
        ("person-facing", assistant_tasks.UserFacingError("Choose a smaller translation scope: at most 100 text slots per run."), ["at most 100 text slots"], []),
        ("deck changed", HTTPException(409, "The deck changed before the result could be proposed."), ["deck changed"], []),
        ("cancelled", RunCancelled("internal"), ["cancelled", "not changed"], ["internal"]),
        ("unexpected", KeyError(MODEL_TEXT), ["Something unexpected", "bug report"], []),
    ]


@pytest.mark.parametrize("label,exc,present,absent", _failure_cases(), ids=[case[0] for case in _failure_cases()])
def test_failures_explain_what_happened_without_model_text(label, exc, present, absent):
    message = assistant_routes.public_error(exc)
    for text in present:
        assert text in message, (label, message)
    for text in [*absent, REPAIR_PROMPT, "Return corrected", MODEL_TEXT]:
        assert text not in message, (label, message)


def test_each_kind_of_failure_reads_differently():
    messages = [assistant_routes.public_error(case[1]) for case in _failure_cases()]
    # local and Vertex timeouts share a sentence on purpose; everything else differs
    assert len(set(messages)) == len(messages) - 1


def test_design_check_timeout_is_not_reported_as_misconfiguration(monkeypatch):
    import subprocess
    from fastapi import HTTPException
    from deckastra_api import assistant_design
    def slow(*args, **kwargs):
        raise subprocess.TimeoutExpired("node", 20)
    monkeypatch.setattr(assistant_design.subprocess, "run", slow)
    with pytest.raises(HTTPException) as failed:
        assistant_design.check({"slides": []})
    assert "20 seconds" in failed.value.detail and "Configure" not in failed.value.detail


def test_slides_are_skipped_by_failure_type_and_timeouts_stop_the_job(monkeypatch):
    from deckastra_agents.budgets import RunBudget
    from deckastra_agents.router import ModelError
    document, ids = advanced_fixture()
    scope = {"kind": "slide", "slide_ids": [ids["faults"], ids["data"]], "element_ids": []}
    snapshot = {"document": document, "vision": []}
    def per_slide(request, snapshot, client, budget, emit):
        if request["scope"]["slide_ids"] == [ids["faults"]]:
            raise assistant_tasks.AssistantFailure("rejected", ["it changed something outside the selection"])
        return {"operations": [{"op": "replace", "path": f"/slides/id:{ids['data']}/name", "value": "Revenue"}]}
    monkeypatch.setattr(assistant_tasks, "_compute", per_slide)
    done = assistant_tasks.compute({"task": "edit", "scope": scope}, snapshot, None, RunBudget(), lambda e: None)
    assert len(done["operations"]) == 1
    assert "Slide 1 was left unchanged. The model's change was not used because it changed something outside the selection." in done["warnings"]

    def timed_out(*args):
        raise ModelError("did not answer within 3s")
    monkeypatch.setattr(assistant_tasks, "_compute", timed_out)
    with pytest.raises(ModelError) as stopped:
        assistant_tasks.compute({"task": "edit", "scope": scope}, snapshot, None, RunBudget(), lambda e: None)
    assert not isinstance(stopped.value, assistant_tasks.AssistantFailure)

    def unusable(*args):
        raise assistant_tasks.AssistantFailure("format")
    monkeypatch.setattr(assistant_tasks, "_compute", unusable)
    with pytest.raises(assistant_tasks.AssistantFailure) as nothing:
        assistant_tasks.compute({"task": "edit", "scope": scope}, snapshot, None, RunBudget(), lambda e: None)
    assert nothing.value.kind == "format"


def test_a_rejected_model_patch_names_the_reason():
    """Real validation, scripted model: a patch touching another slide is refused
    on both attempts and the person is told it went outside the selection."""
    import json as _json
    from deckastra_agents.budgets import RunBudget
    from deckastra_agents.router import ModelResponse
    document, ids = advanced_fixture()

    class OutOfScope:
        local_only, supports_escalation = True, False

        def complete(self, request, budget):
            plan = {"summary": "Renamed", "refusal": "", "operations": [{"op": "replace", "path": f"/slides/id:{ids['data']}/name", "value_json": "\"Elsewhere\""}]}
            return ModelResponse(text=_json.dumps(plan), model="test")

    request = {"task": "edit", "instruction": "Rename this slide", "scope": {"kind": "slide", "slide_ids": [ids["faults"]], "element_ids": []}, "locale": "en"}
    snapshot = {"document": document, "images": [], "assets": [], "vision": []}
    with pytest.raises(assistant_tasks.AssistantFailure) as rejected:
        assistant_tasks.compute(request, snapshot, OutOfScope(), RunBudget(), lambda e: None)
    message = assistant_routes.public_error(rejected.value)
    assert "outside the selection" in message and "Elsewhere" not in message


def test_failed_run_shows_plain_reason_and_keeps_the_diagnostic(client, auth, deck, monkeypatch):
    import json as _json
    from deckastra_agents.nodes._common import NodeFailure
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]
    monkeypatch.setattr(assistant_routes, "model_client", lambda emit: object())

    def invalid(*args):
        failure = NodeFailure("cleanup", "model_failure", REPAIR_PROMPT + " " + MODEL_TEXT, fallback="x")
        failure.__cause__ = _json.JSONDecodeError("Expecting value", "x", 0)
        raise failure
    monkeypatch.setattr(assistant_tasks, "compute", invalid)
    assistant_routes.execute(run_id)
    detail = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert detail["status"] == "failed"
    assert "not in the required format" in detail["error"] and MODEL_TEXT not in detail["error"]
    events = client.get(f"/v1/assistant/runs/{run_id}/events", headers=auth).json()["events"]
    assert MODEL_TEXT not in _json.dumps(events)
    with db_session.session_scope() as session:
        assert MODEL_TEXT in session.get(AssistantRun, run_id).checkpoint_json["failure_diagnostic"]["message"]


# ---- Job time (2026-10-04 recheck: single-slide jobs timed out at 180 s)

@pytest.mark.parametrize("mode,task,slides,expected", [
    ("vertex", "alt_text", 3, (540, 180)),       # room for a local repair attempt
    ("vertex", "consistency", 21, (1800, 180)),  # local ceiling
    ("vertex", "edit", 1, (180, 180)),
    ("vertex", "edit", 21, (1800, 180)),
    ("local", "tidy", 1, (180, 180)),        # engine tasks call no model
    ("local", "motion", 4, (720, 180)),
    ("local", "generate", 5, (900, 900)),
])
def test_job_time_follows_where_the_model_runs(monkeypatch, mode, task, slides, expected):
    monkeypatch.setenv("DECKASTRA_ASSISTANT_MODE", mode)
    monkeypatch.delenv(assistant_routes.SLIDE_SECONDS_ENV, raising=False)
    assert assistant_routes.job_seconds(task, slides) == expected



def test_slide_allowance_can_be_set_and_bad_values_are_ignored(monkeypatch):
    monkeypatch.setenv("DECKASTRA_ASSISTANT_MODE", "local")
    monkeypatch.setenv(assistant_routes.SLIDE_SECONDS_ENV, "600")
    assert assistant_routes.job_seconds("edit", 2) == (1200, 600)
    monkeypatch.setenv(assistant_routes.SLIDE_SECONDS_ENV, "-5")
    assert assistant_routes.job_seconds("edit", 1) == (180, 180)


def test_running_out_of_time_keeps_the_slides_already_done(monkeypatch):
    from deckastra_agents.budgets import BudgetExceeded, RunBudget
    document, ids = advanced_fixture()
    slides = [ids["faults"], ids["data"], ids["wall"]]
    scope = {"kind": "slide", "slide_ids": slides, "element_ids": []}
    def per_slide(request, snapshot, client, budget, emit):
        sid = request["scope"]["slide_ids"][0]
        if sid == ids["data"]:
            raise BudgetExceeded("time", 360, 361)
        return {"operations": [{"op": "replace", "path": f"/slides/id:{sid}/name", "value": "Done"}]}
    monkeypatch.setattr(assistant_tasks, "_compute", per_slide)
    done = assistant_tasks.compute({"task": "edit", "scope": scope}, {"document": document, "vision": [], "slide_seconds": 1}, None, RunBudget(max_wall_clock_seconds=600), lambda e: None)
    assert [op["path"] for op in done["operations"]] == [f"/slides/id:{ids['faults']}/name"]
    assert any("slides 2-3 were not processed" in w for w in done["warnings"])


def test_a_slide_that_cannot_fit_in_the_remaining_time_is_not_started(monkeypatch):
    from deckastra_agents.budgets import RunBudget
    document, ids = advanced_fixture()
    scope = {"kind": "slide", "slide_ids": [ids["faults"], ids["data"]], "element_ids": []}
    started = []
    def per_slide(request, snapshot, client, budget, emit):
        started.append(request["scope"]["slide_ids"][0])
        budget.started_at -= 500  # this slide used most of the job's time
        return {"operations": [{"op": "replace", "path": f"/slides/id:{started[-1]}/name", "value": "Done"}]}
    monkeypatch.setattr(assistant_tasks, "_compute", per_slide)
    done = assistant_tasks.compute({"task": "edit", "scope": scope}, {"document": document, "vision": [], "slide_seconds": 360}, None, RunBudget(max_wall_clock_seconds=720), lambda e: None)
    assert started == [ids["faults"]]
    assert any("slides 2-2 were not processed" in w for w in done["warnings"])


def test_time_running_out_with_nothing_done_or_money_uncertain_still_stops(monkeypatch):
    from deckastra_agents.budgets import BudgetExceeded, RunBudget
    document, ids = advanced_fixture()
    scope = {"kind": "slide", "slide_ids": [ids["faults"], ids["data"]], "element_ids": []}
    def first_fails(*args):
        raise BudgetExceeded("time", 360, 361)
    monkeypatch.setattr(assistant_tasks, "_compute", first_fails)
    with pytest.raises(BudgetExceeded):
        assistant_tasks.compute({"task": "edit", "scope": scope}, {"document": document, "vision": [], "slide_seconds": 1}, None, RunBudget(max_wall_clock_seconds=600), lambda e: None)
    calls = []
    def second_fails(request, snapshot, client, budget, emit):
        calls.append(1)
        if len(calls) == 2:
            budget.reserved_cost_usd = 0.05  # a paid call whose outcome is unknown
            raise BudgetExceeded("time", 360, 361)
        return {"operations": [{"op": "replace", "path": f"/slides/id:{ids['faults']}/name", "value": "Done"}]}
    monkeypatch.setattr(assistant_tasks, "_compute", second_fails)
    with pytest.raises(BudgetExceeded):
        assistant_tasks.compute({"task": "edit", "scope": scope}, {"document": document, "vision": [], "slide_seconds": 1}, None, RunBudget(max_wall_clock_seconds=600), lambda e: None)


# ---- Status reads never write (2026-10-04 recheck: polls failed "database is locked")

def _hold_write_lock():
    """Another writer (a worker mid-transaction) holding SQLite's single write lock."""
    import os, sqlite3
    path = os.environ["DATABASE_URL"].removeprefix("sqlite:///")
    holder = sqlite3.connect(path, timeout=0, isolation_level=None)
    holder.execute("BEGIN IMMEDIATE")
    return holder


def _expire_lease(run_id, *, naive=False):
    from datetime import timedelta
    with db_session.session_scope() as session:
        row = session.get(AssistantRun, run_id)
        lease = assistant_routes.now() - timedelta(seconds=60)
        row.status, row.lease_until = "running", lease.replace(tzinfo=None) if naive else lease


def test_status_poll_answers_while_another_writer_holds_the_lock(client, auth, deck):
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]
    _expire_lease(run_id)
    holder = _hold_write_lock()
    try:
        single = client.get(f"/v1/assistant/runs/{run_id}", headers=auth)
        listed = client.get("/v1/assistant/runs", params={"presentation_id": deck["presentation_id"]}, headers=auth)
        progress = client.get(f"/v1/assistant/runs/{run_id}/events", headers=auth)
    finally:
        holder.execute("ROLLBACK")
        holder.close()
    assert single.status_code == 200, single.text
    assert single.json()["status"] == "interrupted" and "Resume" in single.json()["error"]
    assert listed.status_code == 200 and listed.json()["runs"][0]["status"] == "interrupted"
    assert progress.status_code == 200


def test_status_poll_reports_interruption_without_storing_it(client, auth, deck):
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]
    _expire_lease(run_id, naive=True)  # SQLite hands timestamps back without a zone
    assert client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()["status"] == "interrupted"
    with db_session.session_scope() as session:
        assert session.get(AssistantRun, run_id).status == "running"  # the read wrote nothing
        assistant_routes.recover(session)  # the dispatcher's job
    with db_session.session_scope() as session:
        row = session.get(AssistantRun, run_id)
        assert row.status == "interrupted" and row.error == assistant_routes.INTERRUPTED


def test_a_live_lease_still_reads_as_running(client, auth, deck):
    from datetime import timedelta
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]
    with db_session.session_scope() as session:
        row = session.get(AssistantRun, run_id)
        row.status, row.lease_until = "running", assistant_routes.now() + timedelta(seconds=30)
    assert client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()["status"] == "running"


# ---- Organise keeps good descriptions (2026-10-04 rerun: one "swoosh" tag discarded the batch)

GEMMA_ORGANISE_ANSWER = {"assets": [
    {"asset_id": "ast_chart", "tags": ["regional adoption", "survey results", "North", "percentage chart"],
     "description": "A bar chart showing regional adoption percentages for FY26 based on a survey of 1,204 people. The regions are North (42%), South (67%), East (23%), and West (88%)."},
    {"asset_id": "ast_swoosh", "tags": ["swoosh", "graphic element"], "description": "A graphic element, likely a swoosh shape."},
]}


def _organise(answer):
    import json as _json
    from deckastra_agents.budgets import RunBudget
    from deckastra_agents.router import ModelResponse

    class Scripted:
        local_only, supports_escalation = True, False

        def complete(self, request, budget):
            return ModelResponse(text=_json.dumps(answer), model="test")

    assets = [{"id": "ast_chart", "filename": "adoption.png", "metadata_version": 0}, {"id": "ast_swoosh", "filename": "swoosh.png", "metadata_version": 0}]
    snapshot = {"document": {"slides": []}, "assets": assets, "vision": [{"asset_id": a["id"], "base64": "fixture-pixels"} for a in assets]}
    return assistant_tasks.compute({"task": "organise", "scope": {"kind": "deck", "slide_ids": [], "element_ids": []}}, snapshot, Scripted(), RunBudget(), lambda e: None)


def test_a_filename_tag_is_dropped_not_the_batch():
    result = _organise(GEMMA_ORGANISE_ANSWER)
    by_id = {item["asset_id"]: item for item in result["metadata"]}
    assert by_id["ast_chart"] == GEMMA_ORGANISE_ANSWER["assets"][0]  # the good description survives intact
    assert by_id["ast_swoosh"]["tags"] == ["graphic element"]
    assert any("swoosh.png" in w for w in result["warnings"])


def test_an_asset_with_only_filename_tags_is_left_alone():
    answer = {"assets": [GEMMA_ORGANISE_ANSWER["assets"][0], {"asset_id": "ast_swoosh", "tags": ["Swoosh", "swoosh.png"], "description": "swoosh"}]}
    result = _organise(answer)
    assert [item["asset_id"] for item in result["metadata"]] == ["ast_chart"]
    assert any("Left swoosh.png unchanged" in w for w in result["warnings"])


def test_nothing_but_filename_tags_is_still_refused():
    answer = {"assets": [{"asset_id": "ast_chart", "tags": ["adoption"], "description": "x"}, {"asset_id": "ast_swoosh", "tags": ["SWOOSH"], "description": "y"}]}
    with pytest.raises(assistant_tasks.AssistantFailure) as refused:
        _organise(answer)
    assert refused.value.reasons == ["its tags only repeated file names"]


@pytest.mark.parametrize("tag,filename,matches", [
    ("swoosh", "swoosh.png", True),
    ("Adoption Small", "adoption-small.png", True),
    ("adoption_small", "adoption-small.png", True),
    ("adoption-small.png", "adoption-small.png", True),
    ("regional adoption", "adoption.png", False),
    ("chart", "", False),
])
def test_filename_tags_are_recognised_through_case_and_separators(tag, filename, matches):
    assert assistant_tasks.filename_tag(tag, filename) is matches


# ---- Generation gets checked arithmetic (2026-10-04 rerun: Q1-to-Q4 growth called "YoY")

def _revenue_csv():
    folder = Path(__file__).resolve().parents[3] / "docs/integrations/benchmarks/advanced-deck/advanced"
    return {"id": "revenue", "title": "revenue.csv", "text": (folder / "revenue.csv").read_text(encoding="utf-8")}


def test_generation_receives_the_checked_growth_with_its_label(monkeypatch):
    from types import SimpleNamespace
    from deckastra_agents import runner
    from deckastra_agents.budgets import RunBudget
    document, _ = advanced_fixture()
    seen = {}
    def generated(run, state):
        seen["sources"] = state["source_inputs"]
        return SimpleNamespace(status="completed", state={}, warnings=[], operations=[])
    monkeypatch.setattr(runner, "run_generation", generated)
    snapshot = {"document": document, "images": [], "assets": [], "sources": [_revenue_csv()], "run_id": "fixture", "user_id": "user", "project_id": "project"}
    with pytest.raises(assistant_tasks.UserFacingError):  # the fake produced no slides; the inputs are what matter
        assistant_tasks.compute({"task": "generate", "scope": {"kind": "deck", "slide_ids": [], "element_ids": []}, "instruction": "Board update", "slide_count": 3, "presentation_id": document["id"]}, snapshot, object(), RunBudget(), lambda e: None)
    calculation = next(source for source in seen["sources"] if source["id"] == "csv-calculations")
    assert seen["sources"][0]["id"] == "revenue"  # the upload is still there, first
    assert "India · revenue_inr_crore: Q1 412.5 → Q4 498.9" in calculation["text"]
    assert "growth from Q1 to Q4 was 20.95%" in calculation["text"] and "GCC" in calculation["text"]
    assert "not year-over-year" in calculation["text"] and 'never "YoY"' in calculation["text"]
    assert "9,999" not in calculation["text"]  # the CSV's planted note is not a record


def test_generation_without_numeric_csv_adds_no_calculation(monkeypatch):
    from types import SimpleNamespace
    from deckastra_agents import runner
    from deckastra_agents.budgets import RunBudget
    document, _ = advanced_fixture()
    seen = {}
    monkeypatch.setattr(runner, "run_generation", lambda run, state: seen.setdefault("sources", state["source_inputs"]) and SimpleNamespace(status="completed", state={}, warnings=[], operations=[]))
    snapshot = {"document": document, "images": [], "assets": [], "sources": [{"id": "brief", "title": "brief.txt", "text": "Plain notes"}], "run_id": "fixture", "user_id": "user", "project_id": "project"}
    with pytest.raises(assistant_tasks.UserFacingError):
        assistant_tasks.compute({"task": "generate", "scope": {"kind": "deck", "slide_ids": [], "element_ids": []}, "instruction": "x", "slide_count": 1, "presentation_id": document["id"]}, snapshot, object(), RunBudget(), lambda e: None)
    assert [source["id"] for source in seen["sources"]] == ["brief"]


def test_research_and_generation_describe_growth_the_same_way():
    from deckastra_api.research_calculations import calculation_source, csv_growth, describe
    calculations = csv_growth([_revenue_csv()])
    assert describe(calculations) in calculation_source(calculations)["text"]
