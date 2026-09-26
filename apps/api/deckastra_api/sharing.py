"""Sharing a presentation (gap register doc 01 S2, doc 05 S2).

The Share button in doc 01 §10 has had nothing behind it, and present mode has
had no access path for an audience — so the product's core use case, showing a
deck to people, has been impossible for anyone but the author.

A share link is a **bearer credential**: whoever holds it is authorised, with no
second factor and no identity. That single fact decides everything here.

- **The token is generated with `secrets.token_urlsafe`**, not a UUID and not an
  id. A guessable share link is a public deck nobody chose to publish.
- **Only its hash is stored.** A database read must not hand out working links to
  every deck in the product. The plaintext is returned once, at creation, exactly
  like an API key — and the UI says so, because a user who loses it needs to know
  to make another rather than to go looking.
- **Comparison is constant-time.** The lookup is by hash, so a timing signal
  would be narrow, but `compare_digest` costs nothing and removes the question.
- **Revoked, not deleted.** "Who could see this, and when did that stop" is the
  question asked after something leaks, and a deleted row cannot answer it.

The role on a share is a real role from the same ladder as membership, so a
shared viewer and a workspace viewer are the same thing to every downstream
check. A separate "is public" boolean would have meant a second thing for every
authorisation site to consult, and one of them would have missed it.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import Role, parse_role
from .db.models import Presentation, PresentationShare, PresentationVersion
from .ids import new_id

#: Long enough that guessing is not a strategy. 32 bytes of `token_urlsafe` is
#: 256 bits of entropy in 43 characters — short enough to paste into a chat.
TOKEN_BYTES = 32

#: The longest expiry the API will set from a "days" request. Past a year a link
#: is not a share, it is a publication, and it should be a deliberate act rather
#: than a slider someone dragged.
MAX_EXPIRY_DAYS = 365


class ShareError(RuntimeError):
    """A share request that cannot be honoured, with a reason a user can read."""


@dataclass(frozen=True)
class ResolvedShare:
    """A validated share, and what it lets the holder do."""

    share: PresentationShare
    presentation: Presentation
    role: Role


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; Postgres does not.

    Comparing the two raises, and it raises inside the expiry check — so a
    development database would refuse every share link with a 500 that production
    never shows.
    """
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def hash_token(token: str) -> str:
    """The stored form of a share token.

    A plain SHA-256 rather than a password hash. The token is 256 random bits, so
    there is no dictionary to attack and no user-chosen weakness to stretch
    against — bcrypt here would buy nothing and cost a hash on every page view of
    every shared deck.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_share(
    session: Session,
    *,
    presentation_id: str,
    created_by: str,
    role: str = "viewer",
    label: str | None = None,
    expires_in_days: int | None = None,
    version_id: str | None = None,
) -> tuple[PresentationShare, str]:
    """Mint a link. Returns the row and the plaintext token, once.

    `version_id` pins the link to one version (D5.5). Presenting is what needs
    it: an audience must not have a slide change under them because a colleague
    edited the deck or an agent's proposal applied, and on a projector that is
    not an annoyance but the talk going wrong in front of a room. A pinned link
    is a photograph of the deck; an unpinned one is a window onto it, which is
    still the default because "send this to a client while I fix the typos" is
    the other real use.
    """
    try:
        parsed = parse_role(role)
    except ValueError as error:
        raise ShareError(f"{role!r} is not a role a link can carry.") from error

    if parsed > Role.VIEWER:
        # Closed deliberately, and not because editing by link is a bad idea.
        # Nothing can redeem an editor link: `/v1/shared/{token}` returns a
        # document and the shared page only presents it. Storing a role the
        # product cannot honour tells the person who created the link that they
        # granted something they did not.
        #
        # The column and the `Role` plumbing stay, so token-scoped editing needs
        # no migration — only a write path that authenticates a token instead of
        # a session, and a UI that knows it is editing as a link holder.
        raise ShareError(
            "A share link can grant viewing only. Editing by link is not available yet."
        )

    if expires_in_days is not None and not (1 <= expires_in_days <= MAX_EXPIRY_DAYS):
        raise ShareError(f"An expiry must be between 1 and {MAX_EXPIRY_DAYS} days.")

    if version_id is not None:
        # Checked here rather than trusted, because a link naming a version from
        # another deck would be a link to that deck — the token is the only
        # credential, so whatever it resolves to is what the holder gets.
        version = session.get(PresentationVersion, version_id)
        if version is None or version.presentation_id != presentation_id:
            raise ShareError("That version is not part of this deck's history.")

    token = secrets.token_urlsafe(TOKEN_BYTES)

    share = PresentationShare(
        version_id=version_id,
        id=new_id("shr"),
        presentation_id=presentation_id,
        created_by=created_by,
        token_hash=hash_token(token),
        role=role,
        label=label,
        expires_at=(
            _now() + timedelta(days=expires_in_days) if expires_in_days is not None else None
        ),
    )
    session.add(share)
    session.flush()

    # The only time the plaintext exists outside the holder's hands.
    return share, token


def resolve_share(session: Session, token: str, *, record_view: bool = False) -> ResolvedShare:
    """Turn a link token into access, or refuse it.

    Every refusal is the same refusal. A link that has expired, one that was
    revoked and one that never existed all raise the same error with the same
    message: telling a holder which of those it is confirms that a deck exists
    behind the id they tried.
    """
    if not token:
        raise ShareError("This link is not valid.")

    candidate = session.execute(
        select(PresentationShare).where(PresentationShare.token_hash == hash_token(token))
    ).scalar_one_or_none()

    # Constant-time, even though the lookup was by hash. The comparison is free
    # and it removes the question of whether the index leaked a prefix.
    if candidate is None or not hmac.compare_digest(candidate.token_hash, hash_token(token)):
        raise ShareError("This link is not valid.")

    if candidate.revoked_at is not None:
        raise ShareError("This link is not valid.")

    if candidate.expires_at is not None and _aware(candidate.expires_at) <= _now():
        raise ShareError("This link is not valid.")

    presentation = session.get(Presentation, candidate.presentation_id)
    # A deleted deck's links stop working, with the same refusal as every other
    # invalid link: a share link is the one unauthenticated read in the product,
    # and it must not keep serving a deck its owner deleted. Restoring the deck
    # brings its links back — they key on the deck, which never changed.
    if presentation is None or presentation.deleted_at is not None:
        raise ShareError("This link is not valid.")

    if record_view:
        # Enough to answer "is anyone using this link?" without a per-visit log.
        candidate.view_count += 1
        candidate.last_viewed_at = _now()
        session.flush()

    return ResolvedShare(
        share=candidate,
        presentation=presentation,
        role=parse_role(candidate.role),
    )


def revoke(session: Session, share: PresentationShare) -> PresentationShare:
    """Stop a link working, without forgetting that it existed."""
    if share.revoked_at is None:
        share.revoked_at = _now()
        session.flush()
    return share


def list_for_presentation(session: Session, presentation_id: str) -> list[PresentationShare]:
    return list(
        session.execute(
            select(PresentationShare)
            .where(PresentationShare.presentation_id == presentation_id)
            .order_by(PresentationShare.created_at.desc())
        ).scalars()
    )


def describe(share: PresentationShare, *, token: str | None = None) -> dict[str, Any]:
    """A share as the UI shows it.

    `token` is only ever populated on the response that created it. Every later
    read shows the label and the counters — there is deliberately no way to ask
    the server for an existing link again, because there is no way for the server
    to know it.
    """
    expired = share.expires_at is not None and _aware(share.expires_at) <= _now()

    return {
        "id": share.id,
        "role": share.role,
        "label": share.label,
        # Which version this link shows, or null for "whatever the deck is now"
        # (D5.5). In a list of links it is the difference between one that is
        # safe to leave with an audience and one that keeps changing.
        "version_id": share.version_id,
        "created_at": share.created_at.isoformat() if share.created_at else None,
        "expires_at": share.expires_at.isoformat() if share.expires_at else None,
        "revoked_at": share.revoked_at.isoformat() if share.revoked_at else None,
        "view_count": share.view_count,
        "last_viewed_at": share.last_viewed_at.isoformat() if share.last_viewed_at else None,
        "status": "revoked" if share.revoked_at else "expired" if expired else "active",
        # Present exactly once, on creation. Shown to the user with a note that
        # it cannot be retrieved.
        **({"token": token} if token else {}),
    }
