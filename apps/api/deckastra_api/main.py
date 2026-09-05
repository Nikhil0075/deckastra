"""Deckastra API.

Phase 1 generated decks into process memory. Phase 2 gives them a database, a
version chain, and an authorization chain — so a deck survives a restart, every
change is attributable, and every change is reversible.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from . import store
from .auth import Principal, current_principal, issue_dev_token
from .compose import compose_document
from .db.models import Project, User, Workspace, WorkspaceMember
from .db.session import database_url, get_session
from .ids import new_id
from .models import GenerateRequest, GenerateResponse
from .routes import router as v1_router
from .schema import SchemaUnavailable, validate_document
from .story import StoryGenerationError, api_key_available, generate_story_plan

logger = logging.getLogger("deckastra")

app = FastAPI(
    title="Deckastra API",
    version="0.2.0",
    description="Documents, transactions and versioned history.",
)

# Locked to localhost rather than "*" — a permissive default here survives into
# production because nothing ever visibly breaks.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)

app.include_router(v1_router)


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

    user = session.query(User).filter(User.email == email).one_or_none()

    if user is None:
        user = User(id=new_id("usr"), email=email, name=email.split("@")[0])
        session.add(user)

        workspace = Workspace(id=new_id("wsp"), name=f"{user.name}'s workspace", owner_id=user.id)
        session.add(workspace)
        session.add(
            WorkspaceMember(
                id=new_id("mbr"), workspace_id=workspace.id, user_id=user.id, role="owner"
            )
        )
        session.add(
            Project(
                id=new_id("prj"),
                workspace_id=workspace.id,
                name="My first project",
                created_by=user.id,
            )
        )
        session.flush()

    membership = (
        session.query(WorkspaceMember).filter(WorkspaceMember.user_id == user.id).first()
    )
    project = (
        session.query(Project)
        .filter(Project.workspace_id == membership.workspace_id)
        .first()
    )

    return {
        "token": issue_dev_token(user.id),
        "user_id": user.id,
        "workspace_id": membership.workspace_id,
        "project_id": project.id if project else None,
    }


@app.post("/v1/generate", response_model=GenerateResponse)
def generate(
    request: GenerateRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> GenerateResponse:
    membership = (
        session.query(WorkspaceMember)
        .filter(WorkspaceMember.user_id == principal.user_id)
        .first()
    )
    if membership is None:
        raise HTTPException(status_code=403, detail="You are not a member of any workspace.")

    project_id = request.project_id
    if project_id is None:
        project = (
            session.query(Project)
            .filter(Project.workspace_id == membership.workspace_id)
            .first()
        )
        if project is None:
            raise HTTPException(status_code=400, detail="No project to generate into.")
        project_id = project.id
    else:
        project = session.get(Project, project_id)
        if project is None or project.workspace_id != membership.workspace_id:
            # 404 rather than 403: a 403 on a project you cannot see confirms it
            # exists.
            raise HTTPException(status_code=404, detail="No such project.")

    try:
        plan, diagnostics = generate_story_plan(request)
    except StoryGenerationError as exc:
        # 502, not 500: the failure is upstream, and the message is the useful part.
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    document = compose_document(plan, instruction=request.instruction)

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

    return GenerateResponse(
        presentation_id=stored.presentation_id,
        version_id=stored.version_id,
        document=stored.document,
        diagnostics=diagnostics,
    )
