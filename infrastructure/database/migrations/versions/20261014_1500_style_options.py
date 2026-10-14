"""Persist expiring style-option decisions.

Revision ID: 3de9ca701014
Revises: 2ce9ca701014
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "3de9ca701014"
down_revision = "2ce9ca701014"
branch_labels = None
depends_on = None

JSON_TYPE = sa.JSON().with_variant(JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "style_option_sets",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("presentation_id", sa.String(length=64), nullable=False),
        sa.Column("based_on_version_id", sa.String(length=64), nullable=False),
        sa.Column("slide_id", sa.String(length=64), nullable=False),
        sa.Column("options_json", JSON_TYPE, nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("chosen_option_id", sa.String(length=64), nullable=True),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("status IN ('open', 'chosen', 'expired')", name="ck_style_option_set_status"),
        sa.ForeignKeyConstraint(["presentation_id"], ["presentations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_style_option_sets_presentation_status", "style_option_sets", ["presentation_id", "status"]
    )


def downgrade() -> None:
    op.drop_index("ix_style_option_sets_presentation_status", table_name="style_option_sets")
    op.drop_table("style_option_sets")
