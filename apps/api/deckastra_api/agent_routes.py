"""The agent HTTP surface (doc 03 §20, §26, doc 02 §31.6).

Externally authored proposals enter the transaction layer here, and people can
inspect, approve, reject, withdraw, or revert them. Run history remains readable
for generation and other long-running workflows.

What is deliberately absent is any way for an agent's output to reach the store
except through `proposals.py`. Doc 03 §28's "agents cannot bypass the transaction
layer" is true here because there is no route that would let them.
"""

from __future__ import annotations
import hashlib
import io
import json
import os
from datetime import datetime, timezone
from typing import Any, Literal

from deckastra_agents import ProjectMemory
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import or_
from sqlalchemy.orm import Session

from . import agent_store, author_service, media_style, object_storage, proposals, store, workspace_routes
from .assistant_assets import describe as describe_asset
from .auth import Principal, Role, current_principal, resolve_presentation_access, resolve_project_access
from .db.models import AgentRequest, Asset, Draft, Presentation, TransactionRow
from .db.session import get_session
from .ids import new_id
from .patch import apply_patch

router = APIRouter(prefix="/v1")


# ------------------------------------------------------------------- models


class ProposalSummary(BaseModel):
    id: str
    status: str
    intent: str
    reason: str | None
    risk_tier: str | None
    agent_id: str | None
    run_id: str | None
    created_at: str
    expires_at: str | None
    operation_count: int
    in_reply_to: str | None = None


class AuthoredProposalResponse(BaseModel):
    run_id: str
    status: str
    #: "applied" for a low-risk change, "pending" when a human must decide.
    outcome: str
    transaction_id: str | None = None
    version_id: str | None = None
    document: dict[str, Any] | None = None
    #: The document the change *would* produce. Returned rather than stored — a
    #: stored preview is a second copy that goes stale.
    preview: dict[str, Any] | None = None
    risk_tier: str = "low"
    reasons: list[str] = Field(default_factory=list)
    changes: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    refusal: str | None = None
    expires_at: str | None = None


class ProposalDecision(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


# ------------------------------------------------------------------- helpers


def _summary(row: TransactionRow) -> ProposalSummary:
    return ProposalSummary(
        id=row.id,
        status=row.status,
        intent=row.intent,
        reason=row.reason,
        risk_tier=row.risk_tier,
        agent_id=row.agent_id,
        run_id=row.run_id,
        created_at=row.created_at.isoformat() if row.created_at else "",
        expires_at=row.expires_at.isoformat() if row.expires_at else None,
        operation_count=len(row.operations_json or []),
        in_reply_to=row.in_reply_to_request_id,
    )


def _project_of(session: Session, presentation_id: str) -> str:
    presentation = session.get(Presentation, presentation_id)
    if presentation is None:
        raise HTTPException(status_code=404, detail="No such deck.")
    return presentation.project_id


# ------------------------------------------------- externally authored proposals


class AuthoredProposalRequest(BaseModel):
    """A change an external client worked out for itself (milestone D2.2).

    Deliberately *not* an instruction. The connected client has already authored
    operations, so the workspace only validates, previews, and applies them.

    What is absent from this body is the point: there is no risk tier and no
    `applied` flag. Both are computed here, from the operations.
    """

    #: Bounded because this is a public write surface. The cap is generous — a
    #: whole-deck retheme is a few hundred operations — and a caller that needs
    #: more is describing a document replacement, which is a different request.
    operations: list[dict[str, Any]] = Field(min_length=1, max_length=2_000)
    intent: str = Field(min_length=1, max_length=500)
    #: The version the caller authored these operations against.
    #:
    #: Required, not optional. An external agent reads a deck, thinks for a while
    #: and comes back — and in that gap the person whose deck it is may have been
    #: typing. Without this the operations would apply to whatever is there now,
    #: which is last-write-wins with extra steps. A caller that could omit it
    #: would eventually omit it.
    expected_version_id: str = Field(min_length=1, max_length=64)
    reason: str | None = Field(default=None, max_length=1_000)
    #: Which client authored it, for the approval UI. Namespaced below so it
    #: cannot claim to be one of the product's own agents.
    client_label: str = Field(default="external", max_length=60)
    in_reply_to: str | None = Field(default=None, max_length=64)


@router.post("/presentations/{presentation_id}/proposals", response_model=AuthoredProposalResponse)
def authored_proposal(
    presentation_id: str,
    request: AuthoredProposalRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> AuthoredProposalResponse:
    """Take operations from an external agent, and treat them like any other.

    This is the whole of the MCP write path, and it is short on purpose. It adds
    no second way into the store: the operations go to `create_proposal`, which
    computes the risk tier from them, applies a low-risk change immediately,
    parks anything else for a human, and gives every applied change an inverse in
    the ordinary history. An MCP edit therefore undoes like a typed one, expires
    like any proposal, and is re-validated against the head on approval.

    Three refusals worth naming:

    - **No model is called.** Not "avoided where possible" — there is no client
      in this function to call.
    - **The caller cannot declare a tier**, so it cannot mark its own change low
      risk and skip the human.
    - **The caller cannot claim to be an internal agent.** The label it gives is
      prefixed, so an approval prompt saying `mcp:codex` cannot be produced by
      anything but this route.
    """
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )

    # Checked before anything is created. The actual write is still conditional
    # on this version in `store.commit_transaction`, so this is the honest error,
    # not the concurrency guarantee.
    head = store.load_presentation(session, presentation_id)
    if head.version_id != request.expected_version_id:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "This deck has changed since you read it. Read it again and re-author "
                    "the change against the current version."
                ),
                "code": "E310",
                "current_version_id": head.version_id,
            },
        )

    try:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=request.operations,
            intent=request.intent,
            created_by=principal.user_id,
            # Prefixed, always. `agent_id` reaches the approval UI, and "editor"
            # there would tell a user the product's own edit agent proposed
            # something an external client did.
            agent_id=f"mcp:{request.client_label}"[:120],
            reason=request.reason,
            # Checked again where the base is loaded. The head check above is a
            # clear early error; this is the one that cannot be raced, because
            # `create_proposal` reads the document itself.
            expected_version_id=request.expected_version_id,
            in_reply_to_request_id=request.in_reply_to,
        )
    except proposals.ProposalError as error:
        # 409 rather than 400: the usual cause is that the deck moved under the
        # caller — an operation addressing an element that is no longer there —
        # which is a conflict to re-read and retry, not a malformed request.
        raise HTTPException(
            status_code=409, detail={"message": str(error), "code": error.code}
        ) from error

    return AuthoredProposalResponse(
        run_id="",  # No run: nothing was generated, so there is nothing to trace.
        status="completed",
        outcome=outcome["status"],
        transaction_id=outcome["transaction_id"],
        version_id=outcome.get("version_id"),
        document=outcome.get("document"),
        preview=outcome.get("preview"),
        risk_tier=outcome["risk_tier"],
        reasons=outcome.get("reasons") or [],
        changes=[],
        warnings=[],
        expires_at=outcome.get("expires_at"),
    )


