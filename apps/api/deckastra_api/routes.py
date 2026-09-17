"""HTTP surface for documents, transactions and history (doc 05 §28).

The shape worth noticing: **the server does not compose patches.** A client sends
operations it has already decided on; the server validates, applies, versions and
attributes them. That is the same path an agent will take in Phase 5, which is
what keeps "human and AI editing are equal citizens" (doc 01 §4.7) from becoming
two code paths that drift.
"""

from __future__ import annotations

import base64
import copy
import re

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import assets as asset_service
from . import quotas, sync
from . import export_service, local_mode, motion, proposals, store, themes
from .auth import (
    Principal,
    Role,
    current_principal,
    resolve_creation_project,
    resolve_presentation_access,
    resolve_project_access,
)
from .compose import blank_document
from .db.models import Asset, Presentation, PresentationVersion, TransactionRow
from .db.session import get_session
from .patch import PatchError, apply_patch, disturbs
from .risk import assess_risk
from .schema import validate_document

router = APIRouter(prefix="/v1")


# ---------------------------------------------------------------- request models


class PatchOperationModel(BaseModel):
    op: Literal["add", "remove", "replace", "move", "copy", "test"]
    path: str
    value: Any = None
    from_: str | None = Field(default=None, alias="from")

    model_config = {"populate_by_name": True}

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"op": self.op, "path": self.path}
        if self.op in {"add", "replace", "test"}:
            out["value"] = self.value
        if self.op in {"move", "copy"}:
            out["from"] = self.from_
        return out


class ResolvesConflict(BaseModel):
    """What was merged, so a resolution is more than a change made afterwards.

    Time alone proves nothing — an ordinary edit written a minute after the
    refusal satisfies "later than the refusal", and so does an MCP client's
    low-risk change. These three make the change an **explicit declaration
    against validated versions**: the conflict it resolves, the remote version it
    is declared against, and the local version it was reviewed against. That a
    client supplied them is not evidence anyone read the divergence.
    """

    change_key: str = Field(max_length=64)
    remote_version_id: str = Field(max_length=64)
    local_version_id: str = Field(max_length=64)


class ApplyTransactionRequest(BaseModel):
    operations: list[PatchOperationModel] = Field(min_length=1, max_length=500)
    intent: str = Field(min_length=1, max_length=500)
    # Optimistic concurrency (doc 02 §31.2). Optional, but a client that omits it
    # is opting into last-write-wins and should mean it.
    expected_version_id: str | None = None
    client_id: str | None = None
    source: Literal["user", "agent", "system", "import"] = "user"
    agent_id: str | None = None
    user_instruction: str | None = None
    reason: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    #: What this change is called on the wire (D5.2). Supplied by a device
    #: replaying a change it authored offline; re-sending one already applied
    #: here answers with what it did the first time rather than applying it
    #: again. An ordinary editor save omits it.
    change_key: str | None = Field(default=None, max_length=64)
    #: Declare that this change resolves the deck's divergence (D5.3).
    #:
    #: Here rather than on a route of its own, and that is the whole correction:
    #: an acknowledgement that arrives *after* the merge is a second operation,
    #: and anything committed in the gap between them was retired by mistake. As
    #: one request the gap does not exist.
    resolves: ResolvesConflict | None = None


class TransactionSummary(BaseModel):
    id: str
    status: str
    source: str
    intent: str
    agent_id: str | None
    reason: str | None
    risk_tier: str | None
    parent_version_id: str
    result_version_id: str | None
    created_by: str
    created_at: str
    operation_count: int


class ApplyTransactionResponse(BaseModel):
    transaction_id: str
    version_id: str
    document: dict[str, Any]
    risk_tier: str
    snapshotted: bool
    #: True when this request was a retry of a change already applied here, and
    #: nothing was written. Said out loud because "it worked" and "it had already
    #: worked" are different facts to a device reconciling its outbox.
    duplicate: bool = False
    #: How many queued changes this resolution retired, when it was one.
    retired: int | None = None


def _summary(row) -> TransactionSummary:
    return TransactionSummary(
        id=row.id,
        status=row.status,
        source=row.source,
        intent=row.intent,
        agent_id=row.agent_id,
        reason=row.reason,
        risk_tier=row.risk_tier,
        parent_version_id=row.parent_version_id,
        result_version_id=row.result_version_id,
        created_by=row.created_by,
        created_at=row.created_at.isoformat(),
        operation_count=len(row.operations_json or []),
    )


# --------------------------------------------------------------------- routes


class CreateBlankRequest(BaseModel):
    title: str = Field(default="Untitled presentation", min_length=1, max_length=255)
    project_id: str | None = None


