"""assets travel with a deck, and a link can show one exact version

Revision ID: a0d46b8f912c
Revises: f1c8a25e73b6
Create Date: 2026-09-17 15:00:00

D5.5, two halves of "a deck reaches other people whole".

`sync_outbox.asset_id` and the third `kind`: a synced document that cites an image
the server never received arrives broken for everyone else, so the bytes queue
ahead of the change that names them.

`presentation_shares.version_id`: presenting distributes an immutable version. An
audience watching a link must not have a slide change under them because someone
edited it mid-talk.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a0d46b8f912c"
down_revision: str | None = "f1c8a25e73b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Both inside one batch block. SQLite cannot ALTER a constraint, and adding a
    # column that *carries* one — the foreign key — is an ALTER of a constraint as
    # far as it is concerned. Batch mode rebuilds the table, which does both at
    # once and is why `render_as_batch` is wired up in `env.py`.
    with op.batch_alter_table("sync_outbox") as batch:
        batch.add_column(
            sa.Column(
                "asset_id",
                sa.String(length=64),
                # Named, because batch mode rebuilds the table and refuses to
                # re-create a constraint it cannot refer to.
                sa.ForeignKey("assets.id", ondelete="CASCADE", name="fk_outbox_asset"),
                nullable=True,
            )
        )
        batch.drop_constraint("ck_outbox_kind", type_="check")
        batch.create_check_constraint(
            "ck_outbox_kind", "kind IN ('create', 'change', 'asset')"
        )

    op.add_column(
        "presentation_shares", sa.Column("version_id", sa.String(length=64), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("presentation_shares", "version_id")
    with op.batch_alter_table("sync_outbox") as batch:
        batch.drop_constraint("ck_outbox_kind", type_="check")
        batch.create_check_constraint("ck_outbox_kind", "kind IN ('create', 'change')")
        batch.drop_column("asset_id")
