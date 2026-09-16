"""Authentication and the authorization chain (doc 05 §26, §27).

Every server operation resolves the same chain:

    User -> Workspace -> Project -> Presentation / Source / Asset

Production identity is accepted through a strict OIDC bearer-token boundary and
mapped by immutable issuer/subject. Local development retains a signed dev token,
but that token path is disabled categorically in production.

What is NOT thin, because it would be expensive to retrofit:

* Authorization is by **membership and role**, never by `owner_id`. Doc 05 §21
  gave `workspaces` an owner and nothing else, which is why the chain could not be
  resolved for anyone but the owner. `workspace_members` closes that (gap S1), and
  every check here asks "is this user's role at least X".
* A missing resource and a forbidden one both answer 404 to the caller. A 403 on
  a resource you cannot see tells you it exists, which is an enumeration oracle.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import IntEnum
from functools import lru_cache
from typing import Any

import jwt
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import local_mode
from .db.models import AuthIdentity, Presentation, Project, User, Workspace, WorkspaceMember
from .db.session import get_session
from .ids import new_id


class Role(IntEnum):
    """Ordered, so a check is a comparison rather than a set membership test."""

    VIEWER = 10
    EDITOR = 20
    ADMIN = 30
    OWNER = 40


ROLE_NAMES = {
    "viewer": Role.VIEWER,
    "editor": Role.EDITOR,
    "admin": Role.ADMIN,
    "owner": Role.OWNER,
}


def parse_role(name: str) -> Role:
    try:
        return ROLE_NAMES[name]
    except KeyError:
        raise ValueError(f"Unknown role {name!r}") from None


@dataclass(frozen=True)
class Principal:
    user_id: str
    email: str
    #: What this *credential* may do, which is not always what its owner may do.
    #: Everything, unless a local-mode grant narrowed it — so no existing path
    #: changes and a bridge credential cannot exceed what it was handed.
    scopes: frozenset[str] = local_mode.FULL_SCOPES


@dataclass(frozen=True)
class ExternalClaims:
    issuer: str
    subject: str
    email: str
    name: str | None
    provider: str | None


def _dev_secret() -> str:
    return os.environ.get("DECKASTRA_DEV_SECRET", "deckastra-dev-secret")


def issue_dev_token(user_id: str) -> str:
    """A signed development token.

    Signed rather than a bare user id so that a token cannot be forged by typing
    someone else's id into a header — the property real sessions have, obtained
    for four lines. Not a substitute for real sign-in, which is Phase 9.
    """
    signature = hmac.new(_dev_secret().encode(), user_id.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{user_id}.{signature}"


def verify_dev_token(token: str) -> str | None:
    user_id, _, signature = token.partition(".")
    if not user_id or not signature:
        return None
    expected = hmac.new(_dev_secret().encode(), user_id.encode(), hashlib.sha256).hexdigest()[:32]
    # Constant time: a token check that leaks timing is a token check that leaks.
    return user_id if hmac.compare_digest(expected, signature) else None


def _is_production() -> bool:
    return os.environ.get("DECKASTRA_ENV", "development").lower() == "production"


def _oidc_issuer() -> str | None:
    value = os.environ.get("DECKASTRA_OIDC_ISSUER", "").strip()
    return value.rstrip("/") or None


@lru_cache(maxsize=8)
def _jwks_client(url: str) -> jwt.PyJWKClient:
    # Keys are cached by PyJWT and refreshed when a token names an unknown key.
    # A short timeout makes identity-provider trouble a bounded authentication
    # failure rather than a request thread held indefinitely.
    return jwt.PyJWKClient(url, cache_keys=True, timeout=5)


def _decode_oidc_token(token: str) -> ExternalClaims:
    """Verify a standards-based ID/access token and return the identity claims.

    The web provider is replaceable (Clerk, Auth0, or another OIDC service). The
    API trusts only an exact issuer, audience, RSA signature and verified email.
    A custom provider token must therefore expose `email` and `email_verified`.
    """
    issuer = _oidc_issuer()
    audience = os.environ.get("DECKASTRA_OIDC_AUDIENCE", "").strip()
    if not issuer or not audience:
        raise ValueError("External authentication is not configured.")

    algorithms = ["RS256"]
    public_key = os.environ.get("DECKASTRA_OIDC_PUBLIC_KEY", "").strip()
    if public_key:
        signing_key: Any = public_key.replace("\\n", "\n")
    else:
        jwks_url = os.environ.get(
            "DECKASTRA_OIDC_JWKS_URL", f"{issuer}/.well-known/jwks.json"
        ).strip()
        signing_key = _jwks_client(jwks_url).get_signing_key_from_jwt(token).key

    payload = jwt.decode(
        token,
        signing_key,
        algorithms=algorithms,
        issuer=issuer,
        audience=audience,
        leeway=30,
        options={"require": ["exp", "iat", "iss", "sub", "aud"]},
    )

    authorized = {
        item.strip()
        for item in os.environ.get("DECKASTRA_OIDC_AUTHORIZED_PARTIES", "").split(",")
        if item.strip()
    }
    if authorized and payload.get("azp") not in authorized:
        raise jwt.InvalidTokenError("The token was issued to an untrusted application.")

    subject = payload.get("sub")
    email = payload.get("email")
    if not isinstance(subject, str) or not subject:
        raise jwt.InvalidTokenError("The token has no subject.")
    if not isinstance(email, str) or not email or payload.get("email_verified") is not True:
        raise jwt.InvalidTokenError("A verified email claim is required.")

    name = payload.get("name")
    provider = payload.get("idp") or payload.get("provider")
    return ExternalClaims(
        issuer=issuer,
        subject=subject,
        email=email.strip().casefold(),
        name=name.strip()[:200] if isinstance(name, str) and name.strip() else None,
        provider=str(provider)[:64] if provider else None,
    )


def provision_personal_account(
    session: Session, *, email: str, name: str | None = None
) -> tuple[User, Workspace, Project]:
    """Create the personal workspace/project journey once for a new identity."""
    normalized = email.strip().casefold()
    user = session.scalar(select(User).where(User.email == normalized))
    if user is None:
        display_name = (name or normalized.split("@", 1)[0]).strip()[:200]
        user = User(id=new_id("usr"), email=normalized, name=display_name)
        session.add(user)

        workspace = Workspace(
            id=new_id("wsp"), name=f"{display_name}'s workspace", owner_id=user.id
        )
        session.add(workspace)
        session.add(
            WorkspaceMember(
                id=new_id("mbr"),
                workspace_id=workspace.id,
                user_id=user.id,
                role="owner",
            )
        )
        project = Project(
            id=new_id("prj"),
            workspace_id=workspace.id,
            name="My first project",
            created_by=user.id,
        )
        session.add(project)
        session.flush()
        return user, workspace, project

    membership = session.scalar(
        select(WorkspaceMember)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(WorkspaceMember.workspace_id)
        .limit(1)
    )
    if membership is None:
        # Imported users from an earlier identity system may not have completed
        # onboarding. Finish it without creating a second User row.
        display_name = (user.name or normalized.split("@", 1)[0]).strip()[:200]
        workspace = Workspace(
            id=new_id("wsp"), name=f"{display_name}'s workspace", owner_id=user.id
        )
        session.add(workspace)
        session.add(
            WorkspaceMember(
                id=new_id("mbr"), workspace_id=workspace.id, user_id=user.id, role="owner"
            )
        )
        project = Project(
            id=new_id("prj"), workspace_id=workspace.id, name="My first project", created_by=user.id
        )
        session.add(project)
        session.flush()
        return user, workspace, project

    workspace = session.get(Workspace, membership.workspace_id)
    assert workspace is not None
    project = session.scalar(
        select(Project)
        .where(Project.workspace_id == workspace.id)
        .order_by(Project.id)
        .limit(1)
    )
    if project is None:
        project = Project(
            id=new_id("prj"), workspace_id=workspace.id, name="My first project", created_by=user.id
        )
        session.add(project)
        session.flush()
    return user, workspace, project


def _principal_from_oidc(session: Session, token: str) -> Principal:
    claims = _decode_oidc_token(token)
    identity = session.scalar(
        select(AuthIdentity).where(
            AuthIdentity.issuer == claims.issuer,
            AuthIdentity.subject == claims.subject,
        )
    )
    if identity is not None:
        user = session.get(User, identity.user_id)
        if user is None:
            raise jwt.InvalidTokenError("The linked account no longer exists.")
        return Principal(user_id=user.id, email=user.email)

    # Linking by email is allowed only because `_decode_oidc_token` requires the
    # provider's verified-email assertion. Later sign-ins use issuer+subject and
    # are unaffected if the user changes their email with the provider.
    user, _, _ = provision_personal_account(
        session, email=claims.email, name=claims.name
    )
    session.add(
        AuthIdentity(
            id=new_id("aid"),
            user_id=user.id,
            issuer=claims.issuer,
            subject=claims.subject,
            provider=claims.provider,
            email_at_link=claims.email,
        )
    )
    session.flush()
    return Principal(user_id=user.id, email=user.email)


def current_principal(
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> Principal:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = authorization[7:].strip()

    # Local mode: one account, one secret, for as long as this process lives.
    #
    # Placed before every other path and returning unconditionally, so a local
    # process cannot also be talked to with a dev token or an OIDC assertion —
    # two ways in is one more than a single-user service should have. The account
    # is a real `User` with a real `WorkspaceMember`, so every `resolve_*` check
    # below runs exactly as it does for a tenant; nothing is bypassed, the answer
    # is simply always the same person.
    if local_mode.enabled():
        granted = local_mode.scopes_for(token)
        if granted is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        user, _, _ = local_mode.bootstrap(session)
        # Same account, same membership, same `resolve_*` checks. The scopes are a
        # second, narrower gate on top — a credential the app handed out cannot do
        # everything its owner can.
        return Principal(user_id=user.id, email=user.email, scopes=granted)

    # Development tokens never cross the production boundary, even if someone
    # accidentally deploys the default development secret.
    if not _is_production():
        user_id = verify_dev_token(token)
        if user_id is not None:
            user = session.get(User, user_id)
            if user is None:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user."
                )
            return Principal(user_id=user.id, email=user.email)

    try:
        return _principal_from_oidc(session, token)
    except (jwt.PyJWTError, ValueError, OSError):
        # Do not expose whether the failure was configuration, key retrieval,
        # issuer, audience, expiry or account lookup. That information belongs in
        # operator logs; to an untrusted caller it is an oracle.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None


class Forbidden(HTTPException):
    def __init__(self, detail: str = "Not found.") -> None:
        # 404, not 403. A 403 on a resource you cannot see confirms it exists,
        # which turns the API into an enumeration oracle.
        super().__init__(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


#: How long a mirrored membership keeps working without hearing from the server
#: (D5.4), and how long before it stops working at all.
#:
#: Two numbers rather than one, because the alternatives are both bad. Expiring
#: at the first missed confirmation makes a local-first product useless on a
#: plane; never expiring makes "a cache is not authorization" a sentence rather
#: than a rule. So a stale cache keeps working and **says** it is stale, and a
#: lapsed one stops — thirty days being long enough that nobody loses a holiday's
#: work to it and short enough that a removed colleague does not keep a copy of
#: the workspace alive indefinitely.
MEMBERSHIP_STALE_DAYS = 7
MEMBERSHIP_LAPSE_DAYS = 30


@dataclass(frozen=True)
class MembershipStatus:
    """Whether this row may decide anything, and why (D5.4).

    The reason travels with the answer because the two refusals are not the same
    to the person on the other end: "we have not been able to confirm your access
    for a month" is something they can act on by reconnecting, and "your access
    was removed" is not.
    """

    #: `authoritative` — a `local` workspace: this row *is* the decision (D5.1).
    #: `confirmed` — a mirror, vouched for recently.
    #: `stale` — a mirror, not heard from lately. Still authorizes, and says so.
    #: `lapsed` — a mirror, never confirmed or confirmed too long ago.
    #: `revoked` — the authority said the membership is gone.
    #: `none` — there is no membership.
    state: str
    #: What this membership grants, or None when it grants nothing. A caller that
    #: only reads `role` therefore cannot accidentally honour a lapsed cache.
    role: Role | None
    confirmed_at: datetime | None = None

    @property
    def authorizes(self) -> bool:
        return self.role is not None


def membership_status(
    session: Session, user_id: str, workspace_id: str, *, now: datetime | None = None
) -> MembershipStatus:
    """The one place a `workspace_members` row becomes an authorization decision.

    Every `resolve_*` funnels here, and that is the whole design rather than an
    implementation detail. Once a device mirrors a workspace, some rows in this
    table are copies of decisions made somewhere else — and a copy of a decision
    is not the decision. A route that read the table itself would authorize a
    cached role as readily as a real one, which is exactly how a colleague removed
    upstream keeps working locally for as long as the laptop stays shut.

    The local singleton account needs no special case here, which is the part
    worth noticing: nothing can confirm a membership for an identity this machine
    invented, so a row someone inserted for it in a mirrored workspace carries no
    confirmation and grants nothing.
    """
    membership = session.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user_id,
        )
    )
    if membership is None:
        return MembershipStatus(state="none", role=None)

    role = parse_role(membership.role)
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        return MembershipStatus(state="none", role=None)

    if workspace.origin != "cloud":
        # This machine owns the workspace outright. The row is the authority, so
        # there is nothing to confirm it against and nothing that could go stale.
        return MembershipStatus(state="authoritative", role=role)

    if membership.revoked_at is not None:
        # Known and immediate. A revocation still honoured for a fortnight while
        # a window runs down is not a revocation.
        return MembershipStatus(state="revoked", role=None)

    confirmed = membership.confirmed_at
    if confirmed is None:
        return MembershipStatus(state="lapsed", role=None)
    if confirmed.tzinfo is None:
        confirmed = confirmed.replace(tzinfo=timezone.utc)

    age = (now or datetime.now(timezone.utc)) - confirmed
    if age > timedelta(days=MEMBERSHIP_LAPSE_DAYS):
        return MembershipStatus(state="lapsed", role=None, confirmed_at=confirmed)
    if age > timedelta(days=MEMBERSHIP_STALE_DAYS):
        return MembershipStatus(state="stale", role=role, confirmed_at=confirmed)
    return MembershipStatus(state="confirmed", role=role, confirmed_at=confirmed)


def role_in_workspace(session: Session, user_id: str, workspace_id: str) -> Role | None:
    return membership_status(session, user_id, workspace_id).role


def confirm_membership(
    session: Session, *, user_id: str, workspace_id: str, role: str
) -> WorkspaceMember:
    """The authority vouched for this membership; record it (D5.4).

    The **only** thing that sets `confirmed_at`, deliberately. A second writer
    would be a second way for a cache to start authorizing, and the value of the
    rule is that there is exactly one.

    It also carries the role, because a mirror that refreshed freshness without
    refreshing the role would keep honouring an editor who has since been demoted
    to viewer — a subtler version of the same bug.
    """
    membership = session.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user_id,
        )
    )
    if membership is None:
        membership = WorkspaceMember(
            id=new_id("mbr"), workspace_id=workspace_id, user_id=user_id, role=role
        )
        session.add(membership)

    membership.role = role
    membership.confirmed_at = datetime.now(timezone.utc)
    # A membership that was revoked and has been granted again is an ordinary
    # membership; leaving the mark would refuse it forever.
    membership.revoked_at = None
    session.flush()
    return membership


def revoke_cached_membership(
    session: Session, *, user_id: str, workspace_id: str
) -> bool:
    """The authority says this membership is gone. Stop honouring it now.

    The row is kept rather than deleted, for the reason a revoked share link is
    kept: "who could see this, and when did that stop" is the question asked
    afterwards.

    What this does **not** do is delete the decks. Bytes already on a device are
    already on the device, and quietly destroying a person's local copy of work
    they may have authored is a bigger decision than this function should make on
    its own.
    """
    membership = session.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user_id,
        )
    )
    if membership is None:
        return False

    membership.revoked_at = datetime.now(timezone.utc)
    membership.confirmed_at = None
    session.flush()
    return True


@dataclass(frozen=True)
class PresentationAccess:
    presentation: Presentation
    project: Project
    workspace_id: str
    role: Role

    @property
    def can_edit(self) -> bool:
        return self.role >= Role.EDITOR


def resolve_presentation_access(
    session: Session,
    *,
    user_id: str,
    presentation_id: str,
    require: Role = Role.VIEWER,
) -> PresentationAccess:
    """Walk the whole chain in one place.

    Doing this per-endpoint is how one endpoint ends up skipping a link. Every
    route that touches a presentation calls this.
    """
    presentation = session.get(Presentation, presentation_id)
    if presentation is None:
        raise Forbidden()

    project = session.get(Project, presentation.project_id)
    if project is None:
        raise Forbidden()

    role = role_in_workspace(session, user_id, project.workspace_id)
    if role is None or role < require:
        raise Forbidden()

    return PresentationAccess(
        presentation=presentation,
        project=project,
        workspace_id=project.workspace_id,
        role=role,
    )


def resolve_project_access(
    session: Session, *, user_id: str, project_id: str, require: Role = Role.VIEWER
) -> tuple[Project, Role]:
    project = session.get(Project, project_id)
    if project is None:
        raise Forbidden()

    role = role_in_workspace(session, user_id, project.workspace_id)
    if role is None or role < require:
        raise Forbidden()

    return project, role


@dataclass(frozen=True)
class WorkspaceAccess:
    workspace_id: str
    role: Role


def resolve_workspace_access(
    session: Session, *, user_id: str, require: Role = Role.VIEWER
) -> WorkspaceAccess:
    """The user's workspace, for the routes that take no workspace id.

    The workspace-scoped routes — usage, themes, assets, repositories — had each
    grown a private `_workspace_of` that returned the *first* membership and
    checked no role at all. A workspace viewer could therefore write a
    workspace-wide theme and run the asset sweeper, which deletes files.

    Two decisions worth stating:

    * The role check lives here, so a new workspace route cannot forget it by
      omission — it has to pass a `require` to get a workspace id at all.
    * Legacy unqualified routes consistently use the first membership by ID.
      Selection happens before authorization: insufficient privilege is refused,
      never resolved by silently switching to another workspace.
    """
    memberships = session.scalars(
        select(WorkspaceMember)
        .where(WorkspaceMember.user_id == user_id)
        .order_by(WorkspaceMember.workspace_id)
    ).all()

    if not memberships:
        raise Forbidden("You are not a member of any workspace.")

    membership = memberships[0]
    # Through `membership_status`, not `parse_role` on the row (D5.4). This
    # function used to read the role straight off the row, which meant that the
    # moment a device mirrors a workspace, every workspace-scoped route — themes,
    # assets, the sweeper that deletes files, usage — would honour a cached role
    # as readily as a real one. The check has one home for the same reason the
    # `require` argument is mandatory: a rule that each route re-implements is a
    # rule one route will re-implement wrongly.
    status = membership_status(session, user_id, membership.workspace_id)
    if status.role is None or status.role < require:
        raise Forbidden()
    return WorkspaceAccess(workspace_id=membership.workspace_id, role=status.role)



def resolve_creation_project(session: Session, *, user_id: str, project_id: str | None) -> Project:
    """Authorize the target before any generation spend or document write.

    Explicit targets may belong to any workspace the caller can edit. Default
    selection is stable and never skips a viewer workspace to gain authority.
    """
    if project_id is not None:
        project, _ = resolve_project_access(session, user_id=user_id, project_id=project_id, require=Role.EDITOR)
        return project
    access = resolve_workspace_access(session, user_id=user_id, require=Role.EDITOR)
    project = session.scalar(select(Project).where(Project.workspace_id == access.workspace_id).order_by(Project.id).limit(1))
    if project is None:
        raise HTTPException(status_code=400, detail="Create a project before creating a presentation.")
    return project


def ensure_workspace_membership(
    session: Session, *, user_id: str, workspace_id: str, require: Role = Role.VIEWER
) -> Role:
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise Forbidden()

    role = role_in_workspace(session, user_id, workspace_id)
    if role is None or role < require:
        raise Forbidden()
    return role