@router.post("/presentations", status_code=status.HTTP_201_CREATED)
def create_blank_presentation(
    request: CreateBlankRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    project = resolve_creation_project(session, user_id=principal.user_id, project_id=request.project_id)
    default_theme = themes.default_for(session, project.workspace_id)
    document = blank_document(request.title.strip() or "Untitled presentation",
                              theme_definition=default_theme.definition_json if default_theme else None,
                              theme_id=default_theme.id if default_theme else None)
    errors = validate_document(document)
    if errors:
        raise HTTPException(status_code=500, detail="The blank document failed schema validation.")
    stored = store.create_presentation(session, project_id=project.id, document=document, created_by=principal.user_id, source="user")
    return {"presentation_id": stored.presentation_id, "version_id": stored.version_id, "document": document}


@router.get("/presentations/{presentation_id}")
def get_presentation(
    presentation_id: str,
    at_version: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    access = resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id
    )

    loaded = store.load_presentation(session, presentation_id, at_version=at_version)
    return {
        "presentation_id": loaded.presentation_id,
        "version_id": loaded.version_id,
        "document": loaded.document,
        "role": access.role.name.lower(),
        "can_edit": access.can_edit,
    }


class PreviewRequest(BaseModel):
    slide_id: str = Field(min_length=1, max_length=64)
    #: Render as this pending proposal *would* leave the deck. Nothing is applied.
    proposal_id: str | None = Field(default=None, max_length=64)
    #: The version the caller believes it is looking at. When it is given and the
    #: deck has moved, the picture would be of something else — so it is refused
    #: rather than returned with a quietly different version id attached.
    expected_version_id: str | None = Field(default=None, max_length=64)


#: `/slides/id:sld_x/...` — the only way an operation names a slide (doc 02 §31.3).
_SLIDE_IN_PATH = re.compile(r"^/slides/id:([^/]+)")


def _slides_touched(operations: list[dict[str, Any]]) -> list[str]:
    """Which slides a patch reaches, in document order of first mention."""
    seen: list[str] = []
    for operation in operations:
        for path in (operation.get("path"), operation.get("from")):
            match = _SLIDE_IN_PATH.match(path or "")
            if match and match.group(1) not in seen:
                seen.append(match.group(1))
    return seen


#: The role vocabulary a motion plan speaks (doc 03 §12). Not a schema enum: an
#: element may carry any semantic role, and these are the ones the Motion Agent
#: is taught and the ones a deck this product composes actually uses.
MOTION_ROLES = ["eyebrow", "headline", "subtitle", "body", "metric", "quote", "caption"]


@router.post("/local/agent-access/revoke")
def revoke_agent_access(
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    """Stop honouring every grant issued so far.

    What "revoke" has to mean. A grant lasts hours, so withdrawing the attachment
    file only stops *new* readers: whoever already holds one would keep working
    for the rest of the day after the user said stop. This refuses everything
    issued up to now, and the desktop calls it when access is turned off.

    Reachable only by the app's own credential — `grants.py` requires
    `administer` here and no grant carries it. An agent that could revoke grants
    could revoke someone else's.
    """
    if not local_mode.enabled():
        # There is nothing to revoke in a deployment: grants are a local-mode
        # idea, and a route that pretended otherwise would be a lie in the API.
        raise HTTPException(status_code=404, detail="Not found.")
    assert principal.user_id
    return {"revoked_before": local_mode.revoke_grants()}


@router.get("/motion/capabilities")
def motion_capabilities(
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    """What a motion plan may say — and, by omission, what it may not.

    There are no milliseconds here on purpose. A caller names roles, a preset and
    one word of pacing; code turns that into durations, which is what makes doc 04
    §24.2's entrance budget something enforced rather than something a model is
    asked to respect. A tool surface that accepted timings would move that line.
    """
    # `principal` is not read: the dependency is the authentication, and this
    # answer is the same vocabulary for everyone who may ask at all.
    return {
        "presets": sorted(motion.KNOWN_PRESETS),
        "pacing": {name: dict(values) for name, values in motion.PACING.items()},
        "roles": MOTION_ROLES,
        "entrance_budget_ms": motion.ENTRANCE_BUDGET_MS,
        "read_immediately_words": motion.READ_IMMEDIATELY_WORDS,
        "notes": [
            "Sequence by role. Roles you leave out are on screen from the first frame.",
            "Durations, delays and easing are computed here; a plan cannot name them.",
            "A sequence that would over-run the entrance budget is compressed, not refused.",
            "Body text past the word limit is left in place — the audience has to read it.",
        ],
    }


class MotionRequest(BaseModel):
    slide_id: str = Field(min_length=1, max_length=64)
    #: Required, like every other agent write: a plan authored against a version
    #: that has moved is a plan for a slide that may no longer hold those roles.
    expected_version_id: str = Field(min_length=1, max_length=64)
    #: Reveal order by semantic role.
    sequence: list[str] = Field(min_length=1, max_length=12)
    entrance: str = Field(default="fade", max_length=40)
    pacing: Literal["tight", "measured", "deliberate"] = "measured"
    click_reveals: int = Field(default=0, ge=0, le=6)
    intent: str = Field(default="Animate a slide", min_length=1, max_length=500)
    client_label: str = Field(default="external", max_length=60)


@router.post("/presentations/{presentation_id}/motion")
def propose_motion(
    presentation_id: str,
    request: MotionRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Animate one slide from a plan in roles, through the composer's own code.

    `animate_slide` is what the composer calls, so an agent's motion is the
    product's motion: the same presets, the same restraint rules, and the same
    `_fit_to_budget` compression. A second implementation here would be a second
    set of answers to "how long is a reveal", and one of them would drift.

    The result becomes an ordinary proposal — risk computed from the operations,
    an inverse recorded, undo like any edit — because that is how every agent
    change reaches the store.
    """
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )

    head = store.load_presentation(session, presentation_id)
    if head.version_id != request.expected_version_id:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "This deck has changed since you read it. Read it again and re-plan "
                    "the motion against the current version."
                ),
                "code": "E310",
                "current_version_id": head.version_id,
            },
        )

    slide = next(
        (one for one in head.document.get("slides", []) if one.get("id") == request.slide_id),
        None,
    )
    if slide is None:
        raise HTTPException(status_code=404, detail=f"No slide {request.slide_id} in this deck.")

    # On a copy: `animate_slide` mutates, and the document we hold is the one the
    # store handed us. Patching is how a change reaches it.
    animated = copy.deepcopy(slide)
    warnings = motion.animate_slide(
        animated,
        {
            "sequence": request.sequence,
            "entrance": request.entrance,
            "pacing": request.pacing,
            "click_reveals": request.click_reveals,
        },
    )

    before = slide.get("animations")
    after = animated.get("animations")
    if after == before:
        # Nothing matched: roles that are not on this slide, or text long enough
        # that the rules leave it in place. Said plainly rather than committing an
        # empty change, which would put a version in the history for nothing.
        return {
            "outcome": "none",
            "warnings": warnings,
            "refusal": (
                "None of those roles animate on this slide. Read the slide to see which "
                "roles its elements carry."
            ),
            "version_id": head.version_id,
        }

    operations = [
        {
            # `add` when the slide has no animations yet: `replace` refuses a
            # property that does not exist (doc 02 §31.3).
            "op": "replace" if before is not None else "add",
            "path": f"/slides/id:{request.slide_id}/animations",
            "value": after,
        }
    ]

    try:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=operations,
            intent=request.intent,
            created_by=principal.user_id,
            agent_id=f"mcp:{request.client_label}"[:120],
            reason="; ".join(warnings)[:1000] or None,
            # The route's own check above is an early, clearer error; this is the
            # one that cannot be raced, because `create_proposal` loads the base.
            expected_version_id=request.expected_version_id,
        )
    except proposals.ProposalError as error:
        raise HTTPException(
            status_code=409, detail={"message": str(error), "code": error.code}
        ) from error

    return {
        "outcome": outcome["status"],
        "risk_tier": outcome["risk_tier"],
        "reasons": outcome.get("reasons") or [],
        "transaction_id": outcome["transaction_id"],
        "version_id": outcome.get("version_id"),
        "expires_at": outcome.get("expires_at"),
        "track_count": len(after or []),
        "warnings": warnings,
    }


class TransitionRequest(BaseModel):
    slide_id: str = Field(min_length=1, max_length=64)
    expected_version_id: str = Field(min_length=1, max_length=64)
    #: What the deck does moving *into* this slide.
    kind: Literal["cut", "fade", "slide", "push", "zoom", "morph"] = "fade"
    pacing: Literal["tight", "measured", "deliberate"] = "measured"
    #: Semantic roles to carry across, for a morph. Roles, never ids: the agent
    #: plans before ids exist, and a pairing written in roles survives a layout.
    carry: list[str] = Field(default_factory=list, max_length=8)
    intent: str = Field(default="Set a slide transition", min_length=1, max_length=500)
    client_label: str = Field(default="external", max_length=60)


@router.post("/presentations/{presentation_id}/transition")
def propose_transition(
    presentation_id: str,
    request: TransitionRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Set how the deck moves into one slide, from a plan in roles.

    The entrance planner's split, applied to the space *between* slides: the
    caller names a kind, one word of pacing, and the roles that carry across;
    `motion.plan_transition` resolves those roles against both slides and
    computes the duration. There is no field for milliseconds, and that absence
    is the feature — the same one doc 04 §24.2 relies on for entrances.

    Shared elements are the one place a *guess* is written down. Doc 02 §26 says
    two unrelated objects are never silently morphed, which the engine enforces
    by refusing to pair on its own; a mapping proposed here is explicit in the
    document, visible in the editor, and breakable by the author — which is the
    difference between a suggestion and a silent decision.
    """
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )

    head = store.load_presentation(session, presentation_id)
    if head.version_id != request.expected_version_id:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "This deck has changed since you read it. Read it again and re-plan "
                    "the transition against the current version."
                ),
                "code": "E310",
                "current_version_id": head.version_id,
            },
        )

    slides = head.document.get("slides", [])
    index = next(
        (at for at, one in enumerate(slides) if one.get("id") == request.slide_id), None
    )
    if index is None:
        raise HTTPException(status_code=404, detail=f"No slide {request.slide_id} in this deck.")

    slide = slides[index]
    previous = slides[index - 1] if index > 0 else None

    transition, warnings = motion.plan_transition(
        previous,
        slide,
        kind=request.kind,
        pacing=request.pacing,
        carry=request.carry,
    )

    if transition == slide.get("transition"):
        # Identical to what is already there. Committing would put a version in
        # the history that changes nothing, which every later diff has to be read
        # past.
        return {
            "outcome": "none",
            "warnings": warnings,
            "refusal": "That is already this slide's transition.",
            "version_id": head.version_id,
        }

    operations = [
        {
            # `add` when the slide has no transition yet: `replace` refuses a
            # property that does not exist (doc 02 §31.3).
            "op": "replace" if slide.get("transition") is not None else "add",
            "path": f"/slides/id:{request.slide_id}/transition",
            "value": transition,
        }
    ]

    try:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=operations,
            intent=request.intent,
            created_by=principal.user_id,
            agent_id=f"mcp:{request.client_label}"[:120],
            reason="; ".join(warnings)[:1000] or None,
            expected_version_id=request.expected_version_id,
        )
    except proposals.ProposalError as error:
        raise HTTPException(
            status_code=409, detail={"message": str(error), "code": error.code}
        ) from error

    return {
        "outcome": outcome["status"],
        "risk_tier": outcome["risk_tier"],
        "reasons": outcome.get("reasons") or [],
        "transaction_id": outcome["transaction_id"],
        "version_id": outcome.get("version_id"),
        "expires_at": outcome.get("expires_at"),
        "paired": len(transition.get("sharedElements") or []),
        "warnings": warnings,
    }


