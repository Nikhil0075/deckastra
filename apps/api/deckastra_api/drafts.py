"""Geometry-free draft boards and deterministic builds."""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session

from . import languages, local_mode, presets, proposals, store, template_compose, variety
from .auth import Principal, Role, current_principal, resolve_presentation_access, resolve_project_access
from .compose import compose_document
from .db.models import AgentRequest, Draft, StyleOptionSet, TransactionRow
from .db.session import get_session
from .ids import new_id
from .models import ChartPlan, DiagramPlan, SlideLayout, SlidePlan, StoryPlan, TimelineEntryPlan
from .patch import apply_patch
from .schema import validate_document
from .style_options import StyleOptionInput, _operations as style_operations

router = APIRouter(prefix="/v1")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DraftImage(StrictModel):
    subject: str = Field(min_length=1, max_length=400)
    style_source: Literal["deck", "prompt"] = "deck"
    #: An image already present in the linked deck. Keeping its identity makes a
    #: seeded board a content model of the slide rather than a lossy text-only
    #: description of it.
    asset_id: str | None = Field(default=None, max_length=64)


class DraftBlock(StrictModel):
    role: Literal[
        "headline", "subtitle", "body", "bullet", "metric", "quote",
        "chart", "diagram", "timeline", "image",
    ]
    text: str | None = Field(default=None, max_length=4_000)
    data: dict[str, Any] | list[Any] | None = None
    image: DraftImage | None = None

    @model_validator(mode="after")
    def content_matches_role(self) -> "DraftBlock":
        if self.role in {"chart", "diagram", "timeline"} and self.data is None:
            raise ValueError(f"A {self.role} block needs data.")
        if self.role == "image" and self.image is None and not (self.text or "").strip():
            raise ValueError("An image block needs a subject.")
        if self.data is not None:
            def has_colour(value: Any) -> bool:
                if isinstance(value, dict):
                    return any(str(key).lower() in {"color", "colour", "fill", "stroke", "palette"} or has_colour(item) for key, item in value.items())
                return isinstance(value, list) and any(has_colour(item) for item in value)
            if has_colour(self.data):
                raise ValueError("Draft blocks carry content, not colours.")
            if self.role == "chart":
                self.data = ChartPlan.model_validate(self.data).model_dump(mode="json")
            elif self.role == "diagram":
                self.data = DiagramPlan.model_validate(self.data).model_dump(mode="json")
            elif self.role == "timeline":
                if not isinstance(self.data, list):
                    raise ValueError("A timeline block's data is a list of entries.")
                self.data = [TimelineEntryPlan.model_validate(item).model_dump(mode="json") for item in self.data]
            elif self.role == "metric":
                if not isinstance(self.data, dict) or set(self.data) - {"value", "label"}:
                    raise ValueError("Metric data contains only value and label.")
            else:
                raise ValueError(f"A {self.role} block cannot carry structured data.")
        return self


class DraftMotion(StrictModel):
    pacing: str = Field(default="measured", min_length=1, max_length=40)
    emphasis_roles: list[str] = Field(default_factory=list, max_length=8)


class DraftCard(StrictModel):
    id: str = Field(min_length=1, max_length=64)
    layout: str = Field(min_length=1, max_length=80)
    blocks: list[DraftBlock] = Field(default_factory=list, max_length=30)
    alternatives: list[list[DraftBlock]] = Field(default_factory=list, max_length=5)
    motion: DraftMotion | None = None
    notes: str | None = Field(default=None, max_length=4_000)
    locked: bool = False
    #: The linked deck's slide this card was seeded from, and what the card said
    #: then. A card whose content still matches keeps its slide untouched on
    #: build; a changed one is recomposed under the same slide id (2026-10-15).
    source_slide_id: str | None = Field(default=None, max_length=64)
    source_fingerprint: str | None = Field(default=None, max_length=64)


class DraftBody(StrictModel):
    brief: str | None = Field(default=None, max_length=8_000)
    style: str | StyleOptionInput | None = None
    cards: list[DraftCard] = Field(default_factory=list, max_length=60)

    @model_validator(mode="after")
    def valid_cards(self) -> "DraftBody":
        ids = [card.id for card in self.cards]
        if len(ids) != len(set(ids)):
            raise ValueError("Every draft card needs its own id.")
        layouts = {item.value for item in SlideLayout}
        patterns = set((presets.catalog().get("patternDefinitions") or {}).keys())
        unknown = sorted({card.layout for card in self.cards if card.layout not in layouts | patterns})
        if unknown:
            raise ValueError("Unknown slide layout or pattern: " + ", ".join(unknown))
        return self


class DraftCreate(StrictModel):
    title: str = Field(default="Untitled draft", min_length=1, max_length=300)
    body: DraftBody | None = None
    presentation_id: str | None = Field(default=None, max_length=64)


class DraftReplace(StrictModel):
    revision: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    body: DraftBody


class DraftOperation(StrictModel):
    op: Literal["add", "remove", "move", "set_blocks", "set_layout", "add_alternative", "choose_alternative", "set_locked"]
    card_id: str | None = Field(default=None, max_length=64)
    card: DraftCard | None = None
    index: int | None = Field(default=None, ge=0, le=60)
    blocks: list[DraftBlock] | None = Field(default=None, max_length=30)
    layout: str | None = Field(default=None, min_length=1, max_length=80)
    alternative: list[DraftBlock] | None = Field(default=None, max_length=30)
    alternative_index: int | None = Field(default=None, ge=0, le=4)
    locked: bool | None = None


class DraftPatch(StrictModel):
    revision: int = Field(ge=1)
    operations: list[DraftOperation] = Field(min_length=1, max_length=100)


class DraftBuild(StrictModel):
    revision: int = Field(ge=1)
    card_ids: list[str] | None = Field(default=None, max_length=60)


class DraftRequestCreate(StrictModel):
    card_ids: list[str] = Field(min_length=1, max_length=20)
    block_ids: list[str] = Field(default_factory=list, max_length=50)
    kind: str = Field(default="other", pattern=r"^(motion|style|content|image|layout|other)$")
    message: str = Field(min_length=1, max_length=2_000)
    revision: int = Field(ge=1)


class DraftRequestAnswer(StrictModel):
    revision: int = Field(ge=1)


def _view(row: Draft) -> dict[str, Any]:
    body = DraftBody.model_validate(row.body_json)
    return {
        "id": row.id, "project_id": row.project_id, "presentation_id": row.presentation_id,
        "title": row.title, "body": body.model_dump(mode="json", exclude_none=True),
        "revision": row.revision, "built_version_id": row.built_version_id,
        "built_revision": row.built_revision,
        "changed_since_build": row.built_revision is not None and row.revision != row.built_revision,
        "created_by": row.created_by,
        "created_at": row.created_at.isoformat() if row.created_at else "",
        "updated_at": row.updated_at.isoformat() if row.updated_at else "",
        "deleted_at": row.deleted_at.isoformat() if row.deleted_at else None,
        "density_warnings": _density_warnings(body),
    }


