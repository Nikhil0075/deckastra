"""Running the workspace authority as one person's local service (milestone D1).

The desktop app needs everything this API already does — documents, versions,
transactions, agents, assets, themes — and none of what it does for a *tenant*:
no sign-in, no invitations, no share links, no metering. The temptation is a
second, smaller server. That would be a second implementation of the store, and
the whole reason the store is worth trusting is that there is one of it.

So local mode is a *posture*, not a fork. The same routes, the same
`resolve_*` chain, the same roles — but the caller is a singleton account seeded
at first launch, and it authenticates with a secret that exists only for as long
as this process does.

Three things this module is careful about:

- **It cannot be turned on in production.** `DECKASTRA_ENV=production` and local
  mode together would mean an OIDC-less server that trusts one shared secret, and
  it is the kind of misconfiguration that fails open rather than loudly.
- **The secret is required, not defaulted.** A default would ship, and a default
  bearer token on a loopback port is a local privilege-escalation primitive for
  anything else running on the machine.
- **The account is seeded through `provision_personal_account`,** the same
  function real sign-in uses. A hand-built user with a hand-built membership is a
  second description of what an account is, and it would drift.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

from sqlalchemy.orm import Session

from .db.models import Project, User, Workspace

#: The address of the one account this process serves. Not a real mailbox, and
#: shaped so it can never collide with one someone signs in with.
LOCAL_EMAIL = "local@deckastra.invalid"

#: The plan a local install runs on. `unlimited` already exists for self-hosting;
#: metering a single machine's own decks would be a limit with nobody to enforce
#: it for.
LOCAL_PLAN = "unlimited"


class LocalModeMisconfigured(RuntimeError):
    """Local mode was asked for in a way that cannot be honoured safely."""


def enabled() -> bool:
    if os.environ.get("DECKASTRA_LOCAL_MODE") != "1":
        return False
    if os.environ.get("DECKASTRA_ENV", "development").lower() == "production":
        # Fail loudly rather than quietly downgrading to the multi-tenant path.
        # An operator who set both meant one of them, and guessing which is how a
        # server ends up trusting a shared secret in front of real customers.
        raise LocalModeMisconfigured(
            "DECKASTRA_LOCAL_MODE cannot be combined with DECKASTRA_ENV=production."
        )
    return True


def launch_secret() -> str:
    """The bearer this process accepts, minted by whatever started it.

    Deliberately not generated here and deliberately not defaulted. The supervisor
    knows the secret because it created it; nothing else on the machine does, and
    nothing that reads only this file can guess one.
    """
    secret = os.environ.get("DECKASTRA_LOCAL_SECRET", "")
    if len(secret) < 32:
        raise LocalModeMisconfigured(
            "DECKASTRA_LOCAL_SECRET must be set to at least 32 characters in local mode."
        )
    return secret


#: What a credential may do. Coarse on purpose: a capability nobody can explain
#: in a sentence is one nobody can decide about, and this list is read by a person
#: deciding what to hand an agent.
SCOPES = ("read", "write", "export", "approve", "share")

#: The app's own secret carries everything. A *grant* carries a subset.
FULL_SCOPES = frozenset(SCOPES)

#: `dk1` so a future format can be told apart rather than guessed at.
GRANT_PREFIX = "dk1"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def mint_grant(scopes: "frozenset[str] | set[str] | tuple[str, ...]", ttl_seconds: int) -> str:
    """A credential that can do less than the launch secret can.

    Signed with the launch secret rather than stored, so there is no table to keep
    and no row to get out of step with what the process will accept — and it dies
    with the process that minted it, because the key does.

    The point is that "the MCP server cannot approve its own proposals" stops
    being a property of the tools that adapter happens to register and becomes a
    property of the credential it holds. An adapter's omissions are a choice; this
    is a refusal.
    """
    unknown = sorted(set(scopes) - FULL_SCOPES)
    if unknown:
        raise LocalModeMisconfigured(f"Unknown scopes: {', '.join(unknown)}.")
    payload = _b64(
        json.dumps(
            {"s": sorted(set(scopes)), "exp": int(time.time()) + int(ttl_seconds)},
            separators=(",", ":"),
        ).encode("utf-8")
    )
    signature = _b64(
        hmac.new(launch_secret().encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest()
    )
    return f"{GRANT_PREFIX}.{payload}.{signature}"


def scopes_for(token: str) -> "frozenset[str] | None":
    """What this token may do, or None when it is not one of ours.

    The launch secret is the app itself and carries everything. Anything else has
    to be a grant this process signed, unexpired, and it carries exactly what it
    says.
    """
    if hmac.compare_digest(token, launch_secret()):
        return FULL_SCOPES

    parts = token.split(".")
    if len(parts) != 3 or parts[0] != GRANT_PREFIX:
        return None
    _, payload, signature = parts

    expected = _b64(
        hmac.new(launch_secret().encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(signature, expected):
        return None

    try:
        claims = json.loads(_unb64(payload))
        granted = frozenset(str(scope) for scope in claims["s"])
        expires = int(claims["exp"])
    except (ValueError, KeyError, TypeError):
        return None

    if expires <= time.time():
        return None
    # A grant cannot widen itself by naming a scope this build does not have.
    return granted & FULL_SCOPES


def authenticates(token: str) -> bool:
    """Constant-time comparison against the launch secret.

    `==` on a secret leaks its prefix through timing. That matters less on a
    loopback socket than over a network, but "less" is not "not", and the correct
    comparison is one line.
    """
    return hmac.compare_digest(token, launch_secret())


def bootstrap(session: Session) -> tuple[User, Workspace, Project]:
    """Seed — or find — the singleton account.

    Idempotent, because it runs on every launch. `provision_personal_account`
    already returns the existing user's workspace and project when the account is
    there, which is exactly the second-launch behaviour wanted here.
    """
    from .auth import provision_personal_account  # local: avoids an import cycle
    from . import quotas

    user, workspace, project = provision_personal_account(
        session, email=LOCAL_EMAIL, name="You"
    )
    quotas.ensure(session, workspace.id, plan=LOCAL_PLAN)
    return user, workspace, project
