"""Authentication and the authorization chain (doc 05 §26, §27).

Every server operation resolves the same chain:

    User -> Workspace -> Project -> Presentation / Source / Asset

The chain is the part that matters and the part that is built here. *How* a user
proves who they are is deliberately thin in Phase 2: a signed dev token, with the
seam for real email/social sign-in left explicit. Building an OAuth flow before
there is an editor to protect would be scaffolding, and it would not change a line
of the authorization logic below.

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
from enum import IntEnum

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db.models import Presentation, Project, User, Workspace, WorkspaceMember
from .db.session import get_session


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

    user_id = verify_dev_token(authorization[7:].strip())
    if user_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.")

    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user.")

    return Principal(user_id=user.id, email=user.email)


class Forbidden(HTTPException):
    def __init__(self, detail: str = "Not found.") -> None:
        # 404, not 403. A 403 on a resource you cannot see confirms it exists,
        # which turns the API into an enumeration oracle.
        super().__init__(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


def role_in_workspace(session: Session, user_id: str, workspace_id: str) -> Role | None:
    membership = session.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user_id,
        )
    )
    return parse_role(membership.role) if membership else None


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
