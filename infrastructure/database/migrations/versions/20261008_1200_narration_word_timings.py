"""Store speech word timings on cached audio assets.

Revision ID: 0ad8ba701008
Revises: f9c7a9600601
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0ad8ba701008"
down_revision = "f9c7a9600601"
branch_labels = depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("assets") as batch:
        batch.add_column(
            sa.Column("word_timings", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("assets") as batch:
        batch.drop_column("word_timings")
