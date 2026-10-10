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

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from . import grants, languages, local_mode, object_storage, preset_media, presets, quotas, store, template_compose
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
    TemplatePreviewRequest,
    TemplatePreviewResponse,
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


@app.get("/v1/presets/media/{file_name}")
def preset_media_file(file_name: str, principal: Principal = Depends(current_principal)) -> Response:
    """A template's bundled picture, for previews (unit 7b).

    By file name only, and only a name the manifest lists: nothing here can be
    steered into reading a path. Signed in, like every other read; the bytes
    ship with the build, so they are cacheable for as long as the build is.
    """
    try:
        data = preset_media.read(file_name)
    except (preset_media.PresetMediaError, OSError) as exc:
        raise HTTPException(status_code=404, detail="No such template picture.") from exc
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.post("/v1/presets/{template_id}/preview", response_model=TemplatePreviewResponse)
def preview_template(
    template_id: str,
    request: TemplatePreviewRequest,
    if_none_match: str | None = Header(default=None),
    _principal: Principal = Depends(current_principal),
) -> Any:
    """A template composed exactly as "Use template" would, returned and not stored.

    No project, no quota and no model: it is a read of the catalog, drawn by the
    real composer (UI audit 2026-10-10, unit 2). A preview without the person's
    own words is cached and carries an ETag, because a gallery asks for the same
    two dozen covers every time it opens.
    """
    if template_compose.content_size(request.content) > template_compose.MAX_CONTENT_BYTES:
        raise HTTPException(status_code=413, detail="That is more text than a template preview takes.")
    try:
        body, etag = template_compose.preview(
            template_id,
            theme_key=request.theme_key,
            content=request.content,
            slides=request.slides,
        )
    except presets.PresetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if etag is None:
        return JSONResponse(content=body, headers={"Cache-Control": "no-store"})
    quoted = f'"{etag}"'
    headers = {"ETag": quoted, "Cache-Control": "private, max-age=3600"}
    if if_none_match and quoted in [tag.strip() for tag in if_none_match.split(",")]:
        return Response(status_code=304, headers=headers)
    return JSONResponse(content=body, headers=headers)


@app.post("/v1/decks/from-template", response_model=ComposedDeckResponse)
def deck_from_template(
    request: DeckFromTemplateRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ComposedDeckResponse:
    project = resolve_creation_project(session, user_id=principal.user_id, project_id=request.project_id)
    try:
        # The same composition a preview shows (template_compose): a gallery that
        # previews one deck and creates another is worse than no preview.
        document = template_compose.compose_template(
            request.template_id,
            theme_key=request.theme_key,
            title=request.title,
            content=request.content,
        )
    except presets.PresetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    # The template's pictures become this workspace's own assets, so the deck
    # exports, backs up and syncs like any deck with uploads in it (unit 7b).
    try:
        preset_media.adopt(session, document, workspace_id=project.workspace_id, created_by=principal.user_id)
    except quotas.QuotaExceeded as exc:
        raise HTTPException(status_code=409, detail=f"The template's pictures do not fit this workspace's storage: {exc}") from exc
    except (preset_media.PresetMediaError, object_storage.ObjectStorageError) as exc:
        raise HTTPException(status_code=503, detail=f"The template's pictures could not be stored: {exc}") from exc
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
    language = request.design_language or "neutral"
    try:
        version = presets.language_version(language)
        defaults = (presets.catalog().get("designLanguages") or {})[language].get("defaults") or {}
        theme, theme_id = presets.resolve_theme(request.theme_key or str(defaults.get("themeKey") or "neo-technical"))
    except presets.PresetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    plan, warnings = languages.apply_density(request.story_plan, language)
    document = compose_document(
        plan,
        instruction="Composed from an external StoryPlan",
        theme_definition=theme,
        theme_id=theme_id,
        language=language,
        language_version=version,
    )
    stored = _store_composed(session, principal, document, project_id=project.id)
    stored.warnings = warnings
    return stored