def _view_with_deck(session: Session, row: Draft) -> dict[str, Any]:
    """The board, plus which cards' slides moved in the deck since it took them.

    Every route that hands the board back to its editor answers this way, so
    the board's warnings follow each edit rather than only a fresh read.
    """
    view = _view(row)
    if row.presentation_id:
        try:
            deck = store.load_presentation(session, row.presentation_id).document
        except Exception:  # noqa: BLE001 - a missing or deleted deck reads as nothing moved
            return view
        body = DraftBody.model_validate(row.body_json)
        view["deck_changed_card_ids"] = sorted(_deck_moved(body, deck))
        view["deck_conflict_card_ids"] = _deck_conflicts(body, deck)
    return view


def _request_view(row: AgentRequest, draft: Draft) -> dict[str, Any]:
    body = DraftBody.model_validate(draft.body_json)
    wanted = set((row.target_json or {}).get("card_ids") or [])
    cards = [{"id": card.id, "layout": card.layout, "blocks": card.model_dump(mode="json")["blocks"], "locked": card.locked} for card in body.cards if card.id in wanted]
    return {
        "id": row.id, "draft_id": draft.id, "presentation_id": draft.presentation_id,
        "target": dict(row.target_json or {}), "kind": row.kind, "message": row.message,
        "based_on_draft_revision": row.based_on_draft_revision, "status": row.status,
        "created_by": row.created_by, "created_at": row.created_at.isoformat() if row.created_at else "",
        "resolved_target": {"cards": cards, "missing_card_ids": sorted(wanted - {card["id"] for card in cards})},
    }


def _access(
    session: Session,
    principal: Principal,
    draft_id: str,
    require: Role = Role.VIEWER,
    *,
    include_deleted: bool = False,
) -> Draft:
    row = session.get(Draft, draft_id)
    if row is None or (row.deleted_at is not None and not include_deleted):
        raise HTTPException(status_code=404, detail="Draft not found.")
    resolve_project_access(session, user_id=principal.user_id, project_id=row.project_id, require=require)
    return row


def _is_agent(principal: Principal) -> bool:
    return principal.scopes != local_mode.FULL_SCOPES


def _check_revision(row: Draft, revision: int) -> None:
    if row.revision != revision:
        raise HTTPException(status_code=409, detail={
            "message": "This draft changed. Read it again before editing.",
            "revision": row.revision,
        })


def _locked_changes(before: DraftBody, after: DraftBody) -> list[str]:
    later = {card.id: card for card in after.cards}
    changed: list[str] = []
    for card in before.cards:
        if card.locked and later.get(card.id) != card:
            changed.append(card.id)
    return changed


def _write(row: Draft, body: DraftBody, principal: Principal, *, title: str | None = None) -> None:
    before = DraftBody.model_validate(row.body_json)
    locked = _locked_changes(before, body) if _is_agent(principal) else []
    if locked:
        raise HTTPException(status_code=409, detail="Locked cards cannot be changed by an agent: " + ", ".join(locked))
    row.body_json = body.model_dump(mode="json", exclude_none=True)
    if title is not None:
        row.title = title.strip()
    row.revision += 1
    row.updated_at = datetime.now(timezone.utc)


def _apply_operations(body: DraftBody, operations: list[DraftOperation]) -> DraftBody:
    cards = [card.model_copy(deep=True) for card in body.cards]
    for operation in operations:
        index = next((i for i, card in enumerate(cards) if card.id == operation.card_id), -1)
        if operation.op == "add":
            if operation.card is None:
                raise HTTPException(status_code=422, detail="An add operation needs a card.")
            if any(card.id == operation.card.id for card in cards):
                raise HTTPException(status_code=422, detail="That card id is already in the draft.")
            cards.insert(min(operation.index if operation.index is not None else len(cards), len(cards)), operation.card)
        elif index < 0:
            raise HTTPException(status_code=404, detail=f"No draft card named {operation.card_id}.")
        elif operation.op == "remove":
            cards.pop(index)
        elif operation.op == "move":
            card = cards.pop(index)
            cards.insert(min(operation.index if operation.index is not None else len(cards), len(cards)), card)
        elif operation.op == "set_blocks":
            cards[index] = cards[index].model_copy(update={"blocks": operation.blocks or []})
        elif operation.op == "set_layout":
            if operation.layout is None:
                raise HTTPException(status_code=422, detail="A layout change needs a layout.")
            cards[index] = _convert_layout(cards[index], operation.layout)
        elif operation.op == "add_alternative":
            alternatives = [*cards[index].alternatives, operation.alternative or []]
            cards[index] = cards[index].model_copy(update={"alternatives": alternatives})
        elif operation.op == "choose_alternative":
            choice = operation.alternative_index
            if choice is None or choice >= len(cards[index].alternatives):
                raise HTTPException(status_code=422, detail="That alternative does not exist.")
            current = cards[index]
            alternatives = [*current.alternatives]
            selected = alternatives.pop(choice)
            alternatives.append(current.blocks)
            cards[index] = current.model_copy(update={"blocks": selected, "alternatives": alternatives})
        elif operation.op == "set_locked":
            if operation.locked is None:
                raise HTTPException(status_code=422, detail="A lock operation needs locked=true or false.")
            cards[index] = cards[index].model_copy(update={"locked": operation.locked})
    return DraftBody.model_validate({**body.model_dump(mode="json"), "cards": [card.model_dump(mode="json") for card in cards]})


def _words(blocks: list[DraftBlock], roles: set[str]) -> list[str]:
    return [(block.text or "").strip() for block in blocks if block.role in roles and (block.text or "").strip()]


