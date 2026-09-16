"""record which server version a mirrored deck is a copy of

Revision ID: b8f207ce4d13
Revises: a0d46b8f912c
Create Date: 2026-09-17 19:00:00

D5.6, bootstrap. A device that pulls a deck down holds the same content under a
different version identity — D5.0 found that version ids are the one thing that
does not travel, because `commit_transaction` mints its own and takes none from a
caller. So "which server version is this a copy of" is a fact with nowhere to live
until this column, and it is the fact a later push needs in order to say what its
change is based on.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8f207ce4d13"
down_revision: str | None = "a0d46b8f912c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "presentations", sa.Column("remote_version_id", sa.String(length=64), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("presentations", "remote_version_id")
