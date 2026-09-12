"""Deckastra API.

Phase 1 generated decks into process memory. Phase 2 gives them a database, a
version chain, and an authorization chain — so a deck survives a restart, every
change is attributable, and every change is reversible.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from copy import deepcopy
from typing import Any

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from . import grants, local_mode, store, themes
from .auth import (
    Principal,
    current_principal,
    issue_dev_token,
    provision_personal_account,
    resolve_creation_project,
)
from .compose import compose_document
from .db.session import database_url, get_session, session_middleware
from .models import GenerateRequest, GenerateResponse, GenerationDiagnostics
from deckastra_agents import ProjectMemory
from deckastra_agents.router import MODELS as router_models

from . import agent_service, agent_store, provenance, quotas, repository_service, telemetry
from .agent_routes import router as agent_router
from .export_routes import router as export_router
from .repository_routes import router as repository_router
from .workspace_routes import router as workspace_router
from .routes import router as v1_router
from .schema import SchemaUnavailable, validate_document
from .story import StoryGenerationError, api_key_available, generate_story_plan

logger = logging.getLogger("deckastra")


@asynccontextmanager
async def _lifespan(application: FastAPI):
    telemetry.configure()
    try:
        yield
    finally:
        telemetry.shutdown()


app = FastAPI(
    title="Deckastra API",
    version="0.2.0",
    description="Documents, transactions and versioned history.",
    lifespan=_lifespan,
)

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
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)

app.include_router(v1_router)
app.include_router(agent_router)
app.include_router(repository_router)
app.include_router(export_router)
app.include_router(workspace_router)


@app.get("/health")
def health(session: Session = Depends(get_session)) -> dict[str, Any]:
    url = database_url()
    # Scheme only. A health endpoint that echoes a connection string is a health
    # endpoint that leaks a password.
    dialect = url.split("://", 1)[0]

    return {
        "status": "ok",
        # Surfaced so the UI can tell the user their deck will be stub-composed
        # before they wait for a generation, rather than after.
        "generation": "model" if api_key_available() else "stub",
        "database": dialect,
    }


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


@app.post("/v1/generate", response_model=GenerateResponse)
def generate(
    request: GenerateRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> GenerateResponse:
    project = resolve_creation_project(session, user_id=principal.user_id, project_id=request.project_id)
    project_id = project.id
    workspace_id = project.workspace_id
    default_theme = themes.default_for(session, workspace_id)
    # Freeze one portable definition for every candidate and any final fallback.
    theme_definition = deepcopy(default_theme.definition_json) if default_theme else None
    theme_id = default_theme.id if default_theme else None

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

    # The agent graph, not a single-shot chain (doc 03 §4). The Orchestrator
    # routes, the Story Architect writes, the Layout Agent checks the fit, the
    # Critic reviews — and the composer still makes every geometric decision.
    #
    # `use_graph=False` falls back to the Phase 1 path. It exists because the
    # graph is new and the single-shot chain is the thing that has been working;
    # a flag that lets an operator go back is cheaper than a rollback.
    run_row = agent_store.start_run(
        session,
        project_id=project_id,
        presentation_id=None,
        created_by=principal.user_id,
        intent=request.instruction[:500],
    )

    # Journey B: a deck grounded in a repository. Resolved for this workspace
    # rather than trusted from the request — a repository id from another
    # workspace must not become a source, and `resolve_many` is where that is
    # enforced rather than assumed.
    repositories = [
        repository
        for repository in repository_service.resolve_many(
            session, workspace_id, request.repository_ids
        )
        if repository.index_status == "ready"
    ]

    if request.use_graph:
        try:
            outcome = agent_service.run_deck_generation(
                request,
                run_id=run_row.id,
                user_id=principal.user_id,
                project_id=project_id,
                presentation_id="",
                document=_empty_document(
                    request, theme_definition=theme_definition, theme_id=theme_id
                ),
                memory=ProjectMemory(
                    agent_store.SqlMemoryStore(session, principal.user_id), project_id
                ),
                session=session,
                repositories=repositories,
                workspace_id=workspace_id,
                theme_definition=theme_definition,
                theme_id=theme_id,
            )
        except Exception as exc:  # noqa: BLE001 - reported with its reason, not a bare 500
            logger.exception("Agent run failed")
            agent_store.finish_run(session, run_row, status="failed", errors=[{"message": str(exc)}])
            raise HTTPException(status_code=502, detail=f"The agent run failed: {exc}") from exc

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

        if result.status not in {"completed", "awaiting_approval"} or not outcome.operations:
            raise HTTPException(
                status_code=502,
                detail={
                    "message": "The agent run did not produce a deck.",
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
    else:
        try:
            plan, diagnostics = generate_story_plan(request)
        except StoryGenerationError as exc:
            # 502, not 500: the failure is upstream, and the message is the useful part.
            agent_store.finish_run(session, run_row, status="failed", errors=[{"message": str(exc)}])
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        agent_store.finish_run(session, run_row, status="completed", stage="story")
        document = compose_document(plan, instruction=request.instruction, theme_definition=theme_definition, theme_id=theme_id)

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
