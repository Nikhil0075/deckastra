"""external authentication identities

Revision ID: a8c6f0d91e42
Revises: 76226b0ee21d
Create Date: 2026-09-08 03:00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a8c6f0d91e42"
down_revision: str | None = "76226b0ee21d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "auth_identities",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("issuer", sa.String(length=512), nullable=False),
        sa.Column("subject", sa.String(length=255), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=True),
        sa.Column("email_at_link", sa.String(length=320), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("issuer", "subject", name="uq_auth_identity_subject"),
    )
    op.create_index(
        "ix_auth_identities_user", "auth_identities", ["user_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_auth_identities_user", table_name="auth_identities")
    op.drop_table("auth_identities")
