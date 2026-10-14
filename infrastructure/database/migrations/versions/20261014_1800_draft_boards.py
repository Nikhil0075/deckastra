"""Add geometry-free draft boards and draft request targets.

Revision ID: 4ef0ca701014
Revises: 3de9ca701014
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "4ef0ca701014"
down_revision = "3de9ca701014"
branch_labels = None
depends_on = None

JSON_TYPE = sa.JSON().with_variant(JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "drafts",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("project_id", sa.String(length=64), nullable=False),
        sa.Column("presentation_id", sa.String(length=64), nullable=True),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("body_json", JSON_TYPE, nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("built_version_id", sa.String(length=64), nullable=True),
        sa.Column("built_revision", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["presentation_id"], ["presentations.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_drafts_project_updated", "drafts", ["project_id", "updated_at"])
    op.create_index("ix_drafts_presentation", "drafts", ["presentation_id"])

    with op.batch_alter_table("agent_requests") as batch:
        batch.alter_column("presentation_id", existing_type=sa.String(length=64), nullable=True)
        batch.alter_column("based_on_version_id", existing_type=sa.String(length=64), nullable=True)
        batch.add_column(sa.Column("draft_id", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("based_on_draft_revision", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_agent_requests_draft", "drafts", ["draft_id"], ["id"], ondelete="CASCADE")
        batch.create_index("ix_agent_requests_draft_id", ["draft_id"])


def downgrade() -> None:
    with op.batch_alter_table("agent_requests") as batch:
        batch.drop_index("ix_agent_requests_draft_id")
        batch.drop_constraint("fk_agent_requests_draft", type_="foreignkey")
        batch.drop_column("based_on_draft_revision")
        batch.drop_column("draft_id")
        batch.alter_column("based_on_version_id", existing_type=sa.String(length=64), nullable=False)
        batch.alter_column("presentation_id", existing_type=sa.String(length=64), nullable=False)
    op.drop_index("ix_drafts_presentation", table_name="drafts")
    op.drop_index("ix_drafts_project_updated", table_name="drafts")
    op.drop_table("drafts")
