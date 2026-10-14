"""Persist user questions to agents and link proposal replies.

Revision ID: 2ce9ca701014
Revises: 1be9ca701008
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "2ce9ca701014"
down_revision = "1be9ca701008"
branch_labels = None
depends_on = None

JSON_TYPE = sa.JSON().with_variant(JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "agent_requests",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("presentation_id", sa.String(length=64), nullable=False),
        sa.Column("target_json", JSON_TYPE, nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("based_on_version_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("answer_proposal_ids_json", JSON_TYPE, nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("status IN ('open', 'answered', 'closed')", name="ck_agent_request_status"),
        sa.ForeignKeyConstraint(["presentation_id"], ["presentations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_agent_requests_presentation_status", "agent_requests", ["presentation_id", "status"]
    )
    with op.batch_alter_table("transactions") as batch:
        batch.add_column(sa.Column("in_reply_to_request_id", sa.String(length=64), nullable=True))
        batch.create_foreign_key(
            "fk_transactions_in_reply_to_request_id_agent_requests",
            "agent_requests",
            ["in_reply_to_request_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_transactions_in_reply_to_request_id", ["in_reply_to_request_id"])


def downgrade() -> None:
    with op.batch_alter_table("transactions") as batch:
        batch.drop_index("ix_transactions_in_reply_to_request_id")
        batch.drop_constraint("fk_transactions_in_reply_to_request_id_agent_requests", type_="foreignkey")
        batch.drop_column("in_reply_to_request_id")
    op.drop_index("ix_agent_requests_presentation_status", table_name="agent_requests")
    op.drop_table("agent_requests")
