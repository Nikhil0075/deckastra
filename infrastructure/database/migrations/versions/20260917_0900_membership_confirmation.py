"""a membership in a mirrored workspace is a cache, and a cache expires

Revision ID: f1c8a25e73b6
Revises: e5b93d17c284
Create Date: 2026-09-17 09:00:00

D5.4. `workspace_members` is the authorization source for every route, and once a
device mirrors a workspace some of those rows are copies of decisions made
somewhere else. Nothing in the schema could tell the two apart, so a mirrored row
would have authorized exactly as a real one does — including after the person it
describes was removed upstream.

`confirmed_at` is what a role in a `cloud` workspace now rests on, and it is
backfilled for existing rows: every workspace in every database today is `local`
(D5.1), where the row is the authority and this column is never read.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1c8a25e73b6"
down_revision: str | None = "e5b93d17c284"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "workspace_members", sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "workspace_members", sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True)
    )
    # Deliberately no backfill. `confirmed_at` means "the authority that owns this
    # workspace vouched for this row", and for every existing row nothing ever
    # did — they belong to `local` workspaces, where the row *is* the authority
    # and the column is never read. Stamping them would be fail-open: if one of
    # those workspaces ever became a mirror, a month of access would fall out of a
    # value that records a fact nobody established.


def downgrade() -> None:
    op.drop_column("workspace_members", "revoked_at")
    op.drop_column("workspace_members", "confirmed_at")
