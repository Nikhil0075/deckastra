"""Allow exchange packages in the existing durable export queue."""
from alembic import op
import sqlalchemy as sa

revision = "e8b6f8500404"
down_revision = "d9a5e7400403"
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table("export_jobs") as batch:
        batch.drop_constraint("ck_export_kind", type_="check")
        batch.create_check_constraint("ck_export_kind", "kind IN ('pdf', 'pptx', 'mydeck')")


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT count(*) FROM export_jobs WHERE kind='mydeck'")):
        raise RuntimeError("Retain the package export format while .mydeck jobs exist.")
    with op.batch_alter_table("export_jobs") as batch:
        batch.drop_constraint("ck_export_kind", type_="check")
        batch.create_check_constraint("ck_export_kind", "kind IN ('pdf', 'pptx')")
