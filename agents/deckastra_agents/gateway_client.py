"""Desktop inference through its private main-process account proxy."""
import os
from dataclasses import asdict
from urllib.parse import urlparse
import httpx
from .router import ModelError, ModelRequest, ModelResponse, ModelUnavailable


class GatewayClient:
    supports_escalation = False

    def __init__(self, *, emit=None):
        self.url = os.environ["DECKASTRA_GATEWAY_URL"].rstrip("/")
        self.secret = os.environ.get("DECKASTRA_GATEWAY_SECRET", "")
        parsed = urlparse(self.url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or len(self.secret) < 32:
            raise ModelUnavailable("The private desktop account bridge is not configured.")
        self.emit = emit or (lambda _: None)
        self._image_capability = None
        self._video_capability = None

    def _call(self, path, body=None):
        with httpx.Client(timeout=600 if path == "/video" else 210, trust_env=False) as client:
            reply = client.request("POST" if body is not None else "GET", self.url + path,
                headers={"Authorization": f"Bearer {self.secret}"}, json=body)
        if reply.status_code in (401, 403):
            raise ModelUnavailable("Sign in to use Deckastra AI credits.")
        if reply.status_code != 200:
            detail = reply.json().get("detail", "The hosted AI task is unavailable.")
            raise ModelUnavailable(str(detail)[:500])
        return reply.json()

    def credits(self):
        """The signed-in account's balance, from the hosted ledger.

        The desktop's own database has a credits table too, and it describes
        nothing: the account whose credits pay for AI lives in the cloud.
        """
        return self._call("/credits")

    def service_quote(self, task, *, units=0, prompt=""):
        """Current hosted price for an exact paid service input."""
        return self._call("/quote", {"task": task, "units": units, "prompt": prompt})

    def translate(self, items, *, source, target):
        value = self._call("/translate", {"items": [{"id": item.id, "text": item.text} for item in items],
            "source": source, "target": target})
        return value["translations"]

    def synthesize(self, text, *, locale, voice, rate, pronunciations):
        value = self._call("/speech", {"text": text, "locale": locale, "voice": voice, "rate": rate,
            "pronunciations": [{"term": item.term, "say": item.say} for item in pronunciations]})
        return value["audio"]

    def image_capability(self):
        if self._image_capability is None:
            self._image_capability = self._call("/capabilities").get("tasks", {}).get("image", {})
        capability = self._image_capability
        if not capability.get("available"):
            raise ModelUnavailable(capability.get("reason") or "Image generation is not configured.")
        return capability

    def video_capability(self):
        if self._video_capability is None:
            self._video_capability = self._call("/capabilities").get("tasks", {}).get("video", {})
        capability = self._video_capability
        if not capability.get("available"):
            raise ModelUnavailable(capability.get("reason") or "Video generation is not configured.")
        return capability

    def video_quote(self, duration_seconds):
        capability = self.video_capability()
        rate = float(capability.get("usd_per_second") or 0)
        return {"model": capability.get("model"), "duration_seconds": duration_seconds,
                "usd": rate * duration_seconds, "credits": rate * duration_seconds * 200}

    def generate(self, prompt, *, duration_seconds, aspect_ratio, budget):
        from .video_model import VideoResult
        budget.check_clock()
        value = self._call("/video", {"prompt": prompt, "duration_seconds": duration_seconds,
            "aspect_ratio": aspect_ratio, "generate_audio": False})
        result = value["video"]
        budget.used_cost_usd += value.get("usage", {}).get("used_cost_usd", 0)
        self.emit({"provider": "vertex", "task": "video", "model": result["model"]})
        import base64
        return VideoResult(data=base64.b64decode(result["data"], validate=True),
            content_type=result["content_type"], duration_ms=result["duration_ms"],
            width=result["width"], height=result["height"], model=result["model"])

    @property
    def model(self):
        return self.image_capability().get("model") or "vertex-image"

    def estimate_reservation(self, _request):
        return self.image_capability().get("minimum_reservation_usd") or 0

    def complete(self, request, budget):
        budget.check_clock()
        if not request.image_output:
            raise ModelUnavailable("The account gateway accepts image generation only.")
        body = {"task": "image", "system": "\n\n".join([request.system, *request.context]),
            "messages": request.messages, "images": [asdict(i) for i in request.images],
            "max_tokens": request.max_tokens, "image_output": True}
        value = self._call("/infer", body)
        answer = dict(value["response"])
        response = ModelResponse(**answer)
        budget.spend_tokens(response.input_tokens, response.output_tokens)
        budget.used_cost_usd += value.get("usage", {}).get("used_cost_usd", 0)
        self.emit({"provider": "vertex", "task": "image", "model": response.model})
        return response

    def stream(self, request, budget):
        yield self.complete(request, budget)
