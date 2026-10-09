"""Short-lived, signed credit quotes for every paid service."""
from __future__ import annotations

import hashlib
import json
import math
import os
import time
from typing import Any, Literal

import jwt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from deckastra_agents.router import ModelRequest, ModelUnavailable
from deckastra_agents.video_model import configured_video_client
from deckastra_agents.vertex_model import configured_image_client
from . import credits, local_mode, locales, store, translation
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.session import get_session

router = APIRouter(prefix="/v1/media")
QUOTE_SECONDS = 15 * 60


class VideoQuoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    presentation_id: str = Field(min_length=1, max_length=64)
    prompt: str = Field(min_length=1, max_length=2000)
    duration_seconds: Literal[4, 6, 8] = 4
    aspect_ratio: Literal["16:9", "9:16"] = "16:9"
    generate_audio: Literal[False] = False


def _secret() -> str:
    value = os.environ.get("DECKASTRA_MEDIA_QUOTE_SECRET") or os.environ.get("DECKASTRA_DEV_SECRET")
    if not value and os.environ.get("DECKASTRA_ENV", "development").lower() == "production":
        raise ModelUnavailable("Media quotes are not configured.")
    return hashlib.sha256(((value or "deckastra-dev-secret") + ":media-quotes").encode()).hexdigest()


def prompt_hash(prompt: str) -> str:
    return hashlib.sha256(prompt.strip().encode("utf-8")).hexdigest()


