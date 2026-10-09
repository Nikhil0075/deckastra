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
    result = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "technical-architecture", "title": "A presentation about databases"})
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


@pytest.mark.parametrize("task", ["generate", "edit", "alt_text", "consistency", "narration", "organise", "research", "critique"])
def test_removed_model_jobs_are_not_part_of_the_assistant_api(client, auth, deck, task):
    response = client.post("/v1/assistant/runs", headers=auth, json={**payload(deck), "task": task})
    assert response.status_code == 422


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


def test_advanced_cleanup_and_motion_reuse_engines_and_preserve_scope():
    from deckastra_agents.budgets import RunBudget
    from deckastra_api.patch import apply_patch
    from deckastra_api import assistant_design
    document, ids = advanced_fixture()
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


def test_motion_keeps_authored_animation_unless_asked_to_replace():
    """The 2026-10-04 recheck: re-planning replaced click reveals with entrances."""
    document, _ = advanced_fixture()
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


def test_cleanup_uses_deterministic_fixes_without_model_calls(deck):
    from deckastra_agents.budgets import RunBudget
    document = copy.deepcopy(deck["document"])
    document["slides"][0]["elements"][0]["transform"]["x"] = -25
    snapshot = {"document": document, "images": [], "assets": [], "sources": [], "vision": []}
    result = assistant_tasks.compute({**payload(deck), "instruction": "Fix layout findings"}, snapshot, None, RunBudget(), lambda event: None)
    assert result["operations"]
    assert result["provider"] == "engine"


def test_scope_comparison_rejects_wholesale_outside_edits(deck):
    document = deck["document"]
    candidate = copy.deepcopy(document)
    candidate["slides"][1]["name"] = "Outside"
    assert assistant_tasks.scope_errors(document, candidate, {"kind": "slide", "slide_ids": [document["slides"][0]["id"]], "element_ids": []}, "edit")


def test_capabilities_expose_only_engines_and_paid_media(monkeypatch, tmp_path):
    from types import SimpleNamespace
    monkeypatch.setenv("DECKASTRA_ASSISTANT_MAX_COST_USD", "5")
    monkeypatch.setenv("DECKASTRA_ASSISTANT_COST_LEDGER", str(tmp_path / "ledger.sqlite"))
    monkeypatch.setattr(assistant_routes, "configured_image_client", lambda **kwargs: SimpleNamespace(model="image-model", estimate_reservation=lambda request: .1))
    tasks = assistant_routes.capabilities()["tasks"]
    assert tasks["tidy"]["available"]
    assert set(tasks) == {"tidy", "motion", "image", "video", "speech", "export"}


def test_translation_scope_accepts_new_overlay_and_preserves_source(deck):
    before = deck["document"]; after = copy.deepcopy(before)
    sid = before["slides"][0]["id"]
    scope = {"kind": "slide", "slide_ids": [sid], "element_ids": []}
    after["locales"] = {"hi": {"locale": "hi", "status": "draft", "entries": {f"/slides/id:{sid}/name": {"value": "शीर्षक", "origin": "machine", "sourceHash": "fixture", "reviewStatus": "draft"}}}}
    assert not assistant_tasks.scope_errors(before, after, scope, "translation", "hi")
    after["slides"][0]["name"] = "Source changed"
    assert assistant_tasks.scope_errors(before, after, scope, "translation", "hi")


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
    request = ModelRequest("media", "", [{"role": "user", "content": "Same image"}], image_output=True)
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
    from types import SimpleNamespace
    from deckastra_api import media_quotes
    monkeypatch.setattr(media_quotes, "configured_image_client", lambda: SimpleNamespace(
        model="imagen-fixture", estimate_reservation=lambda request: .04))
    slide_id = deck["document"]["slides"][0]["id"]
    base = {**payload(deck), "task": "image", "instruction": "A red square",
            "scope": {"kind": "slide", "slide_ids": [slide_id], "element_ids": []}}
    quoted = client.post("/v1/media/quotes/image", headers=auth, json={
        "presentation_id": deck["presentation_id"], "expected_version_id": deck["version_id"],
        "slide_id": slide_id, "prompt": "A red square",
    })
    assert quoted.status_code == 200, quoted.text
    body = {**base, "image_quote_token": quoted.json()["quote_token"]}
    changed = client.post("/v1/assistant/runs", headers=auth, json={**body, "operation_key": "changed-image-quote", "instruction": "A blue square"})
    assert changed.status_code == 409
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


