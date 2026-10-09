"""Account API and transient inference for local desktop decks."""
from dataclasses import asdict
import base64
import hashlib
import hmac
import math
import os
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session

from deckastra_agents.budgets import BudgetExceeded, RunBudget, cost_observer
from deckastra_agents.router import ImageInput, ModelRequest, ModelUnavailable
from deckastra_agents.vertex_model import configured_image_client
from deckastra_agents.video_model import configured_video_client, configuration as video_configuration, quote as video_quote
from . import credits, local_mode, speech, translation
from .auth import Principal, current_principal
from .db.session import get_session

router = APIRouter(prefix="/v1")


def _observer(principal: Principal, device_id: str | None, *, task: str, model: str):
    secret = os.environ.get("DECKASTRA_DEVICE_SECRET", "")
    if not secret:
        raise HTTPException(503, "Device accounting is not configured.")
    device_hash = hmac.new(secret.encode(), (device_id or principal.user_id).encode(), hashlib.sha256).hexdigest()
    return credits.observer(principal.user_id, task=task, model=model, device_hash=device_hash)


@router.get("/account/credits")
def balance(principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    # On the desktop the balance that pays for AI is the signed-in cloud
    # account's, reached through the main process's private gateway. The local
    # database's own ledger would answer for a singleton nobody bills, so it is
    # not consulted there (roadmap 08 §1.5: credits are read, never computed).
    if local_mode.enabled() and os.environ.get("DECKASTRA_GATEWAY_URL"):
        from deckastra_agents.gateway_client import GatewayClient
        try:
            return GatewayClient().credits()
        except ModelUnavailable as error:
            raise HTTPException(503, str(error)) from error
    return credits.describe(credits.account(session, principal.user_id))


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str = Field(max_length=100000)
    provider_parts: list[dict] = Field(default_factory=list, max_length=32)


class Image(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data: str = Field(max_length=1500000)
    mime_type: Literal["image/png", "image/jpeg", "image/webp"] = "image/png"


class InferenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: Literal["image"] = "image"
    system: str = Field(max_length=20000)
    messages: list[Message] = Field(min_length=1, max_length=16)
    images: list[Image] = Field(default_factory=list, max_length=4)
    max_tokens: int = Field(default=8000, ge=1, le=16000)
    image_output: Literal[True] = True

    @model_validator(mode="after")
    def bounded_payload(self):
        import json
        if len(json.dumps(self.model_dump()).encode()) > 6_000_000:
            raise ValueError("Inference payload exceeds the request limit.")
        return self


class ServiceQuoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: Literal["image", "translation", "speech"]
    units: int = Field(default=0, ge=0, le=10_000_000)
    prompt: str = Field(default="", max_length=4000)


def _character_quote(task: str, units: int, setting: str, model: str) -> dict:
    try:
        rate = float(os.environ[setting])
        if not math.isfinite(rate) or rate <= 0:
            raise ValueError()
    except (KeyError, ValueError) as error:
        raise HTTPException(503, f"Verified {task} pricing is not configured.") from error
    usd = units * rate / 1_000_000
    return {"task": task, "model": model, "units": units, "estimated_usd": usd,
            "credit_cost": math.ceil(usd * 1_000_000) / credits.MICROS_PER_CREDIT}


@router.post("/assistant/quote")
def quote_service(request: ServiceQuoteRequest, principal: Principal = Depends(current_principal),
                  session: Session = Depends(get_session)):
    if os.environ.get("DECKASTRA_CREDITS_ENABLED") != "1":
        raise HTTPException(503, "The hosted account gateway is not configured.")
    if request.task == "image":
        provider = configured_image_client()
        probe = ModelRequest("media", "", [{"role": "user", "content": request.prompt}], stage="image", max_tokens=4096, image_output=True)
        usd = float(provider.estimate_reservation(probe))
        quote = {"task": "image", "model": provider.model, "units": 1, "estimated_usd": usd,
                 "credit_cost": math.ceil(usd * 1_000_000) / credits.MICROS_PER_CREDIT}
    elif request.task == "translation":
        quote = _character_quote("translation", request.units, "DECKASTRA_TRANSLATION_USD_PER_MILLION", "google-translation")
    else:
        quote = _character_quote("speech", request.units, "DECKASTRA_SPEECH_USD_PER_MILLION", "google-text-to-speech")
    remaining = credits.describe(credits.account(session, principal.user_id))["remaining_credits"]
    if quote["credit_cost"] > remaining:
        raise HTTPException(402, {"message": f"Not enough AI credits for this {request.task} request.",
                                  "required_credits": quote["credit_cost"], "remaining_credits": remaining})
    return quote


class GatewayTranslationItem(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    text: str = Field(max_length=100_000)


class GatewayTranslationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[GatewayTranslationItem] = Field(min_length=1, max_length=40)
    source: str = Field(min_length=2, max_length=35)
    target: str = Field(min_length=2, max_length=35)


@router.post("/assistant/translate")
def translate_service(request: GatewayTranslationRequest, principal: Principal = Depends(current_principal),
                      device_id: str | None = Header(default=None, alias="X-Deckastra-Device")):
    if os.environ.get("DECKASTRA_CREDITS_ENABLED") != "1":
        raise HTTPException(503, "The hosted account gateway is not configured.")
    token = cost_observer.set(_observer(principal, device_id, task="translation", model="google-translation"))
    try:
        items = [translation.Item(item.id, item.text) for item in request.items]
        return {"translations": translation.GoogleTranslator().translate(items, source=request.source, target=request.target)}
    finally:
        cost_observer.reset(token)


class GatewayPronunciation(BaseModel):
    term: str = Field(min_length=1, max_length=80)
    say: str = Field(min_length=1, max_length=120)


class GatewaySpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=100_000)
    locale: str = Field(min_length=2, max_length=35)
    voice: str = Field(default="default", max_length=120)
    rate: float = Field(default=1.0, ge=0.5, le=2.0)
    pronunciations: list[GatewayPronunciation] = Field(default_factory=list, max_length=100)


@router.post("/assistant/speech")
def speech_service(request: GatewaySpeechRequest, principal: Principal = Depends(current_principal),
                   device_id: str | None = Header(default=None, alias="X-Deckastra-Device")):
    if os.environ.get("DECKASTRA_CREDITS_ENABLED") != "1":
        raise HTTPException(503, "The hosted account gateway is not configured.")
    token = cost_observer.set(_observer(principal, device_id, task="speech", model="google-text-to-speech"))
    try:
        made = speech.synthesize(request.text, locale=request.locale, voice=request.voice, rate=request.rate,
                                 pronunciations=[speech.Pronunciation(item.term, item.say) for item in request.pronunciations])
        return {"audio": {"data": base64.b64encode(made.data).decode(), "content_type": made.content_type,
                "extension": made.extension, "duration_ms": made.duration_ms, "voice": made.voice,
                "peaks": made.peaks, "word_timings": made.word_timings}}
    finally:
        cost_observer.reset(token)


@router.get("/account/capabilities")
def capabilities(principal: Principal = Depends(current_principal)):
    try:
        provider = configured_image_client()
        probe = ModelRequest("media", "", [], stage="image", max_tokens=4096, image_output=True)
        image = {"available": True, "model": provider.model, "reason": None,
                 "minimum_reservation_usd": provider.estimate_reservation(probe)}
    except ModelUnavailable as error:
        image = {"available": False, "model": None, "reason": str(error)}
    try:
        config = video_configuration()
        q = video_quote(4, config)
        video = {"available": True, "model": config["model"], "reason": None,
                 "minimum_reservation_usd": q["usd"], "usd_per_second": config["rate"]}
    except ModelUnavailable as error:
        video = {"available": False, "model": None, "reason": str(error)}
    return {"provider": "vertex", "tasks": {"image": image, "video": video}}


class VideoInferenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=2000)
    duration_seconds: Literal[4, 6, 8] = 4
    aspect_ratio: Literal["16:9", "9:16"] = "16:9"
    generate_audio: Literal[False] = False


@router.post("/assistant/video")
def generate_video(request: VideoInferenceRequest, principal: Principal = Depends(current_principal),
                   device_id: str | None = Header(default=None, alias="X-Deckastra-Device")):
    if os.environ.get("DECKASTRA_CREDITS_ENABLED") != "1":
        raise HTTPException(503, "The hosted account gateway is not configured.")
    secret = os.environ.get("DECKASTRA_DEVICE_SECRET", "")
    if not secret:
        raise HTTPException(503, "Device accounting is not configured.")
    device_hash = hmac.new(secret.encode(), (device_id or principal.user_id).encode(), hashlib.sha256).hexdigest()
    provider = configured_video_client()
    budget = RunBudget(max_wall_clock_seconds=600,
        max_cost_usd=float(os.environ.get("DECKASTRA_ASSISTANT_MAX_COST_USD", "10")),
        cost_observer=credits.observer(principal.user_id, task="video", model=provider.model, device_hash=device_hash))
    try:
        result = provider.generate(request.prompt, duration_seconds=request.duration_seconds,
                                   aspect_ratio=request.aspect_ratio, budget=budget)
    except BudgetExceeded as exc:
        raise HTTPException(429, str(exc)) from exc
    return {"video": {"data": base64.b64encode(result.data).decode(), "content_type": result.content_type,
        "duration_ms": result.duration_ms, "width": result.width, "height": result.height, "model": result.model},
        "usage": budget.report(), "request_id": uuid.uuid4().hex}


@router.post("/assistant/infer")
def infer(request: InferenceRequest, principal: Principal = Depends(current_principal),
          device_id: str | None = Header(default=None, alias="X-Deckastra-Device")):
    if os.environ.get("DECKASTRA_CREDITS_ENABLED") != "1":
        raise HTTPException(503, "The hosted account gateway is not configured.")
    if device_id is not None and len(device_id) > 128:
        raise HTTPException(422, "Invalid device identifier.")
    secret = os.environ.get("DECKASTRA_DEVICE_SECRET", "")
    if not secret:
        raise HTTPException(503, "Device accounting is not configured.")
    device_hash = hmac.new(secret.encode(), (device_id or principal.user_id).encode(), hashlib.sha256).hexdigest()
    provider = configured_image_client()
    budget = RunBudget(max_wall_clock_seconds=180, max_cost_usd=float(os.environ.get("DECKASTRA_ASSISTANT_MAX_COST_USD", "0.30")),
        cost_observer=credits.observer(principal.user_id, task=request.task, model=provider.model, device_hash=device_hash))
    model_request = ModelRequest("media", request.system, [m.model_dump() for m in request.messages],
        images=[ImageInput(**i.model_dump()) for i in request.images], max_tokens=request.max_tokens,
        stage="image", image_output=True)
    try:
        response = provider.complete(model_request, budget)
    except BudgetExceeded as exc:
        raise HTTPException(429, str(exc)) from exc
    # The supplied scope and proposed result exist only in request memory.
    return {"response": asdict(response), "usage": budget.report(), "request_id": uuid.uuid4().hex}
