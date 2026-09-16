"""a refused change is not a failed one

Revision ID: e5b93d17c284
Revises: c7e2a91b46f3
Create Date: 2026-09-16 18:00:00

D5.3. The outbox could tell a working server from an unreachable one and nothing
else, so a change the server *refused* — because the deck had moved there — was
retried on the same backoff as a dropped connection: a loop with no exit, and one
that hides the fact that a person has to decide something.

`blocked` and `superseded` join the two states it had. The remote document is kept
beside the refusal so reconciling does not need the network that was missing when
the divergence happened.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "e5b93d17c284"
down_revision: str | None = "c7e2a91b46f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSON_TYPE = sa.JSON().with_variant(JSONB(), "postgresql")


def upgrade() -> None:
    op.add_column("sync_outbox", sa.Column("refused_reason", sa.Text(), nullable=True))
    op.add_column("sync_outbox", sa.Column("remote_document_json", JSON_TYPE, nullable=True))
    with op.batch_alter_table("sync_outbox") as batch:
        batch.drop_constraint("ck_outbox_status", type_="check")
        batch.create_check_constraint(
            "ck_outbox_status", "status IN ('pending', 'sent', 'blocked', 'superseded')"
        )


def downgrade() -> None:
    with op.batch_alter_table("sync_outbox") as batch:
        batch.drop_constraint("ck_outbox_status", type_="check")
        batch.create_check_constraint("ck_outbox_status", "status IN ('pending', 'sent')")
    op.drop_column("sync_outbox", "remote_document_json")
    op.drop_column("sync_outbox", "refused_reason")
