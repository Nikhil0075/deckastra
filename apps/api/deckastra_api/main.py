"""Deckastra API — Phase 1.

One endpoint that turns a prompt into a `.mydeck` document, plus enough storage to
hand the result back to a browser. No persistence beyond process memory: Phase 2
brings Postgres, transactions and versioning, and putting a database behind this
now would mean designing a schema for a document model that has not yet been
edited by anything.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .compose import compose_document
from .models import GenerateRequest, GenerateResponse
from .schema import SchemaUnavailable, validate_document
from .story import StoryGenerationError, api_key_available, generate_story_plan

logger = logging.getLogger("deckastra")

app = FastAPI(
    title="Deckastra API",
    version="0.1.0",
    description="Phase 1 walking skeleton: prompt to rendered deck.",
)

# The web app runs on a different port in development. Locked to localhost rather
# than "*" — a permissive default here is the kind of thing that survives into
# production because nothing ever visibly breaks.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

_documents: dict[str, dict[str, Any]] = {}


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        # Surfaced so the UI can tell the user their deck will be stub-composed
        # *before* they wait for a generation, rather than after.
        "generation": "model" if api_key_available() else "stub",
        "documents": len(_documents),
    }


@app.post("/v1/generate", response_model=GenerateResponse)
def generate(request: GenerateRequest) -> GenerateResponse:
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
        # than a bad model response — which is exactly why it must be loud instead
        # of returning a broken deck the renderer will refuse anyway (doc 04 §6.4).
        logger.error("Composed an invalid document: %s", errors)
        diagnostics.valid_first_attempt = False
        diagnostics.validation_errors.extend(errors)
        raise HTTPException(
            status_code=500,
            detail={
                "message": "Composed document failed schema validation.",
                "errors": errors,
            },
        )

    _documents[document["id"]] = document

    return GenerateResponse(
        presentation_id=document["id"],
        document=document,
        diagnostics=diagnostics,
    )


@app.get("/v1/presentations/{presentation_id}")
def get_presentation(presentation_id: str) -> dict[str, Any]:
    document = _documents.get(presentation_id)
    if document is None:
        raise HTTPException(status_code=404, detail="No such presentation")
    return document