# -------------------------------------------------------- external media imports


class ImportedImageComplete(BaseModel):
    upload_token: str = Field(min_length=20, max_length=12_000)
    #: Repeated from the prepare call and checked by digest, so a compact signed
    #: upload URL does not need to carry a potentially long prompt.
    prompt: str = Field(min_length=1, max_length=4_000)
    provider: str = Field(default="external-image-tool", min_length=1, max_length=120)
    client_label: str = Field(default="external", min_length=1, max_length=60)


def _picture_operations(
    document: dict[str, Any],
    slide: dict[str, Any],
    asset: Asset,
    *,
    alt_text: str,
    style_source: str = "prompt",
    generation: dict[str, Any] | None = None,
    placement: str = "frame",
    replace_element_id: str | None = None,
) -> list[dict[str, Any]]:
    """Register a workspace picture in the deck and place it, as one patch.

    The manifest entry is written from the asset row, never from a caller, and
    only when the deck does not already list the file. Placement is decided
    here: into the slide's picture frame when it has one (the frame's box, its
    corners and the deck's treatment), centred at a readable size otherwise,
    across the whole slide for `background`, or into an existing picture's box
    for `replace`. The caller names intent, not pixels.
    """
    slide_id = str(slide.get("id"))
    operations: list[dict[str, Any]] = []
    if not any(isinstance(entry, dict) and entry.get("id") == asset.id for entry in document.get("assets") or []):
        manifest: dict[str, Any] = {
            "id": asset.id,
            "type": "image",
            "storageKey": asset.storage_key,
            "fileName": asset.filename,
            "mimeType": asset.content_type,
            "byteSize": asset.bytes,
            "width": asset.width,
            "height": asset.height,
        }
        if generation is not None:
            manifest["createdBy"] = "generated"
            manifest["metadata"] = {"generation": generation}
        if "assets" not in document:
            operations.append({"op": "add", "path": "/assets", "value": []})
        operations.append({"op": "add", "path": "/assets/-", "value": {key: value for key, value in manifest.items() if value is not None}})

    if placement == "replace":
        target = next((element for element in slide.get("elements") or [] if element.get("id") == replace_element_id), None)
        if target is None or target.get("type") != "image":
            raise HTTPException(status_code=422, detail="replace_element_id must name a picture on that slide.")
        operations.append({"op": "replace", "path": f"/slides/id:{slide_id}/elements/id:{target['id']}/assetId", "value": asset.id})
        return operations

    view = document["viewport"]
    if placement == "background":
        element: dict[str, Any] = {
            "id": new_id("el"), "type": "image", "assetId": asset.id, "fit": "cover", "layerRole": "background",
            "transform": {"x": 0, "y": 0, "width": view["width"], "height": view["height"]},
            "altText": alt_text, "name": "Background picture",
        }
        operations.append({"op": "add", "path": f"/slides/id:{slide_id}/elements/0", "value": element})
        return operations

    factor = min(view["width"] * .7 / asset.width, view["height"] * .65 / asset.height)
    width, height = asset.width * factor, asset.height * factor
    element = {
        "id": new_id("el"), "type": "image", "assetId": asset.id, "fit": "contain",
        "transform": {"x": (view["width"] - width) / 2, "y": (view["height"] - height) / 2, "width": width, "height": height},
        "altText": alt_text,
        "name": "Generated picture" if generation is not None else (asset.filename or "Picture"),
    }
    frame = media_style.target_frame(slide) if placement == "frame" else None
    if frame is not None:
        frame_index, frame_element = frame
        element["transform"], element["fit"] = dict(frame_element["transform"]), "cover"
        element["semanticRole"] = str(frame_element.get("semanticRole") or "supportingVisual")
        if frame_element.get("altText") and generation is not None:
            element["altText"] = str(frame_element["altText"])[:900]
        radius = (frame_element.get("style") or {}).get("cornerRadius") or 0
        if frame_element.get("shape") == "pill":
            radius = min(element["transform"]["width"], element["transform"]["height"]) / 2
        if radius:
            element["style"] = {"cornerRadius": radius}
        if style_source == "deck":
            treatment = media_style.deck_treatment(document, slide_id, (frame_element.get("mediaSlot") or {}).get("treatmentPreset"))
            if treatment:
                element["treatment"] = treatment
        elements = slide.get("elements") or []
        at = frame_index + 1
        while at < len(elements) and elements[at].get("type") == "image" and elements[at].get("transform") == frame_element["transform"]:
            at += 1
        operations.append({"op": "add", "path": f"/slides/id:{slide_id}/elements/{at}", "value": element})
    else:
        operations.append({"op": "add", "path": f"/slides/id:{slide_id}/elements/-", "value": element})
    return operations