def request_hash(value: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def service_price(kind: Literal["image", "translation", "speech"], *, units: int = 0, prompt: str = "") -> dict[str, Any]:
    if local_mode.enabled() and os.environ.get("DECKASTRA_GATEWAY_URL"):
        from deckastra_agents.gateway_client import GatewayClient
        return GatewayClient().service_quote(kind, units=units, prompt=prompt)
    if kind == "image":
        provider = configured_image_client()
        probe = ModelRequest("media", "", [{"role": "user", "content": prompt}], stage="image", max_tokens=4096, image_output=True)
        usd = float(provider.estimate_reservation(probe))
        return {"task": kind, "model": provider.model, "units": 1, "estimated_usd": usd,
                "credit_cost": math.ceil(usd * 1_000_000) / credits.MICROS_PER_CREDIT}
    setting = "DECKASTRA_TRANSLATION_USD_PER_MILLION" if kind == "translation" else "DECKASTRA_SPEECH_USD_PER_MILLION"
    try:
        rate = float(os.environ[setting])
        if not math.isfinite(rate) or rate <= 0:
            raise ValueError()
    except (KeyError, ValueError) as error:
        raise ModelUnavailable(f"Verified {kind} pricing is not configured.") from error
    usd = units * rate / 1_000_000
    return {"task": kind, "model": f"google-{kind}", "units": units, "estimated_usd": usd,
            "credit_cost": math.ceil(usd * 1_000_000) / credits.MICROS_PER_CREDIT}


def _issue_service_quote(*, kind: str, principal: Principal, session: Session, presentation_id: str,
                         payload: dict[str, Any], price: dict[str, Any]) -> dict[str, Any]:
    cost = float(price["credit_cost"])
    if os.environ.get("DECKASTRA_CREDITS_ENABLED") == "1" and not local_mode.enabled():
        remaining = credits.describe(credits.account(session, principal.user_id))["remaining_credits"]
        if cost > remaining:
            raise HTTPException(402, {"message": f"Not enough AI credits for this {kind} request.",
                                      "required_credits": cost, "remaining_credits": remaining})
    now = int(time.time())
    claims = {"iss": "deckastra-media-quote", "aud": "deckastra-media-quote", "iat": now,
              "exp": now + QUOTE_SECONDS, "sub": principal.user_id, "kind": kind,
              "presentation_id": presentation_id, "request_hash": request_hash(payload),
              "model": price.get("model"), "usd_micros": math.ceil(float(price["estimated_usd"]) * 1_000_000)}
    return {"quote_token": jwt.encode(claims, _secret(), algorithm="HS256"), "expires_at": claims["exp"],
            "provider": "vertex" if kind == "image" else "google", **price}


def verify_service_quote(token: str, *, kind: Literal["image", "translation", "speech"], user_id: str,
                         presentation_id: str, payload: dict[str, Any], units: int = 0, prompt: str = "") -> dict[str, Any]:
    try:
        claims = jwt.decode(token, _secret(), algorithms=["HS256"], audience="deckastra-media-quote",
                            issuer="deckastra-media-quote")
    except jwt.PyJWTError as exc:
        raise HTTPException(409, f"The {kind} credit quote is invalid or expired. Request a new quote.") from exc
    expected = {"sub": user_id, "kind": kind, "presentation_id": presentation_id, "request_hash": request_hash(payload)}
    if any(claims.get(key) != value for key, value in expected.items()):
        raise HTTPException(409, f"The {kind} request changed after it was quoted. Request a new quote.")
    current = service_price(kind, units=units, prompt=prompt)
    if claims.get("model") != current.get("model") or claims.get("usd_micros") != math.ceil(float(current["estimated_usd"]) * 1_000_000):
        raise HTTPException(409, f"The {kind} provider or price changed after this quote. Request a new quote.")
    return claims


class ImageQuoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    presentation_id: str = Field(min_length=1, max_length=64)
    expected_version_id: str = Field(min_length=1, max_length=64)
    slide_id: str = Field(min_length=1, max_length=64)
    prompt: str = Field(min_length=1, max_length=2000)


@router.post("/quotes/image")
def quote_image(request: ImageQuoteRequest, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=request.presentation_id, require=Role.EDITOR)
    loaded = store.load_presentation(session, request.presentation_id)
    if loaded.version_id != request.expected_version_id:
        raise HTTPException(409, "The deck changed. Request a new image quote.")
    if not any(slide.get("id") == request.slide_id for slide in loaded.document.get("slides") or []):
        raise HTTPException(404, "No such slide.")
    payload = request.model_dump()
    return _issue_service_quote(kind="image", principal=principal, session=session, presentation_id=request.presentation_id,
                                payload=payload, price=service_price("image", prompt=request.prompt))


class TranslationQuoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    presentation_id: str = Field(min_length=1, max_length=64)
    expected_version_id: str = Field(min_length=1, max_length=64)
    locale: str = Field(min_length=2, max_length=35)
    scope: Literal["missing", "outdated", "slides"] = "missing"
    slide_ids: list[str] = Field(default_factory=list, max_length=300)
    glossary: list[str] = Field(default_factory=list, max_length=200)


@router.post("/quotes/translation")
def quote_translation(request: TranslationQuoteRequest, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=request.presentation_id, require=Role.EDITOR)
    loaded = store.load_presentation(session, request.presentation_id)
    if loaded.version_id != request.expected_version_id:
        raise HTTPException(409, "The deck changed. Request a new translation quote.")
    slots = translation.slots_to_translate(loaded.document, request.locale, request.scope, request.slide_ids)
    units = translation.characters_to_translate(loaded.document, slots, request.glossary)
    payload = request.model_dump()
    price = {"task": "translation", "model": "stub", "units": units, "estimated_usd": 0.0, "credit_cost": 0.0} if translation.selected_translator_name() == "stub" else service_price("translation", units=units)
    return _issue_service_quote(kind="translation", principal=principal, session=session, presentation_id=request.presentation_id,
                                payload=payload, price=price)


class SpeechQuoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    presentation_id: str = Field(min_length=1, max_length=64)
    expected_version_id: str = Field(min_length=1, max_length=64)
    locale: str = Field(min_length=2, max_length=35)
    cue_ids: list[str] = Field(default_factory=list, max_length=500)
    voice: str = Field(default="default", max_length=120)
    rate: float = Field(default=1.0, ge=0.5, le=2.0)
    pronunciations: list[dict[str, str]] = Field(default_factory=list, max_length=100)


@router.post("/quotes/speech")
def quote_speech(request: SpeechQuoteRequest, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    from .language_routes import SynthesizeRequest, planned_speech
    access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=request.presentation_id, require=Role.EDITOR)
    loaded = store.load_presentation(session, request.presentation_id)
    if loaded.version_id != request.expected_version_id:
        raise HTTPException(409, "The deck changed. Request a new speech quote.")
    synth = SynthesizeRequest(**{key: value for key, value in request.model_dump().items() if key != "presentation_id"})
    _planned, units = planned_speech(session, access.workspace_id, loaded.document, synth)
    payload = request.model_dump()
    from . import speech
    price = {"task": "speech", "model": "stub", "units": units, "estimated_usd": 0.0, "credit_cost": 0.0} if speech.selected_speech_provider() == "stub" else service_price("speech", units=units)
    return _issue_service_quote(kind="speech", principal=principal, session=session, presentation_id=request.presentation_id,
                                payload=payload, price=price)


@router.post("/quotes/video")
def quote_video(request: VideoQuoteRequest, principal: Principal = Depends(current_principal),
                session: Session = Depends(get_session)):
    resolve_presentation_access(session, user_id=principal.user_id,
                                presentation_id=request.presentation_id, require=Role.EDITOR)
    provider = configured_video_client()
    quote = provider.video_quote(request.duration_seconds) if hasattr(provider, "video_quote") else {
        "model": provider.model, "duration_seconds": request.duration_seconds,
        "usd": provider.estimate_reservation(request.duration_seconds),
    }
    usd = float(quote["usd"])
    credit_cost = math.ceil(usd * 1_000_000) / credits.MICROS_PER_CREDIT
    if os.environ.get("DECKASTRA_CREDITS_ENABLED") == "1":
        remaining = credits.describe(credits.account(session, principal.user_id))["remaining_credits"]
        if credit_cost > remaining:
            raise HTTPException(402, {"message": "Not enough AI credits for this clip.",
                                      "required_credits": credit_cost, "remaining_credits": remaining})
    now = int(time.time())
    claims = {"iss": "deckastra-media-quote", "aud": "deckastra-media-quote", "iat": now,
              "exp": now + QUOTE_SECONDS, "sub": principal.user_id,
              "presentation_id": request.presentation_id, "prompt_hash": prompt_hash(request.prompt),
              "duration_seconds": request.duration_seconds, "aspect_ratio": request.aspect_ratio,
              "generate_audio": False, "model": quote.get("model"), "usd_micros": math.ceil(usd * 1_000_000)}
    return {"quote_token": jwt.encode(claims, _secret(), algorithm="HS256"),
            "expires_at": claims["exp"], "provider": "vertex", "model": claims["model"],
            "duration_seconds": request.duration_seconds, "aspect_ratio": request.aspect_ratio,
            "generate_audio": False, "estimated_usd": usd, "credit_cost": credit_cost}


def verify_video_quote(token: str, *, user_id: str, presentation_id: str, prompt: str,
                       duration_seconds: int, aspect_ratio: str) -> dict:
    try:
        claims = jwt.decode(token, _secret(), algorithms=["HS256"], audience="deckastra-media-quote",
                            issuer="deckastra-media-quote")
    except jwt.PyJWTError as exc:
        raise HTTPException(409, "The video credit quote is invalid or expired. Request a new quote.") from exc
    expected = {"sub": user_id, "presentation_id": presentation_id, "prompt_hash": prompt_hash(prompt),
                "duration_seconds": duration_seconds, "aspect_ratio": aspect_ratio, "generate_audio": False}
    if any(claims.get(key) != value for key, value in expected.items()):
        raise HTTPException(409, "The video request changed after it was quoted. Request a new quote.")
    provider = configured_video_client()
    current = provider.video_quote(duration_seconds) if hasattr(provider, "video_quote") else {
        "model": provider.model, "usd": provider.estimate_reservation(duration_seconds),
    }
    if (claims.get("model") != current.get("model") or
            claims.get("usd_micros") != math.ceil(float(current["usd"]) * 1_000_000)):
        raise HTTPException(409, "The video model or price changed after this quote. Request a new quote.")
    return claims
