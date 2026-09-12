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

import hmac
import os

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
