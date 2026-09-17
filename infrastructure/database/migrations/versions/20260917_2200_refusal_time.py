"""when the server refused, so a resolution can be required to come after it

Revision ID: d94c1ba7f082
Revises: b8f207ce4d13
Create Date: 2026-09-17 22:00:00

D5.3, corrected. The resolution boundary was queue order, and every change
already waiting behind a refusal satisfies that — yet those were authored before
anyone knew there was a conflict. Accepting one as the resolution retired every
change between it and the refusal. The boundary is time, so the time has to be
recorded.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d94c1ba7f082"
down_revision: str | None = "b8f207ce4d13"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sync_outbox", sa.Column("refused_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("sync_outbox", "refused_at")
