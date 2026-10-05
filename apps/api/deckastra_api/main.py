"""Deckastra API.

Phase 1 generated decks into process memory. Phase 2 gives them a database, a
version chain, and an authorization chain — so a deck survives a restart, every
change is attributable, and every change is reversible.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from copy import deepcopy
from typing import Any

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import update
from sqlalchemy.orm import Session

from . import grants, local_mode, store, themes
from .auth import (
    Principal,
    current_principal,
    issue_dev_token,
    provision_personal_account,
    resolve_creation_project,
)
from .paths import migrations_digest
from .compose import compose_document
from .db.models import AgentRunRow
from .db.session import database_url, get_session, session_middleware
from .models import (
    GenerateRequest,
    GenerateResponse,
    GenerationDiagnostics,
    OutlineSlide,
    ReviewedGeneration,
    StoryDecision,
    StoryOutline,
)
from deckastra_agents import ProjectMemory
from deckastra_agents.router import MODELS as router_models

from . import agent_service, agent_store, provenance, quotas, repository_service, telemetry
from .agent_routes import router as agent_router
from .export_routes import router as export_router
from .gateway_routes import router as gateway_router
from .account_deletion import router as deletion_router
from .mydeck_import import router as import_router
from .font_packs import router as font_pack_router
from .oauth_routes import router as oauth_router
from .repository_routes import router as repository_router
from .workspace_routes import router as workspace_router
from .language_routes import router as language_router
from .assistant_routes import router as assistant_router
from .assistant_assets import router as assistant_assets_router
from .assistant_design import router as assistant_design_router
from .routes import router as v1_router
from .schema import SchemaUnavailable, validate_document
from deckastra_agents.router import PROVIDER_STUB, ModelUnavailable, generation_status, selected_provider

from .story import StoryGenerationError, generate_story_plan

logger = logging.getLogger("deckastra")


@asynccontextmanager
async def _lifespan(application: FastAPI):
    telemetry.configure()
    # Checked at startup so a mistyped mode is in the log the moment the service
    # comes up, not first discovered when someone presses Generate. A warning, not
    # a refusal to start: decks, history and export need no model, and a service
    # that would not start over this setting would lock someone out of their work.
    try:
        selected_provider()
    except ModelUnavailable as exc:
        logger.warning("%s Generation is unavailable until this is fixed.", exc)
    from .assistant_routes import start_dispatcher
    assistant_stop = start_dispatcher()
    try:
        yield
    finally:
        assistant_stop.set()
        telemetry.shutdown()


app = FastAPI(
    title="Deckastra API",
    version="0.2.0",
    description="Documents, transactions and versioned history.",
    lifespan=_lifespan,
)


@app.exception_handler(ModelUnavailable)
async def _model_unavailable(_request, exc: ModelUnavailable):
    """Any route that reaches for a model the install cannot provide answers 503.

    The generation routes catch this themselves to finish their run rows first;
    this is for every other path that builds a client — Ask's edit agent is the one
    today — so a missing model pack or a mistyped mode is "not available here" with
    the reason, never a 500 that reads like a crash.
    """
    return JSONResponse(status_code=503, content={"detail": str(exc)})

# Providers start/flush with application lifespan. The manual middleware records
# only fixed operation names, HTTP method/status; no headers, URLs or bodies.
app.middleware("http")(telemetry.http_middleware)

# Added before CORS so CORS ends up the outer layer: a preflight is answered
# without opening a database session, and every response — including an error —
# still carries its CORS headers.
app.middleware("http")(session_middleware)
# Outside the session middleware, because a credential that may not make this
# request should be refused before a transaction is opened for it. Only local
# mode has narrowed credentials; everywhere else this passes everything through.
app.middleware("http")(grants.scope_middleware)

# Locked to localhost rather than "*" — a permissive default here survives into
# production because nothing ever visibly breaks.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip().rstrip("/") for origin in os.environ.get("DECKASTRA_WEB_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if origin.strip() and origin.strip() != "*"],
    allow_methods=["GET", "POST", "DELETE", "PATCH", "PUT"],
    allow_headers=["Content-Type", "Authorization", "X-Deckastra-Device"],
)

app.include_router(v1_router)
app.include_router(agent_router)
app.include_router(repository_router)
app.include_router(export_router)
app.include_router(gateway_router)
app.include_router(deletion_router)
app.include_router(import_router)
app.include_router(font_pack_router)
app.include_router(oauth_router)
app.include_router(workspace_router)
app.include_router(language_router)
app.include_router(assistant_router)
app.include_router(assistant_assets_router)
app.include_router(assistant_design_router)


@app.get("/ready")
def ready(session: Session = Depends(get_session)):
    from sqlalchemy import text
    try:
        session.execute(text("SELECT 1"))
        session.execute(text("SELECT user_id FROM credit_accounts LIMIT 1"))
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Database or schema is not ready.") from exc
    return {"status": "ready"}


@app.get("/health")
def health(session: Session = Depends(get_session)) -> dict[str, Any]:
    url = database_url()
    # Scheme only. A health endpoint that echoes a connection string is a health
    # endpoint that leaks a password.
    dialect = url.split("://", 1)[0]

    # Reported, never raised: the service still serves decks, and health is
    # where someone checking the configuration looks.
    status = generation_status()
    report: dict[str, object] = {
        "status": "ok",
        # Surfaced so the UI can tell the user their deck will be stub-composed
        # before they wait for a generation, rather than after. A local model is
        # a model: asking for a key here would have called a local install stub.
        "generation": ("stub" if status["provider"] == PROVIDER_STUB else "model") if status["available"] else "unavailable",
        # And which one, because "no cloud traffic in local mode" is a claim
        # somebody has to be able to check from outside the process.
        "intelligence": status["provider"],
        "database": dialect,
        # What this service's migrations hash to (item 07). The desktop app
        # compares it with what its build manifest recorded, so a window paired
        # with a service built from other migrations is caught rather than
        # trusted to be its own.
        "migrations": migrations_digest(),
    }
    if status["reason"]:
        report["intelligence_error"] = status["reason"]
    return report


@app.post("/v1/dev/session")
def dev_session(
    email: str = Body(embed=True, default="dev@localhost"),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Bootstrap a user, a workspace and a project, and return a token.

    Development only, and deliberately shaped like the real thing: it returns a
    signed token, and the user it creates is a *member* of the workspace rather
    than merely its owner — so every authorization path taken here is the one real
    sign-in will take in Phase 9.
    """
    if os.environ.get("DECKASTRA_ENV") == "production":
        raise HTTPException(status_code=404, detail="Not found.")

    # Local mode already has its one account, seeded at launch. Bootstrapping a
    # second here would create a second workspace that owns none of the decks —
    # and the caller would not find out until a read returned 404.
    if local_mode.enabled():
        raise HTTPException(status_code=404, detail="Not found.")

    user, workspace, project = provision_personal_account(
        session, email=email, name=email.split("@", 1)[0]
    )

    return {
        "token": issue_dev_token(user.id),
        "user_id": user.id,
        "workspace_id": workspace.id,
        "project_id": project.id,
    }


