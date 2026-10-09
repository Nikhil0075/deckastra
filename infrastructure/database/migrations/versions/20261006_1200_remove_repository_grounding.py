"""Remove Deckastra-managed repository grounding.

Revision ID: f9c7a9600601
Revises: e8b6f8500404
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401
from sqlalchemy.dialects import postgresql

revision = "f9c7a9600601"
down_revision = "e8b6f8500404"
branch_labels = depends_on = None


def upgrade() -> None:
    op.drop_table("repository_chunks")
    op.drop_table("repositories")
    op.drop_table("github_installations")
    with op.batch_alter_table("workspace_quotas") as batch:
        batch.drop_column("max_repositories")


def downgrade() -> None:
    with op.batch_alter_table("workspace_quotas") as batch:
        batch.add_column(sa.Column("max_repositories", sa.Integer(), nullable=True))

    op.create_table(
        "github_installations",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("workspace_id", sa.String(64), nullable=False),
        sa.Column("github_installation_id", sa.String(64), nullable=False),
        sa.Column("account_login", sa.String(128), nullable=False),
        sa.Column("installed_by", sa.String(64), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("github_installation_id", name="uq_github_installation"),
    )
    op.create_index("ix_github_installations_workspace", "github_installations", ["workspace_id"])

    op.create_table(
        "repositories",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("workspace_id", sa.String(64), nullable=False),
        sa.Column("installation_id", sa.String(64)),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("full_name", sa.String(255), nullable=False),
        sa.Column("github_repository_id", sa.String(64)),
        sa.Column("default_branch", sa.String(128), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("local_path", sa.Text()),
        sa.Column("index_status", sa.String(16), nullable=False),
        sa.Column("index_error", sa.Text()),
        sa.Column("indexed_sha", sa.String(64)),
        sa.Column("head_sha", sa.String(64)),
        sa.Column("last_indexed_at", sa.DateTime(timezone=True)),
        sa.Column("file_count", sa.Integer(), nullable=False),
        sa.Column("chunk_count", sa.Integer(), nullable=False),
        sa.Column("embedding_model", sa.String(64)),
        sa.Column("embedding_semantic", sa.Boolean(), nullable=False),
        sa.Column("profile_json", sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), "postgresql")),
        sa.Column("warnings_json", sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), "postgresql")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.CheckConstraint("source IN ('github', 'local')", name="ck_repository_source"),
        sa.CheckConstraint("index_status IN ('pending', 'indexing', 'ready', 'failed', 'revoked')", name="ck_repository_index_status"),
        sa.ForeignKeyConstraint(["installation_id"], ["github_installations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("workspace_id", "full_name", name="uq_repository_per_workspace"),
    )
    op.create_index("ix_repositories_workspace", "repositories", ["workspace_id"])

    op.create_table(
        "repository_chunks",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("repository_id", sa.String(64), nullable=False),
        sa.Column("path", sa.String(1024), nullable=False),
        sa.Column("start_line", sa.Integer(), nullable=False),
        sa.Column("end_line", sa.Integer(), nullable=False),
        sa.Column("language", sa.String(64)),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("file_sha", sa.String(64)),
        sa.Column("importance", sa.Float(), nullable=False),
        sa.Column("selection_reason", sa.Text()),
        sa.Column("embedding_json", sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), "postgresql")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["repository_id"], ["repositories.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_repository_chunks_repository", "repository_chunks", ["repository_id"])
    op.create_index("ix_repository_chunks_path", "repository_chunks", ["repository_id", "path"])

    if op.get_bind().dialect.name == "postgresql":
        op.execute("CREATE EXTENSION IF NOT EXISTS vector")
        op.execute("ALTER TABLE repository_chunks ADD COLUMN embedding vector(1024)")
        op.execute(
            "CREATE INDEX ix_repository_chunks_embedding "
            "ON repository_chunks USING hnsw (embedding vector_cosine_ops)"
        )
