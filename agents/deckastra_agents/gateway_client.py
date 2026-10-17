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
        try:
            with httpx.Client(timeout=600 if path == "/video" else 210, trust_env=False) as client:
                reply = client.request("POST" if body is not None else "GET", self.url + path,
                    headers={"Authorization": f"Bearer {self.secret}"}, json=body)
        except httpx.TimeoutException as error:
            raise ModelUnavailable("Deckastra's cloud service did not answer in time. Try again.") from error
        except httpx.HTTPError as error:
            raise ModelUnavailable("The desktop could not reach its cloud bridge. Restart Deckastra and try again.") from error
        if reply.status_code != 200:
            raise ModelUnavailable(error_message(reply))
        try:
            return reply.json()
        except ValueError as error:
            raise ModelUnavailable(
                f"Deckastra's cloud service answered something that is not data{_reference(reply)}."
            ) from error

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

    def voices(self, locale):
        """The account's voices for a language, as the hosted API lists them."""
        return self._call(f"/voices?locale={locale}")["voices"]

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


def _reference(reply) -> str:
    """The id that finds this failure in the cloud logs, when there is one."""
    request_id = reply.headers.get("x-request-id")
    if not request_id:
        try:
            request_id = (reply.json() or {}).get("request_id")
        except (ValueError, AttributeError):
            request_id = None
    return f" (reference {str(request_id)[:40]})" if request_id else ""


def error_message(reply) -> str:
    """What a failed hosted request says, whatever shape its body has.

    The body may be JSON (`{"detail": "..."}`, a detail object with `message`,
    or the hosted classifier's `code`/`hint`), plain text, an HTML error page,
    or nothing. A parse failure must never become the message: that is how
    `JSONDecodeError` reached the person (release 8, 2026-10-17). And only a
    missing or refused sign-in says "sign in": a network failure, a provider
    refusal and a quota are not fixed by signing in again.
    """
    status = reply.status_code
    detail = None
    code = None
    try:
        payload = reply.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        code = payload.get("code")
        detail = payload.get("detail")
        if isinstance(detail, dict):
            code = code or detail.get("code")
            detail = detail.get("message") or detail.get("detail")
        if isinstance(detail, list):  # FastAPI validation errors
            detail = "; ".join(str(item.get("msg", item)) if isinstance(item, dict) else str(item) for item in detail[:3])
    labelled_json = "json" in (reply.headers.get("content-type") or "").lower()
    if not detail and payload is None and not labelled_json:
        text = (reply.text or "").strip()
        if text and not text.startswith("<"):
            detail = text
    if detail:
        message = str(detail)
    elif status == 401 or code == "E_SIGN_IN":
        message = "Sign in to use Deckastra AI credits."
    elif status == 403:
        message = "Your account is not allowed to use this AI service."
    elif status == 429:
        message = "An AI usage limit was reached. Try again later."
    elif status in (502, 503, 504):
        message = f"Deckastra's cloud service could not complete this right now (HTTP {status})."
    else:
        message = f"Deckastra's cloud service failed (HTTP {status})."
    return (message[:480] + _reference(reply))[:540]
