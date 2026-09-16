"""workspace origin: this machine's own, or a mirror of a cloud one

Revision ID: b31f4c7a0d52
Revises: d49ad72c54f1
Create Date: 2026-09-16 09:00:00

D5.1. A desktop that signs in holds two kinds of workspace at once: the personal
one it seeded, whose decks have never left the device, and mirrors of workspaces
the server owns. They cannot be authorized the same way — a mirror's roles are a
cache, and a cache is not authorization — so the row has to say which it is.

Existing rows are `local`, which is what every workspace in every database today
actually is: nothing has ever synced.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b31f4c7a0d52"
down_revision: str | None = "d49ad72c54f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # `server_default` so the column can be NOT NULL without a second pass over
    # existing rows, and so a writer that predates this migration still inserts a
    # valid row.
    op.add_column(
        "workspaces",
        sa.Column("origin", sa.String(length=10), nullable=False, server_default="local"),
    )
    with op.batch_alter_table("workspaces") as batch:
        batch.create_check_constraint("ck_workspace_origin", "origin IN ('local', 'cloud')")


def downgrade() -> None:
    with op.batch_alter_table("workspaces") as batch:
        batch.drop_constraint("ck_workspace_origin", type_="check")
    op.drop_column("workspaces", "origin")