def _empty_document(
    request: GenerateRequest,
    *,
    theme_definition: dict[str, Any] | None = None,
    theme_id: str | None = None,
) -> dict[str, Any]:
    """A minimal document for a run that is creating a deck rather than editing one.

    The graph's tools read the current document, and a new deck has none. An
    empty shell is more honest than passing `None` and making every tool handle
    the absence.
    """
    metadata: dict[str, Any] = {"title": request.instruction[:80]}
    if theme_id is not None:
        metadata["themeId"] = theme_id
    document: dict[str, Any] = {"metadata": metadata, "slides": []}
    if theme_definition is not None:
        # This exact resolved snapshot enters the checkpoint. A resumed run must
        # never look up a newer default and silently change brand mid-generation.
        document["theme"] = deepcopy(theme_definition)
    return document


@dataclass
class _GenerationSetup:
    """What every generation resolves before any model is asked anything."""

    project_id: str
    workspace_id: str
    theme_definition: dict[str, Any] | None
    theme_id: str | None


def _prepare_generation(session: Session, principal: Principal, request: GenerateRequest) -> _GenerationSetup:
    project = resolve_creation_project(session, user_id=principal.user_id, project_id=request.project_id)
    default_theme = themes.default_for(session, project.workspace_id)
    setup = _GenerationSetup(
        project_id=project.id,
        workspace_id=project.workspace_id,
        # Freeze one portable definition for every candidate and any final fallback.
        theme_definition=deepcopy(default_theme.definition_json) if default_theme else None,
        theme_id=default_theme.id if default_theme else None,
    )
    _check_generation_quota(session, setup.workspace_id)
    return setup


