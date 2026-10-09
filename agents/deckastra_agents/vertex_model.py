"""Native Vertex Gemini transport. Identity, models and billing are explicit."""
from __future__ import annotations

import json
import math
import os
import threading
import uuid
import weakref
from contextlib import nullcontext
from typing import Any, Callable, Iterator

from .budgets import RunBudget
from .envelope import POLICY
from .router import ModelError, ModelRequest, ModelResponse, ModelUnavailable

_cloud_slots = threading.BoundedSemaphore(4)


def configuration() -> dict[str, Any]:
    project = os.environ.get("DECKASTRA_VERTEX_PROJECT", "").strip()
    location = os.environ.get("DECKASTRA_VERTEX_LOCATION", "").strip()
    identity = os.environ.get("DECKASTRA_VERTEX_IDENTITY", "").strip()
    credentials = os.environ.get("DECKASTRA_GOOGLE_CREDENTIALS", "").strip()
    if not project or not location or (identity != "attached" and not credentials):
        raise ModelUnavailable("Configure DECKASTRA_VERTEX_PROJECT, DECKASTRA_VERTEX_LOCATION and explicit Google credentials or DECKASTRA_VERTEX_IDENTITY=attached.")
    import re
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,62}", project) or not re.fullmatch(r"[a-z0-9-]+", location):
        raise ModelUnavailable("The Vertex project or location is invalid.")
    try:
        ceiling = float(os.environ["DECKASTRA_ASSISTANT_MAX_COST_USD"])
        prices = json.loads(os.environ["DECKASTRA_VERTEX_PRICES"])
    except (KeyError, ValueError, TypeError) as exc:
        raise ModelUnavailable("Configure a positive media spend ceiling and DECKASTRA_VERTEX_PRICES (per-model USD per million input/output tokens).") from exc
    if not math.isfinite(ceiling) or ceiling <= 0 or not isinstance(prices, dict):
        raise ModelUnavailable("The media spend ceiling or Vertex prices are invalid.")
    try:
        thinking = json.loads(os.environ.get("DECKASTRA_VERTEX_THINKING", "{}"))
        if not isinstance(thinking, dict) or any(level not in ("MINIMAL", "LOW", "MEDIUM", "HIGH") for level in thinking.values()):
            raise ValueError()
    except (ValueError, TypeError) as exc:
        raise ModelUnavailable("DECKASTRA_VERTEX_THINKING must map pinned model IDs to MINIMAL, LOW, MEDIUM or HIGH.") from exc
    ip_family = os.environ.get("DECKASTRA_VERTEX_IP_FAMILY", "auto")
    if ip_family not in {"auto", "ipv4"}:
        raise ModelUnavailable("DECKASTRA_VERTEX_IP_FAMILY must be auto or ipv4.")
    return dict(project=project, location=location, credentials=credentials, identity=identity, ceiling=ceiling, prices=prices, thinking=thinking, ip_family=ip_family)


def token_provider(config: dict[str, Any]) -> Callable[[], str]:
    import google.auth
    import google.auth.transport.requests
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    try:
        if config["credentials"]:
            credentials, _ = google.auth.load_credentials_from_file(config["credentials"], scopes=scopes)
        else:
            credentials, _ = google.auth.default(scopes=scopes)
    except (google.auth.exceptions.GoogleAuthError, OSError, ValueError) as exc:
        raise ModelUnavailable("Google identity is unavailable. Configure a readable credentials file or a working attached identity.") from exc
    lock = threading.Lock()
    def token() -> str:
        with lock:
            if not credentials.valid:
                credentials.refresh(google.auth.transport.requests.Request())
            if not credentials.token:
                raise ModelUnavailable("Vertex identity did not issue an access token.")
            return credentials.token
    return token


