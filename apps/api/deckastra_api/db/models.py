"""Relational model (doc 05 §21, with the gap-register S1 items closed).

Two things the original §21 table list was missing, both flagged as S1 in
`docs/00_DOCUMENT_REVIEW_AND_GAP_REGISTER.md`:

* **`workspace_members`.** `workspaces` carried an `owner_id` and nothing else, so
  §27's authorization chain could not be resolved for anyone but the owner and
  §26's promised team permissions had no home. Adding it now makes a
  single-member workspace a special case of the general model rather than a
  migration later.

* **Transaction `status`, `parent_version_id` and `result_version_id`.** Without
  status there is nowhere for a proposed-but-unapplied change to live, which is
  what doc 01 §11.2's proposal-before-apply requires; without the two version
  columns the lineage of an applied change is implicit and cannot be replayed.

Portability note: types are chosen so the schema runs on both PostgreSQL and
SQLite. `JSONB` is the right column type on Postgres, but SQLAlchemy's `JSON`
renders as `JSONB` there via the variant below while still working in a SQLite
test database. That matters because the store's behaviour — optimistic
concurrency, snapshot replay — is worth testing on every push, and requiring a
container for that means it stops being tested.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

# JSONB on Postgres, plain JSON elsewhere. One column definition, two dialects.
JsonColumn = JSON().with_variant(JSONB(), "postgresql")


class Base(DeclarativeBase):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, server_default=func.now(), nullable=False
    )


# ------------------------------------------------------------------- identity


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    name: Mapped[str | None] = mapped_column(String(200))

    memberships: Mapped[list[WorkspaceMember]] = relationship(back_populates="user")


class Workspace(Base, TimestampMixin):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Kept for convenience and for "who pays", but it is NOT the authorization
    # source — membership is. An owner_id-only model cannot answer "may this user
    # open this deck" for anyone else.
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)

    owner: Mapped[User] = relationship(foreign_keys=[owner_id])
    members: Mapped[list[WorkspaceMember]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan"
    )
    projects: Mapped[list[Project]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan"
    )


class WorkspaceMember(Base, TimestampMixin):
    """Closes doc 05 S1.

    Roles are ordered: owner > admin > editor > viewer. Authorization asks
    "is this user's role at least X", never "is this user the owner".
    """

    __tablename__ = "workspace_members"
    __table_args__ = (
        UniqueConstraint("workspace_id", "user_id", name="uq_workspace_member"),
        CheckConstraint(
            "role IN ('owner', 'admin', 'editor', 'viewer')", name="ck_workspace_member_role"
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False)

    workspace: Mapped[Workspace] = relationship(back_populates="members")
    user: Mapped[User] = relationship(back_populates="memberships")


# ------------------------------------------------------------------- content


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )

    # Declared as relationships, not just FK columns. SQLAlchemy's unit of work
    # orders INSERTs from mapper relationships, so a workspace and a project
    # created in the same flush would otherwise be written in arbitrary order and
    # trip the foreign key.
    workspace: Mapped[Workspace] = relationship(back_populates="projects")
    creator: Mapped[User] = relationship(foreign_keys=[created_by])
    presentations: Mapped[list[Presentation]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class Presentation(Base, TimestampMixin):
    __tablename__ = "presentations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    # The head of the version chain. Nullable only in the instant between
    # inserting the presentation and its first version.
    current_version_id: Mapped[str | None] = mapped_column(String(64))
    schema_version: Mapped[str] = mapped_column(String(20), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )

    project: Mapped[Project] = relationship(back_populates="presentations")
    versions: Mapped[list[PresentationVersion]] = relationship(
        back_populates="presentation", cascade="all, delete-orphan"
    )
    transactions: Mapped[list[TransactionRow]] = relationship(
        back_populates="presentation", cascade="all, delete-orphan"
    )


class PresentationVersion(Base, TimestampMixin):
    """A point in a presentation's history.

    Snapshot-plus-operations (doc 05 §22): most versions carry only the
    transaction that produced them, and a full `snapshot_json` is written
    periodically so replay never has to start from the beginning. Storing a full
    copy for every small edit is what the operation log exists to avoid.
    """

    __tablename__ = "presentation_versions"
    __table_args__ = (
        Index("ix_versions_presentation_created", "presentation_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    presentation_id: Mapped[str] = mapped_column(
        ForeignKey("presentations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Null for the first version. Self-referential rather than a FK so a version
    # can be inserted in the same flush as its parent.
    parent_version_id: Mapped[str | None] = mapped_column(String(64), index=True)
    snapshot_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn)
    # How far this version is from the nearest snapshot. Cheap to read, and it is
    # what decides when to write the next one.
    ops_since_snapshot: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    label: Mapped[str | None] = mapped_column(String(200))

    presentation: Mapped[Presentation] = relationship(back_populates="versions")


class TransactionRow(Base, TimestampMixin):
    """The durable change record (doc 02 §31.5).

    The column set mirrors the schema's `Transaction` type deliberately — doc 03
    §16 and doc 05 §11 previously defined their own near-identical shapes, and
    reconciling them onto one definition is cross-cutting item #2.
    """

    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'applied', 'rejected', 'expired', 'reverted')",
            name="ck_transaction_status",
        ),
        CheckConstraint(
            "source IN ('user', 'agent', 'system', 'import')", name="ck_transaction_source"
        ),
        Index("ix_transactions_presentation_created", "presentation_id", "created_at"),
        Index("ix_transactions_status", "presentation_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    presentation_id: Mapped[str] = mapped_column(
        ForeignKey("presentations.id", ondelete="CASCADE"), nullable=False
    )

    # Closes doc 05 S1: without status a proposal has nowhere to live, and without
    # both version columns the lineage of an applied change is implicit.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="applied")
    parent_version_id: Mapped[str] = mapped_column(String(64), nullable=False)
    result_version_id: Mapped[str | None] = mapped_column(String(64))

    source: Mapped[str] = mapped_column(String(20), nullable=False)
    agent_id: Mapped[str | None] = mapped_column(String(64))
    client_id: Mapped[str | None] = mapped_column(String(64))
    user_instruction: Mapped[str | None] = mapped_column(Text)
    intent: Mapped[str] = mapped_column(Text, nullable=False)

    operations_json: Mapped[list[Any]] = mapped_column(JsonColumn, nullable=False)
    inverse_operations_json: Mapped[list[Any]] = mapped_column(JsonColumn, nullable=False)

    reason: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column()
    source_ids_json: Mapped[list[Any] | None] = mapped_column(JsonColumn)
    risk_tier: Mapped[str | None] = mapped_column(String(10))

    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # A proposal that nobody answered must not sit pending forever: doc 02 §31.6
    # gives one a 24h life, after which it expires rather than silently applying
    # or silently vanishing. Null for anything that was never a proposal.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The run that produced it, so an agent change can be traced to its events,
    # its budget and its sources.
    run_id: Mapped[str | None] = mapped_column(String(64), index=True)

    presentation: Mapped[Presentation] = relationship(back_populates="transactions")


class AgentRunRow(Base, TimestampMixin):
    """One agent run (doc 03 §19).

    Separate from `transactions` because a run and a change are not the same
    thing: a run may end in no change at all (a clarification, a refusal, a
    rejected proposal), and a change may be reverted long after its run is
    finished. Keeping them apart is what lets the agent inspector show *why*
    something was proposed even when it was not applied.

    The state itself lives in LangGraph's checkpoint tables. This row is the
    index: what the run was for, where it got to, and what it spent.
    """

    __tablename__ = "agent_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'awaiting_approval', 'completed', 'failed', 'exhausted', 'cancelled')",
            name="ck_agent_run_status",
        ),
        Index("ix_agent_runs_presentation", "presentation_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    presentation_id: Mapped[str | None] = mapped_column(
        ForeignKey("presentations.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)

    status: Mapped[str] = mapped_column(String(24), nullable=False, default="running")
    stage: Mapped[str | None] = mapped_column(String(32))
    intent: Mapped[str] = mapped_column(Text, nullable=False)

    # Ids and short strings only. Doc 03 §19: large artifacts are referenced, not
    # stored — a slide preview in here is a slide preview in every query.
    scope_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn)
    warnings_json: Mapped[list[Any] | None] = mapped_column(JsonColumn)
    errors_json: Mapped[list[Any] | None] = mapped_column(JsonColumn)
    budget_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn)

    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AgentMemoryRow(Base, TimestampMixin):
    """Within-project agent memory (gap register doc 03 S2).

    Scoped to a project, never to an organisation — doc 03 §27 defers
    cross-organisation memory, and one workspace's rejected layout is not
    evidence about another's.

    Only decisions are stored, never content: "the user dismissed a style issue",
    not what the slide said. A memory of content is a copy of the document that
    drifts from it.
    """

    __tablename__ = "agent_memory"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('accepted_layout', 'rejected_proposal', 'dismissed_issue', 'preference')",
            name="ck_agent_memory_kind",
        ),
        Index("ix_agent_memory_project", "project_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    subject: Mapped[str] = mapped_column(String(128), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64))


class GitHubInstallation(Base, TimestampMixin):
    """A GitHub App installation (doc 05 §19).

    Scoped to a workspace, not a user. An installation belongs to the
    organisation that granted it, so it must survive the person who clicked
    install leaving — a token tied to a departed user is a deck that breaks on
    their last day.

    No secret is stored here. The App's private key lives in the environment and
    installation tokens are minted per use and never persisted: a token in a
    database is a token in every backup.
    """

    __tablename__ = "github_installations"
    __table_args__ = (
        UniqueConstraint("github_installation_id", name="uq_github_installation"),
        Index("ix_github_installations_workspace", "workspace_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    github_installation_id: Mapped[str] = mapped_column(String(64), nullable=False)
    account_login: Mapped[str] = mapped_column(String(128), nullable=False)
    installed_by: Mapped[str] = mapped_column(String(64), nullable=False)
    #: Set when GitHub tells us the installation is gone. Kept rather than deleted
    #: so an indexed repository can explain why it stopped updating.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Repository(Base, TimestampMixin):
    """A repository someone connected, and the state of its index.

    `head_sha` versus `indexed_sha` is the staleness signal (gap register doc 05
    S2). Without it a deck silently drifts from `main`: the index is a photograph
    and nothing says when it was taken.
    """

    __tablename__ = "repositories"
    __table_args__ = (
        CheckConstraint(
            "source IN ('github', 'local')", name="ck_repository_source"
        ),
        CheckConstraint(
            "index_status IN ('pending', 'indexing', 'ready', 'failed', 'revoked')",
            name="ck_repository_index_status",
        ),
        UniqueConstraint("workspace_id", "full_name", name="uq_repository_per_workspace"),
        Index("ix_repositories_workspace", "workspace_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    installation_id: Mapped[str | None] = mapped_column(
        ForeignKey("github_installations.id", ondelete="SET NULL")
    )

    source: Mapped[str] = mapped_column(String(16), nullable=False, default="github")
    #: "owner/name", or a local directory's label. The user-facing identity.
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    github_repository_id: Mapped[str | None] = mapped_column(String(64))
    default_branch: Mapped[str] = mapped_column(String(128), nullable=False, default="main")
    description: Mapped[str | None] = mapped_column(Text)
    #: Absolute path, for a local source. Null for GitHub.
    local_path: Mapped[str | None] = mapped_column(Text)

    index_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    index_error: Mapped[str | None] = mapped_column(Text)
    #: The commit the current index was built from.
    indexed_sha: Mapped[str | None] = mapped_column(String(64))
    #: The latest commit we know about, updated by the push webhook. Ahead of
    #: `indexed_sha` means stale.
    head_sha: Mapped[str | None] = mapped_column(String(64))
    last_indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    file_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: Which embedder built the index. A lexical index and a semantic one answer
    #: differently, and a user comparing two decks needs to know which they have.
    embedding_model: Mapped[str | None] = mapped_column(String(64))
    embedding_semantic: Mapped[bool] = mapped_column(default=False, nullable=False)
    #: Languages and frameworks detected at index time.
    profile_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn)
    #: Anything the user should know: a truncated tree, a size quota hit.
    warnings_json: Mapped[list[Any] | None] = mapped_column(JsonColumn)

    chunks: Mapped[list["RepositoryChunk"]] = relationship(
        back_populates="repository", cascade="all, delete-orphan"
    )


class RepositoryChunk(Base, TimestampMixin):
    """One retrievable piece of a repository, with its provenance (doc 02 §30).

    The line range is not decoration. A citation a reader cannot open is not a
    citation, and `path:start-end` is exactly what a GitHub link needs.

    The embedding is stored as JSON here rather than as a `vector` column so the
    same schema works on SQLite. On PostgreSQL a `pgvector` index is created
    alongside it by the migration, and retrieval uses whichever is available —
    see `retrieval.py` for why that trade was made rather than requiring
    PostgreSQL for local development.
    """

    __tablename__ = "repository_chunks"
    __table_args__ = (
        Index("ix_repository_chunks_repository", "repository_id"),
        Index("ix_repository_chunks_path", "repository_id", "path"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    repository_id: Mapped[str] = mapped_column(
        ForeignKey("repositories.id", ondelete="CASCADE"), nullable=False
    )

    path: Mapped[str] = mapped_column(String(1024), nullable=False)
    start_line: Mapped[int] = mapped_column(Integer, nullable=False)
    end_line: Mapped[int] = mapped_column(Integer, nullable=False)
    language: Mapped[str | None] = mapped_column(String(64))
    content: Mapped[str] = mapped_column(Text, nullable=False)

    #: Blob sha of the file this came from. An unchanged sha means the chunk does
    #: not need re-embedding, which is what makes a push re-index incremental.
    file_sha: Mapped[str | None] = mapped_column(String(64))
    #: Why the file was selected, in words. Doc 03 §8 requires the agent to be
    #: able to explain its selection.
    importance: Mapped[float] = mapped_column(default=0.0, nullable=False)
    selection_reason: Mapped[str | None] = mapped_column(Text)

    embedding_json: Mapped[list[Any] | None] = mapped_column(JsonColumn)

    repository: Mapped[Repository] = relationship(back_populates="chunks")


__all__ = [
    "AgentMemoryRow",
    "AgentRunRow",
    "Base",
    "GitHubInstallation",
    "JsonColumn",
    "Presentation",
    "PresentationVersion",
    "Project",
    "Repository",
    "RepositoryChunk",
    "TransactionRow",
    "User",
    "Workspace",
    "WorkspaceMember",
]


class ExportJob(Base, TimestampMixin):
    """One export (doc 04 §32.4, doc 05 §8).

    A row rather than a request, because a 60-slide PDF at 2× takes tens of
    seconds — longer than any HTTP request should live, and long enough that a
    client that loses its connection would have no way to find out whether the
    work finished. So the API returns an id and the client asks about it.

    The artifact is written to disk and the row holds the path. Object storage is
    Phase 9's; what matters now is that the artifact does not live in the
    database, because an export is megabytes and a row read is not.

    The report is stored alongside it because doc 04 §32.2 requires the user to
    see the degradations *before* they download — which means the report has to
    outlive the job that produced it, not stream past during it.
    """

    __tablename__ = "export_jobs"
    __table_args__ = (
        CheckConstraint("kind IN ('pdf', 'pptx')", name="ck_export_kind"),
        CheckConstraint(
            "status IN ('queued', 'running', 'completed', 'failed')",
            name="ck_export_status",
        ),
        Index("ix_export_jobs_presentation", "presentation_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    presentation_id: Mapped[str] = mapped_column(
        ForeignKey("presentations.id", ondelete="CASCADE"), nullable=False
    )
    #: The version exported. An export is of a *version*, not of a presentation:
    #: doc 04 §32.3 keys artifact stability on it, and a deck that changed after
    #: the job started must not silently change what the file contains.
    version_id: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)

    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    options_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn)

    progress: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    stage: Mapped[str | None] = mapped_column(String(24))
    message: Mapped[str | None] = mapped_column(Text)

    artifact_path: Mapped[str | None] = mapped_column(Text)
    filename: Mapped[str | None] = mapped_column(String(255))
    content_type: Mapped[str | None] = mapped_column(String(128))
    bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    report_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn)
    error: Mapped[str | None] = mapped_column(Text)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PresentationShare(Base, TimestampMixin):
    """A way into a presentation for someone outside the workspace
    (gap register doc 01 S2, doc 05 S2).

    The Share button in doc 01 §10 has had no model behind it, and present mode
    has had no access path for an audience — which makes the core use case,
    showing a deck to people, impossible for anyone but the author.

    Two decisions shape the table:

    **A share carries a role, not a boolean.** `viewer` is the audience case and
    the default; `editor` is a colleague without a seat. Storing "is public"
    instead would mean adding a second column the first time someone wants a
    reviewer, and every check would then have two things to consult.

    **The token is stored hashed.** A share link is a bearer credential — anyone
    holding it is authorised — so a database read must not hand out working links
    to every deck in the product. The plaintext is returned once, at creation,
    exactly like an API key.
    """

    __tablename__ = "presentation_shares"
    __table_args__ = (
        CheckConstraint("role IN ('viewer', 'editor')", name="ck_share_role"),
        # One lookup per request on the hash, so it is indexed and unique: two
        # shares hashing the same would silently grant access to the wrong deck.
        UniqueConstraint("token_hash", name="uq_share_token"),
        Index("ix_shares_presentation", "presentation_id", "revoked_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    presentation_id: Mapped[str] = mapped_column(
        ForeignKey("presentations.id", ondelete="CASCADE"), nullable=False
    )
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)

    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="viewer")
    label: Mapped[str | None] = mapped_column(String(255))

    #: Null means it does not expire. Never expiring is the right default for
    #: "send this to a client today"; an expiry is what makes a link safe to send
    #: to a room you do not control.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: Revoked rather than deleted, so "who could see this, and when did that
    #: stop" survives — the question asked after something leaks.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    #: Enough to answer "is anyone using this link?" without a second table. A
    #: per-visit log is later work; a count and a timestamp are what a user looks
    #: at.
    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class WorkspaceQuota(Base, TimestampMixin):
    """What a workspace is allowed to spend (gap register doc 01 S3).

    Model spend is the dominant variable cost, and Phase 5 `RunBudget` has had
    nothing to reference: it enforces per-run ceilings, which stop one runaway
    generation and do nothing about a hundred ordinary ones.

    Counters are stored rather than derived. Summing every agent run to answer
    "may this proceed" is a table scan on the hot path, and the answer has to be
    right at the moment of asking rather than eventually.

    `period_start` is what makes this a monthly allowance rather than a lifetime
    one, and the reset is **lazy** — the first request of a new period rolls the
    counters. A scheduled job that misses a month would silently lock every
    workspace out.
    """

    __tablename__ = "workspace_quotas"

    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )

    plan: Mapped[str] = mapped_column(String(32), nullable=False, default="free")

    #: The allowance. Null means unlimited, for a plan with no ceiling — which is
    #: a different thing from 0, meaning "allowed nothing".
    monthly_generations: Mapped[int | None] = mapped_column(Integer)
    monthly_tokens: Mapped[int | None] = mapped_column(Integer)
    storage_bytes: Mapped[int | None] = mapped_column(Integer)
    max_repositories: Mapped[int | None] = mapped_column(Integer)

    period_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    used_generations: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    used_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    #: Storage is a level, not a flow, so it is counted from the assets rather
    #: than reset with the month.
    used_storage_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class Asset(Base, TimestampMixin):
    """An uploaded or generated file (gap register doc 05 S2).

    The gap: `assets` had no soft delete, no reference counting, no orphan
    cleanup and no quota, so generated images accumulated forever and deleting a
    slide silently orphaned its uploads.

    **Reference counting, not cascade.** An asset can be used by several slides
    and by several *versions* of the same slide — the version history is the whole
    product — so deleting a slide must not delete the image it used.
    `reference_count` is recomputed from the documents that cite it, and an asset
    reaching zero becomes a candidate for cleanup rather than a deletion.

    **Soft delete with a grace period.** A user who deletes a slide and undoes it
    expects the picture back. `deleted_at` starts the clock; only the sweeper
    removes bytes, and only after the grace period.
    """

    __tablename__ = "assets"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('image', 'video', 'audio', 'font', 'document')", name="ck_asset_kind"
        ),
        Index("ix_assets_workspace", "workspace_id", "deleted_at"),
        # The sweeper query: unreferenced assets, oldest first.
        Index("ix_assets_orphans", "reference_count", "deleted_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)

    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="image")
    #: Opaque, resolved to a signed URL at render time (doc 02, doc 05 §24). A
    #: canonical document must never carry a transient signed URL.
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    filename: Mapped[str | None] = mapped_column(String(255))
    content_type: Mapped[str | None] = mapped_column(String(128))
    bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)

    #: How many live documents cite this asset. Recomputed rather than
    #: incremented: an increment missed once is wrong forever, and the documents
    #: are the truth.
    reference_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Theme(Base, TimestampMixin):
    """A workspace brand, as something an organisation can enforce
    (gap register doc 05 S2).

    Themes have lived only inside document JSON, so every deck carries its own
    copy and nobody can change the brand in one place. Doc 02 §22 calls the theme
    "a design contract" agents reference; a contract each document holds a private
    copy of is not one.

    **The document keeps its resolved snapshot.** A `themeId` alone would make a
    `.mydeck` file unopenable outside the workspace that owns the theme, and doc
    02 first rule is that a document is portable and safe to email. So the
    document carries both: the id, so a brand change can be re-applied, and the
    resolved tokens, so the file renders anywhere.
    """

    __tablename__ = "themes"
    __table_args__ = (
        UniqueConstraint("workspace_id", "name", name="uq_theme_name"),
        Index("ix_themes_workspace", "workspace_id", "archived_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    #: The full `ThemeDefinition`, validated against the generated schema before
    #: it is stored. One definition, generated downward — there is no second
    #: Python model of a theme.
    definition_json: Mapped[dict[str, Any]] = mapped_column(JsonColumn, nullable=False)

    #: Exactly one default per workspace, enforced in the service rather than by
    #: a partial index: SQLite has none, and the two dialects would then disagree
    #: about what is legal.
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
