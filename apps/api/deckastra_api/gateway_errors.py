"""What a paid service failure says when it reaches a person (release 8, 2026-10-17).

The hosted routes call Google Translation, Text-to-Speech and Vertex. A
provider failure used to escape as an unhandled exception, which Starlette
answers with a plain-text 500; the desktop bridge then labelled that body JSON
and the local client failed parsing it, so the person saw `JSONDecodeError`
where the actual cause (an API not enabled, a missing role, a quota, a model
name) should have been.

Every failure on these routes now answers JSON with a stable `code`, the
provider's own reason, an actionable `hint` where the reason is recognised,
and a `request_id` that also travels as `X-Request-ID`, so a report from a
desktop can be found in the cloud logs. Nothing about the person's content is
included: provider messages are about configuration, not about the text sent.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

logger = logging.getLogger("deckastra.gateway")

_MESSAGE_LIMIT = 600


@dataclass(frozen=True)
class Classified:
    status: int
    code: str
    message: str
    hint: str | None

    def body(self, request_id: str) -> dict[str, object]:
        return {
            "detail": self.message if not self.hint else f"{self.message} {self.hint}",
            "code": self.code,
            "message": self.message,
            "hint": self.hint,
            "request_id": request_id,
        }


def _hint(text: str) -> str | None:
    """The fix a recognised Google answer points at."""
    lowered = text.lower()
    if "has not been used" in lowered or "is disabled" in lowered or "service_disabled" in lowered or "api has not been" in lowered:
        return ("The Google API this needs is switched off for the cloud project. The monthly budget stop "
                "switches off Vertex AI, Translation and Text-to-Speech once the project's spend passes its budget; "
                "they come back when an administrator turns them on again or the next month starts.")
    if "permission_denied" in lowered or "permission denied" in lowered or " 403" in f" {lowered}" or ("iam" in lowered and "denied" in lowered):
        return "The cloud service account lacks the role this needs."
    if "unauthenticated" in lowered or " 401" in f" {lowered}" or "invalid_grant" in lowered:
        return "The cloud service's Google credentials were refused."
    if "resource_exhausted" in lowered or "quota" in lowered or " 429" in f" {lowered}":
        return "A Google quota or rate limit was reached; try again later."
    if "not_found" in lowered or " 404" in f" {lowered}" or "was not found" in lowered:
        return "The configured model, voice or region was not found."
    if "deadline" in lowered or "timed out" in lowered or "timeout" in lowered:
        return "Google did not answer in time; try again."
    return None


def classify(error: BaseException) -> Classified:
    """One failure, in the words a person can act on."""
    from deckastra_agents.budgets import BudgetExceeded
    from deckastra_agents.router import ModelError, ModelUnavailable

    from .speech import SpeechError
    from .translation import TranslationError

    text = (str(error) or type(error).__name__)[:_MESSAGE_LIMIT]
    if isinstance(error, BudgetExceeded):
        return Classified(429, "E_BUDGET", text, None)
    if isinstance(error, ModelUnavailable):
        return Classified(503, "E_PROVIDER_UNCONFIGURED", text, _hint(text))
    if isinstance(error, (TranslationError, SpeechError, ModelError)):
        return Classified(502, "E_PROVIDER_FAILED", text, _hint(text))
    try:
        import httpx

        if isinstance(error, httpx.TimeoutException):
            return Classified(504, "E_PROVIDER_TIMEOUT", "Google did not answer in time.", "Try again.")
        if isinstance(error, httpx.HTTPError):
            return Classified(502, "E_PROVIDER_NETWORK", f"The cloud service could not reach Google: {type(error).__name__}.", None)
    except ImportError:  # pragma: no cover - httpx is a dependency
        pass
    return Classified(500, "E_PROVIDER_INTERNAL", f"The cloud service failed unexpectedly ({type(error).__name__}).", None)


def new_request_id() -> str:
    return uuid.uuid4().hex


def log(request_id: str, error: BaseException, classified: Classified) -> None:
    """Logged with the id the person sees; the type and code, not the content."""
    logger.warning(
        "gateway failure request_id=%s code=%s status=%s type=%s",
        request_id, classified.code, classified.status, type(error).__name__,
        exc_info=classified.code == "E_PROVIDER_INTERNAL",
    )