def _convert_layout(card: DraftCard, layout: str) -> DraftCard:
    """Change layout and content semantics together, keeping an escape hatch.

    A layout selector used to change only the label, leaving a Quote or Image
    card with Statement's headline/body fields. Standard layouts get the block
    vocabulary their composer consumes. The previous blocks become an
    alternative, so conversion is reversible without pretending incompatible
    structures can be losslessly inferred.
    """
    layouts = {item.value for item in SlideLayout}
    patterns = set((presets.catalog().get("patternDefinitions") or {}).keys())
    if layout not in layouts | patterns:
        raise HTTPException(status_code=422, detail=f"Unknown slide layout or pattern: {layout}")
    if layout == card.layout:
        return card
    if layout not in layouts:
        return card.model_copy(update={"layout": layout})

    headline = (_words(card.blocks, {"headline"}) or ["A clear slide claim"])[0]
    subtitle = (_words(card.blocks, {"subtitle"}) or [""])[0]
    prose = _words(card.blocks, {"body", "quote", "bullet"})
    body = "\n".join(prose) or "Supporting detail"
    existing = {role: [block for block in card.blocks if block.role == role] for role in {
        "bullet", "metric", "quote", "chart", "diagram", "timeline", "image",
    }}
    blocks: list[DraftBlock] = [DraftBlock(role="headline", text=headline)]
    if layout == "title":
        blocks.append(DraftBlock(role="subtitle", text=subtitle or body))
    elif layout in {"statement", "code"}:
        blocks.append(DraftBlock(role="body", text=body))
    elif layout == "bullets":
        bullets = existing["bullet"] or [DraftBlock(role="bullet", text=line) for line in prose[:4]]
        blocks.extend(bullets or [DraftBlock(role="bullet", text="Supporting point")])
    elif layout == "metrics":
        metrics = existing["metric"]
        if not metrics:
            label = prose[0] if prose else "Add metric"
            metrics = [DraftBlock(role="metric", data={"value": "—", "label": label[:120]})]
        blocks.extend(metrics)
    elif layout == "quote":
        quote = existing["quote"][0] if existing["quote"] else DraftBlock(role="quote", text=body)
        blocks.append(quote)
        if subtitle:
            blocks.append(DraftBlock(role="subtitle", text=subtitle))
    elif layout == "split":
        blocks.append(DraftBlock(role="body", text=body))
        image = existing["image"][0] if existing["image"] else DraftBlock(role="image", image=DraftImage(subject="Describe the supporting picture"))
        blocks.append(image)
    elif layout == "image":
        image = existing["image"][0] if existing["image"] else DraftBlock(role="image", image=DraftImage(subject=body[:400]))
        blocks.append(image)
        if subtitle:
            blocks.append(DraftBlock(role="subtitle", text=subtitle))
    elif layout == "chart":
        chart = existing["chart"][0] if existing["chart"] else DraftBlock(role="chart", data={
            "type": "column", "categories": ["Category 1", "Category 2"],
            "series": [{"name": "Value", "values": [0, 0]}],
        })
        blocks.append(chart)
    elif layout == "diagram":
        diagram = existing["diagram"][0] if existing["diagram"] else DraftBlock(role="diagram", data={
            "kind": "flow", "direction": "LR", "view": "flat",
            "nodes": [{"key": "start", "label": "Start"}, {"key": "finish", "label": "Finish"}],
            "edges": [{"source": "start", "target": "finish", "label": "Next"}],
        })
        blocks.append(diagram)
    elif layout == "timeline":
        timeline = existing["timeline"][0] if existing["timeline"] else DraftBlock(role="timeline", data=[
            {"when": "Stage 1", "label": "Start", "detail": prose[0][:120] if prose else "First step"},
            {"when": "Stage 2", "label": "Finish", "detail": prose[1][:120] if len(prose) > 1 else "Next step"},
        ])
        blocks.append(timeline)

    alternatives = [*card.alternatives]
    if blocks != card.blocks:
        alternatives = [*alternatives, card.blocks][-5:]
    return card.model_copy(update={"layout": layout, "blocks": blocks, "alternatives": alternatives})


def _text(blocks: list[DraftBlock], role: str) -> str:
    return next(((block.text or "").strip() for block in blocks if block.role == role and (block.text or "").strip()), "")


def _story_slide(card: DraftCard) -> SlidePlan:
    blocks = card.blocks
    layout_values = {item.value for item in SlideLayout}
    pattern_id = None if card.layout in layout_values else card.layout
    roles = {block.role for block in blocks}
    if card.layout in layout_values:
        layout = card.layout
    elif "chart" in roles:
        layout = "chart"
    elif "diagram" in roles:
        layout = "diagram"
    elif "timeline" in roles:
        layout = "timeline"
    elif "image" in roles:
        layout = "image"
    elif "quote" in roles:
        layout = "quote"
    elif "metric" in roles:
        layout = "metrics"
    elif "bullet" in roles:
        layout = "bullets"
    else:
        layout = "statement"
    headline = _text(blocks, "headline") or _text(blocks, "body") or "Untitled slide"
    chart_block = next((block for block in blocks if block.role == "chart"), None)
    diagram_block = next((block for block in blocks if block.role == "diagram"), None)
    timeline_block = next((block for block in blocks if block.role == "timeline"), None)
    image_block = next((block for block in blocks if block.role == "image"), None)
    metrics: list[dict[str, str]] = []
    for block in (item for item in blocks if item.role == "metric"):
        if isinstance(block.data, dict):
            metrics.append({"value": str(block.data.get("value") or ""), "label": str(block.data.get("label") or block.text or "")})
        elif block.text:
            value, _, label = block.text.partition(" ")
            metrics.append({"value": value, "label": label})
    payload: dict[str, Any] = {
        "layout": layout, "pattern_id": pattern_id, "purpose": card.notes or "Advance the story",
        "key_message": headline, "headline": headline, "subtitle": _text(blocks, "subtitle"),
        "body": _text(blocks, "body"),
        "bullets": [(block.text or "").strip() for block in blocks if block.role == "bullet" and (block.text or "").strip()],
        "metrics": metrics, "quote": _text(blocks, "quote"), "speaker_notes": card.notes or "",
        "chart": ChartPlan.model_validate(chart_block.data).model_dump(mode="json") if chart_block else None,
        "diagram": DiagramPlan.model_validate(diagram_block.data).model_dump(mode="json") if diagram_block else None,
        "timeline": [TimelineEntryPlan.model_validate(item).model_dump(mode="json") for item in (timeline_block.data or [])] if timeline_block else [],
        "picture": (image_block.image.subject if image_block and image_block.image else (image_block.text or "" if image_block else "")),
    }
    return SlidePlan.model_validate(payload)


def _story(row: Draft, body: DraftBody, card_ids: list[str] | None = None) -> StoryPlan:
    wanted = set(card_ids or [])
    cards = [card for card in body.cards if not wanted or card.id in wanted]
    if wanted - {card.id for card in cards}:
        raise HTTPException(status_code=422, detail="One or more selected cards are not in this draft.")
    if not cards:
        raise HTTPException(status_code=422, detail="Add at least one card before building.")
    return StoryPlan(title=row.title, audience="", objective=body.brief or "", narrative_arc=body.brief or "Draft board order", slides=[_story_slide(card) for card in cards])


def _style(row: Draft, body: DraftBody, session: Session) -> StyleOptionInput | None:
    if isinstance(body.style, StyleOptionInput):
        return body.style
    if not isinstance(body.style, str):
        return None
    if not row.presentation_id:
        raise HTTPException(status_code=422, detail="A saved style option belongs to a deck; use an inline option for an unlinked draft.")
    for option_set in session.query(StyleOptionSet).filter(StyleOptionSet.presentation_id == row.presentation_id).all():
        for option in option_set.options_json or []:
            if option.get("id") == body.style:
                return StyleOptionInput.model_validate({key: value for key, value in option.items() if key not in {"id", "notes", "preview_document", "operations"}})
    raise HTTPException(status_code=422, detail="The selected style option no longer exists.")


