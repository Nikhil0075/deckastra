"""Budgets and project memory — both named gaps in the register.

Budgets close doc 03 S1: doc 03 §21 says a failure must never be silent and §27
defers unbounded recursion, but neither stated a number, so there was nothing to
enforce.

Memory closes doc 03 S2: without it the Critic raises the same issue every run
and the user dismisses it every time, which is how people stop reading agent
output at all.
"""

from __future__ import annotations

import time

import pytest
from deckastra_agents.budgets import BudgetExceeded, RunBudget
from deckastra_agents.memory import InMemoryStore, MemoryEntry, ProjectMemory


# ------------------------------------------------------------------ budgets


def test_tokens_accumulate_until_the_ceiling():
    budget = RunBudget(max_total_tokens=100)
    budget.spend_tokens(40, 10)
    assert budget.used_tokens == 50

    with pytest.raises(BudgetExceeded) as caught:
        budget.spend_tokens(60, 0)

    assert caught.value.budget == "token"
    # The message names what ran out and how much was used — a ceiling nobody can
    # see is a ceiling nobody can raise.
    assert "110" in str(caught.value)


def test_the_clock_is_a_hard_stop():
    budget = RunBudget(max_wall_clock_seconds=0.01)
    time.sleep(0.02)
    with pytest.raises(BudgetExceeded):
        budget.check_clock()


def test_revisions_degrade_rather_than_fail():
    """The distinction the whole module turns on.

    A token ceiling raises, because past it the run is spending money the user
    did not agree to. A revision ceiling returns False, because past it the run
    still has something worth handing over.
    """
    budget = RunBudget(max_revisions_per_run=2)

    assert budget.may_revise("sld_1")
    budget.record_revision("sld_1")
    assert budget.may_revise("sld_1")
    budget.record_revision("sld_1")

    assert budget.may_revise("sld_1") is False
    assert budget.warnings  # and it says so


def test_a_per_slide_limit_stops_one_slide_looping():
    budget = RunBudget(max_revisions_per_slide=1, max_revisions_per_run=10)

    assert budget.may_revise("sld_1")
    budget.record_revision("sld_1")
    assert budget.may_revise("sld_1") is False
    # A different slide is unaffected — one stubborn slide must not end the run.
    assert budget.may_revise("sld_2")


def test_warnings_are_deduplicated():
    # A loop that warns per iteration produces a wall of noise nobody reads.
    budget = RunBudget(max_revisions_per_run=0)
    budget.may_revise("sld_1")
    budget.may_revise("sld_1")
    budget.may_revise("sld_2")
    assert len(budget.warnings) == 1


def test_the_report_says_what_was_spent():
    budget = RunBudget()
    budget.spend_tokens(100, 50)
    report = budget.report()

    assert report["used_tokens"] == 150
    assert report["input_tokens"] == 100
    assert report["output_tokens"] == 50
    assert report["max_total_tokens"] == budget.max_total_tokens
    assert "elapsed_seconds" in report


# ------------------------------------------------------------------- memory


def memory() -> ProjectMemory:
    return ProjectMemory(InMemoryStore(), "prj_1")


def test_nothing_remembered_produces_no_prompt_noise():
    # An empty context block would be a paragraph of preamble saying nothing.
    assert memory().prompt_context() == ""


def test_a_dismissed_issue_is_remembered_by_category():
    project = memory()
    project.record_dismissed_issue("style", "The accent is too loud.")

    assert project.dismissed_categories() == {"style"}
    assert "dismissed a style issue" in project.prompt_context()


def test_dismissed_categories_are_filtered_from_a_review_and_counted():
    """Dropped, and the drop is reported.

    A user who dismissed style issues twice does not want a third — but they do
    want to know the Critic had one.
    """
    project = memory()
    project.record_dismissed_issue("style", "too loud")

    kept, notes = project.filter_issues(
        [
            {"category": "style", "message": "still too loud"},
            {"category": "narrative", "message": "slide 4 repeats slide 2"},
        ]
    )

    assert [issue["category"] for issue in kept] == ["narrative"]
    assert notes and "1 issue" in notes[0]


def test_filtering_is_a_no_op_with_nothing_dismissed():
    issues = [{"category": "style", "message": "x"}]
    kept, notes = memory().filter_issues(issues)
    assert kept == issues
    assert notes == []


def test_memory_is_scoped_to_one_project():
    """Never per organisation (doc 03 §27).

    One workspace's rejected layout is not evidence about another's.
    """
    store = InMemoryStore()
    ProjectMemory(store, "prj_1").record_dismissed_issue("style", "x")

    assert ProjectMemory(store, "prj_2").dismissed_categories() == set()


def test_stale_memory_stops_counting():
    # A deck's audience and purpose change; a preference from last quarter is no
    # longer evidence about what the user wants now.
    store = InMemoryStore()
    store.add(
        MemoryEntry(
            project_id="prj_1",
            kind="dismissed_issue",
            subject="style",
            note="old",
            created_at=time.time() - 10_000,
        )
    )

    assert ProjectMemory(store, "prj_1", ttl_seconds=100).dismissed_categories() == set()
    assert ProjectMemory(store, "prj_1", ttl_seconds=100_000).dismissed_categories() == {"style"}


def test_a_rejection_records_both_reasons():
    project = memory()
    project.record_rejected_proposal("shorten the headline", "we liked it long")

    note = project.entries()[-1].note
    assert "shorten the headline" in note
    assert "we liked it long" in note


def test_the_prompt_block_frames_memory_as_preference_not_instruction():
    """Advisory, never authoritative.

    A preference recorded once must not permanently prevent the right answer.
    """
    project = memory()
    project.record_accepted_layout("metrics")
    context = project.prompt_context()

    assert "preference, not instruction" in context
    assert "propose the right answer even when it differs" in context
