"""Bounded Veo text-to-video transport for short presentation clips.

The provider is deliberately narrower than Veo itself: one 720p MP4, 4/6/8
seconds, no generated audio, and no automatic retry after a request is sent.
That is the product contract Phase 8 can quote before spending credits.
"""
from __future__ import annotations

import base64
import math
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from .budgets import RunBudget
from .router import ModelError, ModelUnavailable
from .vertex_model import token_provider

MAX_VIDEO_BYTES = 32 * 1024 * 1024
VIDEO_DURATIONS = (4, 6, 8)
VIDEO_ASPECTS = ("16:9", "9:16")
_video_slots = threading.BoundedSemaphore(2)


@dataclass(frozen=True)
class VideoResult:
    data: bytes
    content_type: str
    duration_ms: int
    width: int
    height: int
    model: str


def configuration() -> dict[str, Any]:
    project = os.environ.get("DECKASTRA_VERTEX_PROJECT", "").strip()
    location = os.environ.get("DECKASTRA_VERTEX_VIDEO_LOCATION", os.environ.get("DECKASTRA_VERTEX_LOCATION", "")).strip()
    identity = os.environ.get("DECKASTRA_VERTEX_IDENTITY", "").strip()
    credentials = os.environ.get("DECKASTRA_GOOGLE_CREDENTIALS", "").strip()
    model = os.environ.get("DECKASTRA_VERTEX_VIDEO_MODEL", "veo-3.1-fast-generate-001").strip()
    if not project or not location or (identity != "attached" and not credentials):
        raise ModelUnavailable("Configure the Vertex project, video location and explicit Google identity before generating video.")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,62}", project) or not re.fullmatch(r"[a-z0-9-]+", location):
        raise ModelUnavailable("The Vertex project or video location is invalid.")
    if not re.fullmatch(r"veo-[a-zA-Z0-9_.-]+", model) or model.endswith("preview"):
        raise ModelUnavailable("Configure a pinned, non-preview Veo model identifier.")
    try:
        rate = float(os.environ["DECKASTRA_VEO_USD_PER_SECOND"])
        ceiling = float(os.environ["DECKASTRA_ASSISTANT_MAX_COST_USD"])
    except (KeyError, ValueError) as exc:
        raise ModelUnavailable("Configure verified Veo per-second pricing and a positive media spend ceiling.") from exc
    if not math.isfinite(rate) or rate <= 0 or not math.isfinite(ceiling) or ceiling <= 0:
        raise ModelUnavailable("Veo pricing and the media spend ceiling must be positive finite values.")
    return {"project": project, "location": location, "identity": identity, "credentials": credentials,
            "model": model, "rate": rate, "ceiling": ceiling}


def quote(duration_seconds: int, config: dict[str, Any] | None = None) -> dict[str, Any]:
    if duration_seconds not in VIDEO_DURATIONS:
        raise ModelUnavailable("Video duration must be 4, 6 or 8 seconds.")
    chosen = config or configuration()
    usd = duration_seconds * float(chosen["rate"])
    return {"model": chosen["model"], "duration_seconds": duration_seconds, "usd": usd,
            "credits": math.ceil(usd * 1_000_000) / 5_000}


class VeoClient:
    def __init__(self, config: dict[str, Any] | None = None, token: Callable[[], str] | None = None, transport: Any = None):
        self.config = config or configuration()
        self.model = self.config["model"]
        self.token = token or token_provider(self.config)
        self.transport = transport

    def estimate_reservation(self, duration_seconds: int) -> float:
        return float(quote(duration_seconds, self.config)["usd"])

    def generate(self, prompt: str, *, duration_seconds: int = 4, aspect_ratio: str = "16:9",
                 budget: RunBudget) -> VideoResult:
        import httpx
        if not prompt.strip() or len(prompt) > 2_000:
            raise ModelUnavailable("A video brief must contain 1 to 2,000 characters.")
        if duration_seconds not in VIDEO_DURATIONS or aspect_ratio not in VIDEO_ASPECTS:
            raise ModelUnavailable("Video supports 4, 6 or 8 seconds and 16:9 or 9:16.")
        budget.check_clock()
        if budget.max_cost_usd is None:
            budget.max_cost_usd = self.config["ceiling"]
        cost = self.estimate_reservation(duration_seconds)
        operation_id = uuid.uuid4().hex
        access_token = self.token()  # Authentication can fail without a paid request.
        location = self.config["location"]
        host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
        root = f"https://{host}/v1/projects/{self.config['project']}/locations/{location}/publishers/google/models/{self.model}"
        headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
        body = {"instances": [{"prompt": prompt.strip()}], "parameters": {
            "durationSeconds": duration_seconds, "aspectRatio": aspect_ratio, "resolution": "720p",
            "sampleCount": 1, "generateAudio": False, "personGeneration": "disallow",
        }}
        while not _video_slots.acquire(timeout=0.1):
            budget.check_clock()
        sent = False
        client = self.transport or httpx.Client(timeout=httpx.Timeout(60, connect=5))
        close = self.transport is None
        try:
            budget.reserve_cost(operation_id, cost, task="video", model=self.model)
            sent = True
            answer = client.post(root + ":predictLongRunning", json=body, headers=headers)
            if answer.status_code >= 400:
                if answer.status_code in (400, 401, 403, 404, 429):
                    budget.reconcile_cost(operation_id, cost, 0)
                raise ModelError(f"Veo returned HTTP {answer.status_code}; the clip was not generated.")
            name = answer.json().get("name")
            if not isinstance(name, str) or not name:
                raise ModelError("Veo returned no operation name; uncertain usage remains reserved.")
            while True:
                budget.check_clock()
                polled = client.post(root + ":fetchPredictOperation", json={"operationName": name}, headers=headers)
                if polled.status_code >= 400:
                    raise ModelError(f"Veo operation polling returned HTTP {polled.status_code}; uncertain usage remains reserved.")
                payload = polled.json()
                if payload.get("done"):
                    break
                time.sleep(min(2, max(0.1, budget.max_wall_clock_seconds - budget.elapsed_seconds)))
            if payload.get("error"):
                raise ModelError("Veo refused or failed the clip; usage is retained for reconciliation.")
            videos = (payload.get("response") or {}).get("videos") or []
            if len(videos) != 1:
                raise ModelError("Veo did not return exactly one clip.")
            encoded = videos[0].get("bytesBase64Encoded") or videos[0].get("video", {}).get("bytesBase64Encoded")
            if not encoded:
                raise ModelError("Veo returned a storage URI instead of inline bytes; omit storageUri for Deckastra generation.")
            data = base64.b64decode(encoded, validate=True)
            if not data or len(data) > MAX_VIDEO_BYTES:
                raise ModelError("Generated video exceeds the 32MB clip limit.")
            mime = videos[0].get("mimeType") or "video/mp4"
            if mime != "video/mp4":
                raise ModelError("Deckastra accepts generated video only as MP4.")
            budget.reconcile_cost(operation_id, cost, cost)
            width, height = ((1280, 720) if aspect_ratio == "16:9" else (720, 1280))
            return VideoResult(data, mime, duration_seconds * 1_000, width, height, self.model)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            if sent:
                budget.reconcile_cost(operation_id, cost, 0)
            raise ModelError("Could not connect to Veo before a generation request completed.") from exc
        finally:
            if close:
                client.close()
            _video_slots.release()


def configured_video_client():
    if os.environ.get("DECKASTRA_LOCAL_MODE") == "1" and os.environ.get("DECKASTRA_GATEWAY_URL"):
        from .gateway_client import GatewayClient
        return GatewayClient()
    return VeoClient()