def _compose(row: Draft, body: DraftBody, session: Session, card_ids: list[str] | None = None, base: dict[str, Any] | None = None) -> tuple[dict[str, Any], list[str]]:
    option = _style(row, body, session)
    language = option.design_language if option and option.design_language else "neutral"
    defaults = ((presets.catalog().get("designLanguages") or {}).get(language) or {}).get("defaults") or {}
    theme_key = option.theme_key if option else None
    theme, theme_id = presets.resolve_theme(theme_key or str(defaults.get("themeKey") or "neo-technical"))
    if base is not None and option is None:
        theme, theme_id = copy.deepcopy(base.get("theme") or theme), base.get("themeId")
        language_data = (base.get("metadata") or {}).get("designLanguage") or {}
        language = str(language_data.get("id") or "neutral")
        defaults = ((presets.catalog().get("designLanguages") or {}).get(language) or {}).get("defaults") or {}
    plan, warnings = languages.apply_density(_story(row, body, card_ids), language)
    # Exactly the same composition input as POST /v1/decks/compose. The draft is
    # a way to author a StoryPlan, not a second rendering engine.
    document = compose_document(plan, instruction="Composed from an external StoryPlan", theme_definition=theme, theme_id=theme_id, language=language, language_version=presets.language_version(language))
    template_compose.plan_transitions(document, plan, language, str(defaults.get("transitionStyle") or "fade"))
    if option:
        operations, notes, _resolved = style_operations(document, option)
        if operations:
            document, _inverse = apply_patch(document, operations)
        warnings.extend(notes)
    errors = validate_document(document)
    if errors:
        raise HTTPException(status_code=500, detail={"message": "Draft composition failed validation.", "errors": errors[:3]})
    return document, [*warnings, *variety.report(document)["warnings"]]


def _density_warnings(body: DraftBody) -> dict[str, list[str]]:
    warnings: dict[str, list[str]] = {}
    language = body.style.design_language if isinstance(body.style, StyleOptionInput) and body.style.design_language else "neutral"
    for card in body.cards:
        try:
            plan = StoryPlan(title="Draft", audience="", objective="", narrative_arc="", slides=[_story_slide(card)])
            _plan, notices = languages.apply_density(plan, language)
            if notices:
                warnings[card.id] = notices
        except ValueError as error:
            warnings[card.id] = [str(error)]
    return warnings


def _build_issues(body: DraftBody, card_ids: list[str] | None = None) -> list[dict[str, str]]:
    """Return concise, card-addressable problems before composition starts."""
    wanted = set(card_ids or [])
    cards = [card for card in body.cards if not wanted or card.id in wanted]
    issues: list[dict[str, str]] = []
    required = {
        "quote": ("quote", "Add quote text before building."),
        "image": ("image", "Describe or choose the image before building."),
        "chart": ("chart", "Add chart data before building."),
        "diagram": ("diagram", "Add diagram nodes before building."),
        "timeline": ("timeline", "Add at least two timeline stages before building."),
        "metrics": ("metric", "Add at least one metric before building."),
        "bullets": ("bullet", "Add at least one supporting point before building."),
    }
    for card in cards:
        need = required.get(card.layout)
        if need and not any(block.role == need[0] for block in card.blocks):
            issues.append({"card_id": card.id, "layout": card.layout, "message": need[1]})
            continue
        try:
            _story_slide(card)
        except ValueError:
            issues.append({"card_id": card.id, "layout": card.layout, "message": "This card's content does not match its layout. Change the layout or complete its required fields."})
    return issues


def _pending_build(session: Session, row: Draft) -> TransactionRow | None:
    if not row.presentation_id:
        return None
    for transaction in (
        session.query(TransactionRow)
        .filter(
            TransactionRow.presentation_id == row.presentation_id,
            TransactionRow.status == "pending",
            TransactionRow.agent_id == "draft-board",
        )
        .order_by(TransactionRow.created_at.desc())
        .all()
    ):
        if f"draft:{row.id}" in [str(item) for item in transaction.source_ids_json or []]:
            return transaction
    return None


def _fingerprint(card: DraftCard) -> str:
    """What a card says, without its identity, lock or alternatives."""
    content = card.model_dump(mode="json", include={"layout", "blocks", "notes", "motion"})
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


_SEEDED_ROLES = {"headline", "subtitle", "body", "bullet", "metric", "quote"}


def _block_words(block: dict[str, Any]) -> str:
    return "".join(str(span.get("text") or "") for span in block.get("spans") or [] if isinstance(span, dict)).strip()


def _seed_blocks(elements: list[dict[str, Any]]) -> list[DraftBlock]:
    """A slide's words as draft blocks, in reading order, groups included.

    Slide text is rich text: blocks of spans, never a plain string. Reading
    only `content.text` seeded every card of a real deck empty, so "Draft
    changes" showed a board of blank wireframes (2026-10-15). Grouped elements
    count too, because cards and metric rows are groups.
    """
    found: list[DraftBlock] = []
    for element in elements:
        children = element.get("children")
        if isinstance(children, list):
            found.extend(_seed_blocks([child for child in children if isinstance(child, dict)]))
        role = str(element.get("semanticRole") or "body")
        if element.get("type") != "text" or role not in _SEEDED_ROLES:
            continue
        content = element.get("content")
        if isinstance(content, str):
            blocks = [{"type": "paragraph", "spans": [{"text": content}]}]
        elif isinstance(content, dict):
            blocks = [block for block in content.get("blocks") or [] if isinstance(block, dict)]
        else:
            blocks = []
        paragraphs: list[str] = []
        for block in blocks:
            words = _block_words(block)
            if not words:
                continue
            if block.get("type") in ("bullet", "numbered"):
                found.append(DraftBlock(role="bullet", text=words[:4_000]))
            else:
                paragraphs.append(words)
        if paragraphs:
            found.append(DraftBlock(role=role, text="\n".join(paragraphs)[:4_000]))
    return found[:30]


