"""The bridge between the API and the agent system.

The agent package deliberately knows nothing about the database, HTTP or the
composer (doc 05 §17). Everything it needs is injected, and this is where the
injection happens: the tool registry is wired to a live document, the composer is
handed over as a callable, the checkpointer is opened against the configured
database, and the progress emitter is pointed at Redis when there is one.

It is also where the two policies that must not live in an agent are applied:

- **Risk is computed server-side from the operations** (doc 02 §31.7). An agent
  never says how risky its own proposal is.
- **An agent's operations become a pending transaction, not an applied one**,
  unless the risk tier says otherwise. Proposal-before-apply (doc 01 §11.2) is a
  property of this module, not of an agent's good behaviour.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Callable

from deckastra_agents import (
    AgentRun,
    ProjectMemory,
    RunBudget,
    RunResult,
    StubClient,
    ToolRegistry,
    default_client,
    initial_state,
)
from deckastra_agents.events import Emitter, RedisEmitter, fan_out
from deckastra_agents.router import api_key_available
from deckastra_agents.runner import resume_generation, run_generation
from deckastra_agents.tools.presentation import register_presentation_tools

from .compose import compose_document
from .models import GenerateRequest, StoryPlan
from .patch import PatchError, apply_patch
from .risk import assess_risk
from .schema import SchemaUnavailable, validate_document

logger = logging.getLogger("deckastra.agents")


# ------------------------------------------------------------------ stubbing


def _stub_answers(request: GenerateRequest) -> StubClient:
    """A deterministic client that walks the whole graph without credentials.

    Not a test mock — it is what keeps the agent path exercisable on a fresh
    clone and in CI: the graph, the routing, the checkpointer, the streaming and
    the proposal lifecycle all run, and only the model's judgement is missing.
    Its decks say so in the UI.
    """
    from .stub import stub_story_plan

    plan = stub_story_plan(request)
    client = StubClient()

    client.register(
        "fast",
        {
            "intent": "create_deck",
            "stages": ["story", "creative", "layout", "critic"],
            "scope_kind": "deck",
            "needs_research": False,
            "reasoning": "A new deck, composed by the deterministic planner.",
            "clarification_needed": "",
        },
    )
    client.register(
        "planning",
        {
            **plan.model_dump(mode="json"),
            "narrative_arc": "Opens with the brief, works through it, closes on the point.",
            "embedded_instructions_found": False,
            "slides": [
                {**slide, "source_ids": []} for slide in plan.model_dump(mode="json")["slides"]
            ],
        },
    )
    client.register(
        "structured",
        {
            "mood": "calm, technical",
            "emphasis_role": "headline",
            "accent_token": "colors.accent",
            "typography_scale": "balanced",
            "rationale": "The deterministic planner uses the theme as it stands.",
            # The Layout Agent reads the same task type; an empty choice list
            # means "no changes", which is the honest answer from a stub.
            "choices": [],
            "warnings": [],
        },
    )
    client.register(
        "critique",
        {
            "verdict": "pass",
            "score": 0.6,
            "issues": [],
            "summary": "Composed by the deterministic planner; not reviewed by a model.",
        },
    )
    return client


# --------------------------------------------------------------- the service


@dataclass
class AgentOutcome:
    result: RunResult
    document: dict[str, Any] | None
    operations: list[dict[str, Any]]
    risk_tier: str
    requires_approval: bool
    source: str


def _checkpointer() -> Any | None:
    """The durable checkpointer, when the database can carry one.

    Postgres only. SQLite is the local-development database and LangGraph has no
    saver for it, so a run there simply cannot pause — which is worth saying out
    loud rather than discovering when a checkpoint silently does nothing.
    """
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        return None

    try:
        from langgraph.checkpoint.postgres import PostgresSaver
    except ImportError:  # pragma: no cover - the package is a hard dependency
        logger.warning("langgraph-checkpoint-postgres is not installed; runs cannot pause.")
        return None

    try:
        # psycopg wants its own URL, without SQLAlchemy's driver suffix.
        saver = PostgresSaver.from_conn_string(url.replace("+psycopg", ""))
        checkpointer = saver.__enter__()
        checkpointer.setup()
        return checkpointer
    except Exception as exc:  # noqa: BLE001 - a run without checkpoints beats no run
        logger.warning("Could not open the LangGraph checkpointer: %s", exc)
        return None


def _emitter(run_id: str) -> Emitter | None:
    url = os.environ.get("REDIS_URL")
    if not url:
        return None
    try:
        import redis

        return RedisEmitter(redis.Redis.from_url(url))
    except Exception as exc:  # noqa: BLE001 - progress is not worth failing a run
        logger.warning("Could not connect to Redis for progress events: %s", exc)
        return None


def build_registry(document_provider: Callable[[], dict[str, Any]]) -> ToolRegistry:
    """A registry wired to one live document.

    `validate_patch` is the tool an agent uses before proposing. It applies the
    patch to a *copy* and validates the result — the agent learns whether its
    patch works without anything being written, which is the whole point of the
    separation between proposing and applying.
    """

    def validate_patch(operations: list[dict[str, Any]]) -> dict[str, Any]:
        try:
            document, _ = apply_patch(document_provider(), operations)
        except PatchError as error:
            return {"valid": False, "errors": [str(error)], "risk_tier": "unknown"}

        try:
            errors = validate_document(document)
        except SchemaUnavailable as exc:
            return {"valid": False, "errors": [str(exc)], "risk_tier": "unknown"}

        return {
            "valid": not errors,
            "errors": errors,
            # Reported to the agent so it can see what it is asking for — but
            # recomputed server-side at apply time regardless (doc 02 §31.7).
            "risk_tier": assess_risk(operations).tier,
        }

    registry = ToolRegistry(permissions={"presentation.read"})
    register_presentation_tools(
        registry, document_provider=document_provider, validate_patch=validate_patch
    )
    return registry


def _composer(
    request: GenerateRequest, produced: dict[str, Any]
) -> Callable[[dict[str, Any], dict[str, Any]], list[dict[str, Any]]]:
    """Story plan -> patch operations.

    The agent proposes intent; this turns it into a document through the same
    deterministic composer the Phase 1 path uses, and then into operations. Every
    geometric decision is made here, by code, the same way every time.
    """

    def compose(plan: dict[str, Any], direction: dict[str, Any]) -> list[dict[str, Any]]:
        # The agent's StoryPlan and the composer's are different contracts on
        # purpose: the agent's carries provenance and an injection flag the
        # composer has no use for, and the composer's carries the request context
        # the agent was given rather than asked to repeat. Mapping between them
        # here is the honest cost of that separation.
        story_plan = StoryPlan.model_validate(
            {
                "title": plan.get("title", "") or request.instruction[:80],
                "audience": request.audience,
                "objective": request.objective,
                "narrative_arc": plan.get("narrative_arc", ""),
                "slides": [
                    {key: value for key, value in slide.items() if key != "source_ids"}
                    for slide in plan.get("slides", [])
                ],
            }
        )
        document = compose_document(story_plan, instruction=request.instruction)

        # Kept for the caller. The composer runs once; asking main.py to compose
        # the same plan again would be a second chance for the two to differ.
        produced["document"] = document

        # Replace the whole slide array in one operation. A new deck is not a
        # sequence of edits to an old one, and pretending otherwise would produce
        # an inverse nobody can read.
        return [{"op": "replace", "path": "/slides", "value": document["slides"]}]

    return compose


def run_deck_generation(
    request: GenerateRequest,
    *,
    run_id: str,
    user_id: str,
    project_id: str,
    presentation_id: str,
    document: dict[str, Any],
    memory: ProjectMemory | None = None,
    budget: RunBudget | None = None,
    human_checkpoint: bool = False,
) -> AgentOutcome:
    """Run the graph for a whole-deck generation."""
    state_document = document

    def provider() -> dict[str, Any]:
        return state_document

    client = default_client() if api_key_available() else _stub_answers(request)
    emitter = _emitter(run_id)
    produced: dict[str, Any] = {}

    run = AgentRun(
        client=client,
        registry=build_registry(provider),
        compose=_composer(request, produced),
        budget=budget or RunBudget(),
        memory=memory,
        emit=fan_out(emitter) if emitter else None,
        checkpointer=_checkpointer() if human_checkpoint else None,
        human_checkpoint=human_checkpoint,
    )

    result = run_generation(
        run,
        initial_state(
            run_id=run_id,
            user_id=user_id,
            project_id=project_id,
            presentation_id=presentation_id,
            request=request.model_dump(mode="json"),
            document=document,
        ),
    )

    operations = result.operations
    assessment = assess_risk(operations) if operations else assess_risk([])

    return AgentOutcome(
        result=result,
        document=produced.get("document"),
        operations=operations,
        risk_tier=assessment.tier,
        requires_approval=assessment.requires_approval,
        source="model" if api_key_available() else "stub",
    )


def resume(run_id: str, decision: dict[str, Any], request: GenerateRequest, document: dict[str, Any]) -> RunResult:
    """Continue a run parked at the story checkpoint."""
    checkpointer = _checkpointer()
    if checkpointer is None:
        raise RuntimeError(
            "This run cannot be resumed: durable checkpoints need PostgreSQL, and "
            "this server is not using it."
        )

    run = AgentRun(
        client=default_client() if api_key_available() else _stub_answers(request),
        registry=build_registry(lambda: document),
        compose=_composer(request, {}),
        checkpointer=checkpointer,
    )
    return resume_generation(run, run_id, decision)
