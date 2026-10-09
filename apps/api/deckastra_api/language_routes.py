"""Languages and narration over HTTP (integration plan 01 §3.7, §3.8).

Two writes, and both are proposals. Translating a deck and voicing it are
services acting on someone's document, and neither gets a way into the store
that the product's own agents do not have: the operations go to
`proposals.create_proposal`, the risk tier is computed from them, and a large
change waits for the person whose deck it is.

What is *not* here, on purpose: a route to add an empty language. That is an
ordinary edit the editor makes through its own patch path — undoable like any
other — and an external agent adds one with the MCP `locale_add` tool, which
builds the editor's own `addLocaleOperations` and sends them through the
caller-authored proposals route. A third way to make the same change is a
third place for its rules to drift.
"""

from __future__ import annotations
import logging
import os
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import assets as asset_service
from . import credits, local_mode, locales, object_storage, proposals, quotas, speech, store, translation
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.models import Asset
from .db.session import get_session

logger = logging.getLogger("deckastra.languages")

router = APIRouter(prefix="/v1")


@router.get("/languages/status")
def languages_status(principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """What Translate and Voice will do on this install, before anyone presses them.

    Read by the Languages panel so it can say what leaves the machine, the way
    the Generate drawer does for generation (final package review, item 19).
    """
    del principal
    return {"translation": translation.translation_status(), "speech": speech.speech_status()}


def _refuse(error: proposals.ProposalError) -> HTTPException:
    return HTTPException(status_code=409, detail={"message": str(error), "code": error.code})


def _outcome(outcome: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    return {
        "outcome": outcome["status"],
        "transaction_id": outcome["transaction_id"],
        "version_id": outcome.get("version_id"),
        "document": outcome.get("document"),
        "preview": outcome.get("preview"),
        "risk_tier": outcome["risk_tier"],
        "reasons": outcome.get("reasons") or [],
        "expires_at": outcome.get("expires_at"),
        **extra,
    }


# ---------------------------------------------------------------- translate


class TranslateRequest(BaseModel):
    scope: Literal["missing", "outdated", "slides"] = "missing"
    slide_ids: list[str] = Field(default_factory=list, max_length=300)
    #: The version the person was looking at. Required: a translation of words
    #: that changed while it ran would be outdated the moment it landed.
    expected_version_id: str = Field(min_length=1, max_length=64)
    #: Words never to translate — brand and product names (plan 01 §3.7).
    glossary: list[str] = Field(default_factory=list, max_length=200)
    quote_token: str | None = Field(default=None, min_length=20, max_length=4096)


@router.post("/presentations/{presentation_id}/locales/{locale}/translate")
def translate_deck(
    presentation_id: str,
    locale: str,
    request: TranslateRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Translate a deck's words into `locale`, as a proposal of overlay entries."""
    resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR
    )
    if not locales.valid_locale(locale):
        raise HTTPException(status_code=422, detail=f"{locale!r} is not a language tag such as hi-IN or ar.")
    loaded = store.load_presentation(session, presentation_id)
    if loaded.version_id != request.expected_version_id:
        raise HTTPException(
            status_code=409,
            detail={"message": "This deck changed since you looked at it. Look again, then translate.", "code": "E310"},
        )
    if locales.same_language(locale, locales.source_locale(loaded.document)):
        raise HTTPException(status_code=422, detail=f"{locale} is this deck's own language; its words are the source text.")

    slots = translation.slots_to_translate(loaded.document, locale, request.scope, request.slide_ids)
    if not slots:
        return {"outcome": "none", "translated": [], "refused": [], "message": "Nothing to translate in that scope."}

    glossary = [term.strip() for term in request.glossary if term.strip()][:200]
    translator = translation.build_translator()
    characters = translation.characters_to_translate(loaded.document, slots, glossary)
    if translator.name == "google":
        if not request.quote_token:
            raise HTTPException(422, "Request and accept a translation credit quote before translating.")
        from .media_quotes import verify_service_quote
        payload = {"presentation_id": presentation_id, "expected_version_id": request.expected_version_id,
                   "locale": locale, "scope": request.scope, "slide_ids": request.slide_ids, "glossary": request.glossary}
        verify_service_quote(request.quote_token, kind="translation", user_id=principal.user_id,
                             presentation_id=presentation_id, payload=payload, units=characters)
    billing_token = None
    if translator.name == "google" and os.environ.get("DECKASTRA_CREDITS_ENABLED") == "1" and not local_mode.enabled():
        from deckastra_agents.budgets import cost_observer
        billing_token = cost_observer.set(credits.observer(principal.user_id, task="translation", model="google-translation"))
    try:
        plan = translation.plan_translation(loaded.document, locale, slots, translator, glossary=glossary)
    except translation.TranslationError as error:
        raise HTTPException(status_code=502, detail=f"Translation failed: {error}") from error
    finally:
        if billing_token is not None:
            from deckastra_agents.budgets import cost_observer
            cost_observer.reset(billing_token)

    entry_operations = [operation for operation in plan.operations if "/entries/" in operation["path"]]
    if not entry_operations:
        return {
            "outcome": "none",
            "translated": [],
            "refused": plan.refused,
            "message": "The translator returned nothing that could be used.",
        }

    try:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=plan.operations,
            intent=f"Translate {len(plan.translated)} item{'s' if len(plan.translated) != 1 else ''} into {locale}",
            created_by=principal.user_id,
            agent_id=f"translator:{translator.name}",
            reason=(
                f"{translator.name} translation of {len(plan.translated)} text slot(s)"
                + (f"; {len(plan.refused)} left untranslated" if plan.refused else "")
                + (f"; {plan.simplified} paragraph(s) lost mixed formatting" if plan.simplified else "")
            ),
            expected_version_id=request.expected_version_id,
        )
    except proposals.ProposalError as error:
        raise _refuse(error) from error

    return _outcome(
        outcome,
        {
            "provider": translator.name,
            "translated": plan.translated,
            "refused": plan.refused,
            "simplified": plan.simplified,
            "characters": plan.characters,
        },
    )


# --------------------------------------------------------------------- speech


@router.get("/speech/voices")
def list_voices(locale: str, principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    del principal
    if not locales.valid_locale(locale):
        raise HTTPException(status_code=422, detail=f"{locale!r} is not a language tag.")
    try:
        return {"locale": locale, "voices": speech.voices(locale)}
    except speech.SpeechError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


class PronunciationModel(BaseModel):
    term: str = Field(min_length=1, max_length=80)
    say: str = Field(min_length=1, max_length=120)


class SynthesizeRequest(BaseModel):
    locale: str = Field(min_length=2, max_length=35)
    #: Which cues; empty means every cue whose take in this language is missing or stale.
    cue_ids: list[str] = Field(default_factory=list, max_length=500)
    voice: str = Field(default="default", max_length=120)
    rate: float = Field(default=1.0, ge=0.5, le=2.0)
    expected_version_id: str = Field(min_length=1, max_length=64)
    #: Names the voice should say differently from how they are spelled.
    pronunciations: list[PronunciationModel] = Field(default_factory=list, max_length=100)
    quote_token: str | None = Field(default=None, min_length=20, max_length=4096)


def _cues(document: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for slide in document.get("slides") or []:
        for cue in ((slide.get("narration") or {}).get("cues") or []):
            out.append((slide["id"], cue))
    return out


def planned_speech(session: Session, workspace_id: str, document: dict[str, Any], request: SynthesizeRequest):
    """Exact synthesis jobs and uncached characters, shared with the quote route."""
    wanted = set(request.cue_ids)
    pronunciations = [speech.Pronunciation(item.term.strip(), item.say.strip()) for item in request.pronunciations if item.term.strip()]
    default_voice = speech.resolve_voice(
        request.locale,
        request.voice,
        str((document.get("metadata") or {}).get("voiceStyle") or ""),
    )
    jobs: list[tuple[str, dict[str, Any], str]] = []
    for slide_id, cue in _cues(document):
        script = locales.script_entry(document, slide_id, cue, request.locale).strip()
        if not script:
            continue
        take = ((cue.get("takes") or {}).get(request.locale)) or {}
        current = take.get("textHash") == locales.text_hash(script)
        cue_voice = cue.get("voice") or default_voice
        if current and take.get("voice") not in ("recorded", "file"):
            current = (take.get("sayAs", "") == speech.say_as_fingerprint(script, pronunciations, request.rate)
                       and take.get("voice") in (cue_voice, "stub"))
        if (wanted and cue["id"] in wanted) or (not wanted and not current):
            jobs.append((slide_id, cue, script))
    provider = speech.selected_speech_provider()
    extension = "wav" if provider == "stub" else "mp3"
    planned: list[tuple[str, dict[str, Any], str, str, str]] = []
    uncached = 0
    for slide_id, cue, script in jobs:
        cue_voice = cue.get("voice") or default_voice
        key = speech.cache_key(script, request.locale, cue_voice, request.rate, provider, pronunciations)
        storage_key = f"workspaces/{workspace_id}/assets/speech-{key[:40]}.{extension}"
        planned.append((slide_id, cue, script, storage_key, cue_voice))
        if _cached(session, workspace_id, storage_key) is None:
            uncached += len(script)
    return planned, uncached


@router.post("/presentations/{presentation_id}/narration/synthesize")
def synthesize_narration(
    presentation_id: str,
    request: SynthesizeRequest,
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Voice narration cues in one language, and propose the takes."""
    access = resolve_presentation_access(
        session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.EDITOR
    )
    locale = request.locale
    if not locales.valid_locale(locale):
        raise HTTPException(status_code=422, detail=f"{locale!r} is not a language tag.")
    loaded = store.load_presentation(session, presentation_id)
    if loaded.version_id != request.expected_version_id:
        raise HTTPException(
            status_code=409,
            detail={"message": "This deck changed since you looked at it. Look again, then synthesize.", "code": "E310"},
        )
    document = loaded.document

    pronunciations = [speech.Pronunciation(item.term.strip(), item.say.strip()) for item in request.pronunciations if item.term.strip()]
    planned, uncached_characters = planned_speech(session, access.workspace_id, document, request)
    if not planned:
        return {"outcome": "none", "voiced": [], "message": "Every cue already has a current recording in this language."}

    provider = speech.selected_speech_provider()
    quote_claims = None
    if provider == "google":
        if not request.quote_token:
            raise HTTPException(422, "Request and accept a speech credit quote before voicing.")
        from .media_quotes import verify_service_quote
        payload = {"presentation_id": presentation_id, "expected_version_id": request.expected_version_id,
                   "locale": request.locale, "cue_ids": request.cue_ids, "voice": request.voice,
                   "rate": request.rate, "pronunciations": [item.model_dump() for item in request.pronunciations]}
        quote_claims = verify_service_quote(request.quote_token, kind="speech", user_id=principal.user_id,
                                            presentation_id=presentation_id, payload=payload, units=uncached_characters)
    try:
        quotas.check_speech(session, access.workspace_id, uncached_characters)
    except quotas.QuotaExceeded as error:
        raise HTTPException(status_code=429, detail=error.as_detail()) from error

    operations: list[dict[str, Any]] = []
    manifest = {asset.get("id") for asset in document.get("assets") or []}
    voiced: list[dict[str, Any]] = []
    charged = 0
    billing_budget = None
    if provider == "google" and os.environ.get("DECKASTRA_CREDITS_ENABLED") == "1" and not local_mode.enabled():
        from deckastra_agents.budgets import RunBudget
        billing_budget = RunBudget(max_cost_usd=float(quote_claims["usd_micros"]) / 1_000_000,
                                   cost_observer=credits.observer(principal.user_id, task="speech", model="google-text-to-speech"))
    for slide_id, cue, script, storage_key, cue_voice in planned:
        asset = _cached(session, access.workspace_id, storage_key)
        if asset is None:
            try:
                made = speech.synthesize(
                    script, locale=locale, voice=cue_voice, rate=request.rate, pronunciations=pronunciations,
                    budget=billing_budget,
                )
            except speech.SpeechError as error:
                raise HTTPException(status_code=502, detail=str(error)) from error
            try:
                object_storage.put(storage_key, made.data, made.content_type)
                asset = asset_service.register(
                    session,
                    workspace_id=access.workspace_id,
                    created_by=principal.user_id,
                    storage_key=storage_key,
                    kind="audio",
                    filename=f"narration-{locale}-{cue['id'][-8:]}.{made.extension}",
                    content_type=made.content_type,
                    size_bytes=len(made.data),
                    duration_ms=made.duration_ms,
                    waveform_peaks=made.peaks,
                    word_timings=made.word_timings,
                )
            except object_storage.ObjectStorageError as error:
                raise HTTPException(status_code=503, detail=str(error)) from error
            except quotas.QuotaExceeded as error:
                raise HTTPException(status_code=429, detail=error.as_detail()) from error
            charged += len(script)
            voice_name = made.voice
        else:
            voice_name = "stub" if provider == "stub" else cue_voice
        if asset.id not in manifest:
            operations.append(
                {
                    "op": "add",
                    "path": "/assets/-",
                    "value": {
                        "id": asset.id,
                        "type": "audio",
                        "storageKey": asset.storage_key,
                        "fileName": asset.filename,
                        "mimeType": asset.content_type,
                        "byteSize": asset.bytes,
                        "durationMs": asset.duration_ms or 0,
                        "createdBy": "generated",
                    },
                }
            )
            manifest.add(asset.id)
        take = {
            "assetId": asset.id,
            "durationMs": int(asset.duration_ms or 0),
            "voice": voice_name,
            "textHash": locales.text_hash(script),
        }
        if asset.word_timings:
            take["wordTimings"] = asset.word_timings
        say_as = speech.say_as_fingerprint(script, pronunciations, request.rate)
        if say_as:
            take["sayAs"] = say_as
        cue_path = f"/slides/id:{slide_id}/narration/cues/id:{cue['id']}"
        takes = cue.get("takes")
        if not takes:
            operations.append({"op": "add", "path": f"{cue_path}/takes", "value": {locale: take}})
            cue["takes"] = {locale: take}
        else:
            escaped = locale.replace("~", "~0").replace("/", "~1")
            operations.append({"op": "replace" if locale in takes else "add", "path": f"{cue_path}/takes/{escaped}", "value": take})
            takes[locale] = take
        voiced.append({"cue_id": cue["id"], "asset_id": asset.id, "duration_ms": take["durationMs"], "voice": voice_name, "word_timings": len(take.get("wordTimings") or [])})

    if charged:
        quotas.record_speech(session, access.workspace_id, characters=charged)

    try:
        outcome = proposals.create_proposal(
            session,
            presentation_id=presentation_id,
            operations=operations,
            intent=f"Narrate {len(voiced)} cue{'s' if len(voiced) != 1 else ''} in {locale}",
            created_by=principal.user_id,
            agent_id=f"narrator:{provider}",
            reason=f"{provider} voice; {charged} characters synthesized, {len(voiced)} take(s)",
            expected_version_id=request.expected_version_id,
        )
    except proposals.ProposalError as error:
        raise _refuse(error) from error
    return _outcome(outcome, {"provider": provider, "voiced": voiced, "characters": charged})


def _cached(session: Session, workspace_id: str, storage_key: str) -> Asset | None:
    """A take this workspace already synthesized for exactly this request."""
    return session.execute(
        select(Asset).where(
            Asset.workspace_id == workspace_id,
            Asset.storage_key == storage_key,
            Asset.deleted_at.is_(None),
        )
    ).scalar_one_or_none()
