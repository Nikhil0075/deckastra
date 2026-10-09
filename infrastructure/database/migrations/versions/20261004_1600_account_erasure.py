"""Durable cloud erasure queue and stale identity denial."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "c8f4d6300402"
down_revision = "b7f3c5200401"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("account_deletions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64)),
        sa.Column("fingerprints_json", sa.JSON().with_variant(JSONB(), "postgresql"), nullable=False),
        sa.Column("identities_json", sa.JSON().with_variant(JSONB(), "postgresql"), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)))
    op.create_index("ix_account_deletions_user_id", "account_deletions", ["user_id"])
    op.create_index("ix_account_deletions_status", "account_deletions", ["status"])


def downgrade():
    op.drop_table("account_deletions")