@router.post("/presentations/{presentation_id}/media-imports/complete")
def complete_imported_image(
    presentation_id: str,
    request: ImportedImageComplete,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Register externally generated bytes and propose their placement.

    The image generator never receives the Deckastra bearer and the agent never
    sends image bytes through model context. The signed upload token binds the
    object to one deck version, one slide and the digest of this exact prompt.
    Completing the upload and creating the proposal share this transaction, so
    the Media library and Waiting for you cannot disagree about what arrived.
    """
    claims = workspace_routes.decode_upload_token(request.upload_token)
    binding = claims.get("media_import") if isinstance(claims.get("media_import"), dict) else None
    if not binding or binding.get("presentation_id") != presentation_id or claims.get("sub") != principal.user_id:
        raise HTTPException(status_code=404, detail="No such media import.")
    if hashlib.sha256(request.prompt.encode("utf-8")).hexdigest() != binding.get("prompt_sha256"):
        raise HTTPException(status_code=409, detail="The prompt does not match the prepared media import.")

    access = resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR
    )
    loaded = store.load_presentation(session, presentation_id)
    expected_version_id = str(binding.get("expected_version_id") or "")
    slide_id = str(binding.get("slide_id") or "")
    if loaded.version_id != expected_version_id:
        raise HTTPException(status_code=409, detail={"message": "The deck changed before this image could be proposed.", "code": "E310", "current_version_id": loaded.version_id})
    slide = next((item for item in loaded.document.get("slides") or [] if item.get("id") == slide_id), None)
    if slide is None:
        raise HTTPException(status_code=404, detail="No such slide in this deck.")

    uploaded = workspace_routes.complete_asset_upload(
        workspace_routes.CompleteAssetUpload(upload_token=request.upload_token), principal, session
    )
    asset = session.get(Asset, uploaded["id"])
    if asset is None or asset.workspace_id != access.workspace_id or asset.kind != "image" or not asset.width or not asset.height:
        raise HTTPException(status_code=422, detail="The uploaded image could not be registered with usable dimensions.")
    # The placement uses the file's real aspect ratio, not numbers supplied by
    # the agent. This also catches an image container that merely claimed to be
    # PNG/JPEG/WebP before a proposal can cite it.
    try:
        from PIL import Image
        image_bytes, _content_type = object_storage.read(asset.storage_key)
        with Image.open(io.BytesIO(image_bytes)) as image:
            image.verify()
            width, height = image.size
    except (object_storage.ObjectStorageError, OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail="The uploaded file is not a readable image.") from error
    if width * height > 16_000_000:
        raise HTTPException(status_code=422, detail="The uploaded image exceeds the 16 megapixel limit.")
    asset.width, asset.height = width, height
    style_source = str(binding.get("style_source") or "prompt")
    asset.tags = ["generated", "external-tool", style_source]
    asset.description = f"Generated by {request.provider} to {'match the deck' if style_source == 'deck' else 'follow the prompt'}"

    operations = _picture_operations(
        loaded.document, slide, asset,
        alt_text="Generated illustration requested as: " + request.prompt[:400],
        style_source=style_source,
        generation={"styleSource": style_source, "prompt": request.prompt, "model": request.provider, "at": datetime.now(timezone.utc).isoformat()},
    )

    candidate, _ = apply_patch(loaded.document, operations)
    errors = author_service.check(loaded.document, operations)
    from .assistant_routes import asset_errors
    errors += asset_errors(session, loaded.document, candidate, access.workspace_id)
    if errors:
        raise HTTPException(status_code=422, detail="; ".join(errors[:3]))
    try:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=operations,
            intent="Place externally generated image",
            created_by=principal.user_id,
            agent_id=f"mcp:{request.client_label}"[:120],
            reason=f"Generated with {request.provider}; review the image and placement before applying.",
            source_ids=[asset.id],
            user_instruction=request.prompt,
            expected_version_id=expected_version_id,
            model_authored=True,
            review_reason="Generated media and its placement require visual review.",
        )
    except proposals.ProposalError as error:
        raise HTTPException(status_code=409, detail={"message": str(error), "code": error.code}) from error
    return {
        "asset": describe_asset(asset),
        "proposal_id": outcome["transaction_id"],
        "status": outcome["status"],
        "risk_tier": outcome["risk_tier"],
        "slide_id": slide_id,
        "awaiting": "Review the image beside the current slide under Assistant › Waiting for you.",
    }


# ------------------------------------------------------------ agent requests


class AgentRequestCreate(BaseModel):
    target: dict[str, list[str]]
    kind: str = Field(pattern=r"^(motion|style|content|image|layout|review|other)$")
    message: str = Field(min_length=1, max_length=2_000)
    based_on_version_id: str = Field(min_length=1, max_length=64)


class AgentRequestAnswer(BaseModel):
    #: Up to three alternatives for the person to choose between, or none when
    #: the request asked for findings rather than a change.
    proposal_ids: list[str] = Field(default_factory=list, max_length=3)
    #: The answer in words: what the agent found, for the person to read.
    findings: str | None = Field(default=None, max_length=8_000)

    @model_validator(mode="after")
    def _something(self) -> "AgentRequestAnswer":
        if not self.proposal_ids and not (self.findings or "").strip():
            raise ValueError("Answer with proposal_ids, findings, or both.")
        return self


class AgentRequestView(BaseModel):
    id: str
    presentation_id: str
    target: dict[str, list[str]]
    kind: str
    message: str
    based_on_version_id: str
    status: str
    created_by: str
    created_at: str
    proposal_ids: list[str]
    resolved_target: dict[str, Any]
    findings: str | None = None


class AgentTaskView(BaseModel):
    id: str
    project_id: str
    resource_type: Literal["deck", "draft"]
    resource_id: str
    resource_title: str
    resource_deleted: bool
    kind: str
    message: str
    status: Literal["open", "answered", "closed"]
    created_at: str
    completed_at: str | None
    target_summary: dict[str, int]
    proposal_ids: list[str]
    findings: str | None = None


def _plain_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(_plain_text(item) for item in value)
    if isinstance(value, dict):
        if isinstance(value.get("text"), str):
            return value["text"]
        return "".join(_plain_text(value.get(key)) for key in ("content", "children", "blocks", "spans"))
    return ""


def _walk_elements(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for element in elements:
        found.append(element)
        children = element.get("children")
        if isinstance(children, list):
            found.extend(_walk_elements([item for item in children if isinstance(item, dict)]))
    return found


def _resolved_target(document: dict[str, Any], target: dict[str, list[str]]) -> dict[str, Any]:
    wanted_slides = set(target.get("slide_ids") or [])
    wanted_elements = set(target.get("element_ids") or [])
    slides: list[dict[str, Any]] = []
    elements: list[dict[str, Any]] = []
    seen_elements: set[str] = set()
    for position, slide in enumerate(document.get("slides") or []):
        if not isinstance(slide, dict):
            continue
        slide_id = str(slide.get("id") or "")
        if slide_id in wanted_slides:
            slides.append({"id": slide_id, "name": slide.get("name") or f"Slide {position + 1}"})
        tracks = slide.get("animations") or []
        for element in _walk_elements([item for item in (slide.get("elements") or []) if isinstance(item, dict)]):
            element_id = str(element.get("id") or "")
            if element_id not in wanted_elements:
                continue
            seen_elements.add(element_id)
            motion = [track for track in tracks if isinstance(track, dict) and track.get("targetId") == element_id]
            elements.append({
                "id": element_id,
                "slide_id": slide_id,
                "type": element.get("type"),
                "name": element.get("name"),
                "semantic_role": element.get("semanticRole"),
                "text": _plain_text(element.get("content"))[:1_000] or None,
                "motion": motion,
            })
    return {
        "slides": slides,
        "elements": elements,
        "missing_slide_ids": sorted(wanted_slides - {item["id"] for item in slides}),
        "missing_element_ids": sorted(wanted_elements - seen_elements),
    }


def _request_view(row: AgentRequest, document: dict[str, Any]) -> AgentRequestView:
    return AgentRequestView(
        id=row.id,
        presentation_id=row.presentation_id,
        target=dict(row.target_json or {}),
        kind=row.kind,
        message=row.message,
        based_on_version_id=row.based_on_version_id,
        status=row.status,
        created_by=row.created_by,
        created_at=row.created_at.isoformat() if row.created_at else "",
        proposal_ids=list(row.answer_proposal_ids_json or []),
        resolved_target=_resolved_target(document, dict(row.target_json or {})),
        findings=row.answer_text,
    )


@router.post("/presentations/{presentation_id}/requests", response_model=AgentRequestView)
def create_agent_request(
    presentation_id: str,
    request: AgentRequestCreate,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> AgentRequestView:
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR)
    loaded = store.load_presentation(session, presentation_id)
    if loaded.version_id != request.based_on_version_id:
        raise HTTPException(status_code=409, detail="The deck changed. Review the selection and ask again.")
    slide_ids = list(dict.fromkeys(request.target.get("slide_ids") or []))
    element_ids = list(dict.fromkeys(request.target.get("element_ids") or []))
    # A review may be of the whole deck: no target names every slide as it
    # stands now (release E2E step 9). Every other kind is about something.
    if not slide_ids and not element_ids and request.kind == "review":
        slide_ids = [str(slide.get("id")) for slide in loaded.document.get("slides") or [] if slide.get("id")][:50]
    if not slide_ids and not element_ids:
        raise HTTPException(status_code=422, detail="Choose a slide or at least one object.")
    if len(slide_ids) > 50 or len(element_ids) > 200:
        raise HTTPException(status_code=422, detail="That request targets too many objects.")
    row = AgentRequest(
        id=new_id("req"), presentation_id=presentation_id,
        target_json={"slide_ids": slide_ids, "element_ids": element_ids},
        kind=request.kind, message=request.message.strip(),
        based_on_version_id=request.based_on_version_id,
        status="open", created_by=principal.user_id,
    )
    session.add(row)
    session.flush()
    return _request_view(row, loaded.document)


@router.get("/presentations/{presentation_id}/requests", response_model=list[AgentRequestView])
def list_agent_requests(
    presentation_id: str,
    status: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[AgentRequestView]:
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.VIEWER)
    if status is not None and status not in {"open", "answered", "closed"}:
        raise HTTPException(status_code=422, detail="Unknown request status.")
    query = session.query(AgentRequest).filter(AgentRequest.presentation_id == presentation_id)
    if status:
        query = query.filter(AgentRequest.status == status)
    document = store.load_presentation(session, presentation_id).document
    return [_request_view(row, document) for row in query.order_by(AgentRequest.created_at.asc()).all()]


@router.get("/projects/{project_id}/agent-tasks", response_model=list[AgentTaskView])
def list_agent_tasks(
    project_id: str,
    status: str = "all",
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[AgentTaskView]:
    """List the persisted Ask-agent work for one project without loading decks."""
    resolve_project_access(session, user_id=principal.user_id, project_id=project_id, require=Role.VIEWER)
    if status not in {"all", "pending", "completed"}:
        raise HTTPException(status_code=422, detail="Unknown agent task status.")
    presentations = {row.id: row for row in session.query(Presentation).filter(Presentation.project_id == project_id).all()}
    drafts = {row.id: row for row in session.query(Draft).filter(Draft.project_id == project_id).all()}
    if not presentations and not drafts:
        return []
    query = session.query(AgentRequest).filter(or_(
        AgentRequest.presentation_id.in_(list(presentations)),
        AgentRequest.draft_id.in_(list(drafts)),
    ))
    if status == "pending":
        query = query.filter(AgentRequest.status == "open")
    elif status == "completed":
        query = query.filter(AgentRequest.status.in_(("answered", "closed")))
    rows = query.order_by(AgentRequest.created_at.desc()).all()
    tasks: list[AgentTaskView] = []
    for row in rows:
        target = dict(row.target_json or {})
        if row.presentation_id:
            resource = presentations[row.presentation_id]
            resource_type = "deck"
            summary = {
                "slides": len(target.get("slide_ids") or []),
                "objects": len(target.get("element_ids") or []),
                "cards": 0,
            }
        else:
            assert row.draft_id is not None
            resource = drafts[row.draft_id]
            resource_type = "draft"
            summary = {
                "slides": 0,
                "objects": len(target.get("block_ids") or []),
                "cards": len(target.get("card_ids") or []),
            }
        completed = row.closed_at or row.answered_at
        tasks.append(AgentTaskView(
            id=row.id,
            project_id=project_id,
            resource_type=resource_type,
            resource_id=resource.id,
            resource_title=resource.title,
            resource_deleted=resource.deleted_at is not None,
            kind=row.kind,
            message=row.message,
            status=row.status,
            created_at=row.created_at.isoformat() if row.created_at else "",
            completed_at=completed.isoformat() if completed else None,
            target_summary=summary,
            proposal_ids=list(row.answer_proposal_ids_json or []),
            findings=row.answer_text,
        ))
    return tasks


@router.post("/requests/{request_id}/answer", response_model=AgentRequestView)
def answer_agent_request(
    request_id: str,
    answer: AgentRequestAnswer,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> AgentRequestView:
    row = session.get(AgentRequest, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such request.")
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=row.presentation_id, require=Role.EDITOR)
    if row.status == "closed":
        raise HTTPException(status_code=409, detail="That request is closed.")
    proposal_ids = list(dict.fromkeys(answer.proposal_ids))
    if len(proposal_ids) != len(answer.proposal_ids):
        raise HTTPException(status_code=422, detail="Proposal ids must be distinct.")
    proposals_found = [session.get(TransactionRow, proposal_id) for proposal_id in proposal_ids]
    if any(item is None or item.presentation_id != row.presentation_id for item in proposals_found):
        raise HTTPException(status_code=404, detail="One of those proposals does not belong to this deck.")
    if any(item.status != "pending" for item in proposals_found if item is not None):
        raise HTTPException(status_code=409, detail="Only pending proposals can answer a request.")
    if any(not (item.agent_id or "").startswith("mcp:") for item in proposals_found if item is not None):
        raise HTTPException(status_code=409, detail="Only proposals authored through an agent tool can answer a request.")
    if any(item.in_reply_to_request_id not in {None, row.id} for item in proposals_found if item is not None):
        raise HTTPException(status_code=409, detail="One proposal already answers a different request.")
    for item in proposals_found:
        assert item is not None
        item.in_reply_to_request_id = row.id
    if answer.findings and answer.findings.strip():
        row.answer_text = answer.findings.strip()
    row.answer_proposal_ids_json = proposal_ids or list(row.answer_proposal_ids_json or [])
    row.status = "answered"
    row.answered_at = datetime.now(timezone.utc)
    session.flush()
    return _request_view(row, store.load_presentation(session, row.presentation_id).document)


@router.post("/requests/{request_id}/close", response_model=AgentRequestView)
def close_agent_request(
    request_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> AgentRequestView:
    row = session.get(AgentRequest, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such request.")
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=row.presentation_id, require=Role.EDITOR)
    row.status = "closed"
    row.closed_at = datetime.now(timezone.utc)
    session.flush()
    return _request_view(row, store.load_presentation(session, row.presentation_id).document)


# ---------------------------------------------------------------- proposals


@router.get("/presentations/{presentation_id}/proposals", response_model=list[ProposalSummary])
def list_proposals(
    presentation_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[ProposalSummary]:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.VIEWER
    )
    return [_summary(row) for row in proposals.pending(session, presentation_id)]


class ProposalDetail(ProposalSummary):
    """One pending change with its operations (editor Phase 6).

    The panel shows a proposal as Before and After pictures. It draws both from
    the deck on screen with the editor's own renderer: "after" is the deck the
    person is looking at with this change applied, which is what approving
    means. For that it needs the operations, which the list leaves out so a poll
    stays small.
    """

    operations: list[dict[str, Any]]
    #: The version the change was written against. When the head has moved past
    #: it the change may still apply, but it is not the change as written, and
    #: approval asks for a fresh look.
    base_version_id: str | None


@router.get(
    "/presentations/{presentation_id}/proposals/{proposal_id}", response_model=ProposalDetail
)
def get_proposal(
    presentation_id: str,
    proposal_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ProposalDetail:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.VIEWER
    )
    row = session.get(TransactionRow, proposal_id)
    # Pending only, and only this deck's: an applied transaction is history,
    # read through the version routes, and another deck's is not this caller's.
    if row is None or row.presentation_id != presentation_id or row.status != "pending":
        raise HTTPException(status_code=404, detail="No such pending change.")
    return ProposalDetail(
        **_summary(row).model_dump(),
        operations=list(row.operations_json or []),
        base_version_id=row.parent_version_id,
    )


class ApprovalRequest(BaseModel):
    """Which version the approver was looking at when they said yes.

    Optional, and when it is absent the proposal's own base is used instead — so
    a deck that moved since the proposal was made is refused rather than applied
    to something nobody reviewed. A client that has shown the user the deck as it
    stands sends the version it showed, and the approval goes through.
    """

    expected_version_id: str | None = Field(default=None, max_length=64)


@router.post("/presentations/{presentation_id}/proposals/{proposal_id}/approve")
def approve_proposal(
    presentation_id: str,
    proposal_id: str,
    request: ApprovalRequest | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR
    )

    selected = session.get(TransactionRow, proposal_id)
    request_id = selected.in_reply_to_request_id if selected is not None else None
    try:
        result = proposals.approve(
            session,
            presentation_id=presentation_id,
            transaction_id=proposal_id,
            approved_by=principal.user_id,
            expected_version_id=(request.expected_version_id if request else None),
        )
        if request_id:
            siblings = (
                session.query(TransactionRow)
                .filter(
                    TransactionRow.presentation_id == presentation_id,
                    TransactionRow.in_reply_to_request_id == request_id,
                    TransactionRow.id != proposal_id,
                    TransactionRow.status == "pending",
                )
                .all()
            )
            for sibling in siblings:
                sibling.status = "rejected"
                sibling.reason = f"{sibling.reason or ''}\nSuperseded by accepted reply {proposal_id}.".strip()
            question = session.get(AgentRequest, request_id)
            if question is not None:
                question.status = "closed"
                question.closed_at = datetime.now(timezone.utc)
            session.flush()
        return result
    except proposals.ProposalError as error:
        code = 404 if error.code == "E404" else 409
        raise HTTPException(status_code=code, detail={"message": str(error), "code": error.code}) from error


class WithdrawalRequest(BaseModel):
    #: The label the agent proposed under, without the `mcp:` prefix.
    client_label: str = Field(min_length=1, max_length=60)


@router.post("/presentations/{presentation_id}/proposals/{proposal_id}/withdraw")
def withdraw_proposal(
    presentation_id: str,
    proposal_id: str,
    request: WithdrawalRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ProposalSummary:
    """An external agent takes back its own pending change (`proposals.withdraw`).

    `write`, not `approve`: nothing is applied and nobody else's work is
    decided. Nothing is written to project memory either — the agent changed
    its mind, which says nothing about what the person wants.
    """
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR
    )
    try:
        row = proposals.withdraw(
            session,
            presentation_id=presentation_id,
            transaction_id=proposal_id,
            agent_id=f"mcp:{request.client_label}"[:120],
        )
    except proposals.ProposalError as error:
        code = {"E404": 404, "E403": 403}.get(error.code, 409)
        raise HTTPException(status_code=code, detail={"message": str(error), "code": error.code}) from error
    return _summary(row)


@router.post("/presentations/{presentation_id}/proposals/{proposal_id}/reject")
def reject_proposal(
    presentation_id: str,
    proposal_id: str,
    decision: ProposalDecision,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ProposalSummary:
    """Decline a proposal, and remember that it was declined.

    The memory write is the point of recording a reason at all: a Critic that
    proposes the same rejected change every run is a Critic people stop reading
    (gap register doc 03 S2).
    """
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR
    )

    try:
        row = proposals.reject(
            session,
            presentation_id=presentation_id,
            transaction_id=proposal_id,
            reason=decision.reason,
        )
    except proposals.ProposalError as error:
        code = 404 if error.code == "E404" else 409
        raise HTTPException(status_code=code, detail={"message": str(error), "code": error.code}) from error

    memory = ProjectMemory(
        agent_store.SqlMemoryStore(session, principal.user_id), _project_of(session, presentation_id)
    )
    memory.record_rejected_proposal(row.intent, decision.reason or "")

    return _summary(row)


# ----------------------------------------------------------------- streaming


@router.get("/runs/{run_id}/events")
def run_events(
    run_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Watch a run over Server-Sent Events (doc 03 §20).

    Events are relayed from the Redis channel the run publishes to. Without Redis
    the endpoint still answers — with the run's final state — rather than hanging:
    a stream that never produces anything is indistinguishable from a run that
    never started, which is the exact confusion progress events exist to remove.
    """
    run = agent_store.get_run(session, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run.")
    if run.presentation_id:
        resolve_presentation_access(
            session,
            user_id=principal.user_id,
            presentation_id=run.presentation_id,
            require=Role.VIEWER,
        )
    elif run.created_by != principal.user_id:
        raise HTTPException(status_code=404, detail="No such run.")

    redis_url = os.environ.get("REDIS_URL")

    def final_only() -> Any:
        payload = {
            "run_id": run_id,
            "stage": run.stage or "done",
            "status": "completed" if run.status == "completed" else run.status,
            "message": f"Run {run.status}.",
        }
        yield f"event: {payload['status']}\ndata: {json.dumps(payload)}\n\n"

    if not redis_url:
        return StreamingResponse(final_only(), media_type="text/event-stream")

    def relay() -> Any:
        import redis

        client = redis.Redis.from_url(redis_url)
        pubsub = client.pubsub()
        pubsub.subscribe(f"deckastra:run:{run_id}")
        try:
            for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                data = message["data"]
                text = data.decode() if isinstance(data, bytes) else str(data)
                event = json.loads(text)
                yield f"event: {event.get('status', 'progress')}\ndata: {text}\n\n"
                if event.get("stage") in {"propose", "done"} and event.get("status") == "completed":
                    break
        finally:
            pubsub.close()

    return StreamingResponse(relay(), media_type="text/event-stream")


@router.get("/presentations/{presentation_id}/runs")
def list_runs(
    presentation_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.VIEWER
    )

    return [
        {
            "id": run.id,
            "status": run.status,
            "stage": run.stage,
            "intent": run.intent,
            "warnings": run.warnings_json or [],
            "errors": run.errors_json or [],
            "budget": run.budget_json or {},
            "created_at": run.created_at.isoformat() if run.created_at else "",
        }
        for run in agent_store.recent_runs(session, presentation_id)
    ]


class MediaPlaceRequest(BaseModel):
    """Put a picture the workspace already holds on a slide (release 8)."""
    asset_id: str = Field(min_length=1, max_length=64)
    slide_id: str = Field(min_length=1, max_length=64)
    expected_version_id: str = Field(min_length=1, max_length=64)
    client_label: str = Field(min_length=1, max_length=60)
    placement: Literal["frame", "center", "background", "replace"] = "frame"
    replace_element_id: str | None = Field(default=None, max_length=64)
    alt_text: str = Field(min_length=1, max_length=900)
    intent: str = Field(default="Place a picture", min_length=1, max_length=200)


@router.post("/presentations/{presentation_id}/media/place")
def place_media(
    presentation_id: str,
    request: MediaPlaceRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Register a workspace picture in the deck and place it, as one proposal.

    The safe way for an agent to put an existing upload or generated picture
    on a slide: the manifest entry comes from the asset row, so the element can
    never cite a file the deck cannot find (release 8, 2026-10-17). It waits
    for the person, like every agent change that adds media.
    """
    access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR)
    asset = session.get(Asset, request.asset_id)
    if asset is None or asset.workspace_id != access.workspace_id or asset.deleted_at is not None:
        raise HTTPException(status_code=404, detail="No such picture in this workspace's Media.")
    if asset.kind != "image" or not asset.width or not asset.height:
        raise HTTPException(status_code=422, detail="Only a picture with known dimensions can be placed this way.")
    loaded = store.load_presentation(session, presentation_id)
    if loaded.version_id != request.expected_version_id:
        raise HTTPException(status_code=409, detail={"message": "The deck changed. Read it again and place the picture against the current version.", "code": "E310", "current_version_id": loaded.version_id})
    slide = next((item for item in loaded.document.get("slides") or [] if item.get("id") == request.slide_id), None)
    if slide is None:
        raise HTTPException(status_code=404, detail="No such slide in this deck.")
    operations = _picture_operations(
        loaded.document, slide, asset, alt_text=request.alt_text,
        placement=request.placement, replace_element_id=request.replace_element_id,
    )
    try:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=operations,
            intent=request.intent,
            created_by=principal.user_id,
            agent_id=f"mcp:{request.client_label}"[:120],
            source_ids=[asset.id],
            expected_version_id=request.expected_version_id,
            review_reason="A picture and its placement need visual review.",
        )
    except proposals.ProposalError as error:
        raise HTTPException(status_code=409, detail={"message": str(error), "code": error.code}) from error
    return {
        "proposal_id": outcome["transaction_id"],
        "status": outcome["status"],
        "risk_tier": outcome["risk_tier"],
        "asset_id": asset.id,
        "slide_id": request.slide_id,
        "awaiting": "The person reviews the picture beside the current slide in Review.",
    }