def _check_generation_quota(session: Session, workspace_id: str) -> None:
    # Refused before the work, not after (gap register doc 01 S3). Checking
    # afterwards means paying for the request that broke the limit, and the
    # user has no way to tell a limit from a failure.
    try:
        quotas.check_generation(session, workspace_id)
    except quotas.QuotaExceeded as exceeded:
        telemetry.record_quota_refusal(
            workspace_id=workspace_id, limit=exceeded.limit
        )
        # 429 rather than 403: this is a rate the caller can wait out, and the
        # detail carries the numbers so the message can say which limit and when
        # it resets rather than "quota exceeded".
        raise HTTPException(status_code=429, detail=exceeded.as_detail()) from exceeded


def _run_graph(
    session: Session,
    principal: Principal,
    request: GenerateRequest,
    setup: _GenerationSetup,
    run_row: Any,
    *,
    human_checkpoint: bool,
) -> agent_service.AgentOutcome:
    # Journey B: a deck grounded in a repository. Resolved for this workspace
    # rather than trusted from the request — a repository id from another
    # workspace must not become a source, and `resolve_many` is where that is
    # enforced rather than assumed.
    repositories = [
        repository
        for repository in repository_service.resolve_many(
            session, setup.workspace_id, request.repository_ids
        )
        if repository.index_status == "ready"
    ]
    try:
        return agent_service.run_deck_generation(
            request,
            run_id=run_row.id,
            user_id=principal.user_id,
            project_id=setup.project_id,
            presentation_id="",
            document=_empty_document(
                request, theme_definition=setup.theme_definition, theme_id=setup.theme_id
            ),
            memory=ProjectMemory(
                agent_store.SqlMemoryStore(session, principal.user_id), setup.project_id
            ),
            human_checkpoint=human_checkpoint,
            session=session,
            repositories=repositories,
            workspace_id=setup.workspace_id,
            theme_definition=setup.theme_definition,
            theme_id=setup.theme_id,
        )
    except ModelUnavailable as exc:
        # 503 rather than 502, and no "the agent run failed" in front of it:
        # nothing failed and nothing is upstream. Something the install was
        # told to use is not there, and the message says which and what to do.
        agent_store.finish_run(session, run_row, status="failed", errors=[{"message": str(exc)}])
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - reported with its reason, not a bare 500
        logger.exception("Agent run failed")
        agent_store.finish_run(session, run_row, status="failed", errors=[{"message": str(exc)}])
        raise HTTPException(status_code=502, detail=f"The agent run failed: {exc}") from exc


def _graph_deck(
    session: Session, run_row: Any, outcome: agent_service.AgentOutcome
) -> tuple[dict[str, Any], GenerationDiagnostics]:
    """A finished graph run's document and its diagnostics."""
    result = outcome.result
    agent_store.finish_run(
        session,
        run_row,
        status=result.status,
        stage=result.state.get("current_stage"),
        warnings=result.warnings,
        errors=result.errors,
        budget=result.budget,
    )

    if result.status != "completed" or not outcome.operations:
        # The reason goes into the sentence people are shown. Clients render
        # `detail.message` and nothing else, so a bare "did not produce a deck"
        # left someone with a valid key and no idea the API had refused the
        # request — the cause sat in `errors`, unread.
        reason = next(
            (
                f" {error.get('stage') or 'A stage'} failed: {error['message']}"
                for error in result.errors
                if isinstance(error, dict) and error.get("message")
            ),
            "",
        )
        raise HTTPException(
            status_code=502,
            detail={
                "message": f"The agent run did not produce a deck.{reason}",
                "errors": result.errors,
                "warnings": result.warnings,
            },
        )

    # The graph already composed the document; composing it again from the
    # plan would be a second implementation of the same step, free to differ.
    document = outcome.document
    if document is None:
        raise HTTPException(
            status_code=502, detail="The agent run produced no document."
        )

    # Doc 02 §30: provenance lives in the document, not a side table, so a
    # user can click a claim and see which file produced it — and so that
    # survives export and duplication.
    research = outcome.result.state.get("research") or {}
    story_plan = outcome.result.state.get("story_plan") or {}
    records = provenance.records_for_document(
        document, story_plan, research.get("sources") or []
    )
    if records:
        document = provenance.attach(document, records)

    structured = result.budget.get("structured_requests", [])
    plans = [entry for entry in structured if entry["stage"] == "story"]
    diagnostics = GenerationDiagnostics(
        source="model" if outcome.source == "model" else "stub",
        model=router_models.get("planning", "") if outcome.source == "model" else "",
        duration_ms=int(result.budget.get("elapsed_seconds", 0) * 1000),
        # Maximum schema attempts for any structured request, not the number
        # of graph nodes or provider-internal transport retries. Empty
        # observations cannot establish first-attempt validity.
        attempts=max((entry["attempts"] for entry in structured), default=0),
        valid_first_attempt=bool(structured) and all(entry["valid_first_attempt"] for entry in structured),
        plan_valid_first_attempt=bool(plans) and all(entry["valid_first_attempt"] for entry in plans),
        input_tokens=result.budget.get("input_tokens", 0),
        output_tokens=result.budget.get("output_tokens", 0),
        validation_errors=[
            f"{entry['stage']}: {entry['contract']} required schema repair."
            for entry in structured if entry["attempts"] > 1
        ],
        warnings=list(result.warnings),
    )
    return document, diagnostics


