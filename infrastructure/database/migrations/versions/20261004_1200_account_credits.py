"""Monthly account credits and atomic daily abuse limits."""
from alembic import op
import sqlalchemy as sa

revision = "b7f3c5200401"
down_revision = "a6e2b4100301"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("credit_accounts",
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("plan", sa.String(24), nullable=False), sa.Column("monthly_allowance", sa.Integer(), nullable=False),
        sa.Column("balance_micros", sa.Integer(), nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False), sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("anchor_day", sa.Integer(), nullable=False))
    op.create_table("credit_entries",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("credit_accounts.user_id", ondelete="CASCADE"), nullable=False),
        sa.Column("operation_id", sa.String(64), nullable=False), sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("amount_micros", sa.Integer(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("operation_id", "kind", name="uq_credit_operation_kind"))
    op.create_index("ix_credit_entries_user_id", "credit_entries", ["user_id"])
    op.create_table("credit_reservations",
        sa.Column("operation_id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("credit_accounts.user_id", ondelete="CASCADE"), nullable=False),
        sa.Column("reserved_micros", sa.Integer(), nullable=False), sa.Column("actual_micros", sa.Integer()),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("task", sa.String(32), nullable=False), sa.Column("model", sa.String(128), nullable=False), sa.Column("device_hash", sa.String(64), nullable=False))
    op.create_index("ix_credit_reservations_user_id", "credit_reservations", ["user_id"])
    op.create_table("credit_daily_limits", sa.Column("scope", sa.String(140), primary_key=True), sa.Column("day", sa.String(10), primary_key=True),
        sa.Column("spent_micros", sa.Integer(), nullable=False), sa.Column("requests", sa.Integer(), nullable=False))


def downgrade():
    for table in ("credit_daily_limits", "credit_reservations", "credit_entries", "credit_accounts"):
        op.drop_table(table)
