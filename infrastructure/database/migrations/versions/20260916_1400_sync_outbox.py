"""a change key, and the outbox that owes it to a server

Revision ID: c7e2a91b46f3
Revises: b31f4c7a0d52
Create Date: 2026-09-16 14:00:00

D5.2. Two halves of one mechanism.

`transactions.change_key` is the receiving half: a device that retries an upload
it never heard the answer to must land the change once. It is not the version id,
because D5.0 found the two chains never share version identity and because the
case sync exists for — divergence — lands a change at a different version than it
had locally.

`sync_outbox` is the sending half, and the reason it is a table rather than a
queue in memory is that its row is written in the same database transaction as
the change it describes. Anything else loses the enqueue to a crash, silently.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e2a91b46f3"
down_revision: str | None = "b31f4c7a0d52"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("transactions", sa.Column("change_key", sa.String(length=64), nullable=True))
    with op.batch_alter_table("transactions") as batch:
        # Repeated NULLs are allowed by both dialects, so every existing row —
        # and every change on a deck that never syncs — coexists under this.
        batch.create_unique_constraint(
            "uq_transaction_change_key", ["presentation_id", "change_key"]
        )

    op.create_table(
        "sync_outbox",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column(
            "presentation_id",
            sa.String(length=64),
            sa.ForeignKey("presentations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column(
            "transaction_id",
            sa.String(length=64),
            sa.ForeignKey("transactions.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("change_key", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("remote_version_id", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('create', 'change')", name="ck_outbox_kind"),
        sa.CheckConstraint("status IN ('pending', 'sent')", name="ck_outbox_status"),
        sa.UniqueConstraint("presentation_id", "change_key", name="uq_outbox_change_key"),
    )
    op.create_index("ix_outbox_ready", "sync_outbox", ["status", "next_attempt_at"])
    op.create_index("ix_outbox_presentation", "sync_outbox", ["presentation_id", "id"])


def downgrade() -> None:
    op.drop_index("ix_outbox_presentation", table_name="sync_outbox")
    op.drop_index("ix_outbox_ready", table_name="sync_outbox")
    op.drop_table("sync_outbox")
    with op.batch_alter_table("transactions") as batch:
        batch.drop_constraint("uq_transaction_change_key", type_="unique")
    op.drop_column("transactions", "change_key")
