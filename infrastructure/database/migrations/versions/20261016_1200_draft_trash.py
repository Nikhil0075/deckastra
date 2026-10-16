"""Add recoverable deletion for rough canvas drafts.

Revision ID: 5af0ca701016
Revises: 4ef0ca701014
"""

from alembic import op
import sqlalchemy as sa

revision = "5af0ca701016"
down_revision = "4ef0ca701014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("drafts") as batch:
        batch.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("drafts") as batch:
        batch.drop_column("deleted_at")