def _store_generated(
    session: Session,
    principal: Principal,
    run_row: Any,
    document: dict[str, Any],
    diagnostics: GenerationDiagnostics,
    *,
    project_id: str,
    workspace_id: str,
) -> GenerateResponse:
    try:
        errors = validate_document(document)
    except SchemaUnavailable as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if errors:
        # The composer is deterministic, so this is a bug in the composer rather
        # than a bad model response — which is why it must be loud instead of
        # storing a deck the renderer will refuse anyway (doc 04 §6.4).
        logger.error("Composed an invalid document: %s", errors)
        diagnostics.valid_first_attempt = False
        diagnostics.validation_errors.extend(errors)
        raise HTTPException(
            status_code=500,
            detail={"message": "Composed document failed schema validation.", "errors": errors},
        )

    stored = store.create_presentation(
        session,
        project_id=project_id,
        document=document,
        created_by=principal.user_id,
        source="agent" if diagnostics.source == "model" else "system",
    )

    run_row.presentation_id = stored.presentation_id

    # Charged after the fact, with what the run actually spent. A reservation
    # taken up front has to be released, and a crash in between leaves the
    # workspace permanently poorer.
    quotas.record_generation(
        session,
        workspace_id,
        tokens=diagnostics.input_tokens + diagnostics.output_tokens,
    )

    # Ids and counts, never the prompt or the copy. A trace store is a third
    # party, and a span attribute is the easiest place in a system to leak a
    # customer's words without noticing.
    telemetry.record_generation(
        workspace_id=workspace_id,
        run_id=run_row.id,
        duration_ms=diagnostics.duration_ms,
        tokens_in=diagnostics.input_tokens,
        tokens_out=diagnostics.output_tokens,
        outcome=diagnostics.source,
    )
    session.flush()

    return GenerateResponse(
        presentation_id=stored.presentation_id,
        version_id=stored.version_id,
        document=stored.document,
        diagnostics=diagnostics,
        run_id=run_row.id,
    )


