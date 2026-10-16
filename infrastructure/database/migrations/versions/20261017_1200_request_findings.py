"""Let an agent answer a request in words: findings, with no change to apply.

A request such as "review this deck for clarity and change nothing" could only
be answered with proposals, so it stayed pending forever and its findings had
nowhere to go (release E2E step 9, 2026-10-17). Additive: a nullable column the
previous release never reads.

Revision ID: 7cf0ca701017
Revises: 6bf0ca701016
"""

from alembic import op
import sqlalchemy as sa

revision = "7cf0ca701017"
down_revision = "6bf0ca701016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("agent_requests") as batch:
        batch.add_column(sa.Column("answer_text", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("agent_requests") as batch:
        batch.drop_column("answer_text")
