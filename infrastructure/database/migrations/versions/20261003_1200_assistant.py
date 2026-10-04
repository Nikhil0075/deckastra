"""Assistant runs, cost reservations, replayable events and asset metadata."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "a6e2b4100301"
down_revision = "5d8b3e1f7a26"
branch_labels = None
depends_on = None


def upgrade():
    json_type = sa.JSON().with_variant(JSONB(), "postgresql")
    with op.batch_alter_table("assets") as batch:
        batch.add_column(sa.Column("tags", json_type))
        batch.add_column(sa.Column("description", sa.Text()))
        batch.add_column(sa.Column("sha256", sa.String(64)))
        batch.add_column(sa.Column("dhash64", sa.String(16)))
        batch.add_column(sa.Column("metadata_version", sa.Integer(), nullable=False, server_default="0"))
    timestamps = lambda: [sa.Column("created_at", sa.DateTime(timezone=True), nullable=False)]
    op.create_table("assistant_runs",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("workspace_id", sa.String(64), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("presentation_id", sa.String(64), sa.ForeignKey("presentations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False), sa.Column("operation_key", sa.String(64), nullable=False),
        sa.Column("status", sa.String(24), nullable=False), sa.Column("request_json", json_type, nullable=False), sa.Column("scopes_json", json_type, nullable=False),
        sa.Column("checkpoint_json", json_type), sa.Column("result_json", json_type), sa.Column("budget_json", json_type), sa.Column("error", sa.Text()),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False), sa.Column("lease_until", sa.DateTime(timezone=True)), sa.Column("owner_id", sa.String(64)),
        sa.Column("event_seq", sa.Integer(), nullable=False), *timestamps(), sa.UniqueConstraint("created_by", "operation_key", name="uq_assistant_request"))
    for field in ("workspace_id", "presentation_id", "status"):
        op.create_index(f"ix_assistant_runs_{field}", "assistant_runs", [field])
    op.create_table("assistant_events", sa.Column("run_id", sa.String(64), sa.ForeignKey("assistant_runs.id", ondelete="CASCADE"), primary_key=True), sa.Column("sequence", sa.Integer(), primary_key=True), sa.Column("payload_json", json_type, nullable=False))
    op.create_table("assistant_reservations", sa.Column("operation_id", sa.String(64), primary_key=True), sa.Column("run_id", sa.String(64), sa.ForeignKey("assistant_runs.id", ondelete="CASCADE"), nullable=False), sa.Column("reserved_usd", sa.Float(), nullable=False), sa.Column("actual_usd", sa.Float()))
    op.create_index("ix_assistant_reservations_run_id", "assistant_reservations", ["run_id"])
    op.create_table("asset_metadata_changes", sa.Column("id", sa.String(64), primary_key=True), sa.Column("asset_id", sa.String(64), sa.ForeignKey("assets.id", ondelete="CASCADE"), nullable=False), sa.Column("created_by", sa.String(64), nullable=False), sa.Column("before_json", json_type, nullable=False), sa.Column("after_json", json_type, nullable=False), sa.Column("result_version", sa.Integer(), nullable=False), sa.Column("reverted", sa.Boolean(), nullable=False), *timestamps())
    op.create_index("ix_asset_metadata_changes_asset_id", "asset_metadata_changes", ["asset_id"])


def downgrade():
    for table in ("asset_metadata_changes", "assistant_reservations", "assistant_events", "assistant_runs"):
        op.drop_table(table)
    with op.batch_alter_table("assets") as batch:
        for field in ("metadata_version", "dhash64", "sha256", "description", "tags"):
            batch.drop_column(field)
