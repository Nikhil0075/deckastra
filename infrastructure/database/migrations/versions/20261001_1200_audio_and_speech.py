"""audio assets know how long they are; workspaces have a speech allowance

Revision ID: 5d8b3e1f7a26
Revises: 7c2e9a4d5b18
Create Date: 2026-10-01 12:00:00

Integration plan 01 (multilingual decks, step narration and sound):

- `assets.duration_ms` — read from an audio file's container when it arrives,
  because a narrated deck advances on it.
- `assets.waveform_peaks` — 256 peaks for the timeline's audio lane, computed
  once rather than by decoding on every draw.
- `workspace_quotas.monthly_speech_characters` / `used_speech_characters` —
  speech is billed by the character. Existing workspaces get their plan's
  allowance rather than nothing: null means unlimited here, and a free plan that
  silently became unlimited by being created before this column is a decision
  nobody made.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "5d8b3e1f7a26"
down_revision: str | None = "7c2e9a4d5b18"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("assets") as batch:
        batch.add_column(sa.Column("duration_ms", sa.Integer(), nullable=True))
        batch.add_column(
            sa.Column("waveform_peaks", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True)
        )
    with op.batch_alter_table("workspace_quotas") as batch:
        batch.add_column(sa.Column("monthly_speech_characters", sa.Integer(), nullable=True))
        batch.add_column(
            sa.Column("used_speech_characters", sa.Integer(), nullable=False, server_default="0")
        )
    op.execute("UPDATE workspace_quotas SET monthly_speech_characters = 200000 WHERE plan = 'free'")
    op.execute("UPDATE workspace_quotas SET monthly_speech_characters = 5000000 WHERE plan = 'pro'")


def downgrade() -> None:
    with op.batch_alter_table("workspace_quotas") as batch:
        batch.drop_column("used_speech_characters")
        batch.drop_column("monthly_speech_characters")
    with op.batch_alter_table("assets") as batch:
        batch.drop_column("waveform_peaks")
        batch.drop_column("duration_ms")
