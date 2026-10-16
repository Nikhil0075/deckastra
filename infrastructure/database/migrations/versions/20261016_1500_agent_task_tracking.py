"""Record when agent tasks are answered.

Revision ID: 6bf0ca701016
Revises: 5af0ca701016
"""

from alembic import op
import sqlalchemy as sa

revision = "6bf0ca701016"
down_revision = "5af0ca701016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("agent_requests") as batch:
        batch.add_column(sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("agent_requests") as batch:
        batch.drop_column("answered_at")
