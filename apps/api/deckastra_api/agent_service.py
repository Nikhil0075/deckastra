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
from pathlib import Path
from copy import deepcopy
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
from deckastra_agents.router import PROVIDER_STUB, default_client, selected_provider
from deckastra_agents.runner import resume_generation, run_generation
from deckastra_agents.tools.presentation import register_presentation_tools
from deckastra_agents.tools.repository import register_repository_tools
from sqlalchemy.orm import Session

from . import retrieval, telemetry
from .compose import compose_document
from .db.models import Repository
from .models import GenerateRequest, StoryPlan
from .patch import PatchError, apply_patch
from .risk import assess_risk
from .schema import SchemaUnavailable, validate_document

logger = logging.getLogger("deckastra.agents")


# ------------------------------------------------------------------ stubbing


def _stub_answers(
    request: GenerateRequest, repositories: list[Repository] | None = None
) -> StubClient:
    """A deterministic client that walks the whole graph without credentials.

    Not a test mock — it is what keeps the agent path exercisable on a fresh
    clone and in CI: the graph, the routing, the checkpointer, the streaming and
    the proposal lifecycle all run, and only the model's judgement is missing.
    Its decks say so in the UI.
    """
    from .stub import parse_sources, stub_repository_story_plan, stub_story_plan

    plan = stub_story_plan(request)
    client = StubClient()

    # One task type, two callers: the Orchestrator asks first and the Research
    # Agent asks second, so the answer carries both shapes. A stub that answered
    # only the first would make the research stage look like a model failure.
    client.register(
        "fast",
        {
            "intent": "create_deck",
            "stages": (
                ["research", "story", "creative", "layout", "motion", "critic"]
                if repositories
                else ["story", "creative", "layout", "motion", "critic"]
            ),
            "scope_kind": "deck",
            "needs_research": bool(repositories),
            "reasoning": "A new deck, composed by the deterministic planner.",
            "clarification_needed": "",
            # The brief first. A lexical index answers the user's own words far
            # better than three generic questions, and a stub that ignores what
            # was asked produces a deck about the wrong part of the repository.
            "questions": [
                request.instruction[:200],
                "architecture overview",
                "how is it structured",
                "what is it built with",
            ],
            "focus": "An overview of the connected repository.",
        },
    )
    generic = {
        **plan.model_dump(mode="json"),
        "narrative_arc": "Opens with the brief, works through it, closes on the point.",
        "embedded_instructions_found": False,
        "slides": [
            {**slide, "source_ids": []} for slide in plan.model_dump(mode="json")["slides"]
        ],
    }

    def planning(model_request: Any) -> dict[str, Any]:
        """The story answer, chosen from what the prompt actually contains.

        A callable rather than a fixed payload because a grounded deck cannot be
        written before the retrieval that grounds it. When the Research Agent
        found repository chunks, they are in this prompt, and the stub writes a
        deck out of them that cites them truthfully. When it found nothing, the
        generic deck is the honest answer.
        """
        text = "\n".join(
            str(message.get("content", "")) for message in model_request.messages
        )
        sources = parse_sources(text)
        return stub_repository_story_plan(request, sources) if sources else generic

    client.register("planning", planning)
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
            # So does the Motion Agent. A stub that choreographed every slide
            # would make a placeholder deck busier than a generated one, which is
            # exactly backwards — but one restrained entrance keeps the whole
            # motion path (compose, compile, sample, play) exercised in CI.
            "slides": [
                {
                    "slide_id": "0",
                    "sequence": ["headline", "subtitle"],
                    "entrance": "blurReveal",
                    "pacing": "measured",
                    "click_reveals": 0,
                    "rationale": "The title arrives before the line that qualifies it.",
                }
            ],
            "warnings": [],
        },
    )
    client.register(
        "critique",
        {
            "verdict": "pass",
            # Middling across the board, and honestly so: no model looked at this
            # deck. A stub that scored itself 0.9 would make the agent inspector
            # show a confident review that never happened.
            "scores": {
                "hierarchy": 0.6,
                "readability": 0.6,
                "contrast": 0.6,
                "alignment": 0.6,
                "density": 0.6,
                "consistency": 0.6,
                "narrative_clarity": 0.6,
                "motion_quality": None,
            },
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
    """The durable checkpointer, matched to whichever database is configured.

    The human checkpoint before the story is approved is a *product* feature, not
    a deployment detail: a run that cannot pause cannot be reviewed. So both
    engines the product runs on carry a saver — Postgres for the deployed
    service, SQLite for the desktop, which is one process on one machine and does
    not need a server to hold a paused graph.

    A failure here is downgraded rather than raised, because a run without
    checkpoints still produces a deck and a run that refused to start produces
    nothing. `resume` is where the absence becomes an error, and only for the one
    operation that genuinely cannot proceed without one.
    """
    url = os.environ.get("DATABASE_URL", "")

    if url.startswith("postgresql"):
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

    if url.startswith("sqlite"):
        path = _sqlite_checkpoint_path(url)
        if path is None:
            # An in-memory database, which the test suite uses. Each connection
            # would get its own empty database, so a checkpoint written by one
            # would be invisible to the next — worse than none, because it would
            # look durable.
            return None
        try:
            from langgraph.checkpoint.sqlite import SqliteSaver
        except ImportError:
            logger.warning("langgraph-checkpoint-sqlite is not installed; runs cannot pause.")
            return None
        try:
            saver = SqliteSaver.from_conn_string(str(path))
            checkpointer = saver.__enter__()
            checkpointer.setup()
            return checkpointer
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not open the LangGraph checkpointer: %s", exc)
            return None

    return None


def _sqlite_checkpoint_path(url: str) -> Path | None:
    """Where a SQLite install keeps its graph checkpoints.

    Beside the application database rather than inside it. They are LangGraph's
    tables, on LangGraph's schema, migrated by LangGraph — putting them in a file
    Alembic owns would make every `alembic check` see tables it did not create.
    """
    location = url.split("///", 1)[-1] if "///" in url else ""
    if not location or location.startswith(":memory:"):
        return None
    return Path(location).with_name(Path(location).name + ".checkpoints")


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


def add_repository_tools(
    registry: ToolRegistry,
    session: Session,
    repositories: list[Repository],
) -> None:
    """Give a registry access to a workspace's indexed repositories.

    The permission is granted here, on a registry built for one run against
    repositories already resolved for that workspace. An agent never names a
    repository id it was not given, and a repository from another workspace never
    reaches this list — which is what keeps one customer's private code out of
    another's deck.
    """
    if not repositories:
        return

    ids = [repository.id for repository in repositories]
    by_id = {repository.id: repository for repository in repositories}

    def profile() -> list[dict[str, Any]]:
        return [retrieval.repository_summary(repository) for repository in repositories]

    def search(query: str, limit: int) -> list[dict[str, Any]]:
        return [
            {
                "path": hit.path,
                # The repository is part of the answer, not context the caller is
                # expected to remember: a search spans all of them.
                "repository": hit.repository_full_name,
                "repository_id": hit.repository_id,
                "start_line": hit.start_line,
                "end_line": hit.end_line,
                "language": hit.language,
                "content": hit.content,
                "similarity": hit.similarity,
                "reference": hit.reference,
                "source_id": hit.source_id,
                "why_selected": hit.selection_reason,
            }
            for hit in retrieval.search(session, ids, query, limit=limit)
        ]

    def read_file(repository_id: str, path: str) -> dict[str, Any]:
        """Reassembled from indexed chunks, not re-fetched from the host.

        Two reasons. A file that was never indexed is a file the ignore rules
        excluded — a lockfile, a binary, something that looked like a secret —
        and re-fetching it would route around that decision. And an agent asking
        for a file should not be able to make the server call GitHub.
        """
        from .db.models import RepositoryChunk

        target_ids = [repository_id] if repository_id in by_id else ids

        chunks = (
            session.query(RepositoryChunk)
            .filter(
                RepositoryChunk.repository_id.in_(target_ids),
                RepositoryChunk.path == path,
            )
            .order_by(RepositoryChunk.start_line.asc())
            .all()
        )

        if not chunks:
            return {"path": path, "content": "", "found": False, "truncated": False}

        # Chunks overlap by design, so a naive join would repeat lines.
        lines: list[str] = []
        next_line = 1
        for chunk in chunks:
            body = chunk.content.splitlines()
            skip = max(0, next_line - chunk.start_line)
            lines.extend(body[skip:])
            next_line = max(next_line, chunk.end_line + 1)

        text = "\n".join(lines)
        truncated = len(text) > 40_000
        return {
            "path": path,
            "content": text[:40_000],
            "found": True,
            "truncated": truncated,
        }

    registry._permissions.add("repository.read")
    register_repository_tools(
        registry, profile=profile, search=search, read_file=read_file
    )


def _composer(
    request: GenerateRequest, produced: dict[str, Any], *,
    theme_definition: dict[str, Any] | None = None, theme_id: str | None = None,
) -> Callable[[dict[str, Any], dict[str, Any], dict[str, Any]], list[dict[str, Any]]]:
    """Story plan -> patch operations.

    The agent proposes intent; this turns it into a document through the same
    deterministic composer the Phase 1 path uses, and then into operations. Every
    geometric decision is made here, by code, the same way every time.
    """

    def compose(
        plan: dict[str, Any],
        direction: dict[str, Any],
        motion_plan: dict[str, Any],
    ) -> list[dict[str, Any]]:
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
        document = compose_document(
            story_plan,
            instruction=request.instruction,
            motion_plan=motion_plan,
            theme_definition=theme_definition,
            theme_id=theme_id,
        )

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
    session: Session | None = None,
    repositories: list[Repository] | None = None,
    workspace_id: str | None = None,
    theme_definition: dict[str, Any] | None = None,
    theme_id: str | None = None,
) -> AgentOutcome:
    """Run the graph for a whole-deck generation."""
    state_document = document

    def provider() -> dict[str, Any]:
        return state_document

    # Not `if api_key_available()`. That asked the right question only while there
    # were two answers: with local intelligence selected, a keyless install is a
    # local-model install, and this line would have quietly run the stub instead —
    # which is the failure the whole D3 selection exists to refuse.
    client = default_client(fallback=lambda: _stub_answers(request, repositories))
    emitter = _emitter(run_id)
    produced: dict[str, Any] = {}

    registry = build_registry(provider)
    if session is not None and repositories:
        add_repository_tools(registry, session, repositories)

    run = AgentRun(
        client=telemetry.TracedModelClient(client, run_id),
        registry=registry,
        compose=_composer(request, produced, theme_definition=theme_definition, theme_id=theme_id),
        budget=budget or RunBudget(),
        memory=memory,
        emit=fan_out(emitter) if emitter else None,
        checkpointer=_checkpointer() if human_checkpoint else None,
        human_checkpoint=human_checkpoint,
    )

    with telemetry.span("agent.run", **{telemetry.RUN_ID: run_id, telemetry.WORKSPACE_ID: workspace_id}) as current:
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
        current.set_attribute(telemetry.OUTCOME, result.status)

    operations = result.operations
    assessment = assess_risk(operations) if operations else assess_risk([])
    final_document = produced.get("document")
    if final_document is not None:
        # Proposal metadata is appended after composition. Persist the final
        # validated proposal, including extensions, rather than its earlier
        # composer snapshot. Keep the composer's generated document metadata.
        final_document, _ = apply_patch(final_document, operations)
        errors = validate_document(final_document)
        if errors:
            raise ValueError(f"Generated proposal is invalid: {errors}")

    return AgentOutcome(
        result=result,
        document=final_document,
        operations=operations,
        risk_tier=assessment.tier,
        requires_approval=assessment.requires_approval,
        # "model" covers a local model as well as a cloud one: the document's own
        # record of who wrote it must not call a local run a stub run.
        source="stub" if selected_provider() == PROVIDER_STUB else "model",
    )


def resume(run_id: str, decision: dict[str, Any], request: GenerateRequest, document: dict[str, Any]) -> RunResult:
    """Continue a run parked at the story checkpoint."""
    checkpointer = _checkpointer()
    if checkpointer is None:
        raise RuntimeError(
            "This run cannot be resumed: durable checkpoints need PostgreSQL, and "
            "this server is not using it."
        )

    checkpoint_theme = document.get("theme")
    checkpoint_theme_id = (document.get("metadata") or {}).get("themeId")
    run = AgentRun(
        client=telemetry.TracedModelClient(default_client(fallback=lambda: _stub_answers(request)), run_id),
        registry=build_registry(lambda: document),
        compose=_composer(
            request,
            {},
            theme_definition=deepcopy(checkpoint_theme) if isinstance(checkpoint_theme, dict) else None,
            theme_id=str(checkpoint_theme_id) if checkpoint_theme_id else None,
        ),
        checkpointer=checkpointer,
    )
    with telemetry.span("agent.run", **{telemetry.RUN_ID: run_id}) as current:
        result = resume_generation(run, run_id, decision)
        current.set_attribute(telemetry.OUTCOME, result.status)
        return result
