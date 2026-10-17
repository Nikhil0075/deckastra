"""Object motion and real loops for agents (release 8, 2026-10-17).

Asked for "subtle looping accents", an agent could only repeat a scale
entrance. These hold the new tools to the engine's own presets, to the line on
timing (loops and emphasis may be timed; entrances keep their computed
budget), and to the rule that a loop never goes on words or data.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import motion  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.patch import apply_patch  # noqa: E402
from deckastra_api.schema import validate_document  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]


def test_the_categories_are_the_engines():
    source = (ROOT / "packages/animation-engine/src/presets.ts").read_text(encoding="utf-8")
    engine: dict[str, set[str]] = {}
    for name, category in re.findall(r'simplePreset\("(\w+)", "(\w+)"', source):
        engine.setdefault(category, set()).add(name)
    for name in re.findall(r'(\w+): exitPreset\("', source):
        engine.setdefault("exit", set()).add(name)
    # shimmer is written out in full rather than through simplePreset.
    assert re.search(r'name: "shimmer",\s*category: "loop"', source)
    engine.setdefault("loop", set()).add("shimmer")
    assert set(motion.LOOP_PRESETS) == engine["loop"]
    assert set(motion.EMPHASIS_PRESETS) == engine["emphasis"]
    assert set(motion.EXIT_PRESETS) <= engine["exit"]


def _slide():
    return {
        "id": "sld_1",
        "elements": [
            {"id": "el_title", "type": "text", "semanticRole": "headline"},
            {"id": "el_photo", "type": "image", "transform": {"width": 800, "height": 600}},
            {"id": "el_dot", "type": "shape", "semanticRole": "decoration", "transform": {"width": 60, "height": 60}},
            {"id": "el_icon", "type": "icon", "transform": {"width": 80, "height": 80}},
            {"id": "el_chart", "type": "chart", "transform": {"width": 900, "height": 500}},
        ],
    }


def test_a_loop_is_a_real_loop_not_a_repeated_entrance():
    operations, warnings = motion.object_motion_operations(
        _slide(), element_ids=["el_dot"], roles=[], category="loop", preset="float", speed="slow")
    track = operations[-1]["value"]
    clip = track["clips"][0]
    assert track["trigger"] == {"type": "slideEnter"}
    assert (clip["preset"], clip["durationMs"], clip["repeat"], clip["restOffset"]) == ("float", 9000, -1, 0)
    assert warnings == []


def test_words_and_data_never_loop():
    operations, warnings = motion.object_motion_operations(
        _slide(), element_ids=["el_title", "el_dot"], roles=[], category="loop", preset="breathe")
    assert [op["value"]["targetId"] for op in operations if op["op"] == "add" and op["path"].endswith("/-")] == ["el_dot"]
    assert any("not given a loop" in warning for warning in warnings)
    with pytest.raises(motion.MotionPlanError, match="stay still"):
        motion.object_motion_operations(_slide(), element_ids=["el_chart"], roles=[], category="loop", preset="spin")


def test_an_entrance_keeps_its_computed_timing():
    with pytest.raises(motion.MotionPlanError, match="pacing word only"):
        motion.object_motion_operations(_slide(), element_ids=["el_title"], roles=[], category="entrance",
                                        preset="fade", duration_ms=5000)
    operations, _ = motion.object_motion_operations(
        _slide(), element_ids=[], roles=["headline"], category="entrance", preset="fade", pacing="tight")
    assert operations[-1]["value"]["clips"][0]["durationMs"] == motion.PACING["tight"]["durationMs"]


def test_timing_is_bounded_and_named_presets_only():
    with pytest.raises(motion.MotionPlanError, match="between 1500 and 12000"):
        motion.object_motion_operations(_slide(), element_ids=["el_dot"], roles=[], category="loop", preset="float", duration_ms=300)
    with pytest.raises(motion.MotionPlanError, match="is not a loop preset"):
        motion.object_motion_operations(_slide(), element_ids=["el_dot"], roles=[], category="loop", preset="scale")


def test_a_new_loop_replaces_the_old_one_on_that_object():
    slide = _slide()
    first, _ = motion.object_motion_operations(slide, element_ids=["el_dot"], roles=[], category="loop", preset="float")
    slide["animations"] = [op["value"] for op in first if op["path"].endswith("/-")]
    second, warnings = motion.object_motion_operations(slide, element_ids=["el_dot"], roles=[], category="loop", preset="breathe")
    assert second[0] == {"op": "remove", "path": f"/slides/id:sld_1/animations/id:{slide['animations'][0]['id']}"}
    assert any("Replaced 1" in warning for warning in warnings)


def test_ambient_motion_is_restrained():
    operations, warnings = motion.ambient_operations(_slide(), {"width": 1920, "height": 1080})
    looped = [op["value"] for op in operations if op["op"] == "add" and op["path"].endswith("/-")]
    assert [(track["targetId"], track["clips"][0]["preset"]) for track in looped] == [("el_photo", "kenBurns"), ("el_dot", "float")]
    assert all(track["clips"][0]["repeat"] == -1 for track in looped)
    # Asked again, a slide that already loops is left alone.
    slide = {**_slide(), "animations": looped}
    assert motion.ambient_operations(slide, {"width": 1920, "height": 1080})[0] == []


# ---------------------------------------------------------------- the routes


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'motion.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


def test_ambient_motion_on_a_real_deck_is_one_pending_valid_change(client):
    auth = {"Authorization": "Bearer " + client.post("/v1/dev/session", json={"email": "m@localhost"}).json()["token"]}
    deck = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "business-pitch", "title": "Loops"}).json()
    slide_ids = [slide["id"] for slide in deck["document"]["slides"]]
    head = client.get(f"/v1/presentations/{deck['presentation_id']}/head", headers=auth).json()["version_id"]
    answer = client.post(f"/v1/presentations/{deck['presentation_id']}/ambient-motion", headers=auth, json={
        "slide_ids": slide_ids, "expected_version_id": head, "client_label": "codex", "dry_run": True,
    })
    assert answer.status_code == 200, answer.text
    planned = answer.json()
    if planned["outcome"] == "none":
        pytest.skip("this template has no picture or small decoration to loop")
    document, _ = apply_patch(deck["document"], planned["operations"])
    assert validate_document(document) == []

    proposed = client.post(f"/v1/presentations/{deck['presentation_id']}/ambient-motion", headers=auth, json={
        "slide_ids": slide_ids, "expected_version_id": head, "client_label": "codex",
    })
    assert proposed.json()["outcome"] == "pending", proposed.json()


def test_an_agents_low_risk_change_still_waits(client):
    """Release 8: every agent change is a proposal until the person approves it."""
    auth = {"Authorization": "Bearer " + client.post("/v1/dev/session", json={"email": "w@localhost"}).json()["token"]}
    deck = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "business-pitch", "title": "Wait"}).json()
    head = client.get(f"/v1/presentations/{deck['presentation_id']}/head", headers=auth).json()["version_id"]
    answer = client.post(f"/v1/presentations/{deck['presentation_id']}/proposals", headers=auth, json={
        "operations": [{"op": "replace", "path": "/metadata/title", "value": "Retitled"}],
        "intent": "Retitle", "expected_version_id": head, "client_label": "codex",
    })
    assert answer.status_code == 200, answer.text
    assert answer.json()["outcome"] == "pending"
    assert client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth).json()["document"]["metadata"]["title"] == "Wait"
