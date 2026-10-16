"""Mutually exclusive style directions: preview many, apply exactly one."""

from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from . import motion, office_theme, presets, store
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.models import StyleOptionSet
from .db.session import get_session
from .ids import new_id
from .patch import PatchError, apply_patch
from .risk import assess_risk
from .schema import validate_document

router = APIRouter(prefix="/v1")
TTL = timedelta(hours=24)
DECK_OWNED_THEME_KEYS = ("objectStyles", "icons", "modes", "table")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


class StylePalette(BaseModel):
    background: str = Field(min_length=7, max_length=7)
    text: str = Field(min_length=7, max_length=7)
    accent: str = Field(min_length=7, max_length=7)
    secondary: str | None = Field(default=None, min_length=7, max_length=7)
    series: list[str] = Field(default_factory=list, max_length=5)


class StyleFonts(BaseModel):
    display: str | None = Field(default=None, min_length=1, max_length=80)
    body: str | None = Field(default=None, min_length=1, max_length=80)


class StyleOptionInput(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    design_language: str | None = Field(default=None, min_length=1, max_length=80)
    theme_key: str | None = Field(default=None, min_length=1, max_length=80)
    palette: StylePalette | None = None
    fonts: StyleFonts | None = None
    motion_style: str | None = Field(default=None, min_length=1, max_length=80)
    rationale: str = Field(min_length=1, max_length=1_000)

    @model_validator(mode="after")
    def one_theme_source(self) -> "StyleOptionInput":
        if self.theme_key and self.palette:
            raise ValueError("Choose a built-in theme or a palette, not both.")
        return self


class StyleSuggestRequest(BaseModel):
    expected_version_id: str = Field(min_length=1, max_length=64)
    options: list[StyleOptionInput] = Field(min_length=2, max_length=4)
    slide_id: str | None = Field(default=None, max_length=64)
    #: Which client suggested these, for the history row a choice writes.
    client_label: str = Field(default="external", max_length=60)


class StyleChooseRequest(BaseModel):
    option_id: str = Field(min_length=1, max_length=64)
    expected_version_id: str = Field(min_length=1, max_length=64)


def _theme_for(document: dict[str, Any], option: StyleOptionInput) -> tuple[dict[str, Any] | None, list[str]]:
    notes: list[str] = []
    theme: dict[str, Any] | None = None
    if option.theme_key:
        try:
            theme, _theme_id = presets.resolve_theme(option.theme_key)
        except presets.PresetError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    elif option.palette:
        try:
            theme, notes = office_theme.theme_from_palette(
                option.label,
                background=option.palette.background,
                foreground=option.palette.text,
                accent=option.palette.accent,
                secondary=option.palette.secondary,
                series=option.palette.series,
                display_font=option.fonts.display if option.fonts else None,
                body_font=option.fonts.body if option.fonts else None,
            )
        except office_theme.OfficeThemeError as error:
            raise HTTPException(status_code=422, detail=f'{option.label}: {error}') from error
    elif option.fonts:
        theme = copy.deepcopy(document.get("theme") or {})

    if option.fonts:
        for face in (option.fonts.display, option.fonts.body):
            if face and face not in office_theme.BUNDLED_FONTS:
                raise HTTPException(status_code=422, detail=f'{option.label}: {face!r} is not a bundled font.')
        if theme is None:
            theme = copy.deepcopy(document.get("theme") or {})
        typography = theme.setdefault("typography", {})
        for token in ("display", "h1", "h2", "h3", "quote", "metric"):
            if option.fonts.display and token in typography:
                typography[token]["fontFamily"] = option.fonts.display
        for token in ("body", "bodySmall", "caption"):
            if option.fonts.body and token in typography:
                typography[token]["fontFamily"] = option.fonts.body

    if theme is not None:
        current = document.get("theme") or {}
        custom = (current.get("colors") or {}).get("custom")
        if custom:
            theme.setdefault("colors", {})["custom"] = copy.deepcopy(custom)
        for key in DECK_OWNED_THEME_KEYS:
            if key in current:
                theme[key] = copy.deepcopy(current[key])
    return theme, notes


def _operations(document: dict[str, Any], option: StyleOptionInput) -> tuple[list[dict[str, Any]], list[str], StyleOptionInput]:
    operations: list[dict[str, Any]] = []
    language: dict[str, Any] | None = None
    if option.design_language:
        language = (presets.catalog().get("designLanguages") or {}).get(option.design_language)
        if not language:
            raise HTTPException(status_code=422, detail=f'{option.label}: no design language named {option.design_language!r}.')
        defaults = language.get("defaults") or {}
        option = option.model_copy(update={
            "theme_key": option.theme_key or (None if option.palette else defaults.get("themeKey")),
            "motion_style": option.motion_style or defaults.get("motionStyle"),
        })

    theme, notes = _theme_for(document, option)
    if theme is not None and theme != document.get("theme"):
        operations.append({"op": "replace", "path": "/theme", "value": theme})
        if "themeId" in document:
            operations.append({"op": "remove", "path": "/themeId"})

    if option.design_language:
        # The language supplies the theme and motion defaults above. Its layouts
        # are not applied: these slides keep the geometry they were composed
        # with, so the deck keeps recording the language that geometry is in.
        # Writing the new name would be untrue, and slides inserted later would
        # be drawn in a grammar the rest of the deck does not use (2026-10-15).
        current = ((document.get("metadata") or {}).get("designLanguage") or {}).get("id") or "neutral"
        if current != option.design_language:
            notes.append(f"Colours, type and motion from {option.design_language}; the slides keep their {current} layouts.")

    if option.motion_style:
        style = (presets.catalog().get("motionStyles") or {}).get(option.motion_style)
        if not style:
            raise HTTPException(status_code=422, detail=f'{option.label}: no motion style named {option.motion_style!r}.')
        for slide in document.get("slides") or []:
            candidate = copy.deepcopy(slide)
            notes.extend(motion.animate_slide(candidate, {
                "sequence": list(style.get("sequence") or []),
                "entrance": str(style.get("entrance") or "fade"),
                "pacing": str(style.get("pacing") or "measured"),
                "click_reveals": int(style.get("clickReveals") or 0),
            }))
            if candidate.get("animations") != slide.get("animations"):
                operations.append({
                    "op": "replace" if "animations" in slide else "add",
                    "path": f"/slides/id:{slide['id']}/animations",
                    "value": candidate.get("animations") or [],
                })
        metadata = document.get("metadata") or {}
        if metadata.get("motionStyle") != option.motion_style:
            operations.append({"op": "replace" if "motionStyle" in metadata else "add", "path": "/metadata/motionStyle", "value": option.motion_style})
    return operations, notes, option


def _public(row: StyleOptionSet, current_version_id: str) -> dict[str, Any]:
    return {
        "id": row.id,
        "presentation_id": row.presentation_id,
        "based_on_version_id": row.based_on_version_id,
        "slide_id": row.slide_id,
        "status": row.status,
        "stale": current_version_id != row.based_on_version_id,
        "chosen_option_id": row.chosen_option_id,
        "created_at": row.created_at.isoformat() if row.created_at else "",
        "expires_at": row.expires_at.isoformat(),
        "options": [
            {key: value for key, value in option.items() if key != "operations"}
            for option in (row.options_json or [])
        ],
    }


def _expire(session: Session, presentation_id: str) -> None:
    changed = False
    for row in session.query(StyleOptionSet).filter(
        StyleOptionSet.presentation_id == presentation_id, StyleOptionSet.status == "open"
    ).all():
        if _aware(row.expires_at) <= _now():
            row.status = "expired"
            changed = True
    if changed:
        session.flush()


@router.post("/presentations/{presentation_id}/style-options")
def suggest_styles(
    presentation_id: str,
    request: StyleSuggestRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR)
    loaded = store.load_presentation(session, presentation_id)
    if loaded.version_id != request.expected_version_id:
        raise HTTPException(status_code=409, detail={"message": "The deck changed. Read it again before suggesting styles.", "code": "E310", "current_version_id": loaded.version_id})
    slides = loaded.document.get("slides") or []
    slide_id = request.slide_id or str((slides or [{}])[0].get("id") or "")
    if not any(slide.get("id") == slide_id for slide in loaded.document.get("slides") or []):
        raise HTTPException(status_code=404, detail="No such slide in this deck.")
    labels = [option.label.casefold() for option in request.options]
    if len(set(labels)) != len(labels):
        raise HTTPException(status_code=422, detail="Style option labels must be distinct.")

    stored: list[dict[str, Any]] = []
    for option in request.options:
        operations, notes, resolved = _operations(loaded.document, option)
        if not operations:
            raise HTTPException(status_code=422, detail=f'{option.label}: this option would not change the deck.')
        try:
            candidate, _inverse = apply_patch(loaded.document, operations)
        except PatchError as error:
            raise HTTPException(status_code=422, detail=f'{option.label}: {error}') from error
        errors = validate_document(candidate)
        if errors:
            raise HTTPException(status_code=422, detail={"message": f'{option.label} would make an invalid deck.', "errors": errors[:3]})
        preview = copy.deepcopy(candidate)
        # A request may be made while a dense body slide is selected, but that
        # is a poor and inconsistent surface for comparing type and colour. A
        # style set therefore always uses this deck's front slide: the same
        # authored cover, words and geometry for every option, with only the
        # proposed deck-wide style applied. `slide_id` still records where the
        # request was made; it does not decide which slide becomes the swatch.
        # This is intentionally not a separately invented mock cover (2026-10-16).
        preview["slides"] = [copy.deepcopy(candidate["slides"][0])]
        stored.append({
            "id": new_id("opt"), "label": option.label, "rationale": option.rationale,
            "design_language": resolved.design_language, "theme_key": resolved.theme_key,
            "motion_style": resolved.motion_style, "notes": notes,
            "agent_id": f"mcp:{request.client_label}"[:120],
            "preview_document": preview, "operations": operations,
        })
    row = StyleOptionSet(
        id=new_id("sty"), presentation_id=presentation_id,
        based_on_version_id=loaded.version_id, slide_id=slide_id, options_json=stored,
        status="open", created_by=principal.user_id, expires_at=_now() + TTL,
    )
    session.add(row)
    session.flush()
    return _public(row, loaded.version_id)


@router.get("/presentations/{presentation_id}/style-options")
def list_style_options(
    presentation_id: str,
    status: str = "open",
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.VIEWER)
    if status not in {"open", "chosen", "expired"}:
        raise HTTPException(status_code=422, detail="Unknown style-option status.")
    _expire(session, presentation_id)
    loaded = store.load_presentation(session, presentation_id)
    rows = session.query(StyleOptionSet).filter(
        StyleOptionSet.presentation_id == presentation_id, StyleOptionSet.status == status
    ).order_by(StyleOptionSet.created_at.asc()).all()
    return [_public(row, loaded.version_id) for row in rows]


@router.post("/style-options/{set_id}/choose")
def choose_style(
    set_id: str,
    request: StyleChooseRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    row = session.get(StyleOptionSet, set_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such style option set.")
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=row.presentation_id, require=Role.EDITOR)
    if row.status != "open" or _aware(row.expires_at) <= _now():
        if row.status == "open":
            row.status = "expired"
            session.flush()
        raise HTTPException(status_code=409, detail="Those style options are no longer open.")
    loaded = store.load_presentation(session, row.presentation_id)
    if loaded.version_id != row.based_on_version_id or loaded.version_id != request.expected_version_id:
        raise HTTPException(status_code=409, detail={"message": "The deck changed since these options were drawn. Ask for fresh options.", "code": "E310", "current_version_id": loaded.version_id})
    option = next((item for item in row.options_json if item.get("id") == request.option_id), None)
    if option is None:
        raise HTTPException(status_code=404, detail="No such option in this set.")
    operations = list(option.get("operations") or [])
    try:
        document, inverse = apply_patch(loaded.document, operations)
    except PatchError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    errors = validate_document(document)
    if errors:
        raise HTTPException(status_code=422, detail={"message": "That style no longer makes a valid deck.", "errors": errors[:3]})
    risk = assess_risk(operations)
    result = store.commit_transaction(
        session, presentation_id=row.presentation_id, operations=operations,
        inverse_operations=inverse, document=document, parent_version_id=loaded.version_id,
        expected_version_id=loaded.version_id, intent=f"Use style: {option.get('label')}",
        # The person chose it; the agent wrote it. The history shows whose
        # suggestion it was, as an approved proposal does (2026-10-15).
        source="agent", agent_id=str(option.get("agent_id") or "mcp:external"),
        created_by=principal.user_id, client_id="style-options",
        reason=str(option.get("rationale") or ""), risk_tier=risk.tier,
        label=f"Use style: {option.get('label')}",
    )
    row.status = "chosen"
    row.chosen_option_id = request.option_id
    row.decided_at = _now()
    session.flush()
    return {
        "transaction_id": result.transaction_id,
        "version_id": result.version_id,
        "document": result.document,
        "option_id": request.option_id,
        "set_id": row.id,
    }
