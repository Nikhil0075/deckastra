"""Motion composition (doc 03 §12, doc 04 §24).

The Motion Agent names roles and one word of pacing; this is the code that turns
that into tracks. Everything worth testing here is a consequence of that split —
the agent cannot over-run the budget because it never sees a millisecond, and it
cannot animate the same element twice because it never names an element.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.motion import (  # noqa: E402
    ENTRANCE_BUDGET_MS,
    PACING,
    animate_slide,
)


def text(element_id: str, role: str, words: int = 3) -> dict:
    return {
        "id": element_id,
        "type": "text",
        "semanticRole": role,
        "content": {
            "blocks": [{"spans": [{"text": " ".join(["word"] * words)}]}],
        },
    }


def slide(*elements: dict, name: str = "A slide") -> dict:
    return {"id": "sld_1", "name": name, "elements": list(elements)}


def total_entrance(one: dict) -> int:
    """The wall-clock length of everything that runs on slide entry."""
    end = 0
    cursor = 0
    previous = 0

    for track in one.get("animations") or []:
        trigger = track["trigger"]
        if trigger["type"] == "click":
            break
        if trigger["type"] == "slideEnter":
            start = 0
        elif trigger["type"] == "withPrevious":
            start = previous
        elif trigger["type"] == "timer":
            start = cursor + trigger["delayMs"]
        else:
            start = cursor

        previous = start
        for clip in track["clips"]:
            finish = start + clip["startMs"] + clip["durationMs"]
            cursor = max(cursor, finish)
            end = max(end, finish)

    return end


# --------------------------------------------------------------- the default


def test_no_plan_means_nothing_moves():
    """Restraint is the baseline, not a fallback (doc 04 §24.4).

    A composer that invented an entrance for every slide would make every deck
    busier than its author asked for, and the author has no way to see where it
    came from.
    """
    one = slide(text("el_a", "headline"))
    assert animate_slide(one, None) == []
    assert "animations" not in one


def test_an_empty_sequence_means_nothing_moves():
    one = slide(text("el_a", "headline"))
    animate_slide(one, {"sequence": [], "entrance": "fade", "pacing": "measured"})
    assert "animations" not in one


def test_a_role_the_slide_does_not_have_is_simply_skipped():
    one = slide(text("el_a", "headline"))
    animate_slide(one, {"sequence": ["metric", "headline"], "pacing": "measured"})
    assert len(one["animations"]) == 1
    assert one["animations"][0]["targetId"] == "el_a"


# ------------------------------------------------------------------ ordering


def test_the_sequence_is_the_reveal_order():
    one = slide(
        text("el_body", "body"),
        text("el_head", "headline"),
        text("el_metric", "metric"),
    )
    animate_slide(one, {"sequence": ["headline", "metric", "body"], "pacing": "measured"})

    # Document order does not decide this; the plan does. That is the whole
    # point of sequencing by role.
    assert [track["targetId"] for track in one["animations"]] == [
        "el_head",
        "el_metric",
        "el_body",
    ]


def test_the_first_step_runs_on_slide_entry_and_the_rest_follow():
    one = slide(text("el_a", "headline"), text("el_b", "subtitle"))
    animate_slide(one, {"sequence": ["headline", "subtitle"], "pacing": "measured"})

    triggers = [track["trigger"]["type"] for track in one["animations"]]
    assert triggers[0] == "slideEnter"
    # The gap between steps is a delay on the next trigger, not a longer clip:
    # stretching the clip slows the motion rather than spacing it.
    assert triggers[1] == "timer"
    assert one["animations"][1]["trigger"]["delayMs"] == PACING["measured"]["gapMs"]


def test_several_elements_in_one_step_arrive_together():
    one = slide(text("el_a", "metric"), text("el_b", "metric"), text("el_c", "metric"))
    animate_slide(one, {"sequence": ["metric"], "pacing": "measured"})

    assert one["animations"][0]["trigger"]["type"] == "slideEnter"
    # Fanned rather than simultaneous, but on one trigger — three numbers landing
    # on the same frame reads as a jump, three landing 90ms apart reads as one
    # gesture.
    assert [track["trigger"]["type"] for track in one["animations"][1:]] == [
        "withPrevious",
        "withPrevious",
    ]
    assert [track["clips"][0]["startMs"] for track in one["animations"]] == [0, 90, 180]


def test_an_element_is_never_animated_twice():
    """Two tracks on one element's opacity is a conflict the renderer warns about.

    It cannot arise from a plan, because a role is consumed the first time it is
    reached — which is a property of this code, not of the agent behaving.
    """
    one = slide(text("el_a", "headline"))
    animate_slide(one, {"sequence": ["headline", "headline", "headline"], "pacing": "tight"})
    assert len(one["animations"]) == 1


# -------------------------------------------------------------- §24.2 budget


@pytest.mark.parametrize("pacing", ["tight", "measured", "deliberate"])
def test_the_entrance_budget_is_enforced_not_warned(pacing: str):
    """Doc 04 §24.2's 2.5s ceiling.

    A budget only means something if something enforces it. A model asked to
    respect one usually does; code that computes the durations always does.
    """
    one = slide(
        *[text(f"el_{index}", role) for index, role in enumerate(
            ["eyebrow", "headline", "subtitle", "body", "metric", "caption", "callout"]
        )]
    )
    warnings = animate_slide(
        one,
        {
            "sequence": ["eyebrow", "headline", "subtitle", "body", "metric", "caption", "callout"],
            "pacing": pacing,
        },
    )

    assert total_entrance(one) <= ENTRANCE_BUDGET_MS
    if pacing == "deliberate":
        # Compressed, and the author is told rather than left to wonder why their
        # deliberate slide feels brisk.
        assert any("tightened" in warning for warning in warnings)


def test_a_sequence_that_already_fits_is_left_alone():
    one = slide(text("el_a", "headline"), text("el_b", "subtitle"))
    warnings = animate_slide(one, {"sequence": ["headline", "subtitle"], "pacing": "deliberate"})

    assert one["animations"][0]["clips"][0]["durationMs"] == PACING["deliberate"]["durationMs"]
    assert warnings == []


def test_motion_never_becomes_a_flicker():
    # Below about 150ms an entrance is a twitch. A slide that appears is better
    # than one that flinches.
    one = slide(*[text(f"el_{index}", role) for index, role in enumerate(
        ["eyebrow", "headline", "subtitle", "body", "metric", "caption"]
    )])
    animate_slide(
        one,
        {"sequence": ["eyebrow", "headline", "subtitle", "body", "metric", "caption"], "pacing": "deliberate"},
        budget_ms=300,
    )
    assert all(track["clips"][0]["durationMs"] >= 150 for track in one["animations"])


def test_click_reveals_do_not_count_against_the_entrance():
    """The budget is about talking over an entrance.

    A revealed point happens when the presenter asks for it, so it cannot be
    over-running.
    """
    one = slide(
        text("el_a", "headline"),
        text("el_b", "body"),
        text("el_c", "metric"),
    )
    animate_slide(
        one,
        {"sequence": ["headline", "body", "metric"], "pacing": "deliberate", "click_reveals": 2},
    )

    assert [track["trigger"]["type"] for track in one["animations"]] == [
        "slideEnter",
        "click",
        "click",
    ]
    assert total_entrance(one) == PACING["deliberate"]["durationMs"]


def test_many_elements_in_one_step_still_fit_the_budget():
    """The fan is part of the entrance, so it has to be part of the budget.

    Six metrics offset 90ms apart add 450ms that a step-count-only calculation
    never sees, and the slide over-runs while the arithmetic says it does not.
    """
    one = slide(*[text(f"el_{index}", "metric") for index in range(6)], text("el_h", "headline"))
    animate_slide(one, {"sequence": ["headline", "metric"], "pacing": "deliberate"})
    assert total_entrance(one) <= ENTRANCE_BUDGET_MS


def test_click_reveals_cannot_consume_the_whole_slide():
    # Everything waiting for a click is a slide that starts blank, which reads as
    # a broken deck rather than a paced one.
    one = slide(text("el_a", "headline"), text("el_b", "body"))
    animate_slide(
        one, {"sequence": ["headline", "body"], "pacing": "measured", "click_reveals": 9}
    )
    assert one["animations"][0]["trigger"]["type"] == "slideEnter"


# ---------------------------------------------------------------- §24.4 rules


def test_long_body_text_is_left_in_place():
    """Doc 04 §24.4: never animate what the audience must read immediately."""
    one = slide(text("el_a", "headline"), text("el_b", "body", words=60))
    warnings = animate_slide(one, {"sequence": ["headline", "body"], "pacing": "measured"})

    assert [track["targetId"] for track in one["animations"]] == ["el_a"]
    assert any("immediately" in warning for warning in warnings)


def test_a_group_animates_as_a_stagger_over_its_children():
    # A group draws no content of its own, so animating it as one block moves a
    # list as a slab rather than revealing it.
    one = slide({"id": "el_g", "type": "group", "semanticRole": "body", "children": []})
    animate_slide(one, {"sequence": ["body"], "entrance": "slide", "pacing": "measured"})
    assert one["animations"][0]["clips"][0]["preset"] == "staggerReveal"


def test_playful_motion_cascades_text_and_springs_non_text():
    one = slide(
        text("el_head", "headline"),
        {"id": "el_shape", "type": "shape", "semanticRole": "caption"},
    )
    warnings = animate_slide(
        one,
        {"sequence": ["headline", "caption"], "entrance": "wordCascade", "pacing": "tight"},
    )

    assert warnings == []
    assert [track["clips"][0]["preset"] for track in one["animations"]] == ["wordCascade", "springIn"]


def test_an_unknown_preset_falls_back_and_says_so():
    # The renderer would degrade it anyway; degrading here means the document
    # says what it will actually do rather than what was asked for.
    one = slide(text("el_a", "headline"))
    warnings = animate_slide(
        one, {"sequence": ["headline"], "entrance": "holographicUnfold", "pacing": "measured"}
    )
    assert one["animations"][0]["clips"][0]["preset"] == "fade"
    assert any("holographicUnfold" in warning for warning in warnings)


def test_composition_is_deterministic_apart_from_ids():
    def shape(one: dict) -> list:
        return [
            (track["targetId"], track["trigger"], track["clips"][0]["durationMs"])
            for track in one["animations"]
        ]

    intent = {"sequence": ["headline", "subtitle"], "pacing": "measured"}
    first = slide(text("el_a", "headline"), text("el_b", "subtitle"))
    second = slide(text("el_a", "headline"), text("el_b", "subtitle"))
    animate_slide(first, intent)
    animate_slide(second, intent)

    assert shape(first) == shape(second)