def test_quoted_video_becomes_bounded_assets_and_a_pending_proposal(client, auth, deck, monkeypatch):
    import base64
    from types import SimpleNamespace
    from deckastra_api import media_quotes

    monkeypatch.setattr(media_quotes, "configured_video_client", lambda: SimpleNamespace(
        model="veo-3.1-fast-generate-001", estimate_reservation=lambda duration: duration * .15))
    brief = "A calm blue product dashboard moving through a clean workflow"
    quoted = client.post("/v1/media/quotes/video", headers=auth, json={
        "presentation_id": deck["presentation_id"], "prompt": brief,
        "duration_seconds": 4, "aspect_ratio": "16:9", "generate_audio": False,
    })
    assert quoted.status_code == 200, quoted.text
    assert quoted.json()["credit_cost"] == 120

    body = {**payload(deck), "task": "video", "instruction": brief,
        "scope": {"kind": "slide", "slide_ids": [deck["document"]["slides"][0]["id"]], "element_ids": []},
        "video_duration_seconds": 4, "video_aspect_ratio": "16:9",
        "video_quote_token": quoted.json()["quote_token"]}
    created = client.post("/v1/assistant/runs", headers=auth, json=body)
    assert created.status_code == 202, created.text
    run_id = created.json()["id"]

    poster = io.BytesIO(); Image.new("RGB", (32, 18), "blue").save(poster, "PNG")
    clip = b"fixture-mp4"
    monkeypatch.setattr(assistant_tasks, "compute", lambda *args: {"media": [
        {"base64": base64.b64encode(clip).decode(), "kind": "video", "extension": "mp4", "content_type": "video/mp4", "width": 1280, "height": 720, "duration_ms": 4000, "provider": "fixture-veo"},
        {"base64": base64.b64encode(poster.getvalue()).decode(), "kind": "image", "extension": "png", "content_type": "image/png", "width": 1280, "height": 720, "provider": "poster-frame"},
    ]})
    monkeypatch.setattr(assistant_routes, "configured_video_client", lambda: object())
    monkeypatch.setattr(assistant_routes.object_storage, "put", lambda *args: None)
    assistant_routes.execute(run_id)

    result = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    if result["status"] != "completed":
        from deckastra_api.db.session import session_scope
        from deckastra_api.assistant_models import AssistantRun
        with session_scope() as diagnostic_session:
            diagnostic = diagnostic_session.get(AssistantRun, run_id).checkpoint_json
        raise AssertionError({"result": result, "checkpoint": diagnostic})
    assert [item["kind"] for item in result["result"]["assets"]] == ["video", "image"]
    assert result["result"]["status"] == "pending"
    with db_session.session_scope() as session:
        from deckastra_api.db.models import TransactionRow
        proposal = session.get(TransactionRow, result["result"]["transaction_id"])
        placed = [op["value"] for op in proposal.operations_json if op["path"].endswith("/elements/-")]
        assert len(placed) == 1
        assert placed[0]["type"] == "video" and placed[0]["posterAssetId"] and placed[0]["muted"] is True

    changed = client.post("/v1/assistant/runs", headers=auth, json={**body,
        "operation_key": "changed-video-quote", "instruction": brief + " changed"})
    assert changed.status_code == 409


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
    import httpx
    from deckastra_agents.budgets import BudgetExceeded, RunCancelled
    from deckastra_agents.router import ModelError, ModelUnavailable
    from fastapi import HTTPException
    def chained(outer, inner):
        outer.__cause__ = inner
        return outer
    return [
        ("media timeout", chained(ModelError("Vertex request interrupted; uncertain usage remains reserved"), httpx.ReadTimeout("read")), ["image service did not answer", "Try again"], ["Vertex request interrupted"]),
        ("job time limit", BudgetExceeded("time", 180, 181.4), ["180-second time limit", "fewer slides"], []),
        ("token limit", BudgetExceeded("token", 60000, 61000), ["token allowance"], []),
        ("cost ceiling", BudgetExceeded("total assistant cost", 5, 5.0748), ["US$5.0748", "US$5.0000", "raise the ceiling"], ["(5 of 5)", "is kept"]),
        ("not configured", ModelUnavailable("Configure DECKASTRA_VERTEX_IMAGE_MODEL before generating images."), ["Configure DECKASTRA_VERTEX_IMAGE_MODEL", "not changed"], []),
        ("provider error", ModelError("The image provider answered 500: " + MODEL_TEXT), ["image service returned an error"], ["500"]),
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
    assert len(set(messages)) == len(messages)


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


def test_failed_run_shows_plain_reason_and_keeps_the_diagnostic(client, auth, deck, monkeypatch):
    from deckastra_agents.router import ModelError
    run_id = client.post("/v1/assistant/runs", headers=auth, json=payload(deck)).json()["id"]

    def invalid(*args):
        raise ModelError(REPAIR_PROMPT + " " + MODEL_TEXT)
    monkeypatch.setattr(assistant_tasks, "compute", invalid)
    assistant_routes.execute(run_id)
    detail = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
    assert detail["status"] == "failed"
    assert "image service returned an error" in detail["error"] and MODEL_TEXT not in detail["error"]
    events = client.get(f"/v1/assistant/runs/{run_id}/events", headers=auth).json()["events"]
    assert MODEL_TEXT not in json.dumps(events)
    with db_session.session_scope() as session:
        assert MODEL_TEXT in session.get(AssistantRun, run_id).checkpoint_json["failure_diagnostic"]["message"]


# ---- Job time (2026-10-04 recheck: single-slide jobs timed out at 180 s)

@pytest.mark.parametrize("task,slides,expected", [
    ("tidy", 1, (180, 180)),
    ("motion", 4, (720, 180)),
])
def test_job_time_scales_with_slide_count(monkeypatch, task, slides, expected):
    monkeypatch.delenv(assistant_routes.SLIDE_SECONDS_ENV, raising=False)
    assert assistant_routes.job_seconds(task, slides) == expected



def test_slide_allowance_can_be_set_and_bad_values_are_ignored(monkeypatch):
    monkeypatch.setenv(assistant_routes.SLIDE_SECONDS_ENV, "600")
    assert assistant_routes.job_seconds("tidy", 2) == (1200, 600)
    monkeypatch.setenv(assistant_routes.SLIDE_SECONDS_ENV, "-5")
    assert assistant_routes.job_seconds("tidy", 1) == (180, 180)


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


# ---- Checked arithmetic (2026-10-04 rerun: Q1-to-Q4 growth called "YoY")

def _revenue_csv():
    folder = Path(__file__).resolve().parents[3] / "docs/integrations/benchmarks/advanced-deck/advanced"
    return {"id": "revenue", "title": "revenue.csv", "text": (folder / "revenue.csv").read_text(encoding="utf-8")}


def test_calculation_source_uses_the_checked_growth_description():
    from deckastra_api.research_calculations import calculation_source, csv_growth, describe
    calculations = csv_growth([_revenue_csv()])
    assert describe(calculations) in calculation_source(calculations)["text"]
