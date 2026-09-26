"""a deck list shows slide counts, and a deleted deck can come back

Revision ID: 3f7a2c9e1b40
Revises: d94c1ba7f082
Create Date: 2026-09-19 10:00:00

Editor Phase 4 (the deck list). Two nullable columns on `presentations`:

- `slide_count`, maintained by every commit, so a card can say "12 slides"
  without the list replaying every deck in the project. Existing rows are left
  null and filled in once by the list route when it first sees them — a
  migration cannot replay a version chain, and guessing a number would be worse
  than showing none for one request.
- `deleted_at`, a soft delete. Deleting a deck is undoable, as deleting an
  asset or archiving a theme already is.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3f7a2c9e1b40"
down_revision: str | None = "d94c1ba7f082"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("presentations", sa.Column("slide_count", sa.Integer(), nullable=True))
    op.add_column("presentations", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("presentations", "deleted_at")
    op.drop_column("presentations", "slide_count")
