"""Account API and transient inference for local desktop decks."""
from dataclasses import asdict
import hashlib
import hmac
import os
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session

from deckastra_agents.budgets import BudgetExceeded, RunBudget
from deckastra_agents.router import ImageInput, ModelRequest, ModelTool, ModelUnavailable
from deckastra_agents.vertex_router import configured_client
from . import credits
from .auth import Principal, current_principal
from .db.session import get_session

router = APIRouter(prefix="/v1")


@router.get("/account/credits")
def balance(principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    return credits.describe(credits.account(session, principal.user_id))


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant", "tool"]
    content: str = Field(max_length=100000)
    name: str | None = Field(default=None, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    provider_parts: list[dict] = Field(default_factory=list, max_length=32)
    tool_calls: list[dict] = Field(default_factory=list, max_length=32)
    tool_call_id: str | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def tool_has_name(self):
        if self.role == "tool" and not self.name:
            raise ValueError("A tool response must name its tool.")
        return self


class Image(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data: str = Field(max_length=1500000)
    mime_type: Literal["image/png", "image/jpeg", "image/webp"] = "image/png"


class Tool(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(max_length=64)
    description: str = Field(max_length=2000)
    parameters: dict


class InferenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: Literal["planning", "authoring", "cleanup", "critique", "translation", "narration", "vision", "research", "image", "consistency", "organise"]
    system: str = Field(max_length=20000)
    messages: list[Message] = Field(min_length=1, max_length=16)
    response_schema: dict | None = None
    images: list[Image] = Field(default_factory=list, max_length=4)
    tools: list[Tool] = Field(default_factory=list, max_length=20)
    max_tokens: int = Field(default=8000, ge=1, le=16000)
    web_search: bool = False
    image_output: bool = False

    @model_validator(mode="after")
    def bounded_payload(self):
        import json
        if len(json.dumps(self.model_dump()).encode()) > 6_000_000:
            raise ValueError("Inference payload exceeds the request limit.")
        return self


@router.get("/account/capabilities")
def capabilities(principal: Principal = Depends(current_principal)):
    client = configured_client()
    tasks = {}
    for task in InferenceRequest.model_fields["task"].annotation.__args__:
        try:
            provider = client.vertex_factory(task)
            tasks[task] = {"available": True, "model": provider.model, "reason": None,
                "minimum_reservation_usd": provider.estimate_reservation(ModelRequest("structured", "", [], stage=task, max_tokens=4096))}
        except ModelUnavailable as error:
            tasks[task] = {"available": False, "model": None, "reason": str(error)}
    return {"provider": "vertex", "tasks": tasks}


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
    client = configured_client()
    provider = client.vertex_factory(request.task)
    budget = RunBudget(max_wall_clock_seconds=180, max_cost_usd=float(os.environ.get("DECKASTRA_ASSISTANT_MAX_COST_USD", "0.30")),
        cost_observer=credits.observer(principal.user_id, task=request.task, model=provider.model, device_hash=device_hash))
    model_request = ModelRequest("structured", request.system, [m.model_dump() for m in request.messages],
        response_schema=request.response_schema, images=[ImageInput(**i.model_dump()) for i in request.images],
        tools=[ModelTool(**t.model_dump()) for t in request.tools], max_tokens=request.max_tokens,
        stage=request.task, web_search=request.web_search, image_output=request.image_output)
    try:
        response = client.complete(model_request, budget)
    except BudgetExceeded as exc:
        raise HTTPException(429, str(exc)) from exc
    # The supplied scope and proposed result exist only in request memory.
    return {"response": asdict(response), "usage": budget.report(), "request_id": uuid.uuid4().hex}