@app.post("/v1/generate", response_model=GenerateResponse)
def generate(
    request: GenerateRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> GenerateResponse:
    setup = _prepare_generation(session, principal, request)

    # The agent graph, not a single-shot chain (doc 03 §4). The Orchestrator
    # routes, the Story Architect writes, the Layout Agent checks the fit, the
    # Critic reviews — and the composer still makes every geometric decision.
    #
    # `use_graph=False` falls back to the Phase 1 path. It exists because the
    # graph is new and the single-shot chain is the thing that has been working;
    # a flag that lets an operator go back is cheaper than a rollback.
    run_row = agent_store.start_run(
        session,
        project_id=setup.project_id,
        presentation_id=None,
        created_by=principal.user_id,
        intent=request.instruction[:500],
    )

    if request.use_graph:
        outcome = _run_graph(session, principal, request, setup, run_row, human_checkpoint=False)
        document, diagnostics = _graph_deck(session, run_row, outcome)
    else:
        try:
            plan, diagnostics = generate_story_plan(request)
        except ModelUnavailable as exc:
            agent_store.finish_run(session, run_row, status="failed", errors=[{"message": str(exc)}])
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except StoryGenerationError as exc:
            # 502, not 500: the failure is upstream, and the message is the useful part.
            agent_store.finish_run(session, run_row, status="failed", errors=[{"message": str(exc)}])
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        agent_store.finish_run(session, run_row, status="completed", stage="story")
        document = compose_document(
            plan,
            instruction=request.instruction,
            locale=request.locale,
            theme_definition=setup.theme_definition,
            theme_id=setup.theme_id,
        )

    return _store_generated(
        session, principal, run_row, document, diagnostics,
        project_id=setup.project_id, workspace_id=setup.workspace_id,
    )


# ------------------------------------------------------- the story checkpoint


def _outline(values: dict[str, Any]) -> StoryOutline:
    """What a person reviews at the checkpoint: the plan's words, no geometry."""
    plan = values.get("story_plan") or {}
    return StoryOutline(
        title=str(plan.get("title") or ""),
        narrative_arc=str(plan.get("narrative_arc") or ""),
        slides=[
            OutlineSlide(
                headline=str(slide.get("headline") or ""),
                key_message=str(slide.get("key_message") or ""),
                layout=str(slide.get("layout") or ""),
            )
            for slide in plan.get("slides") or []
        ],
        warnings=[str(warning) for warning in values.get("warnings") or []],
    )


def _spent(outcome: agent_service.AgentOutcome) -> int:
    budget = outcome.result.budget or {}
    return int(budget.get("input_tokens", 0)) + int(budget.get("output_tokens", 0))


def _paused_answer(
    session: Session, run_row: Any, outcome: agent_service.AgentOutcome, workspace_id: str
) -> ReviewedGeneration:
    """A run that stopped at its outline: charge what it spent, and show it."""
    result = outcome.result
    agent_store.finish_run(
        session,
        run_row,
        status="awaiting_approval",
        stage="story",
        warnings=result.warnings,
        errors=result.errors,
        budget=result.budget,
    )
    # Tokens now, the generation once a deck exists. A person who revises three
    # times has spent four outlines' worth of tokens, and a workspace whose
    # reviewers abandon outlines has still spent them.
    quotas.record_tokens(session, workspace_id, tokens=_spent(outcome))
    return ReviewedGeneration(
        run_id=run_row.id,
        status="awaiting_story",
        outline=_outline(result.state),
    )


@app.post("/v1/generate/review", response_model=ReviewedGeneration)
def generate_with_review(
    request: GenerateRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ReviewedGeneration:
    """Generate a deck, stopping at the outline for a person to approve.

    Its own route rather than a flag on `/v1/generate`, because the answer is a
    different thing: an outline and a run to resume, not a deck. A client that
    asked for a deck and sometimes got an outline would have to check which it
    was on every call.
    """
    if not agent_service.checkpoints_available():
        # Said, not quietly run through: a person who asked to see the outline
        # first would otherwise get a deck they never approved.
        raise HTTPException(
            status_code=409,
            detail="This server cannot pause a run, so it cannot show the outline first.",
        )
    if not request.use_graph:
        raise HTTPException(status_code=422, detail="Only the agent graph has an outline to review.")
    setup = _prepare_generation(session, principal, request)
    run_row = agent_store.start_run(
        session,
        project_id=setup.project_id,
        presentation_id=None,
        created_by=principal.user_id,
        intent=request.instruction[:500],
    )
    outcome = _run_graph(session, principal, request, setup, run_row, human_checkpoint=True)
    if outcome.result.status == "awaiting_approval":
        return _paused_answer(session, run_row, outcome, setup.workspace_id)

    # The orchestrator routed around the story stage and there was no outline to
    # stop at. Said, with the deck, rather than pretending a review happened.
    document, diagnostics = _graph_deck(session, run_row, outcome)
    generation = _store_generated(
        session, principal, run_row, document, diagnostics,
        project_id=setup.project_id, workspace_id=setup.workspace_id,
    )
    return ReviewedGeneration(run_id=run_row.id, status="completed", generation=generation)


def _owned_run(session: Session, principal: Principal, run_id: str) -> tuple[Any, str]:
    """A generation run this caller started, and the workspace it would land in.

    A run id is not a capability: one person's outline is not another's to
    approve, and every refusal is the same 404, as for a deck. The caller must
    still be an editor where the deck would go — access can be lost while an
    outline waits, and approving must not create a deck somewhere the person can
    no longer write.
    """
    run_row = agent_store.get_run(session, run_id)
    if run_row is None or run_row.created_by != principal.user_id or run_row.presentation_id:
        raise HTTPException(status_code=404, detail="No such run.")
    project = resolve_creation_project(session, user_id=principal.user_id, project_id=run_row.project_id)
    return run_row, project.workspace_id


@app.get("/v1/runs/{run_id}/checkpoint", response_model=ReviewedGeneration)
def run_checkpoint(
    run_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ReviewedGeneration:
    """The outline a paused run is waiting on, read from the checkpoint itself."""
    run_row, _ = _owned_run(session, principal, run_id)
    values = agent_service.paused_run(run_id) if run_row.status == "awaiting_approval" else None
    if values is None:
        raise HTTPException(status_code=404, detail="This run is not waiting for a review.")
    return ReviewedGeneration(run_id=run_id, status="awaiting_story", outline=_outline(values))


@app.post("/v1/runs/{run_id}/resume", response_model=ReviewedGeneration)
def resume_run(
    run_id: str,
    decision: StoryDecision,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ReviewedGeneration:
    """Approve, revise or discard the outline a run is paused on.

    Approving builds the deck exactly as `/v1/generate` would have. Revising runs
    the story stage again with the note and stops at the new outline. Discarding
    ends the run and makes nothing.
    """
    run_row, workspace_id = _owned_run(session, principal, run_id)

    # Asked before the claim, so a refusal leaves the outline waiting. A
    # revision makes no deck, so only the token allowance applies to it.
    if decision.action == "approve":
        _check_generation_quota(session, workspace_id)
    elif decision.action == "revise":
        try:
            quotas.check_tokens(session, workspace_id)
        except quotas.QuotaExceeded as exceeded:
            raise HTTPException(status_code=429, detail=exceeded.as_detail()) from exceeded

    # Claimed with a conditional update and committed before any model is asked
    # anything. Two presses of Approve, or Approve and Revise from two windows,
    # would otherwise both resume one checkpoint, pay twice and race to write its
    # state. The second is told, and nothing of theirs ran.
    claimed = session.execute(
        update(AgentRunRow)
        .where(AgentRunRow.id == run_id, AgentRunRow.status == "awaiting_approval")
        .values(status="running")
    ).rowcount
    if not claimed:
        raise HTTPException(status_code=409, detail="This outline is no longer waiting for a review.")
    session.commit()
    session.refresh(run_row)

    if decision.action == "reject":
        # Nothing to run: a discarded outline has no further stage, and resuming
        # the graph only to reach END would be work for the same answer.
        # `cancelled`: the person ended it. The run table has no separate word for
        # a discarded outline, and a migration for a synonym would be noise.
        agent_store.finish_run(session, run_row, status="cancelled", stage="story")
        return ReviewedGeneration(run_id=run_id, status="rejected")

    payload: dict[str, Any] = {"action": decision.action}
    if decision.action == "revise":
        payload["note"] = decision.note
    try:
        outcome, _ = agent_service.resume_deck_generation(
            run_id,
            payload,
            memory=ProjectMemory(agent_store.SqlMemoryStore(session, principal.user_id), run_row.project_id),
        )
    except Exception as exc:  # noqa: BLE001 - reported with its reason
        # Put back where it was when the checkpoint still holds it, so the person
        # can try again rather than losing an outline to one failed call.
        still_paused = agent_service.paused_run(run_id) is not None
        agent_store.finish_run(
            session,
            run_row,
            status="awaiting_approval" if still_paused else "failed",
            stage="story",
            errors=[{"message": str(exc)}],
        )
        if isinstance(exc, ModelUnavailable):
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        logger.exception("Resuming a run failed")
        raise HTTPException(status_code=502, detail=f"The agent run failed: {exc}") from exc

    if outcome.result.status == "awaiting_approval":
        return _paused_answer(session, run_row, outcome, workspace_id)

    # A resumed run has its own budget, so these diagnostics count what was
    # spent after the outline was approved; every outline before it was charged
    # when it paused. Nothing is counted twice.
    document, diagnostics = _graph_deck(session, run_row, outcome)
    generation = _store_generated(
        session, principal, run_row, document, diagnostics,
        project_id=run_row.project_id, workspace_id=workspace_id,
    )
    return ReviewedGeneration(run_id=run_id, status="completed", generation=generation)
