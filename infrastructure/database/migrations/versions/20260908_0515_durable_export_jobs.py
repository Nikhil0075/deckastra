"""durable export jobs

Revision ID: d49ad72c54f1
Revises: a8c6f0d91e42
Create Date: 2026-09-08 05:15:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d49ad72c54f1"
down_revision: str | None = "a8c6f0d91e42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("export_jobs") as batch:
        batch.drop_constraint("ck_export_status", type_="check")
        batch.create_check_constraint(
            "ck_export_status",
            "status IN ('queued', 'running', 'completed', 'failed', 'cancelled')",
        )
        batch.add_column(sa.Column("idempotency_key", sa.String(128)))
        batch.add_column(sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"))
        batch.add_column(sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("lease_owner", sa.String(128)))
        batch.add_column(sa.Column("lease_expires_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("next_attempt_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("started_at", sa.DateTime(timezone=True)))
        batch.create_unique_constraint(
            "uq_export_idempotency", ["presentation_id", "created_by", "idempotency_key"]
        )
    op.create_index(
        "ix_export_jobs_claim",
        "export_jobs",
        ["status", "next_attempt_at", "lease_expires_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_export_jobs_claim", table_name="export_jobs")
    with op.batch_alter_table("export_jobs") as batch:
        batch.drop_constraint("uq_export_idempotency", type_="unique")
        for column in [
            "started_at", "next_attempt_at", "lease_expires_at", "lease_owner",
            "cancel_requested", "max_attempts", "attempts", "idempotency_key",
        ]:
            batch.drop_column(column)
        batch.drop_constraint("ck_export_status", type_="check")
        batch.create_check_constraint(
            "ck_export_status", "status IN ('queued', 'running', 'completed', 'failed')"
        )
