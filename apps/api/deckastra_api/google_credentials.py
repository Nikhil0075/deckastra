"""Credentials for Google translation and voices (plan 01 §3.7, §3.8; plan 04).

Three ways in, chosen by what the operator set, never guessed:

- ``DECKASTRA_GOOGLE_ACCESS_TOKEN`` — a bearer token, used as given. Good for a
  one-off check; it lapses in an hour and nothing here renews it.
- ``DECKASTRA_GOOGLE_CREDENTIALS`` — the path to a credentials file: a
  service-account key, or the ``authorized_user`` file ``gcloud auth
  application-default login`` writes. Tokens are minted from it and renewed
  before they lapse, so a session left open all afternoon keeps voicing.
- ``DECKASTRA_GOOGLE_API_KEY`` — a key (handled by the callers, as a query
  parameter rather than a header).

The machine's *default* credentials (``GOOGLE_APPLICATION_CREDENTIALS`` or
gcloud's own file) are deliberately not consulted. A developer's default login
is usually for some other project, and slide text sent to Google under whatever
account happened to be signed in is a decision nobody made. Naming the file is
the decision.
"""

from __future__ import annotations

import os
import threading
from typing import Any

from deckastra_agents.router import ModelUnavailable

SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]

_lock = threading.Lock()
_cached: dict[str, Any] = {}


def configured() -> str | None:
    """Which way in is configured: "token", "file", "key", or None."""
    if os.environ.get("DECKASTRA_GOOGLE_ACCESS_TOKEN", "").strip():
        return "token"
    if os.environ.get("DECKASTRA_GOOGLE_CREDENTIALS", "").strip():
        return "file"
    if os.environ.get("DECKASTRA_GOOGLE_API_KEY", "").strip():
        return "key"
    return None


def bearer_token() -> str | None:
    """A current bearer token, or None when the operator configured a key or nothing."""
    token = os.environ.get("DECKASTRA_GOOGLE_ACCESS_TOKEN", "").strip()
    if token:
        return token
    path = os.environ.get("DECKASTRA_GOOGLE_CREDENTIALS", "").strip()
    if not path:
        return None
    with _lock:
        credentials = _cached.get(path)
        if credentials is None:
            credentials = _load(path)
            _cached.clear()
            _cached[path] = credentials
        if not credentials.valid:
            _refresh(credentials)
        return credentials.token


def project() -> str:
    """The project Google bills: named explicitly, else the credentials file's own."""
    named = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    if named:
        return named
    path = os.environ.get("DECKASTRA_GOOGLE_CREDENTIALS", "").strip()
    if path:
        with _lock:
            credentials = _cached.get(path)
        quota = getattr(credentials, "quota_project_id", None) if credentials else None
        if quota:
            return str(quota)
    return ""


def reset() -> None:
    """For tests: forget any loaded credentials."""
    with _lock:
        _cached.clear()


def _load(path: str) -> Any:
    try:
        import google.auth
    except ImportError as error:  # pragma: no cover - depends on the build
        raise ModelUnavailable(
            "DECKASTRA_GOOGLE_CREDENTIALS is set, and this build cannot read a credentials file. "
            "Use DECKASTRA_GOOGLE_ACCESS_TOKEN or DECKASTRA_GOOGLE_API_KEY. Nothing was sent."
        ) from error
    if not os.path.isfile(path):
        raise ModelUnavailable(f"DECKASTRA_GOOGLE_CREDENTIALS names {path!r}, which is not a file. Nothing was sent.")
    try:
        credentials, _project = google.auth.load_credentials_from_file(path, scopes=SCOPES)
    except Exception as error:  # google.auth raises its own family; all mean the same here
        raise ModelUnavailable(f"The Google credentials file could not be read: {error}. Nothing was sent.") from error
    return credentials


def _refresh(credentials: Any) -> None:
    from google.auth.transport.requests import Request

    try:
        credentials.refresh(Request())
    except Exception as error:
        # An expired or revoked sign-in reads like this; saying so is the fix,
        # because retrying a dead refresh token never works.
        raise ModelUnavailable(
            f"Google refused the saved sign-in ({error}). Sign in again with "
            "scripts/setup-google-cloud.ps1. Nothing was sent."
        ) from error
