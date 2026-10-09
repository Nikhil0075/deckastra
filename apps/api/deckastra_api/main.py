"""Deckastra API.

Phase 1 generated decks into process memory. Phase 2 gives them a database, a
version chain, and an authorization chain — so a deck survives a restart, every
change is attributable, and every change is reversible.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from . import grants, local_mode, motion, presets, store
from .auth import (
    Principal,
    current_principal,
    issue_dev_token,
    provision_personal_account,
    resolve_creation_project,
)
from .paths import migrations_digest
from .compose import compose_document
from .db.session import database_url, get_session, session_middleware
from .models import (
    ComposedDeckResponse,
    DeckComposeRequest,
    DeckFromTemplateRequest,
)

from . import telemetry
from .agent_routes import router as agent_router
from .export_routes import router as export_router
from .gateway_routes import router as gateway_router
from .account_deletion import router as deletion_router
from .mydeck_import import router as import_router
from .font_packs import router as font_pack_router
from .oauth_routes import router as oauth_router
from .workspace_routes import router as workspace_router
from .language_routes import router as language_router
from .assistant_routes import router as assistant_router
from .assistant_assets import router as assistant_assets_router
from .assistant_design import router as assistant_design_router
from .media_quotes import router as media_quotes_router
from .routes import router as v1_router
from .schema import SchemaUnavailable, validate_document
from deckastra_agents.router import ModelUnavailable

logger = logging.getLogger("deckastra")


@asynccontextmanager
async def _lifespan(application: FastAPI):
    telemetry.configure()
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
    """A paid media or Google service that is not configured answers 503."""
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
app.include_router(media_quotes_router)


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
    report: dict[str, object] = {
        "status": "ok",
        "database": dialect,
        # What this service's migrations hash to (item 07). The desktop app
        # compares it with what its build manifest recorded, so a window paired
        # with a service built from other migrations is caught rather than
        # trusted to be its own.
        "migrations": migrations_digest(),
    }
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


def _store_composed(
    session: Session,
    principal: Principal,
    document: dict[str, Any],
    *,
    project_id: str,
    template_id: str | None = None,
) -> ComposedDeckResponse:
    """Validate and store deterministic output without creating an agent run."""
    try:
        errors = validate_document(document)
    except SchemaUnavailable as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if errors:
        logger.error("Composed an invalid preset document: %s", errors)
        raise HTTPException(
            status_code=500,
            detail={"message": "Composed document failed schema validation.", "errors": errors},
        )

    stored = store.create_presentation(
        session,
        project_id=project_id,
        document=document,
        created_by=principal.user_id,
        source="agent" if principal.scopes != local_mode.FULL_SCOPES else "user",
    )
    return ComposedDeckResponse(
        presentation_id=stored.presentation_id,
        version_id=stored.version_id,
        document=stored.document,
        template_id=template_id,
    )


@app.get("/v1/presets")
def list_presets(_principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """Reviewed deck templates and their named slots. No geometry."""
    try:
        return presets.public_catalog()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/v1/decks/from-template", response_model=ComposedDeckResponse)
def deck_from_template(
    request: DeckFromTemplateRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ComposedDeckResponse:
    project = resolve_creation_project(session, user_id=principal.user_id, project_id=request.project_id)
    try:
        preset = presets.find_preset(request.template_id)
        plan = presets.story_plan_from_preset(
            preset,
            title=request.title,
            content=request.content,
        )
        theme, theme_id = presets.resolve_theme(request.theme_key or str(preset["themeKey"]))
        motion_plan = presets.motion_plan_from_preset(preset)
    except presets.PresetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    document = compose_document(
        plan,
        instruction=f"Deck template: {request.template_id}",
        motion_plan=motion_plan,
        theme_definition=theme,
        theme_id=theme_id,
    )
    document.setdefault("metadata", {})["templateId"] = request.template_id
    document["metadata"]["motionStyle"] = str(preset["motionStyle"])
    # A template's delivery direction is part of the resulting deck, not just
    # gallery copy. Narration resolves the default provider voice from this
    # style while an explicitly selected cue or request voice still wins.
    document["metadata"]["voiceStyle"] = str(preset.get("voiceStyle") or "")
    previous_slide = None
    pacing = str((motion_plan.get("slides") or [{}])[0].get("pacing") or "measured")
    for slide in document.get("slides") or []:
        transition, _warnings = motion.plan_transition(
            previous_slide,
            slide,
            str(preset.get("transitionStyle") or "fade"),
            pacing,
        )
        if transition is not None:
            slide["transition"] = transition
        previous_slide = slide
    return _store_composed(
        session,
        principal,
        document,
        project_id=project.id,
        template_id=request.template_id,
    )


@app.post("/v1/decks/compose", response_model=ComposedDeckResponse)
def deck_compose(
    request: DeckComposeRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ComposedDeckResponse:
    """Compose a StoryPlan whose layouts are names, never caller geometry."""
    project = resolve_creation_project(session, user_id=principal.user_id, project_id=request.project_id)
    try:
        theme, theme_id = presets.resolve_theme(request.theme_key)
    except presets.PresetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    document = compose_document(
        request.story_plan,
        instruction="Composed from an external StoryPlan",
        theme_definition=theme,
        theme_id=theme_id,
    )
    return _store_composed(session, principal, document, project_id=project.id)