def _walk_elements(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten groups without throwing away the group itself."""
    found: list[dict[str, Any]] = []
    for element in elements:
        found.append(element)
        children = element.get("children")
        if isinstance(children, list):
            found.extend(_walk_elements([child for child in children if isinstance(child, dict)]))
    return found


def _chart_data(element: dict[str, Any]) -> dict[str, Any] | None:
    """Translate a document chart back into the geometry-free ChartPlan."""
    data = element.get("data") or {}
    rows = data.get("rows") if data.get("type") == "inline" else None
    encoding = element.get("encoding") or {}
    if not isinstance(rows, list) or not rows:
        return None
    chart_type = str(element.get("chartType") or "column")
    style = element.get("chartStyle") or {}
    number_format = style.get("numberFormat") or {}
    unit = str(number_format.get("suffix") or "").strip()
    if chart_type in {"scatter", "bubble", "bubbleMap"}:
        category = str(encoding.get("category") or "label")
        value = str(encoding.get("value") or "y")
        x = str(encoding.get("x") or "x")
        size = str(encoding.get("size") or "size")
        latitude = str(encoding.get("latitude") or "latitude")
        longitude = str(encoding.get("longitude") or "longitude")
        series = str(encoding.get("series") or "")
        points: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            point: dict[str, Any] = {"label": str(row.get(category) or "")}
            if chart_type == "bubbleMap":
                point.update({"latitude": row.get(latitude), "longitude": row.get(longitude), "size": row.get(size)})
            else:
                point.update({"x": row.get(x), "y": row.get(value)})
                if chart_type == "bubble":
                    point["size"] = row.get(size)
            if series:
                point["group"] = str(row.get(series) or "")
            points.append(point)
        axis_x = style.get("axisX") or {}
        axis_y = style.get("axisY") or {}
        candidate = {"type": chart_type, "points": points, "x_title": axis_x.get("title") or "", "y_title": axis_y.get("title") or "", "unit": unit}
    else:
        category = str(encoding.get("category") or "category")
        values = encoding.get("value")
        names = [str(item) for item in values] if isinstance(values, list) else [str(values or "value")]
        candidate = {
            "type": chart_type,
            "categories": [str(row.get(category) or "") for row in rows if isinstance(row, dict)],
            "series": [{"name": name, "values": [row.get(name) for row in rows if isinstance(row, dict)]} for name in names],
            "unit": unit,
        }
    try:
        return ChartPlan.model_validate(candidate).model_dump(mode="json")
    except ValueError:
        return None


def _diagram_data(element: dict[str, Any]) -> dict[str, Any] | None:
    """Translate document node ids into stable, compact DraftPlan keys."""
    source_nodes = [node for node in element.get("nodes") or [] if isinstance(node, dict)]
    if len(source_nodes) < 2:
        return None
    keys = {str(node.get("id") or ""): f"n{index + 1}" for index, node in enumerate(source_nodes)}
    nodes = [{
        "key": keys[str(node.get("id") or "")],
        "label": str(node.get("label") or "Node")[:60],
        "sublabel": str(node.get("sublabel") or "")[:80],
        "role": str(node.get("role") or "")[:20],
    } for node in source_nodes]
    edges = []
    for edge in element.get("edges") or []:
        if not isinstance(edge, dict) or str(edge.get("from") or "") not in keys or str(edge.get("to") or "") not in keys:
            continue
        edges.append({
            "source": keys[str(edge["from"])], "target": keys[str(edge["to"])],
            "label": str(edge.get("label") or "")[:40],
        })
    hint = element.get("layoutHint") or {}
    algorithm = str(hint.get("algorithm") or "")
    view = "stack" if algorithm == "stack" else "orbit" if algorithm == "orbit" else "isometric" if hint.get("projection") == "isometric" else "flat"
    kind = str(element.get("diagramType") or "architecture")
    if kind not in {"architecture", "flow", "sequence", "network", "mindmap"}:
        kind = "architecture"
    candidate = {"kind": kind, "direction": hint.get("direction") if hint.get("direction") in {"LR", "TB"} else "LR", "view": view, "nodes": nodes, "edges": edges}
    try:
        return DiagramPlan.model_validate(candidate).model_dump(mode="json")
    except ValueError:
        return None


def _timeline_data(elements: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """Recover timelines emitted by the deterministic composer.

    A timeline is represented in the document as named markers plus text, not a
    dedicated element. Geometry is used only to associate authored words with a
    marker; no geometry is stored in the board.
    """
    flat = _walk_elements(elements)
    markers = [element for element in flat if str(element.get("name") or "").startswith("Milestone ")]
    if len(markers) < 2:
        return None
    markers.sort(key=lambda item: float((item.get("transform") or {}).get("x") or 0))
    texts = [element for element in flat if element.get("type") == "text" and element.get("semanticRole") in {"label", "body"}]
    entries: list[dict[str, Any]] = []
    centres = [float((item.get("transform") or {}).get("x") or 0) + float((item.get("transform") or {}).get("width") or 0) / 2 for item in markers]
    marker_y = float((markers[0].get("transform") or {}).get("y") or 0)
    for index, centre in enumerate(centres):
        left = (centres[index - 1] + centre) / 2 if index else float("-inf")
        right = (centre + centres[index + 1]) / 2 if index + 1 < len(centres) else float("inf")
        values: list[tuple[float, str, str]] = []
        for element in texts:
            transform = element.get("transform") or {}
            text_centre = float(transform.get("x") or 0) + float(transform.get("width") or 0) / 2
            if not (left <= text_centre < right):
                continue
            content = element.get("content") or {}
            words = "\n".join(_block_words(block) for block in content.get("blocks") or [] if isinstance(block, dict)).strip() if isinstance(content, dict) else str(content).strip()
            if words:
                values.append((float(transform.get("y") or 0), str(element.get("semanticRole") or "body"), words))
        above = [value for value in values if value[0] < marker_y]
        below = [value for value in values if value[0] >= marker_y]
        above.sort(); below.sort()
        when = above[0][2] if above else f"Stage {index + 1}"
        label = below[0][2] if below else f"Stage {index + 1}"
        detail = below[1][2] if len(below) > 1 else ""
        entries.append({"when": when[:24], "label": label[:60], "detail": detail[:120]})
    try:
        return [TimelineEntryPlan.model_validate(item).model_dump(mode="json") for item in entries]
    except ValueError:
        return None


def _structured_blocks(slide: dict[str, Any]) -> list[DraftBlock]:
    elements = [item for item in slide.get("elements") or [] if isinstance(item, dict)]
    flat = _walk_elements(elements)
    blocks: list[DraftBlock] = []
    for element in flat:
        if element.get("type") == "chart" and (data := _chart_data(element)) is not None:
            blocks.append(DraftBlock(role="chart", data=data))
        elif element.get("type") == "diagram" and (data := _diagram_data(element)) is not None:
            blocks.append(DraftBlock(role="diagram", data=data))
        elif element.get("type") == "image" and element.get("assetId"):
            blocks.append(DraftBlock(role="image", image=DraftImage(subject=str(element.get("altText") or element.get("name") or "Existing deck image")[:400], asset_id=str(element["assetId"]))))
    if (timeline := _timeline_data(elements)) is not None:
        blocks.append(DraftBlock(role="timeline", data=timeline))
    background = slide.get("background") or {}
    if background.get("assetId") and not any(block.role == "image" for block in blocks):
        blocks.append(DraftBlock(role="image", image=DraftImage(subject="Existing deck background", asset_id=str(background["assetId"]))))
    return blocks


def _notes_text(notes: Any) -> str | None:
    """Speaker notes are a string, or rich text when they carry formatting."""
    if isinstance(notes, dict):
        notes = "\n".join(_block_words(block) for block in notes.get("blocks") or [] if isinstance(block, dict))
    text = str(notes or "").strip()
    return text[:4_000] or None


def _seed_body(document: dict[str, Any]) -> DraftBody:
    cards: list[DraftCard] = []
    patterns = set((presets.catalog().get("patternDefinitions") or {}).keys())
    for slide in document.get("slides") or []:
        elements = [element for element in slide.get("elements") or [] if isinstance(element, dict)]
        structured = _structured_blocks(slide)
        blocks = _seed_blocks(elements)
        roles = {block.role for block in structured}
        # Timeline labels/details and image captions are already represented by
        # their typed block. Keeping their rendered text as generic body blocks
        # is what produced the nine-field timeline reported in the live deck.
        if "timeline" in roles or "image" in roles:
            blocks = [block for block in blocks if block.role in {"headline", "subtitle", "quote"}]
        blocks.extend(structured)
        layout = str((slide.get("layout") or {}).get("styleLabel") or (slide.get("layout") or {}).get("templateId") or "statement")
        for role in ("chart", "diagram", "timeline", "image"):
            if role in roles:
                layout = role
                break
        if layout not in patterns and layout not in {item.value for item in SlideLayout}:
            layout = "statement"
        card = DraftCard(id=new_id("crd"), layout=layout, blocks=blocks, notes=_notes_text(slide.get("speakerNotes")), source_slide_id=str(slide.get("id") or "") or None)
        cards.append(card.model_copy(update={"source_fingerprint": _fingerprint(card)}))
    metadata = document.get("metadata") or {}
    return DraftBody(brief=str(metadata.get("description") or "") or None, cards=cards)


def _deck_moved(body: DraftBody, deck: dict[str, Any]) -> dict[str, str]:
    """Cards whose slide changed in the deck after the board took it: card id -> slide id.

    The current slide is seeded again and its fingerprint compared with the
    one the card recorded when it was taken: seeding is deterministic, so they
    agree exactly when the slide still says what it said then (2026-10-17,
    release E2E step 7).
    """
    fresh = {card.source_slide_id: card for card in _seed_body(deck).cards if card.source_slide_id}
    moved: dict[str, str] = {}
    for card in body.cards:
        source = card.source_slide_id
        if source and card.source_fingerprint and source in fresh and _fingerprint(fresh[source]) != card.source_fingerprint:
            moved[card.id] = source
    return moved


def _deck_conflicts(body: DraftBody, deck: dict[str, Any]) -> list[str]:
    """Cards edited on the board whose slide was also edited in the deck.

    Building one would recompose the slide from the board and lose the deck
    edit. An untouched card is never a conflict: its slide is kept as the deck
    has it now, edits included.
    """
    moved = _deck_moved(body, deck)
    return [card.id for card in body.cards if card.id in moved and card.source_fingerprint != _fingerprint(card)]


def _upgrade_seeded_structure(row: Draft, document: dict[str, Any]) -> bool:
    """Repair untouched legacy cards without overwriting authored draft work.

    Boards created before structured seeding contain only the words rendered by
    charts, diagrams, timelines and images. A card is safe to enrich only when
    it still matches the fingerprint recorded at seed time. New cards, edited
    cards and alternatives remain exactly as the person left them.
    """
    body = DraftBody.model_validate(row.body_json)
    fresh = _seed_body(document)
    by_slide = {card.source_slide_id: card for card in fresh.cards if card.source_slide_id}
    structured_roles = {"chart", "diagram", "timeline", "image"}
    changed = False
    cards: list[DraftCard] = []
    for card in body.cards:
        replacement = by_slide.get(card.source_slide_id)
        untouched = card.source_fingerprint is not None and card.source_fingerprint == _fingerprint(card)
        current_roles = {block.role for block in card.blocks}
        replacement_roles = {block.role for block in replacement.blocks} if replacement else set()
        if replacement and untouched and not (current_roles & structured_roles) and replacement_roles & structured_roles:
            enriched = replacement.model_copy(update={
                "id": card.id,
                "alternatives": card.alternatives,
                "locked": card.locked,
            })
            enriched = enriched.model_copy(update={"source_fingerprint": _fingerprint(enriched)})
            cards.append(enriched)
            changed = True
        else:
            cards.append(card)
    if not changed:
        return False
    row.body_json = body.model_copy(update={"cards": cards}).model_dump(mode="json", exclude_none=True)
    row.revision += 1
    row.updated_at = datetime.now(timezone.utc)
    return True


@router.post("/projects/{project_id}/drafts")
def create_draft(project_id: str, request: DraftCreate, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    resolve_project_access(session, user_id=principal.user_id, project_id=project_id, require=Role.EDITOR)
    body = request.body or DraftBody(cards=[])
    if request.presentation_id:
        access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=request.presentation_id, require=Role.EDITOR)
        if access.project.id != project_id:
            raise HTTPException(status_code=422, detail="The linked deck belongs to another project.")
    row = Draft(id=new_id("drf"), project_id=project_id, presentation_id=request.presentation_id, title=request.title.strip(), body_json=body.model_dump(mode="json", exclude_none=True), created_by=principal.user_id, revision=1)
    session.add(row)
    session.flush()
    return _view(row)


@router.post("/presentations/{presentation_id}/drafts")
def seed_draft(presentation_id: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR)
    loaded = store.load_presentation(session, presentation_id)
    # Opening Draft changes is idempotent. The old route created a fresh board on
    # every open, which left stale revision-1 boards competing with the real one.
    existing = (
        session.query(Draft)
        .filter(Draft.presentation_id == presentation_id, Draft.deleted_at.is_(None))
        .order_by(Draft.revision.desc(), Draft.updated_at.desc(), Draft.created_at.desc(), Draft.id.desc())
        .first()
    )
    if existing is not None:
        if _upgrade_seeded_structure(existing, loaded.document):
            session.flush()
        return _view(existing)
    row = Draft(id=new_id("drf"), project_id=access.project.id, presentation_id=presentation_id, title=f"Draft changes — {access.presentation.title}", body_json=_seed_body(loaded.document).model_dump(mode="json", exclude_none=True), created_by=principal.user_id, revision=1, built_version_id=loaded.version_id, built_revision=1)
    session.add(row)
    session.flush()
    return _view(row)


@router.get("/projects/{project_id}/drafts")
def list_drafts(project_id: str, deleted: bool = False, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    resolve_project_access(session, user_id=principal.user_id, project_id=project_id, require=Role.VIEWER)
    deleted_filter = Draft.deleted_at.is_not(None) if deleted else Draft.deleted_at.is_(None)
    order = Draft.deleted_at.desc() if deleted else Draft.updated_at.desc()
    return [_view(row) for row in session.query(Draft).filter(Draft.project_id == project_id, deleted_filter).order_by(order).all()]


@router.get("/drafts/{draft_id}")
def read_draft(draft_id: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    return _view_with_deck(session, _access(session, principal, draft_id))


@router.put("/drafts/{draft_id}")
def replace_draft(draft_id: str, request: DraftReplace, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    row = _access(session, principal, draft_id, Role.EDITOR)
    _check_revision(row, request.revision)
    _write(row, request.body, principal, title=request.title)
    session.flush()
    return _view_with_deck(session, row)


@router.post("/drafts/{draft_id}/sync")
def sync_draft_cards(draft_id: str, request: DraftBuild, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    """Take the deck's current version of chosen cards' slides back into the board.

    The way through a build refused for deck edits (`E_DRAFT_DECK_MOVED`): the
    card becomes what its slide says now, keeping its place, id and lock. The
    board edit to that card is replaced, which is the person's choice to make
    by naming the card. One revision, so it undoes like any board edit.
    """
    row = _access(session, principal, draft_id, Role.EDITOR)
    _check_revision(row, request.revision)
    if not row.presentation_id:
        raise HTTPException(status_code=422, detail="This board is not linked to a deck.")
    body = DraftBody.model_validate(row.body_json)
    wanted = set(request.card_ids or [card.id for card in body.cards if card.source_slide_id])
    deck = store.load_presentation(session, row.presentation_id).document
    fresh = {card.source_slide_id: card for card in _seed_body(deck).cards if card.source_slide_id}
    cards: list[DraftCard] = []
    synced = 0
    for card in body.cards:
        replacement = fresh.get(card.source_slide_id) if card.id in wanted else None
        if replacement is None:
            cards.append(card)
            continue
        cards.append(replacement.model_copy(update={"id": card.id, "locked": card.locked}))
        synced += 1
    if not synced:
        raise HTTPException(status_code=422, detail="None of those cards came from a slide still in the deck.")
    _write(row, body.model_copy(update={"cards": cards}), principal)
    session.flush()
    return _view_with_deck(session, row)


@router.patch("/drafts/{draft_id}")
def patch_draft(draft_id: str, request: DraftPatch, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    row = _access(session, principal, draft_id, Role.EDITOR)
    _check_revision(row, request.revision)
    body = _apply_operations(DraftBody.model_validate(row.body_json), request.operations)
    _write(row, body, principal)
    session.flush()
    return _view_with_deck(session, row)


@router.delete("/drafts/{draft_id}")
def delete_draft(draft_id: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    """Move a rough canvas to Trash without losing cards or request history."""
    row = _access(session, principal, draft_id, Role.EDITOR)
    now = datetime.now(timezone.utc)
    row.deleted_at = now
    for question in row.agent_requests:
        if question.status == "open":
            question.status = "closed"
            question.closed_at = now
    session.flush()
    return {"draft_id": row.id, "deleted_at": row.deleted_at.isoformat()}


@router.post("/drafts/{draft_id}/restore")
def restore_draft(draft_id: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    row = _access(session, principal, draft_id, Role.EDITOR, include_deleted=True)
    if row.deleted_at is None:
        raise HTTPException(status_code=409, detail="This draft is not in Trash.")
    row.deleted_at = None
    row.updated_at = datetime.now(timezone.utc)
    session.flush()
    return _view(row)


@router.post("/drafts/{draft_id}/requests")
def create_draft_request(draft_id: str, request: DraftRequestCreate, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    row = _access(session, principal, draft_id, Role.EDITOR)
    _check_revision(row, request.revision)
    known = {card.id for card in DraftBody.model_validate(row.body_json).cards}
    card_ids = list(dict.fromkeys(request.card_ids))
    if not set(card_ids) <= known:
        raise HTTPException(status_code=422, detail="One or more target cards are not in this draft.")
    question = AgentRequest(id=new_id("req"), presentation_id=None, draft_id=row.id, target_json={"card_ids": card_ids, "block_ids": list(dict.fromkeys(request.block_ids))}, kind=request.kind, message=request.message.strip(), based_on_version_id=None, based_on_draft_revision=row.revision, status="open", created_by=principal.user_id)
    session.add(question)
    session.flush()
    return _request_view(question, row)


@router.get("/drafts/{draft_id}/requests")
def list_draft_requests(draft_id: str, status: str | None = None, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    row = _access(session, principal, draft_id)
    if status is not None and status not in {"open", "answered", "closed"}:
        raise HTTPException(status_code=422, detail="Unknown request status.")
    query = session.query(AgentRequest).filter(AgentRequest.draft_id == draft_id)
    if status:
        query = query.filter(AgentRequest.status == status)
    return [_request_view(item, row) for item in query.order_by(AgentRequest.created_at.asc()).all()]


@router.post("/draft-requests/{request_id}/answer")
def answer_draft_request(request_id: str, request: DraftRequestAnswer, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    question = session.get(AgentRequest, request_id)
    if question is None or not question.draft_id:
        raise HTTPException(status_code=404, detail="Draft request not found.")
    row = _access(session, principal, question.draft_id, Role.EDITOR)
    if question.status != "open":
        raise HTTPException(status_code=409, detail="That draft request has already been decided.")
    if row.revision != request.revision or request.revision <= int(question.based_on_draft_revision or 0):
        raise HTTPException(status_code=409, detail="Update the draft before answering this request, then use its new revision.")
    question.status = "answered"
    question.answered_at = datetime.now(timezone.utc)
    session.flush()
    return _request_view(question, row)


@router.post("/draft-requests/{request_id}/close")
def close_draft_request(request_id: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    question = session.get(AgentRequest, request_id)
    if question is None or not question.draft_id:
        raise HTTPException(status_code=404, detail="Draft request not found.")
    row = _access(session, principal, question.draft_id, Role.EDITOR)
    question.status = "closed"
    question.closed_at = datetime.now(timezone.utc)
    session.flush()
    return _request_view(question, row)


# What a rebuilt slide keeps from the slide it replaces: decisions about the
# slide as a whole, which recomposing its words says nothing about.
_KEPT_SLIDE_FIELDS = ("transition", "narration", "colorMode", "background")


def _plural(count: int, one: str, many: str) -> str:
    return one if count == 1 else many


def _element_ids(items: list[dict[str, Any]]) -> set[str]:
    found: set[str] = set()
    for item in items:
        found.add(str(item.get("id") or ""))
        found |= _element_ids(item.get("children") or [])
    return found


def _prune_pairs(slides: list[dict[str, Any]]) -> int:
    """Drop morph pairs whose elements are gone, and say how many.

    A rebuilt slide's elements have new ids, so a pair into or out of it names
    elements that no longer exist. The server validates only the schema, so a
    dangling pair would reach the editor as an E104 instead of being refused.
    """
    dropped = 0
    previous: set[str] = set()
    for slide in slides:
        own = _element_ids(slide.get("elements") or [])
        transition = slide.get("transition")
        if isinstance(transition, dict) and transition.get("sharedElements"):
            kept = [pair for pair in transition["sharedElements"]
                    if pair.get("sourceElementId") in previous and pair.get("destinationElementId") in own]
            dropped += len(transition["sharedElements"]) - len(kept)
            if kept:
                transition["sharedElements"] = kept
            else:
                transition.pop("sharedElements")
        previous = own
    return dropped


def _linked_slides(row: Draft, body: DraftBody, session: Session, card_ids: list[str] | None, deck: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """The linked deck's slides after building, changing only what the draft changed.

    A card still saying what it said when it was seeded keeps its slide byte for
    byte. A changed card is recomposed under its slide's id, so links to the
    slide survive. A new card becomes a new slide. Only a build of every card
    removes the slides whose cards were deleted and follows the board's order; a
    build of selected cards never removes or reorders anything else (2026-10-15).
    """
    deck_slides = [copy.deepcopy(slide) for slide in deck.get("slides") or []]
    by_id = {slide["id"]: slide for slide in deck_slides}
    wanted = set(card_ids or [])
    if wanted - {card.id for card in body.cards}:
        raise HTTPException(status_code=422, detail="One or more selected cards are not in this draft.")
    chosen = [card for card in body.cards if not wanted or card.id in wanted]
    if not chosen:
        raise HTTPException(status_code=422, detail="Add at least one card before building.")

    # A card keeps its source only if it is the first card naming that slide: a
    # duplicated card is a new slide, not a second claim on the original.
    claimed: set[str] = set()
    source: dict[str, str] = {}
    for card in body.cards:
        if card.source_slide_id and card.source_slide_id in by_id and card.source_slide_id not in claimed:
            claimed.add(card.source_slide_id)
            source[card.id] = card.source_slide_id

    rebuild = [card for card in chosen if card.id not in source or card.source_fingerprint != _fingerprint(card)]
    composed: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    if rebuild:
        document, warnings = _compose(row, body, session, [card.id for card in rebuild], deck)
        for card, slide in zip(rebuild, document["slides"]):
            if card.id in source:
                original = by_id[source[card.id]]
                slide["id"] = original["id"]
                for key in _KEPT_SLIDE_FIELDS:
                    if key in original:
                        slide[key] = copy.deepcopy(original[key])
                    else:
                        slide.pop(key, None)
            composed[card.id] = slide

    def slide_for(card: DraftCard) -> dict[str, Any]:
        return composed.get(card.id) or by_id[source[card.id]]

    if not wanted:
        slides = [slide_for(card) for card in body.cards]
    else:
        slides = list(deck_slides)
        positions = {slide["id"]: index for index, slide in enumerate(slides)}
        for card in chosen:
            if card.id in source:
                slides[positions[source[card.id]]] = slide_for(card)
        # A new card goes after the nearest earlier card whose slide is in the deck.
        for index, card in enumerate(body.cards):
            if card.id not in wanted or card.id in source:
                continue
            anchor = next((source[earlier.id] for earlier in reversed(body.cards[:index]) if earlier.id in source), None)
            at = next((i + 1 for i, slide in enumerate(slides) if slide["id"] == anchor), 0)
            slides.insert(at, slide_for(card))
            source[card.id] = slide_for(card)["id"]

    dropped = _prune_pairs(slides)
    if dropped:
        warnings.append(f"{dropped} morph {_plural(dropped, 'pair named objects that were rebuilt, and was', 'pairs named objects that were rebuilt, and were')} removed.")
    removed = {slide["id"] for slide in deck_slides} - {slide["id"] for slide in slides}
    if removed:
        warnings.append(f"{len(removed)} {_plural(len(removed), 'slide whose card was', 'slides whose cards were')} deleted from the draft will be removed.")
    rebuilt = {composed[card.id]["id"] for card in rebuild if card.id in source}
    stale = sum(1 for locale in (deck.get("locales") or {}).values() for path in (locale.get("entries") or {})
                if any(f"/slides/id:{slide_id}/" in path for slide_id in rebuilt | removed))
    if stale:
        warnings.append(f"{stale} translated text {_plural(stale, 'slot belonged', 'slots belonged')} to rebuilt or removed slides and will need translating again.")
    return slides, warnings


@router.post("/drafts/{draft_id}/build")
def build_draft(draft_id: str, request: DraftBuild, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)) -> dict[str, Any]:
    row = _access(session, principal, draft_id, Role.EDITOR)
    _check_revision(row, request.revision)
    body = DraftBody.model_validate(row.body_json)
    if request.card_ids and set(request.card_ids) - {card.id for card in body.cards}:
        raise HTTPException(status_code=422, detail="One or more selected cards are not in this draft.")
    issues = _build_issues(body, request.card_ids)
    if issues:
        raise HTTPException(status_code=422, detail={"message": "Fix these cards before building.", "issues": issues})
    if row.presentation_id:
        if pending := _pending_build(session, row):
            raise HTTPException(status_code=409, detail={
                "message": "This draft already has a build waiting in Review. Approve or decline it before building again.",
                "code": "E_DRAFT_BUILD_PENDING", "proposal_id": pending.id,
            })
        loaded = store.load_presentation(session, row.presentation_id)
        conflicts = [card_id for card_id in _deck_conflicts(body, loaded.document) if not request.card_ids or card_id in request.card_ids]
        if conflicts:
            positions = {card.id: index + 1 for index, card in enumerate(body.cards)}
            raise HTTPException(status_code=409, detail={
                "message": "The deck changed on the slides behind "
                + ", ".join(f"card {positions[card_id]}" for card_id in conflicts[:5])
                + " after this board took them, and the board changed them too. Building would lose the deck edits. "
                "Take the deck's version into the board again, or leave those cards out of the build.",
                "code": "E_DRAFT_DECK_MOVED", "card_ids": conflicts,
            })
        slides, warnings = _linked_slides(row, body, session, request.card_ids, loaded.document)
        if slides == loaded.document.get("slides"):
            raise HTTPException(status_code=422, detail="Nothing on the board differs from the deck.")
        # One whole-array replace, as a version restore does: unchanged slides are
        # byte-identical in it, so Review marks only the slides that differ.
        provenance = [f"draft:{row.id}", f"draft-revision:{row.revision}", "draft-build:full" if not request.card_ids else "draft-build:partial"]
        provenance.extend(f"draft-card:{card_id}" for card_id in request.card_ids or [])
        result = proposals.create_proposal(session, presentation_id=row.presentation_id, operations=[{"op": "replace", "path": "/slides", "value": slides}], intent=f"Build draft: {row.title}", created_by=principal.user_id, agent_id="draft-board", source_ids=provenance, expected_version_id=loaded.version_id, review_reason="A draft build changes the linked deck's slides.")
        # A pending proposal is not a build. Approval records the resulting deck
        # version and revision atomically in proposals.approve.
        session.flush()
        return {"kind": "proposal", "presentation_id": row.presentation_id, "warnings": warnings, **result}
    document, warnings = _compose(row, body, session, request.card_ids)
    stored = store.create_presentation(session, project_id=row.project_id, document=document, created_by=principal.user_id, source="user")
    row.presentation_id = stored.presentation_id
    row.built_version_id = stored.version_id
    row.built_revision = row.revision
    session.flush()
    return {"kind": "deck", "presentation_id": stored.presentation_id, "version_id": stored.version_id, "document": stored.document, "warnings": warnings}
