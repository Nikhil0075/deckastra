"""Planning a transition in roles (D4, doc 02 §26, doc 04 §24.2).

The Motion Agent's split, applied to the space *between* slides: the caller names
a kind, one word of pacing, and the roles that carry across; `plan_transition`
resolves those roles against both slides and computes the duration.

The interesting tests are the refusals. Doc 02 §26 says two unrelated objects are
never silently morphed, which the engine enforces by refusing to guess — so this
is the one place a guess gets written down, and it has to be written where a
human can see it and say no.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import motion  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402


def slide(slide_id: str, *roles: str) -> dict:
    return {
        "id": slide_id,
        "elements": [
            {"id": f"el_{slide_id}_{role}", "type": "text", "semanticRole": role}
            for role in roles
        ],
    }


# --------------------------------------------------------------- the planner


def test_a_morph_pairs_the_roles_it_was_given():
    transition, warnings = motion.plan_transition(
        slide("a", "headline", "metric"),
        slide("b", "headline", "metric"),
        kind="morph",
        pacing="tight",
        carry=["headline"],
    )

    assert warnings == []
    assert transition["type"] == "morph"
    assert transition["durationMs"] == motion.PACING["tight"]["durationMs"]
    assert transition["sharedElements"] == [
        {
            "sourceElementId": "el_a_headline",
            "destinationElementId": "el_b_headline",
            # Never `full`: rotation and opacity change what an element *is*, and
            # naming a role has not asked for that.
            "matchMode": "positionAndScale",
        }
    ]


def test_a_role_missing_on_either_side_is_named_not_dropped():
    transition, warnings = motion.plan_transition(
        slide("a", "headline"),
        slide("b", "metric"),
        kind="morph",
        carry=["headline", "metric"],
    )

    assert "sharedElements" not in transition
    assert any("headline" in warning and "this slide" in warning for warning in warnings)
    assert any("metric" in warning and "previous slide" in warning for warning in warnings)


def test_carrying_roles_across_a_push_is_refused_and_said():
    """Only a morph consumes the deltas.

    Writing mappings a push will never read would leave the document claiming a
    relationship nothing honours.
    """
    transition, warnings = motion.plan_transition(
        slide("a", "headline"), slide("b", "headline"), kind="push", carry=["headline"]
    )

    assert "sharedElements" not in transition
    assert any("does not carry" in warning for warning in warnings)


def test_the_first_slide_has_nothing_to_come_from():
    transition, warnings = motion.plan_transition(
        None, slide("b", "headline"), kind="morph", carry=["headline"]
    )

    assert transition["type"] == "morph"
    assert "sharedElements" not in transition
    assert any("first slide" in warning for warning in warnings)


def test_an_ambiguous_role_pairs_the_first_and_says_so():
    # Guessing further is exactly the silent pairing the schema forbids.
    transition, warnings = motion.plan_transition(
        slide("a", "body", "body"),
        slide("b", "body"),
        kind="morph",
        carry=["body"],
    )

    assert transition["sharedElements"][0]["sourceElementId"] == "el_a_body"
    assert any("more than once" in warning for warning in warnings)


def test_an_unknown_kind_becomes_a_fade_rather_than_a_refusal():
    transition, warnings = motion.plan_transition(
        slide("a"), slide("b"), kind="kaleidoscope"
    )

    assert transition["type"] == "fade"
    assert any("kaleidoscope" in warning for warning in warnings)


def test_a_cut_carries_nothing_and_lasts_no_time():
    transition, warnings = motion.plan_transition(
        slide("a", "headline"), slide("b", "headline"), kind="cut", carry=["headline"]
    )

    assert transition == {"type": "cut", "durationMs": 0}


def test_pacing_decides_the_duration_and_nothing_else_can():
    durations = {
        pacing: motion.plan_transition(slide("a"), slide("b"), kind="fade", pacing=pacing)[0][
            "durationMs"
        ]
        for pacing in ("tight", "measured", "deliberate")
    }

    assert durations["tight"] < durations["measured"] < durations["deliberate"]


# ----------------------------------------------------------------- the route

SECRET = "a-launch-secret-that-is-long-enough-to-pass"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKASTRA_LOCAL_MODE", "1")
    monkeypatch.setenv("DECKASTRA_LOCAL_SECRET", SECRET)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'transitions.db'}")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


def bearer() -> dict[str, str]:
    return {"Authorization": f"Bearer {SECRET}"}


@pytest.fixture()
def deck(client):
    created = client.post("/v1/presentations", headers=bearer(), json={"title": "Transitions"})
    assert created.status_code == 201, created.text
    return created.json()


def test_the_route_refuses_a_plan_authored_against_a_moved_deck(client, deck):
    answer = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transition",
        headers=bearer(),
        json={
            "slide_id": "sld_whatever",
            "expected_version_id": "ver_stale",
            "kind": "fade",
        },
    )

    assert answer.status_code == 409
    assert answer.json()["detail"]["code"] == "E310"


def test_the_route_commits_no_version_for_a_transition_already_there(client, deck):
    """An empty change is a row every later diff has to be read past."""
    document = client.get(
        f"/v1/presentations/{deck['presentation_id']}", headers=bearer()
    ).json()
    slide_id = document["document"]["slides"][0]["id"]

    first = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transition",
        headers=bearer(),
        json={
            "slide_id": slide_id,
            "expected_version_id": document["version_id"],
            "kind": "fade",
            "pacing": "measured",
        },
    )
    assert first.status_code == 200, first.text
    assert first.json()["outcome"] in {"applied", "pending"}

    head = client.get(f"/v1/presentations/{deck['presentation_id']}", headers=bearer()).json()
    again = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transition",
        headers=bearer(),
        json={
            "slide_id": slide_id,
            "expected_version_id": head["version_id"],
            "kind": "fade",
            "pacing": "measured",
        },
    )

    assert again.json()["outcome"] == "none"
    assert "already" in again.json()["refusal"]
    # And nothing was written.
    assert (
        client.get(f"/v1/presentations/{deck['presentation_id']}", headers=bearer()).json()[
            "version_id"
        ]
        == head["version_id"]
    )


def test_the_route_attributes_the_change_to_the_client(client, deck):
    document = client.get(
        f"/v1/presentations/{deck['presentation_id']}", headers=bearer()
    ).json()
    slide_id = document["document"]["slides"][0]["id"]

    answer = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transition",
        headers=bearer(),
        json={
            "slide_id": slide_id,
            "expected_version_id": document["version_id"],
            "kind": "zoom",
            "client_label": "acceptance",
        },
    )

    assert answer.status_code == 200, answer.text
    stored = client.get(
        f"/v1/presentations/{deck['presentation_id']}", headers=bearer()
    ).json()["document"]
    assert stored["slides"][0]["transition"]["type"] == "zoom"
