"""Allow deterministic narrated MP4 export jobs.

Revision ID: 1be9ca701008
Revises: 0ad8ba701008
"""

from alembic import op

revision = "1be9ca701008"
down_revision = "0ad8ba701008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("export_jobs") as batch:
        batch.drop_constraint("ck_export_kind", type_="check")
        batch.create_check_constraint(
            "ck_export_kind", "kind IN ('pdf', 'pptx', 'mp4', 'mydeck')"
        )


def downgrade() -> None:
    with op.batch_alter_table("export_jobs") as batch:
        batch.drop_constraint("ck_export_kind", type_="check")
        batch.create_check_constraint(
            "ck_export_kind", "kind IN ('pdf', 'pptx', 'mydeck')"
        )
