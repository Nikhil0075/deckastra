"""Motion an agent can ask for: roles in, tracks out (milestone D2).

The division this tests is the product's, applied to time: a caller names
semantic roles, a preset and one word of pacing, and *code* turns that into
durations. Doc 04 §24.2's 2.5s entrance budget is only a budget because
something computes against it — a plan that could name milliseconds could
over-run it, and a model asked politely to respect it eventually will not.

So the interesting assertions are the ones about what a caller cannot do.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'motion.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


def session_for(client, email: str) -> dict[str, str]:
    response = client.post("/v1/dev/session", json={"email": email})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def auth(client):
    return session_for(client, "motion@localhost")


@pytest.fixture()
def deck(client, auth):
    generated = client.post(
        "/v1/decks/from-template", headers=auth, json={"template_id": "technical-architecture", "title": "A deck to animate"}
    )
    assert generated.status_code == 200, generated.text
    return generated.json()


def head_version(client, auth, presentation_id: str) -> str:
    return client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()["version_id"]


def animate(client, auth, deck, **body):
    presentation_id = deck["presentation_id"]
    payload = {
        "slide_id": deck["document"]["slides"][0]["id"],
        "expected_version_id": head_version(client, auth, presentation_id),
        "sequence": ["headline", "body"],
        **body,
    }
    return client.post(f"/v1/presentations/{presentation_id}/motion", headers=auth, json=payload)


def entrance_span(slide: dict) -> int:
    """How long the on-entry part of this slide runs, in milliseconds.

    Mirrors the compiler (`packages/animation-engine/src/compile.ts`): a cursor
    runs through the tracks, `slideEnter` resets it to zero, `timer` offsets it
    by `delayMs`, `afterPrevious` takes it as it stands, and a click starts a new
    segment — so the entrance ends there.

    Written out because the obvious version is wrong in a way that hides the bug
    it was meant to catch: every clip starts at 0 *within its own track*, so
    `max(startMs + durationMs)` measures one step and passes however long the
    real sequence runs.
    """
    cursor = 0
    span = 0
    previous_start = 0
    for track in slide.get("animations") or []:
        trigger = track.get("trigger") or {}
        kind = trigger.get("type")
        if kind == "click":
            break
        if kind == "slideEnter":
            start = 0
        elif kind == "timer":
            start = cursor + int(trigger.get("delayMs", 0))
        elif kind == "withPrevious":
            start = previous_start
        else:  # afterPrevious, and anything the compiler treats like it
            start = cursor
        previous_start = start

        end = start
        for clip in track.get("clips") or []:
            end = max(
                end,
                start
                + int(clip.get("startMs", 0))
                + int(clip.get("delayMs", 0))
                + int(clip.get("durationMs", 0)),
            )
        cursor = end
        span = max(span, end)
    return span


def text_element(index: int, role: str, words: int = 2) -> dict:
    return {
        "id": f"el_{index:026d}",
        "type": "text",
        "semanticRole": role,
        "transform": {"x": 0, "y": index * 100, "width": 400, "height": 80},
        "content": {
            "version": 1,
            "blocks": [
                {
                    "id": f"blk_{index:026d}",
                    "type": "paragraph",
                    "spans": [{"text": " ".join(["word"] * words)}],
                }
            ],
        },
    }


# ------------------------------------------------------------- capabilities


def test_capabilities_offer_no_way_to_name_a_duration(client, auth):
    answer = client.get("/v1/motion/capabilities", headers=auth)
    assert answer.status_code == 200, answer.text
    body = answer.json()

    assert {"fade", "staggerReveal", "wordCascade"} <= set(body["presets"])
    assert set(body["pacing"]) == {"tight", "measured", "deliberate"}
    assert "headline" in body["roles"] and "metric" in body["roles"]
    assert body["entrance_budget_ms"] == 2_500
    # The pacing words show what they produce, so a caller can choose with its
    # eyes open — while still not being able to send a number of its own.
    assert body["pacing"]["tight"]["durationMs"] < body["pacing"]["deliberate"]["durationMs"]


# ------------------------------------------------------------------ writing


def test_a_plan_in_roles_becomes_tracks_with_computed_timings(client, auth, deck):
    response = animate(client, auth, deck, sequence=["headline", "body", "metric"], pacing="tight")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["outcome"] in {"applied", "pending"}
    assert body["track_count"] >= 1

    document = client.get(
        f"/v1/presentations/{deck['presentation_id']}", headers=auth
    ).json()["document"]
    slide = document["slides"][0]
    tracks = slide.get("animations") or []
    assert tracks, "the slide should have animation tracks"
    # Durations exist and were not sent by the caller: this is the whole split.
    assert all(clip.get("durationMs", 0) > 0 for track in tracks for clip in track["clips"])


def test_a_sequence_that_would_over_run_is_compressed_rather_than_emitted(client, auth, deck):
    """Doc 04 §24.2, and the reason a plan cannot name milliseconds.

    Tested against `animate_slide` directly, with a slide built to need
    compressing. The route's deck is whatever the composer produced, and a slide
    with three roles fits the budget without anything being enforced — which is
    how the first version of this test passed while proving nothing.
    """
    from deckastra_api import motion

    roles = ["eyebrow", "headline", "subtitle", "body", "metric", "quote", "caption"]
    slide = {
        "id": "sld_synthetic",
        "name": "Everything at once",
        "elements": [text_element(index, role) for index, role in enumerate(roles)],
    }
    pacing = motion.PACING["deliberate"]

    # The case has to be real: seven steps at 600ms with 200ms gaps is 5,400ms,
    # more than double the budget. If this arithmetic ever fits, the test below
    # stops meaning anything.
    uncompressed = len(roles) * pacing["durationMs"] + (len(roles) - 1) * pacing["gapMs"]
    assert uncompressed > motion.ENTRANCE_BUDGET_MS

    warnings = motion.animate_slide(
        slide, {"sequence": roles, "entrance": "fade", "pacing": "deliberate"}
    )
    # Compressed *and said so*. A slide quietly tightened is a slide whose author
    # wonders why "deliberate" looks brisk; degradations are surfaced, never
    # silent (doc 04 §32.2's rule, applied to time).
    assert any("tightened to fit" in warning for warning in warnings), warnings

    span = entrance_span(slide)
    assert span <= motion.ENTRANCE_BUDGET_MS, f"entrance ran {span}ms"
    # And compressed, not merely shorter because fewer roles matched.
    assert len(slide["animations"]) == len(roles)
    durations = {clip["durationMs"] for track in slide["animations"] for clip in track["clips"]}
    assert max(durations) < pacing["durationMs"]
    # Floored rather than scaled to a flicker: below ~150ms motion is a twitch.
    assert min(durations) >= 150


def test_the_span_helper_would_notice_a_sequence_that_did_not_fit(client, auth, deck):
    """The measurement itself, checked against a slide built to over-run.

    A budget assertion is only as good as the thing that measures the span, and
    the previous one always measured a single step.
    """
    over_running = {
        "animations": [
            {"trigger": {"type": "slideEnter"}, "clips": [{"startMs": 0, "durationMs": 600}]},
            {"trigger": {"type": "timer", "delayMs": 200}, "clips": [{"startMs": 0, "durationMs": 600}]},
            {"trigger": {"type": "timer", "delayMs": 200}, "clips": [{"startMs": 0, "durationMs": 600}]},
            {"trigger": {"type": "timer", "delayMs": 200}, "clips": [{"startMs": 0, "durationMs": 600}]},
        ]
    }
    # 600, then three steps of 200 + 600: 3,000ms in total.
    assert entrance_span(over_running) == 3_000
    # A click begins a new segment, so it is not part of the entrance.
    clicked = {
        "animations": [
            {"trigger": {"type": "slideEnter"}, "clips": [{"startMs": 0, "durationMs": 600}]},
            {"trigger": {"type": "click"}, "clips": [{"startMs": 0, "durationMs": 5_000}]},
        ]
    }
    assert entrance_span(clicked) == 600


def test_a_real_slide_stays_inside_the_budget(client, auth, deck):
    response = animate(
        client,
        auth,
        deck,
        sequence=["eyebrow", "headline", "subtitle", "body", "metric", "caption"],
        pacing="deliberate",
    )
    assert response.status_code == 200, response.text

    document = client.get(
        f"/v1/presentations/{deck['presentation_id']}", headers=auth
    ).json()["document"]
    assert entrance_span(document["slides"][0]) <= 2_500


def test_an_unknown_preset_falls_back_and_says_so(client, auth, deck):
    # The renderer would degrade it anyway; degrading here means the stored
    # document says what it will actually do.
    response = animate(client, auth, deck, entrance="explodeFromOrbit")
    assert response.status_code == 200, response.text
    assert any("explodeFromOrbit" in warning for warning in response.json()["warnings"])


def test_roles_that_match_nothing_commit_no_version(client, auth, deck):
    presentation_id = deck["presentation_id"]
    before = head_version(client, auth, presentation_id)

    response = animate(client, auth, deck, sequence=["mascot", "sponsor"])
    assert response.status_code == 200, response.text
    assert response.json()["outcome"] == "none"
    assert "roles" in response.json()["refusal"]

    # An empty change would put a version in the history for nothing, and every
    # later diff would have to be read past it.
    assert head_version(client, auth, presentation_id) == before


def test_a_plan_authored_against_a_stale_version_is_refused(client, auth, deck):
    presentation_id = deck["presentation_id"]
    stale = head_version(client, auth, presentation_id)

    typed = client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth,
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "Typed"}],
            "intent": "Retitle",
            "expected_version_id": stale,
            "client_id": "web-editor",
        },
    )
    assert typed.status_code == 200, typed.text

    response = client.post(
        f"/v1/presentations/{presentation_id}/motion",
        headers=auth,
        json={
            "slide_id": deck["document"]["slides"][0]["id"],
            "expected_version_id": stale,
            "sequence": ["headline"],
        },
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["current_version_id"] != stale


def test_a_caller_cannot_send_timings(client, auth, deck):
    # Not a field the request model has. Sent anyway, because the check worth
    # making is that an unknown key cannot become one by being supplied.
    response = animate(client, auth, deck, durationMs=9_000, gapMs=4_000)
    assert response.status_code == 200, response.text

    document = client.get(
        f"/v1/presentations/{deck['presentation_id']}", headers=auth
    ).json()["document"]
    assert entrance_span(document["slides"][0]) <= 2_500


def test_someone_outside_the_workspace_cannot_animate_a_slide(client, auth, deck):
    stranger = session_for(client, "stranger@localhost")
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/motion",
        headers=stranger,
        json={
            "slide_id": deck["document"]["slides"][0]["id"],
            "expected_version_id": head_version(client, auth, deck["presentation_id"]),
            "sequence": ["headline"],
        },
    )
    assert response.status_code == 404


# ---------------------------------------------------------------- dry runs


def test_a_dry_run_plans_without_writing_anything(client, auth, deck):
    """The editor's "Plan by roles" (Phase 7).

    The planner is deterministic, so a person can see what a plan would do and
    apply it as their own edit. A dry run must therefore leave no trace: no
    version, no proposal, no attribution to an agent that did not exist.
    """
    presentation_id = deck["presentation_id"]
    before = head_version(client, auth, presentation_id)
    response = animate(client, auth, deck, sequence=["headline", "body"], dry_run=True)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["outcome"] == "planned"
    assert body["version_id"] == before
    [operation] = body["operations"]
    assert operation["path"].endswith("/animations")
    assert operation["value"] and body["track_count"] == len(operation["value"])

    assert head_version(client, auth, presentation_id) == before
    assert client.get(f"/v1/presentations/{presentation_id}/proposals", headers=auth).json() == []


def test_a_reviewed_pattern_dry_run_inserts_after_the_named_slide(client, auth, deck):
    presentation_id = deck["presentation_id"]
    before = head_version(client, auth, presentation_id)
    first = deck["document"]["slides"][0]
    response = client.post(
        f"/v1/presentations/{presentation_id}/patterns/insert",
        headers=auth,
        json={
            "expected_version_id": before,
            "pattern": "statement",
            "slots": {"headline": "One clear decision"},
            "after_slide_id": first["id"],
            "dry_run": True,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["outcome"] == "planned"
    assert body["pattern"] == "statement"
    [operation] = body["operations"]
    assert operation["op"] == "add"
    assert operation["path"] == "/slides/1"
    assert operation["value"]["layout"]["styleLabel"] == "statement"
    assert head_version(client, auth, presentation_id) == before


def test_a_reviewed_motion_style_dry_run_returns_one_editor_patch_set(client, auth, deck):
    presentation_id = deck["presentation_id"]
    before = head_version(client, auth, presentation_id)
    response = client.post(
        f"/v1/presentations/{presentation_id}/motion-style",
        headers=auth,
        json={"expected_version_id": before, "style": "energetic", "dry_run": True},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["outcome"] == "planned"
    assert body["style"] == "energetic"
    assert body["slides_changed"] == len(deck["document"]["slides"])
    assert any(operation["path"] == "/metadata/motionStyle" for operation in body["operations"])
    assert any(operation["path"].endswith("/animations") for operation in body["operations"])
    assert head_version(client, auth, presentation_id) == before


def test_a_dry_run_transition_plans_without_writing(client, auth, deck):
    presentation_id = deck["presentation_id"]
    before = head_version(client, auth, presentation_id)
    response = client.post(
        f"/v1/presentations/{presentation_id}/transition",
        headers=auth,
        json={
            "slide_id": deck["document"]["slides"][1]["id"],
            "expected_version_id": before,
            "kind": "fade",
            "dry_run": True,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["outcome"] == "planned"
    [operation] = body["operations"]
    assert operation["path"].endswith("/transition") and operation["value"]["type"] == "fade"
    assert operation["value"]["durationMs"] > 0
    assert head_version(client, auth, presentation_id) == before


@pytest.mark.parametrize("kind", ["cover", "wipe", "split", "iris", "flip", "blurDissolve"])
def test_every_engine_transition_is_available_through_the_api(client, auth, deck, kind):
    presentation_id = deck["presentation_id"]
    response = client.post(
        f"/v1/presentations/{presentation_id}/transition",
        headers=auth,
        json={"slide_id": deck["document"]["slides"][1]["id"],
              "expected_version_id": head_version(client, auth, presentation_id),
              "kind": kind, "dry_run": True},
    )
    assert response.status_code == 200, response.text
    [operation] = response.json()["operations"]
    assert operation["value"]["type"] == kind


def test_a_dry_run_is_still_refused_against_a_stale_version(client, auth, deck):
    response = animate(client, auth, deck, dry_run=True, expected_version_id="ver_stale")
    assert response.status_code == 409