class VertexClient:
    @property
    def capabilities(self):
        return {"provider": "vertex", "model": self.model, "inputs": ["text", "image", "tools"], "streaming": True}

    def __init__(self, model: str, config: dict[str, Any] | None = None, token: Callable[[], str] | None = None, transport: Any = None):
        import re
        if not re.fullmatch(r"[a-zA-Z0-9_.-]+", model) or model.endswith("latest"):
            raise ModelUnavailable("Configure a pinned Vertex model identifier.")
        self.model = model
        self.config = config or configuration()
        self.token = token or token_provider(self.config)
        self.transport = transport
        self._http = None
        self._http_lock = threading.Lock()
        self._http_finalizer = None
        try:
            price = self.config["prices"][model]
            self.input_rate = float(price["input"])
            self.output_rate = float(price["output"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ModelUnavailable(f"Configure input/output pricing for Vertex model {model}.") from exc
        if any(not math.isfinite(x) or x < 0 for x in (self.input_rate, self.output_rate)):
            raise ModelUnavailable("Vertex pricing must be finite and nonnegative.")

    def _http_client(self):
        """Keep a bounded connection pool across stages and repairs.

        Identity and timeout belong to each request, never to pooled headers.
        A discarded task client closes its pool without retaining itself.
        """
        import httpx
        with self._http_lock:
            if self._http is None:
                limits = httpx.Limits(max_connections=4, max_keepalive_connections=4, keepalive_expiry=60)
                transport = self.transport
                if transport is None and self.config.get("ip_family") == "ipv4":
                    transport = httpx.HTTPTransport(local_address="0.0.0.0", retries=0, limits=limits)
                self._http = httpx.Client(transport=transport, limits=limits)
                self._http_finalizer = weakref.finalize(self, self._http.close)
            return self._http

    def close(self):
        with self._http_lock:
            if self._http_finalizer is not None:
                self._http_finalizer()
            self._http = None

    def _body(self, request: ModelRequest) -> dict[str, Any]:
        if not request.image_output:
            raise ModelUnavailable("The Vertex transport is restricted to image generation.")
        contents = []
        for message in request.messages:
            if message.get("provider_parts"):
                parts = message["provider_parts"]
            else:
                parts = [{"text": str(message.get("content") or "")}]
            contents.append({"role": "model" if message.get("role") == "assistant" else "user", "parts": parts})
        if request.images:
            if not contents:
                contents.append({"role": "user", "parts": []})
            contents[-1]["parts"].extend({"inlineData": {"mimeType": image.mime_type, "data": image.data}} for image in request.images)
        generation: dict[str, Any] = {"maxOutputTokens": request.max_tokens}
        # Gemini 3 deprecates sampling controls; use its supported thinking
        # level rather than carrying a legacy temperature into new requests.
        if not self.model.startswith("gemini-3"):
            generation["temperature"] = 0.2
        level = self.config.get("thinking", {}).get(self.model)
        if level:
            generation["thinkingConfig"] = {"thinkingLevel": level}
        body = {"systemInstruction": {"parts": [{"text": "\n\n".join([request.system, *request.context, POLICY])}]}, "contents": contents, "generationConfig": generation}
        generation["responseModalities"] = ["TEXT", "IMAGE"]
        return body

    def estimate_reservation(self, request: ModelRequest) -> float:
        """The same conservative upper bound used before sending a paid call."""
        body = self._body(request)
        # UTF-8 bytes conservatively bound text tokens; reserve a generous image allowance.
        maximum_input = len(json.dumps(body, ensure_ascii=False).encode("utf-8")) + len(request.images) * 16384
        prices = self.config["prices"][self.model]
        input_long = float(prices.get("input_long", self.input_rate))
        output_long = float(prices.get("output_long", self.output_rate))
        if any(not math.isfinite(rate) or rate < 0 for rate in (input_long, output_long)):
            raise ModelUnavailable("Long-context prices must be finite nonnegative rates.")
        reserve_input_rate = input_long if maximum_input > 200000 else self.input_rate
        reserve_output_rate = output_long if maximum_input > 200000 else self.output_rate
        image_rate = self.output_rate
        if request.image_output:
            try:
                image_rate = float(self.config["prices"][self.model]["image_output"])
                if not math.isfinite(image_rate) or image_rate <= 0:
                    raise ValueError()
            except (KeyError, ValueError, TypeError) as exc:
                raise ModelUnavailable("Configure image_output USD per million image tokens before generating images.") from exc
        return (maximum_input * reserve_input_rate + request.max_tokens * max(reserve_output_rate, image_rate)) / 1_000_000

    def stream(self, request: ModelRequest, budget: RunBudget) -> Iterator[ModelResponse]:
        import httpx
        budget.check_clock()
        if budget.max_cost_usd is None:
            budget.max_cost_usd = self.config["ceiling"]
        body = self._body(request)
        maximum = self.estimate_reservation(request)
        prices = self.config["prices"][self.model]
        input_long = float(prices.get("input_long", self.input_rate))
        output_long = float(prices.get("output_long", self.output_rate))
        image_rate = float(prices["image_output"]) if request.image_output else self.output_rate
        operation_id = uuid.uuid4().hex
        # Authentication can fail without a paid request. Do it before reserving.
        access_token = self.token()
        location = self.config["location"]
        host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
        url = f"https://{host}/v1/projects/{self.config['project']}/locations/{location}/publishers/google/models/{self.model}:streamGenerateContent?alt=sse"
        while not _cloud_slots.acquire(timeout=0.1):
            budget.check_clock()
        usage = None
        try:
            budget.check_clock()
            budget.reserve_cost(operation_id, maximum, task="image", model=self.model)
            remaining = max(0.1, budget.max_wall_clock_seconds - budget.elapsed_seconds)
            # Thinking may produce no text for more than 30s. The run's clock
            # remains authoritative; a premature read timeout creates uncertain
            # paid calls and cannot safely be fixed by an automatic retry.
            timeout = httpx.Timeout(remaining, connect=min(5, remaining), read=min(120, remaining))
            with nullcontext(self._http_client()) as client:
                with client.stream("POST", url, json=body, headers={"Authorization": f"Bearer {access_token}"}, timeout=timeout) as answer:
                    if answer.status_code >= 400:
                        answer.read()
                        if answer.status_code in (400, 401, 403, 404, 429):
                            budget.reconcile_cost(operation_id, maximum, 0)
                        hint = {400: "Check the pinned model's schema, thinking level and supported modalities.", 401: "Refresh the configured Google identity.", 403: "Check Vertex API enablement and the configured identity's project permissions.", 404: "Check the project, model ID and serving location.", 429: "Vertex quota is exhausted; retry later with a new operation after checking usage."}.get(answer.status_code, "Uncertain usage remains reserved; do not retry automatically.")
                        raise ModelError(f"Vertex returned HTTP {answer.status_code}. {hint}")
                    for line in answer.iter_lines():
                        budget.check_clock()
                        if not line.startswith("data:"):
                            continue
                        payload = json.loads(line[5:].strip())
                        usage = payload.get("usageMetadata", usage)
                        candidate = (payload.get("candidates") or [{}])[0]
                        if candidate.get("finishReason") == "MAX_TOKENS":
                            budget.warn("Vertex reached the output-token limit; incomplete structured output must be repaired or rejected.")
                        parts = candidate.get("content", {}).get("parts", [])
                        refusal = candidate.get("finishReason") if candidate.get("finishReason") in ("SAFETY", "RECITATION", "PROHIBITED_CONTENT") else None
                        yield ModelResponse(text="".join(p.get("text", "") for p in parts if not p.get("thought")), model=self.model, provider_parts=parts, refusal=refusal)
            if usage is None:
                raise ModelError("Vertex returned no usage; the cost reservation is retained.")
            incoming = int(usage.get("promptTokenCount", 0))
            outgoing = int(usage.get("candidatesTokenCount", 0)) + int(usage.get("thoughtsTokenCount", 0))
            actual_input_rate = input_long if incoming > 200000 else self.input_rate
            actual_output_rate = output_long if incoming > 200000 else self.output_rate
            output_cost = outgoing * actual_output_rate
            if request.image_output:
                details = usage.get("candidatesTokensDetails", [])
                candidate_count = int(usage.get("candidatesTokenCount", 0))
                if details and sum(int(d.get("tokenCount", 0)) for d in details) == candidate_count:
                    output_cost = sum(int(d.get("tokenCount", 0)) * (image_rate if d.get("modality") == "IMAGE" else actual_output_rate) for d in details) + int(usage.get("thoughtsTokenCount", 0)) * actual_output_rate
                else:
                    output_cost = outgoing * max(image_rate, actual_output_rate)
                    budget.warn("Image usage lacked modality counts; cost conservatively uses the highest output token rate.")
            budget.reconcile_cost(operation_id, maximum, (incoming * actual_input_rate + output_cost) / 1_000_000)
            budget.spend_tokens(incoming, outgoing)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            # The connection failed before sending an HTTP request. This is
            # confirmed non-use, unlike a read timeout after a paid request.
            budget.reconcile_cost(operation_id, maximum, 0)
            raise ModelError("Could not connect to Vertex before sending the request; no model usage was charged. Check network connectivity (including IPv6) before a new operation.") from exc
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            raise ModelError("Vertex request interrupted; uncertain usage remains reserved and will not be retried automatically.") from exc
        finally:
            _cloud_slots.release()

    def complete(self, request: ModelRequest, budget: RunBudget) -> ModelResponse:
        result = ModelResponse(text="", model=self.model)
        before_in, before_out = budget.input_tokens, budget.output_tokens
        for chunk in self.stream(request, budget):
            result.text += chunk.text
            result.provider_parts.extend(chunk.provider_parts)
            result.refusal = chunk.refusal or result.refusal
        result.input_tokens = budget.input_tokens - before_in
        result.output_tokens = budget.output_tokens - before_out
        return result


_image_clients: dict[tuple[str, str], VertexClient] = {}
_image_clients_lock = threading.Lock()


def image_model_id() -> str:
    """Return the one explicitly pinned image model; there is no task router."""

    model = os.environ.get("DECKASTRA_VERTEX_IMAGE_MODEL", "").strip()
    if not model:
        raise ModelUnavailable("Configure DECKASTRA_VERTEX_IMAGE_MODEL before generating images.")
    return model


def configured_image_client(*, emit=None):
    """Build the paid image client locally or through the desktop gateway."""

    if os.environ.get("DECKASTRA_LOCAL_MODE") == "1" and os.environ.get("DECKASTRA_GATEWAY_URL"):
        from .gateway_client import GatewayClient

        return GatewayClient(emit=emit)
    config = configuration()
    model = image_model_id()
    key = (model, json.dumps(config, sort_keys=True))
    with _image_clients_lock:
        client = _image_clients.get(key)
        if client is None:
            client = VertexClient(model, config)
            _image_clients[key] = client
    if emit is not None:
        emit({"provider": "vertex", "task": "image", "model": client.model})
    return client
