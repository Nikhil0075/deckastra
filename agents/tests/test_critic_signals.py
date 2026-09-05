"""The Critic's deterministic measurements (doc 03 §13, §14).

Doc 03 §14 calls these a deterministic service rather than an agent, and the
distinction is the whole point: nothing here has an opinion. A model asked to
judge density will sometimes count four bullets where there are three and then
raise an issue about the four. Measuring first means the Critic argues about what
the numbers mean rather than about what they are.
"""

from __future__ import annotations

from typing import Any

from deckastra_agents.contracts import CriticScores
from deckastra_agents.nodes._signals import (
    CROWDED_WORDS,
    DENSE_WORDS,
    describe,
    measure_deck,
)


def slide(**overrides: Any) -> dict[str, Any]:
    return {
        "layout": "bullets",
        "headline": "A headline",
        "key_message": "A message",
        "bullets": ["One", "Two", "Three"],
        "metrics": [],
        "source_ids": [],
        **overrides,
    }


def state(slides: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {"story_plan": {"slides": slides}, **extra}


# ------------------------------------------------------------------ counting


def test_it_counts_words_across_everything_on_the_slide():
    measured = measure_deck(
        state([slide(headline="Two words", body="three more words here", bullets=["a b"])])
    )
    # headline 2 + body 4 + bullet 2 = 8. A count that only looked at the body
    # would call a bullet-heavy slide empty.
    assert measured["slides"][0]["words"] == 8


def test_a_dense_slide_is_named_by_index():
    long_body = " ".join(["word"] * (DENSE_WORDS + 5))
    measured = measure_deck(state([slide(), slide(body=long_body)]))
    assert measured["dense_slides"] == [1]
    assert measured["crowded_slides"] == []


def test_a_crowded_slide_is_both_dense_and_crowded():
    # The two thresholds are a gradient, not a partition: a slide past the
    # crowded line is also past the dense one, and reporting it as only crowded
    # would make the dense list look shorter than it is.
    huge = " ".join(["word"] * (CROWDED_WORDS + 5))
    measured = measure_deck(state([slide(body=huge)]))
    assert measured["dense_slides"] == [0]
    assert measured["crowded_slides"] == [0]


# ------------------------------------------------------------- layout misfits


def test_a_metrics_layout_with_one_number_is_a_misfit():
    measured = measure_deck(state([slide(layout="metrics", metrics=[{"value": "1", "label": "a"}])]))
    assert measured["layout_misfits"] == [0]
    assert "statement" in measured["slides"][0]["layout_misfit"]


def test_a_metrics_layout_with_two_numbers_is_not():
    measured = measure_deck(
        state([slide(layout="metrics", metrics=[{"value": "1"}, {"value": "2"}])])
    )
    assert measured["layout_misfits"] == []


def test_a_bullets_layout_with_two_points_is_a_misfit():
    measured = measure_deck(state([slide(bullets=["one", "two"])]))
    assert measured["layout_misfits"] == [0]


def test_a_quote_with_no_quotation_and_code_with_no_code_are_misfits():
    measured = measure_deck(state([slide(layout="quote", quote=""), slide(layout="code", code="")]))
    assert measured["layout_misfits"] == [0, 1]


# ------------------------------------------------------------------- claims


def test_a_number_with_no_source_is_counted():
    """Doc 03 §13's most important catch, measured rather than spotted."""
    measured = measure_deck(state([slide(headline="Latency fell 43%")]))
    assert measured["uncited_claims"] == 1
    assert measured["slides"][0]["has_numbers"] is True


def test_a_number_with_a_real_source_is_not():
    measured = measure_deck(
        state(
            [slide(headline="Latency fell 43%", source_ids=["acme/x#a.py:1-9"])],
            research={"sources": [{"id": "acme/x#a.py:1-9"}]},
        )
    )
    assert measured["uncited_claims"] == 0


def test_a_citation_the_research_never_produced_does_not_count():
    # An invented source id is worse than none: it looks like grounding.
    measured = measure_deck(
        state(
            [slide(headline="Latency fell 43%", source_ids=["made/up#nowhere.py:1-2"])],
            research={"sources": [{"id": "acme/x#a.py:1-9"}]},
        )
    )
    assert measured["uncited_claims"] == 1
    assert measured["slides"][0]["cites"] == []


def test_vague_quantities_are_not_flagged():
    # "Several" is vague rather than unsourced. Flagging it would bury the case
    # that matters — a specific figure the material does not support.
    measured = measure_deck(state([slide(headline="Several teams adopted it")]))
    assert measured["uncited_claims"] == 0


# ---------------------------------------------------------------- repetition


def test_a_run_of_identical_layouts_is_measured():
    """Invisible one slide at a time, which is why the Critic needs it counted.

    A deck of seven bullet slides is a failure even when every bullet is correct.
    """
    measured = measure_deck(state([slide() for _ in range(5)]))
    assert measured["layout_runs"] == 5
    assert measured["layout_variety"] == 1


def test_a_varied_deck_reports_a_short_run():
    measured = measure_deck(
        state([slide(layout="title"), slide(layout="bullets"), slide(layout="quote", quote="x")])
    )
    assert measured["layout_runs"] == 1
    assert measured["layout_variety"] == 3


# -------------------------------------------------------------------- motion


def test_motion_is_measured_as_counts_not_judged():
    measured = measure_deck(
        state(
            [slide(), slide(), slide(), slide()],
            motion_plan={
                "slides": [
                    {"index": 0, "sequence": ["headline"], "click_reveals": 1},
                    {"index": 1, "sequence": [], "click_reveals": 0},
                ]
            },
        )
    )
    assert measured["motion"]["animated_slides"] == 1
    assert measured["motion"]["click_reveals"] == 1
    assert measured["motion"]["everything_moves"] is False


def test_a_deck_where_everything_moves_is_flagged():
    # Doc 04 §24.4: motion reads as emphasis, and a deck that emphasises
    # everything emphasises nothing.
    measured = measure_deck(
        state(
            [slide() for _ in range(4)],
            motion_plan={
                "slides": [{"index": index, "sequence": ["headline"]} for index in range(4)]
            },
        )
    )
    assert measured["motion"]["everything_moves"] is True


def test_a_short_deck_that_all_moves_is_not_flagged():
    # Three slides that all animate is a deliberate choice, not a pattern.
    measured = measure_deck(
        state(
            [slide() for _ in range(3)],
            motion_plan={
                "slides": [{"index": index, "sequence": ["headline"]} for index in range(3)]
            },
        )
    )
    assert measured["motion"]["everything_moves"] is False


# ------------------------------------------------------------------ prompting


def test_the_description_names_what_the_critic_must_not_re_count():
    text = describe(
        measure_deck(state([slide(layout="metrics", metrics=[{"value": "1"}], headline="Up 40%")]))
    )
    assert "MISFIT" in text
    assert "NUMBER WITH NO SOURCE" in text
    assert "slide_count: 1" in text


def test_an_empty_deck_measures_without_dividing_by_zero():
    measured = measure_deck(state([]))
    assert measured["slide_count"] == 0
    assert measured["layout_runs"] == 0
    assert describe(measured)


# -------------------------------------------------------------- the score model


def test_the_overall_is_the_mean_of_the_dimensions_that_apply():
    scores = CriticScores(
        hierarchy=1,
        readability=1,
        contrast=1,
        alignment=1,
        density=1,
        consistency=1,
        narrative_clarity=0.3,
    )
    # Seven dimensions, motion excluded because a still deck has no motion to
    # judge — averaging in a zero would punish a deck for not animating.
    assert scores.overall() == round((6 + 0.3) / 7, 4)


def test_motion_quality_joins_the_average_when_there_is_motion():
    with_motion = CriticScores(
        hierarchy=1,
        readability=1,
        contrast=1,
        alignment=1,
        density=1,
        consistency=1,
        narrative_clarity=1,
        motion_quality=0.2,
    )
    assert with_motion.overall() == round((7 + 0.2) / 8, 4)


def test_scores_are_comparable_between_drafts():
    """What the disagreement fallback relies on (gap register doc 03 S3).

    A draft that fixed two of five problems must score higher than the one before
    it, even though three remain — otherwise the fallback picks the wrong draft.
    """
    before = CriticScores(
        hierarchy=0.4, readability=0.4, contrast=1, alignment=1, density=0.4,
        consistency=1, narrative_clarity=0.6,
    )
    after = CriticScores(
        hierarchy=0.8, readability=0.8, contrast=1, alignment=1, density=0.4,
        consistency=1, narrative_clarity=0.6,
    )
    assert after.overall() > before.overall()
