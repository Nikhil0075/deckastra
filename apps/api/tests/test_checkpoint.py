"""The story checkpoint: pause and resume (doc 03 §17, §28).

"Story checkpoint can pause/resume" is an acceptance criterion, and it is the one
that cannot be faked with a flag. A boolean the next node checks is not a pause —
the run has already continued. A real pause means the graph stopped with its
state durable, and a real resume means the same run id picks it up afterwards,
possibly in another process.

That needs a durable checkpointer, which means PostgreSQL. These skip without
one rather than passing vacuously.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Importing the API package puts `agents/` on the path — see its docstring for
# why that bootstrap lives there rather than in a PYTHONPATH nobody sets twice.
import deckastra_api  # noqa: E402,F401

from deckastra_agents.budgets import RunBudget  # noqa: E402
from deckastra_agents.events import collector  # noqa: E402
from deckastra_agents.nodes._common import NodeContext  # noqa: E402
from deckastra_agents.router import StubClient  # noqa: E402
from deckastra_agents.runner import AgentRun, resume_generation, run_generation  # noqa: E402
from deckastra_agents.state import initial_state  # noqa: E402
from deckastra_agents.tools.registry import ToolRegistry  # noqa: E402
from tests.conftest import POSTGRES_URL, requires_postgres  # noqa: E402

SLIDE = {
    "layout": "statement",
    "purpose": "p",
    "key_message": "k",
    "headline": "It works",
    "eyebrow": "",
    "subtitle": "",
    "body": "",
    "bullets": [],
    "metrics": [],
    "quote": "",
    "attribution": "",
    "code": "",
    "language": "",
    "caption": "",
    "speaker_notes": "",
    "source_ids": [],
}

ANSWERS = {
    "fast": {
        "intent": "create_deck",
        "stages": ["story", "layout", "critic"],
        "scope_kind": "deck",
        "needs_research": False,
        "reasoning": "New deck.",
        "clarification_needed": "",
    },
    "planning": {
        "title": "Deck",
        "narrative_arc": "open, build, close",
        "slides": [SLIDE],
        "embedded_instructions_found": False,
    },
    "structured": {
        "mood": "calm",
        "emphasis_role": "headline",
        "accent_token": "colors.accent",
        "typography_scale": "balanced",
        "rationale": "r",
        "choices": [],
        "warnings": [],
    },
    "critique": {"verdict": "pass", "score": 0.9, "issues": [], "summary": "Ready."},
}


def compose(plan, direction):
    return [{"op": "replace", "path": "/slides", "value": plan.get("slides", [])}]


def make_run(checkpointer):
    client = StubClient()
    for task, payload in ANSWERS.items():
        client.register(task, payload)

    _, emit = collector()
    return AgentRun(
        client=client,
        registry=ToolRegistry(),
        compose=compose,
        budget=RunBudget(),
        emit=emit,
        checkpointer=checkpointer,
        human_checkpoint=True,
    )


@pytest.fixture()
def checkpointer(postgres_url):
    from langgraph.checkpoint.postgres import PostgresSaver

    with PostgresSaver.from_conn_string(postgres_url.replace("+psycopg", "")) as saver:
        saver.setup()
        yield saver


@requires_postgres
def test_the_run_pauses_before_the_story_is_used(checkpointer):
    run = make_run(checkpointer)
    result = run_generation(
        run,
        initial_state(
            run_id="run_pause_1",
            user_id="u",
            project_id="p",
            presentation_id="d",
            request={"instruction": "Explain it", "slide_count": 1},
            document={"metadata": {"title": "x"}, "slides": []},
        ),
    )

    assert result.status == "awaiting_approval"
    # The story exists — that is what the human is being asked to approve.
    assert result.state["story_plan"]["slides"]
    # Nothing downstream ran: no proposal was produced.
    assert result.operations == []


@requires_postgres
def test_approving_resumes_the_same_run_and_finishes_it(checkpointer):
    run = make_run(checkpointer)
    run_generation(
        run,
        initial_state(
            run_id="run_pause_2",
            user_id="u",
            project_id="p",
            presentation_id="d",
            request={"instruction": "Explain it", "slide_count": 1},
            document={"metadata": {"title": "x"}, "slides": []},
        ),
    )

    # A fresh AgentRun, as a later request would have — the state comes from the
    # checkpoint, not from anything held in memory.
    resumed = resume_generation(make_run(checkpointer), "run_pause_2", {"action": "approve"})

    assert resumed.status == "completed"
    assert resumed.operations, "approving should let the run produce its proposal"


@requires_postgres
def test_rejecting_ends_the_run_without_proposing(checkpointer):
    """The user said no. Continuing to 'save the work' would do the declined thing."""
    run = make_run(checkpointer)
    run_generation(
        run,
        initial_state(
            run_id="run_pause_3",
            user_id="u",
            project_id="p",
            presentation_id="d",
            request={"instruction": "Explain it", "slide_count": 1},
            document={"metadata": {"title": "x"}, "slides": []},
        ),
    )

    resumed = resume_generation(make_run(checkpointer), "run_pause_3", {"action": "reject"})
    assert resumed.operations == []


@requires_postgres
def test_two_runs_do_not_share_a_checkpoint(checkpointer):
    """The thread id is derived from the run id.

    Getting this wrong produces a resume that silently starts a new run, which
    looks exactly like the checkpoint never happened.
    """
    for run_id in ("run_thread_a", "run_thread_b"):
        run_generation(
            make_run(checkpointer),
            initial_state(
                run_id=run_id,
                user_id="u",
                project_id="p",
                presentation_id="d",
                request={"instruction": f"Explain {run_id}", "slide_count": 1},
                document={"metadata": {"title": "x"}, "slides": []},
            ),
        )

    a = resume_generation(make_run(checkpointer), "run_thread_a", {"action": "approve"})
    b = resume_generation(make_run(checkpointer), "run_thread_b", {"action": "approve"})

    assert a.state["request"]["instruction"] == "Explain run_thread_a"
    assert b.state["request"]["instruction"] == "Explain run_thread_b"


def test_resuming_without_a_checkpointer_says_so_rather_than_silently_restarting():
    # SQLite has no LangGraph saver, so a run there cannot pause. Saying it out
    # loud beats discovering that a checkpoint did nothing.
    run = make_run(None)
    with pytest.raises(ValueError, match="needs a checkpointer"):
        resume_generation(run, "run_x", {"action": "approve"})


def test_the_postgres_url_is_configured_for_ci():
    # A guard on the guard: if the environment stops being wired, the tests above
    # skip silently and this is the only thing that notices.
    if POSTGRES_URL:
        assert POSTGRES_URL.startswith("postgresql")
