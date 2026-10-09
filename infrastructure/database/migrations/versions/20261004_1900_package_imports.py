"""Exchange package imports and preserved opaque extras."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "d9a5e7400403"
down_revision = "c8f4d6300402"
branch_labels = depends_on = None


def upgrade():
    op.create_table("import_jobs", sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_by", sa.String(64), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("storage_key", sa.String(1024), nullable=False), sa.Column("expected_bytes", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False), sa.Column("copy", sa.Boolean(), nullable=False),
        sa.Column("presentation_id", sa.String(64)), sa.Column("error", sa.Text()),
        sa.Column("warnings_json", sa.JSON().with_variant(JSONB(), "postgresql"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False), sa.Column("lease_until", sa.DateTime(timezone=True)))
    op.create_index("ix_import_jobs_project_id", "import_jobs", ["project_id"])
    op.create_index("ix_import_jobs_status", "import_jobs", ["status"])
    op.create_table("package_extras", sa.Column("presentation_id", sa.String(64), sa.ForeignKey("presentations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("assets_json", sa.JSON().with_variant(JSONB(), "postgresql"), nullable=False))


def downgrade():
    op.drop_table("package_extras")
    op.drop_table("import_jobs")