@router.post("/presentations/{presentation_id}/preview")
def preview_slide(
    presentation_id: str,
    request: PreviewRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """One slide as an image — as stored, or as a pending proposal would leave it.

    The reason this exists is D2's: an agent that cannot see its own change has
    to ask the person whose deck it is to look, which is exactly the review the
    preview was supposed to support. It renders through the same worker and the
    same browser an export uses, because a preview produced any other way is a
    picture of a deck this product would not export.

    A named proposal needs editor access — it is unapplied work, visible to
    people who could approve it — while previewing the stored deck needs only the
    access a read needs.
    """
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR if request.proposal_id else Role.VIEWER,
    )

    loaded = store.load_presentation(session, presentation_id)
    if request.expected_version_id and loaded.version_id != request.expected_version_id:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "This deck has changed since you read it, so this picture would be of "
                    "a different deck. Read it again."
                ),
                "code": "E310",
                "current_version_id": loaded.version_id,
            },
        )

    loaded_document = loaded.document
    document = loaded_document
    changed: list[str] = []
    proposal_base: str | None = None
    rebased = False

    if request.proposal_id:
        transaction = session.get(TransactionRow, request.proposal_id)
        if transaction is None or transaction.presentation_id != presentation_id:
            raise HTTPException(status_code=404, detail="No such proposal.")
        if transaction.status != "pending":
            raise HTTPException(
                status_code=409,
                detail={
                    "message": f"This proposal is {transaction.status}, not pending.",
                    "code": "E409",
                },
            )
        operations = transaction.operations_json or []
        try:
            # Onto a copy, and nothing is committed: a preview must not be a
            # second way to apply a change that has not been approved.
            document, _inverse = apply_patch(loaded.document, operations)
        except PatchError as error:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": (
                        "This change no longer applies — the deck moved since it was "
                        f"proposed. ({error})"
                    ),
                    "code": error.code,
                },
            ) from error
        changed = _slides_touched(operations)
        proposal_base = transaction.parent_version_id
        # A preview of a proposal whose base has moved is a preview of a *rebased*
        # change: it still applies, but it is not the change as it was written.
        # Approval refuses that silently-different case, so the picture says so.
        rebased = bool(proposal_base and proposal_base != loaded.version_id)

    if not any(slide.get("id") == request.slide_id for slide in document.get("slides", [])):
        # Named rather than rendered blank: after a proposal that removes a
        # slide, asking for it is a reasonable mistake with a specific answer.
        raise HTTPException(
            status_code=404, detail=f"No slide {request.slide_id} in this deck."
        )

    try:
        rendered = export_service.render_slide_png(
            document,
            request.slide_id,
            # The same authorized load an export does. A preview that drew
            # placeholders where the export draws pictures would be a picture of a
            # deck this product does not produce.
            assets=asset_service.inline_for_render(
                session, presentation_id=presentation_id, document=document
            ),
        )
    except export_service.ExportError as error:
        # 502: the renderer is a subprocess, and its failure is not the caller's
        # request being wrong.
        raise HTTPException(status_code=502, detail=str(error)) from error

    return {
        "slide_id": request.slide_id,
        "image_base64": base64.b64encode(rendered["bytes"]).decode("ascii"),
        "width": rendered["width"],
        "height": rendered["height"],
        "version_id": loaded.version_id,
        "changed_slide_ids": changed,
        "metrics_estimated": rendered["metrics_estimated"],
        "proposal_base_version_id": proposal_base,
        "rebased": rebased,
    }


