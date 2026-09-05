"""Workspace themes (gap register doc 05 S2).

Themes have lived only inside document JSON. Every deck therefore carries its own
private copy of the brand, and nobody can change the brand in one place — which
contradicts doc 01 §5.4's organisational brand and doc 02 §22's claim that the
theme is "a design contract" agents reference. A contract each party holds a
private copy of is not one.

**The document keeps both.** A `themeId` alone would make a `.mydeck` file
unopenable outside the workspace that owns the theme, and doc 02's first rule is
that a document is portable and safe to email. So a themed document carries the
id — so a brand change can be re-applied later — *and* the resolved tokens, so
the file renders anywhere, forever, with no lookup.

**A theme change is a transaction.** Re-applying a brand is an edit like any
other: it produces operations, goes through the one mutation path, and undoes.
Writing the document directly would make it the single change in the product with
no inverse, and the first time someone re-applied the wrong theme to a client
deck they would have no way back.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db.models import Theme
from .ids import new_id
from .schema import SchemaUnavailable, validate_theme


class ThemeError(RuntimeError):
    """A theme that cannot be saved, with a reason a user can read."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def save(
    session: Session,
    *,
    workspace_id: str,
    created_by: str,
    name: str,
    definition: dict[str, Any],
    description: str | None = None,
    is_default: bool = False,
) -> Theme:
    """Create or replace a workspace theme.

    Validated against the generated schema before it is stored. There is
    deliberately no hand-written Python model of a theme — the Zod definition is
    normative and everything downstream reads the artifact it emits, so a theme
    that validates here is one the renderer can resolve.
    """
    try:
        errors = validate_theme(definition)
    except SchemaUnavailable as error:
        raise ThemeError(str(error)) from error

    if errors:
        # The first three. A wall of schema paths is not something a user acts
        # on, and the first error is almost always the cause of the rest.
        raise ThemeError(
            "This theme does not match the schema: " + "; ".join(errors[:3])
        )

    existing = session.execute(
        select(Theme).where(Theme.workspace_id == workspace_id, Theme.name == name)
    ).scalar_one_or_none()

    if existing is not None:
        existing.definition_json = definition
        existing.description = description
        existing.archived_at = None
        theme = existing
    else:
        theme = Theme(
            id=new_id("thm"),
            workspace_id=workspace_id,
            created_by=created_by,
            name=name,
            description=description,
            definition_json=definition,
        )
        session.add(theme)

    session.flush()

    if is_default:
        # Enforced here rather than by a partial unique index: SQLite has none,
        # and a constraint that exists on one dialect and not the other means the
        # two databases disagree about what is legal.
        for other in session.query(Theme).filter(Theme.workspace_id == workspace_id).all():
            other.is_default = other.id == theme.id
        session.flush()

    return theme


def list_for_workspace(session: Session, workspace_id: str) -> list[Theme]:
    return list(
        session.execute(
            select(Theme)
            .where(Theme.workspace_id == workspace_id, Theme.archived_at.is_(None))
            .order_by(Theme.is_default.desc(), Theme.name)
        ).scalars()
    )


def default_for(session: Session, workspace_id: str) -> Theme | None:
    return session.execute(
        select(Theme).where(
            Theme.workspace_id == workspace_id,
            Theme.is_default.is_(True),
            Theme.archived_at.is_(None),
        )
    ).scalar_one_or_none()


def apply_operations(theme: Theme) -> list[dict[str, Any]]:
    """The patch that re-themes a document.

    Two operations, and the second is what keeps the document portable: the id
    records *which* workspace theme this deck follows, so a later brand change
    knows what to re-apply, and the resolved definition is what actually renders.

    Replacing the whole theme rather than diffing its tokens is deliberate. A
    token-by-token patch would produce a hundred operations whose inverse is a
    hundred more, and "apply theme" would fill the history with noise nobody can
    read. One replace is one line in the history and one undo.
    """
    return [
        {"op": "replace", "path": "/theme", "value": theme.definition_json},
        # `add`, not `replace`: a deck themed for the first time has no `themeId`
        # yet, and `replace` refuses a property that does not exist. `add` writes
        # it either way, and its inverse restores the previous value rather than
        # removing the key — which is what makes undo put the old theme back
        # rather than leaving an untethered deck.
        {"op": "add", "path": "/metadata/themeId", "value": theme.id},
    ]


def archive(session: Session, theme: Theme) -> Theme:
    """Retire a theme without breaking the decks that used it.

    Archived, never deleted. Every deck carries its own resolved snapshot, so a
    deleted theme would not change how anything renders — but it would break the
    id the deck records, and with it the ability to say what brand this deck was
    built from.
    """
    theme.archived_at = _now()
    theme.is_default = False
    session.flush()
    return theme


def describe(theme: Theme) -> dict[str, Any]:
    definition = theme.definition_json or {}
    colors = definition.get("colors") or {}

    return {
        "id": theme.id,
        "name": theme.name,
        "description": theme.description,
        "is_default": theme.is_default,
        "archived_at": theme.archived_at.isoformat() if theme.archived_at else None,
        # A swatch rather than the whole definition. A list endpoint that returns
        # every token for every theme is a page that loads a hundred kilobytes to
        # draw six coloured squares.
        "preview": {
            "background": colors.get("background"),
            "foreground": colors.get("foreground"),
            "accent": colors.get("accent"),
            "surface": colors.get("surface"),
        },
        "created_at": theme.created_at.isoformat() if theme.created_at else None,
    }
