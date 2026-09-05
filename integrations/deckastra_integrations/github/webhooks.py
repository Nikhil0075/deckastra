"""Webhooks: signature verification and event parsing (gap register doc 05 S2).

Without webhooks an index is a photograph. Someone connects a repository, a deck
is generated from it, and six weeks later the deck still cites a file that was
deleted — with no indication that anything has moved. Doc 05 §19 sketched the
install flow and stopped there; staleness is the half that makes the integration
honest.

The verification is the security boundary and is written to be boring:

- **HMAC-SHA256 over the raw body**, compared with `hmac.compare_digest`. A `==`
  comparison leaks timing, and a timing oracle on a signature is a forgery.
- **The raw bytes**, not a re-serialised payload. Re-encoding JSON changes the
  bytes and the signature stops matching for reasons nobody can debug.
- **No secret configured means reject**, never "allow". A deployment that forgot
  the secret should fail closed.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass, field
from typing import Any, Literal

EventKind = Literal[
    "push",
    "installation_created",
    "installation_deleted",
    "installation_repositories",
    "repository_deleted",
    "repository_renamed",
    "ping",
    "unhandled",
]


class WebhookRejected(RuntimeError):
    """The delivery was not accepted. The message is for logs, never for the sender."""


def verify_signature(body: bytes, signature_header: str | None, secret: str) -> None:
    """Check `X-Hub-Signature-256`.

    Raises rather than returning False so a caller cannot forget to check the
    result — the most common way signature verification stops working.
    """
    if not secret:
        raise WebhookRejected("No webhook secret is configured; deliveries are rejected.")

    if not signature_header or not signature_header.startswith("sha256="):
        raise WebhookRejected("Missing or malformed signature header.")

    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, signature_header):
        raise WebhookRejected("Signature does not match.")


@dataclass(frozen=True)
class WebhookEvent:
    kind: EventKind
    installation_id: str | None = None
    #: "owner/name" for every repository the event concerns.
    repositories: list[str] = field(default_factory=list)
    #: Paths touched by a push, when GitHub included them.
    changed_paths: list[str] = field(default_factory=list)
    after_sha: str | None = None
    ref: str | None = None
    #: The event as delivered, for the ones this build does not act on yet.
    raw_event: str = ""


def parse_event(event_name: str, payload: dict[str, Any]) -> WebhookEvent:
    """Turn a delivery into the few facts the indexer acts on.

    Anything unrecognised becomes `unhandled` rather than an error: GitHub adds
    event types, and a 500 on an event we chose not to subscribe to would show up
    as a red delivery history for no reason.
    """
    installation = str((payload.get("installation") or {}).get("id") or "") or None
    action = payload.get("action", "")

    if event_name == "ping":
        return WebhookEvent(kind="ping", installation_id=installation, raw_event=event_name)

    if event_name == "push":
        repository = payload.get("repository") or {}
        # `commits` carries paths only for pushes under a size GitHub decides. A
        # missing list means "re-index everything", not "nothing changed".
        changed: list[str] = []
        for commit in payload.get("commits") or []:
            changed.extend(commit.get("added") or [])
            changed.extend(commit.get("modified") or [])
            changed.extend(commit.get("removed") or [])

        return WebhookEvent(
            kind="push",
            installation_id=installation,
            repositories=[repository.get("full_name", "")] if repository.get("full_name") else [],
            changed_paths=sorted(set(changed)),
            after_sha=payload.get("after"),
            ref=payload.get("ref"),
            raw_event=event_name,
        )

    if event_name == "installation":
        if action in {"deleted", "suspend"}:
            return WebhookEvent(
                kind="installation_deleted", installation_id=installation, raw_event=event_name
            )
        if action in {"created", "unsuspend", "new_permissions_accepted"}:
            return WebhookEvent(
                kind="installation_created",
                installation_id=installation,
                repositories=[
                    repository.get("full_name", "")
                    for repository in payload.get("repositories") or []
                ],
                raw_event=event_name,
            )

    if event_name == "installation_repositories":
        # Both directions in one event. The removed list is the one that matters:
        # access was withdrawn, and anything indexed from those repositories has
        # to go.
        return WebhookEvent(
            kind="installation_repositories",
            installation_id=installation,
            repositories=[
                repository.get("full_name", "")
                for repository in payload.get("repositories_added") or []
            ],
            changed_paths=[
                repository.get("full_name", "")
                for repository in payload.get("repositories_removed") or []
            ],
            raw_event=event_name,
        )

    if event_name == "repository":
        repository = payload.get("repository") or {}
        if action == "deleted":
            return WebhookEvent(
                kind="repository_deleted",
                installation_id=installation,
                repositories=[repository.get("full_name", "")],
                raw_event=event_name,
            )
        if action == "renamed":
            return WebhookEvent(
                kind="repository_renamed",
                installation_id=installation,
                repositories=[repository.get("full_name", "")],
                changed_paths=[(payload.get("changes") or {}).get("repository", {}).get("name", {}).get("from", "")],
                raw_event=event_name,
            )

    return WebhookEvent(kind="unhandled", installation_id=installation, raw_event=event_name)


def decode(body: bytes) -> dict[str, Any]:
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WebhookRejected("Body is not valid JSON.") from error