@router.get("/projects/{project_id}/presentations")
def list_presentations(
    project_id: str,
    limit: int = 200,
    after: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """The decks in one project, most recently changed first, without content.

    There was no way to ask this. `/v1/account` names workspaces and projects,
    and every other read needed a presentation id the caller already had — so an
    agent over MCP, asked "which decks do I have", could name the one open in the
    window and nothing else. A real Claude Code session found that and said so.

    Rows only. Listing a project must not cost a replay of every deck in it.

    **`after` pages, and it changes the ordering on purpose.** Without a cursor
    this stopped at the limit and said nothing, so a caller reading every deck —
    a sync bootstrap, say — silently saw the first page and concluded that was
    all of them (found by review, 2026-09-17). Paging by *id* rather than by
    "most recently changed" is what makes that safe: ids never change, so a deck
    edited while the pages are being read cannot jump between them or be skipped,
    where `updated_at` reorders under a reader mid-walk. The default ordering is
    unchanged for the UI, which wants recency and reads one page.

    `next_after` is present exactly when there may be more, so a caller loops
    while it is there rather than comparing counts against a limit it has to
    remember.
    """
    resolve_project_access(session, user_id=principal.user_id, project_id=project_id)
    size = min(max(limit, 1), 500)

    query = select(Presentation).where(Presentation.project_id == project_id)
    if after is not None:
        query = query.where(Presentation.id > after).order_by(Presentation.id)
    else:
        # `id` breaks ties so two decks touched in the same instant keep one order.
        query = query.order_by(Presentation.updated_at.desc(), Presentation.id)

    rows = session.scalars(query.limit(size)).all()
    answer: dict[str, Any] = {
        "presentations": [
            {
                "id": row.id,
                "title": row.title,
                "version_id": row.current_version_id,
                "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            }
            for row in rows
        ]
    }
    if after is not None and len(rows) == size:
        answer["next_after"] = rows[-1].id
    return answer


class MovePresentationRequest(BaseModel):
    """Where the deck should go. Nothing else about it changes."""

    project_id: str


@router.post("/presentations/{presentation_id}/move")
def move_presentation(
    presentation_id: str,
    request: MovePresentationRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Move one deck to another project — the only way a deck changes workspace.

    D5.1, and the reason it exists is what it makes *impossible*. A desktop
    install has a local workspace full of decks that have never left the machine.
    Signing in adds a workspace; the tempting next step is to upload what is
    already there, and that would be a privacy decision taken on the user's
    behalf in the one direction that cannot be taken back — the same argument D3
    used to refuse a silent fall-back to a cloud model. So nothing moves by
    itself, ever, and this route is the whole of the other path: one deck, named
    by the person moving it, to a project they picked.

    Three refusals, each because the alternative is a deck that looks moved and
    is broken:

    * **Editor on both sides.** On the destination because a move is a write
      there; on the source because it is a removal from everyone else who could
      see it. A viewer cannot launder a deck out of a workspace by moving it
      somewhere they have rights.
    * **No pending proposals.** A pending change is waiting for a human in the
      *source* workspace to approve it. Moving the deck hands that decision to a
      different set of people, none of whom saw the preview the request was
      authored against — which is the one thing the proposal lifecycle exists to
      prevent.
    * **No assets.** `Asset.workspace_id` scopes an upload to the workspace that
      holds it, so a deck citing images would arrive with every picture
      unreadable by the people it arrived for. Carrying them is real work —
      an asset can be cited by other decks in the source workspace, so it is a
      copy-or-move decision per file — and it belongs to D5.5 with the rest of
      assets. Refusing by name is honest; moving the rows and hoping is not.

    What survives is everything that makes it the same deck: the presentation id,
    the version chain, the transaction history and any share links, all of which
    key on the presentation rather than on the project it sits in.
    """
    access = resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )
    destination, _role = resolve_project_access(
        session,
        user_id=principal.user_id,
        project_id=request.project_id,
        require=Role.EDITOR,
    )

    if destination.id == access.project.id:
        return {
            "presentation_id": presentation_id,
            "project_id": destination.id,
            "workspace_id": destination.workspace_id,
            "moved": False,
            "refusal": "That deck is already in this project.",
        }

    pending = session.scalar(
        select(TransactionRow).where(
            TransactionRow.presentation_id == presentation_id,
            TransactionRow.status == "pending",
        )
    )
    if pending is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "This deck has a change waiting for approval. Approve or reject it "
                "before moving the deck, so the person who has to decide is still "
                "someone who can see it."
            ),
        )

    # D5.2. A deck that has lived its whole life in a local workspace has no
    # change keys and no outbox rows — nothing was ever owed to anyone. Moving it
    # into a workspace that syncs would therefore produce a deck that looks
    # shared and silently never uploads, which is worse than refusing: the
    # failure is invisible until someone else cannot find it.
    #
    # Seeding a moved deck is a real piece of work — it is an upload of the
    # current state rather than a replay of a local history whose changes have no
    # keys — and it belongs with the rest of sync. Until then this is closed
    # rather than left open.
    if sync.workspace_origin(session, destination.workspace_id) == sync.SYNCING_ORIGIN:
        raise HTTPException(
            status_code=409,
            detail=(
                "That workspace syncs to a server, and moving a deck into one is not "
                "supported yet — its history was authored offline and has nothing to "
                "upload under. Create the deck in the shared workspace instead."
            ),
        )

    # The deck's pictures go with it (D5.5). `Asset.workspace_id` scopes an
    # upload to the workspace holding it, so a deck that moved without its files
    # would arrive with every image unreadable by the people it arrived for — and
    # its own history pointing at bytes it can no longer see.
    #
    # Across the whole of its history, not just the current slides: a third
    # version citing an image the fifth deleted is a reference that still has to
    # resolve, and version history is what this product promises hardest.
    mine = asset_service.cited_by_history(session, presentation_id)
    shared = mine & asset_service.cited_elsewhere(
        session,
        workspace_id=access.workspace_id,
        except_presentation_id=presentation_id,
    )
    if shared:
        # A file two decks use cannot move with one of them, and copying it would
        # mean minting a second asset id and rewriting the document to point at
        # it — which makes a move an edit, and a move must not change the deck.
        raise HTTPException(
            status_code=409,
            detail=(
                f"{len(shared)} of this deck's uploaded file(s) are also used by other "
                "decks in this workspace, so they cannot move with it. Replace them "
                "with copies of their own, or move those decks too."
            ),
        )

    presentation = access.presentation
    presentation.project_id = destination.id
    for asset_id in sorted(mine):
        asset = session.get(Asset, asset_id)
        if asset is not None and asset.workspace_id == access.workspace_id:
            asset.workspace_id = destination.workspace_id
    session.flush()

    # Storage is a level rather than a flow (`quotas.py`), so both sides are
    # recounted rather than adjusted: an increment missed once is wrong forever.
    quotas.recount_storage(session, access.workspace_id)
    quotas.recount_storage(session, destination.workspace_id)

    return {
        "presentation_id": presentation_id,
        "project_id": destination.id,
        "workspace_id": destination.workspace_id,
        "from_workspace_id": access.workspace_id,
        "moved": True,
        #: How many uploaded files travelled with it.
        "assets_moved": len(mine),
        # Unchanged, and said out loud: a move must not look like a new deck to
        # anything holding a reference to this one.
        "version_id": presentation.current_version_id,
    }


@router.get("/presentations/{presentation_id}/head")
def get_presentation_head(
    presentation_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Which version is current, without the document.

    An open editor asks this every few seconds so a change made somewhere else —
    an agent over MCP, a second window — reaches the person looking at the deck.
    The full read replays operations forward from the nearest snapshot, which is
    the wrong thing to do on a timer when the answer is almost always "nothing
    changed". This is one row.
    """
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id
    )
    presentation = session.get(Presentation, presentation_id)
    if presentation is None or presentation.current_version_id is None:
        raise HTTPException(status_code=404, detail="No such deck.")

    # Which change produced it, so an editor that adopts someone else's work can
    # offer to undo *that* rather than leaving the user with a deck that changed
    # under them and no way back. The inverse lives server-side, computed against
    # the pre-state, so the editor needs only the id.
    latest = session.scalar(
        select(TransactionRow).where(
            TransactionRow.presentation_id == presentation_id,
            TransactionRow.result_version_id == presentation.current_version_id,
        )
    )
    return {
        "presentation_id": presentation_id,
        "version_id": presentation.current_version_id,
        "transaction_id": latest.id if latest else None,
        "source": latest.source if latest else None,
        "intent": latest.intent if latest else None,
        "client_id": latest.client_id if latest else None,
    }


@router.get("/presentations/{presentation_id}/sync")
def sync_status(
    presentation_id: str,
    documents: bool = False,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Where this deck stands with the server, and what a merge would need (D5.3).

    Four states rather than a boolean, because "not in sync" covers two different
    situations and only one of them needs a person: a queue that is merely
    waiting clears itself, and a diverged one never will.

    `documents` is off by default and that is not a micro-optimisation. An editor
    polls this; a diverged deck would otherwise send three whole documents on
    every poll, forever, to a client that already has them. It asks once, when it
    decides to show the review.

    The three it gets are the three a three-way merge takes — and all three are
    read locally. The base is the version the refused change was authored
    against, the local one is this device's head, and the remote one is what the
    server had when it refused, kept since. Reconciling therefore needs no
    network, which matters because the network is usually what was missing when
    the divergence happened.
    """
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id
    )

    state = sync.status(session, presentation_id)
    answer: dict[str, Any] = {
        "presentation_id": state.presentation_id,
        "state": state.state,
        "pending": state.pending,
    }
    if state.diverged is not None:
        answer["diverged"] = {
            "change_key": state.diverged.change_key,
            "reason": state.diverged.reason,
            "remote_version_id": state.diverged.remote_version_id,
            "base_version_id": state.diverged.base_version_id,
            "intent": state.diverged.intent,
        }

    if documents and state.diverged is not None:
        head = store.load_presentation(session, presentation_id)
        base = (
            store.load_presentation(
                session, presentation_id, at_version=state.diverged.base_version_id
            ).document
            if state.diverged.base_version_id
            else None
        )
        answer["merge"] = {
            "base": base,
            "local": head.document,
            "local_version_id": head.version_id,
            "remote": sync.remote_document(session, presentation_id),
        }

    return answer


@router.post("/presentations/{presentation_id}/transactions", response_model=ApplyTransactionResponse)
def apply_transaction(
    presentation_id: str,
    request: ApplyTransactionRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ApplyTransactionResponse:
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )

    # D5.2. Before anything else, including the concurrency check: a retry of a
    # change that already landed necessarily carries a stale
    # `expected_version_id`, because applying it the first time is what moved the
    # head. Checking versions first would answer 409 to every retry and the
    # device would never be able to clear its outbox.
    if request.change_key is not None:
        already = store.transaction_by_change_key(
            session, presentation_id, request.change_key
        )
        if already is not None and already.result_version_id is not None:
            head = store.load_presentation(session, presentation_id)
            return ApplyTransactionResponse(
                transaction_id=already.id,
                version_id=already.result_version_id,
                document=head.document,
                risk_tier=already.risk_tier or "low",
                snapshotted=False,
                duplicate=True,
            )

    loaded = store.load_presentation(session, presentation_id)

    # Checked before anything is written: a resolution claim that does not hold
    # must not leave a version row behind. The retirement happens after the
    # commit, in this same database transaction, so the merge and the
    # acknowledgement are one operation and nothing can arrive between them.
    if request.resolves is not None:
        problem = sync.resolution_problem(
            session,
            presentation_id,
            sync.Resolution(
                change_key=request.resolves.change_key,
                remote_version_id=request.resolves.remote_version_id,
                local_version_id=request.resolves.local_version_id,
            ),
            head_version_id=loaded.version_id,
        )
        if problem:
            raise HTTPException(status_code=409, detail=problem)

    operations = [operation.to_dict() for operation in request.operations]

    # Risk is computed here, from the operations, never taken from the caller — a
    # caller-declared tier is a caller-controlled security boundary (doc 02 §31.7).
    risk = assess_risk(operations)

    try:
        document, inverse = apply_patch(loaded.document, operations)
    except PatchError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(error),
                "code": error.code,
                "operation_index": error.operation_index,
                "path": error.path,
            },
        ) from error

    # Validate before committing. Doc 04 §6.4 refuses to render an invalid
    # document, so storing one only moves the failure somewhere less diagnosable.
    errors = validate_document(document)
    if errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"message": "The patch would produce an invalid document.", "errors": errors},
        )

    try:
        result = store.commit_transaction(
            session,
            presentation_id=presentation_id,
            operations=operations,
            inverse_operations=inverse,
            document=document,
            parent_version_id=loaded.version_id,
            expected_version_id=request.expected_version_id,
            intent=request.intent,
            source=request.source,
            created_by=principal.user_id,
            agent_id=request.agent_id,
            client_id=request.client_id,
            user_instruction=request.user_instruction,
            reason=request.reason,
            confidence=request.confidence,
            risk_tier=risk.tier,
            change_key=request.change_key,
        )
    except store.VersionConflict as conflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(conflict),
                "code": "E304",
                "expected_version_id": conflict.expected,
                "current_version_id": conflict.actual,
            },
        ) from conflict

    retired = None
    if request.resolves is not None:
        retired = sync.retire_for_resolution(
            session, presentation_id, resolving_transaction_id=result.transaction_id
        )

    return ApplyTransactionResponse(
        transaction_id=result.transaction_id,
        version_id=result.version_id,
        document=result.document,
        risk_tier=risk.tier,
        snapshotted=result.snapshotted,
        retired=retired,
    )


@router.get("/presentations/{presentation_id}/transactions", response_model=list[TransactionSummary])
def list_transactions(
    presentation_id: str,
    limit: int = 50,
    transaction_status: str | None = None,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[TransactionSummary]:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id
    )
    rows = store.transaction_history(
        session, presentation_id, limit=min(limit, 200), status=transaction_status
    )
    return [_summary(row) for row in rows]


def _later_conflicts(session: Session, original) -> set[str]:
    """Ids that a transaction applied after `original` would make its undo unsafe."""
    conflicts: set[str] = set()

    for row in store.transaction_history(session, original.presentation_id, limit=500):
        if row.id == original.id or row.status != "applied":
            continue
        if row.created_at <= original.created_at:
            continue
        conflicts |= disturbs(original.operations_json, row.operations_json)

    return conflicts


@router.post(
    "/presentations/{presentation_id}/transactions/{transaction_id}/revert",
    response_model=ApplyTransactionResponse,
)
def revert_transaction(
    presentation_id: str,
    transaction_id: str,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> ApplyTransactionResponse:
    """Undo one specific change, including an AI one (doc 01 §4.2).

    Reverting appends a new transaction rather than deleting the original: "this
    was undone" is a fact worth keeping, and a version lineage with holes in it
    cannot be replayed.
    """
    resolve_presentation_access(
        session,
        user_id=principal.user_id,
        presentation_id=presentation_id,
        require=Role.EDITOR,
    )

    original = store.get_transaction(session, transaction_id)
    if original.presentation_id != presentation_id:
        raise HTTPException(status_code=404, detail="No such transaction.")
    if original.status != "applied":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Only an applied transaction can be reverted; this one is {original.status}.",
        )

    # An inverse is computed against one specific state. Some of it can only be
    # index-addressed — restoring a removed element has to name a position — so
    # replaying it after an unrelated structural change can land on whatever now
    # occupies that index. Refusing is the only safe answer; the alternative is
    # silently editing the wrong thing (doc 04 §29.3).
    conflicts = _later_conflicts(session, original)
    if conflicts:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": (
                    "This change can no longer be undone on its own — a later edit "
                    "changed what it depends on. Undo the later changes first."
                ),
                "code": "E303",
                "conflicting_ids": sorted(conflicts),
            },
        )

    loaded = store.load_presentation(session, presentation_id)

    try:
        document, inverse = apply_patch(loaded.document, original.inverse_operations_json)
    except PatchError as error:
        # The inverse no longer applies because a later edit moved what it depends
        # on. Refused with a reason rather than half-applied.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": (
                    "This change can no longer be undone on its own — a later edit "
                    f"changed what it depends on. ({error})"
                ),
                "code": error.code,
            },
        ) from error

    result = store.commit_transaction(
        session,
        presentation_id=presentation_id,
        operations=original.inverse_operations_json,
        inverse_operations=inverse,
        document=document,
        parent_version_id=loaded.version_id,
        expected_version_id=None,
        intent=f"Undo: {original.intent}",
        source="user",
        created_by=principal.user_id,
        label=f"Undo: {original.intent}"[:200],
    )

    original.status = "reverted"
    session.flush()

    return ApplyTransactionResponse(
        transaction_id=result.transaction_id,
        version_id=result.version_id,
        document=result.document,
        risk_tier="low",
        snapshotted=result.snapshotted,
    )


class VersionSummary(BaseModel):
    id: str
    parent_version_id: str | None
    source: str
    label: str | None
    created_by: str
    created_at: str
    is_snapshot: bool


@router.get("/presentations/{presentation_id}/versions", response_model=list[VersionSummary])
def list_versions(
    presentation_id: str,
    limit: int = 50,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[VersionSummary]:
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id
    )

    return [
        VersionSummary(
            id=version.id,
            parent_version_id=version.parent_version_id,
            source=version.source,
            label=version.label,
            created_by=version.created_by,
            created_at=version.created_at.isoformat(),
            is_snapshot=version.snapshot_json is not None,
        )
        for version in store.version_history(session, presentation_id, limit=min(limit, 200))
    ]
