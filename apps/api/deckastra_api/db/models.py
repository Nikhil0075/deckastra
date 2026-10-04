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
    identities: Mapped[list[AuthIdentity]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class UserPreference(Base, TimestampMixin):
    """A person's own editor settings that should follow them between devices.

    The Add library's recent and favourite items were kept in one browser only
    (design review, 2026-09-27). They are not about any deck, so they live with
    the user, keyed by a short name the service allowlists, and never with a
    workspace, where they would be shared with everyone in it.
    """

    __tablename__ = "user_preferences"
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_user_preferences_user_key"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    key: Mapped[str] = mapped_column(String(64), nullable=False)
    value_json: Mapped[Any] = mapped_column(JsonColumn, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, server_default=func.now(), nullable=False
    )


class AuthIdentity(Base, TimestampMixin):
    """A stable external login mapped to one Deckastra user.

    Email addresses can change and can be reused. The issuer/subject pair is the
    identity provider's immutable account key, so authorization never depends on
    an email claim after the first verified sign-in.
    """

    __tablename__ = "auth_identities"
    __table_args__ = (
        UniqueConstraint("issuer", "subject", name="uq_auth_identity_subject"),
        Index("ix_auth_identities_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    issuer: Mapped[str] = mapped_column(String(512), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    provider: Mapped[str | None] = mapped_column(String(64))
    email_at_link: Mapped[str] = mapped_column(String(320), nullable=False)

    user: Mapped[User] = relationship(back_populates="identities")


class Workspace(Base, TimestampMixin):
    __tablename__ = "workspaces"
    __table_args__ = (
        CheckConstraint("origin IN ('local', 'cloud')", name="ck_workspace_origin"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    #: Where this workspace's authority lives (D5.1).
    #:
    #: `local` is a workspace this machine owns outright — the personal one a
    #: desktop install seeds, whose decks have never left the device. `cloud` is a
    #: mirror of a workspace the server owns, kept here so the app works offline.
    #:
    #: The distinction exists because the two cannot be authorized the same way.
    #: A local workspace's owner is genuinely its owner; a mirrored one's roles
    #: are a *cache*, and a cache is not authorization. Without a column saying
    #: which is which, a desktop that signed in would have no way to tell its own
    #: decks from someone else's, and local mode's "everyone is OWNER" posture
    #: would silently extend over both.
    origin: Mapped[str] = mapped_column(String(10), default="local", nullable=False)
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

    #: When the authority that owns this workspace last vouched for this row
    #: (D5.4), and the only thing that makes a role in a `cloud` workspace mean
    #: anything.
    #:
    #: In a `local` workspace the row *is* the authority and this is never
    #: consulted — which is why nothing sets it there, and why the migration that
    #: added it backfilled nothing: a stamp would record a fact nobody
    #: established. In a mirrored one the row is a **cache**, and a cache is not
    #: authorization — so it authorizes only while it has been confirmed, and a
    #: row that appeared any other way carries no confirmation and grants
    #: nothing. That is what makes the rule hold without a special case for the
    #: local singleton account: nothing can confirm a membership for an identity
    #: this machine invented.
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    #: Set when the authority says the membership is gone. Immediate, rather than
    #: waiting out the confirmation window — a revocation that is *known* and
    #: still honoured for a fortnight is not a revocation.
    #:
    #: The row is kept rather than deleted: "who could see this, and when did that
    #: stop" is the question asked afterwards, which is the same reason a revoked
    #: share link is kept.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

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

    #: The server version this device last mirrored, in the **server's** version
    #: ids (D5.6). Null for a deck that has never been pulled.
    #:
    #: It has to be recorded separately because version ids are the one identity
    #: that does *not* travel (D5.0): `commit_transaction` mints its own and takes
    #: none from a caller, so the local chain and the remote chain share content
    #: and nothing else. This column is the only thing that can answer "which
    #: server version is this copy of", which is what a later push needs in order
    #: to say what its change is based on, and what divergence detection compares.
    remote_version_id: Mapped[str | None] = mapped_column(String(64))

    #: Slides in the head version, kept current by every commit the way `title`
    #: is. A deck list shows it on every card, and listing a project must not
    #: cost a replay of every deck in it. Null only for rows written before the
    #: column existed; the list fills those in once, on first sight.
    slide_count: Mapped[int | None] = mapped_column(Integer)

    #: Set when a person deletes the deck (editor Phase 4). Soft, like an
    #: asset's `deleted_at` and a theme's `archived_at`: a deck is someone's
    #: work, and "Delete" pressed on the wrong card must be undoable. Every read
    #: through `resolve_presentation_access` treats a deleted deck as missing —
    #: the same 404 a stranger gets — except `restore`, which asks for it.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

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
        # D5.2. The receiving half of idempotent sync: a device that retries an
        # upload it never heard the answer to must land the change once. Scoped
        # to the presentation because a key only has to be unique where it is
        # applied, and nullable because nothing that does not sync needs one —
        # SQLite and PostgreSQL both allow repeated NULLs in a unique index.
        UniqueConstraint("presentation_id", "change_key", name="uq_transaction_change_key"),
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

    #: What this change is called on the wire (D5.2), minted by whichever device
    #: authored it and stable across every retry of its upload.
    #:
    #: **Not the version id, deliberately.** D5.0 found that `commit_transaction`
    #: mints its own `ver_…` and takes none from a caller, so a replayed change is
    #: the same content under a different identity. Making the caller supply the
    #: version id instead would tie idempotency to *where the change landed* —
    #: and the case sync exists for is divergence, where a change rebased behind
    #: someone else's edit lands at a different version than it did locally. A key
    #: that identifies the **change** survives that; one that identifies the
    #: version does not.
    change_key: Mapped[str | None] = mapped_column(String(64))

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
            "status IN ('queued', 'running', 'completed', 'failed', 'cancelled')",
            name="ck_export_status",
        ),
        UniqueConstraint(
            "presentation_id", "created_by", "idempotency_key", name="uq_export_idempotency"
        ),
        Index("ix_export_jobs_presentation", "presentation_id", "created_at"),
        Index("ix_export_jobs_claim", "status", "next_attempt_at", "lease_expires_at"),
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
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    lease_owner: Mapped[str | None] = mapped_column(String(128))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

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

    #: The exact version this link shows, or null to follow the deck (D5.5).
    #:
    #: Presenting is the case that needs it. An audience watching a link must not
    #: have the slide change under them because a colleague edited it or an agent
    #: proposal applied — and on a projector that is not a small annoyance, it is
    #: the talk going wrong in front of a room. Pinning makes the link a
    #: *photograph* of the deck rather than a window onto it.
    #:
    #: Null stays the default, because "send this to a client and keep fixing
    #: typos" is the other real use and pinning would freeze the typos in.
    version_id: Mapped[str | None] = mapped_column(String(64))

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

    #: Characters sent to a speech service this period (integration plan 01 §3.8).
    #: Speech is billed by the character, and a twenty-language deck re-voiced
    #: after every edit is the shape that cost takes.
    monthly_speech_characters: Mapped[int | None] = mapped_column(Integer)
    used_speech_characters: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

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
    #: For audio: how long it plays, read from the file's own container rather
    #: than from what anyone said about it (integration plan 01 §3.8). A narrated
    #: deck advances on this number, so a guessed one cuts a narrator off.
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    #: For audio: 256 peaks, 0..1, computed once when the file arrives, so the
    #: timeline draws a waveform without decoding anything (plan 01 §3.6).
    waveform_peaks: Mapped[list[float] | None] = mapped_column(JsonColumn)
    tags: Mapped[list[str] | None] = mapped_column(JsonColumn)
    description: Mapped[str | None] = mapped_column(Text)
    sha256: Mapped[str | None] = mapped_column(String(64))
    dhash64: Mapped[str | None] = mapped_column(String(16))
    metadata_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

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


class SyncOutboxRow(Base, TimestampMixin):
    """One thing this device owes the server (D5.2).

    The outbox exists because of one ordering rule: **the record of what to send
    is written in the same database transaction as the change it describes.** A
    device that committed a version and then enqueued it separately loses the
    enqueue to any crash in between — and loses it silently, because the deck
    looks right locally and simply never reaches anyone. So `commit_transaction`
    writes both inside its own savepoint, and there is no code path that can
    produce a syncable change without producing its outbox row.

    Only decks in a `cloud`-origin workspace get rows (D5.1). A local deck has
    nowhere to go, and an outbox full of changes for decks that will never sync
    is a queue nobody can read.

    Two kinds, because a deck reaches a server in two different shapes:

    * `create` — the deck itself, as the snapshot its first version holds. There
      is no transaction to point at: `create_presentation` writes a version and
      no change row.
    * `change` — one applied transaction, by id.
    * `asset` — the bytes of one uploaded file (D5.5), queued **before** the
      change that first cites it. A document referencing an image the server has
      never received is a deck that arrives broken for everyone else.

    Rows are kept after they are sent rather than deleted: "what did this device
    send, and when" is the question asked when two sides disagree, which is the
    whole of D5.3. Pruning them is not implemented.
    """

    __tablename__ = "sync_outbox"
    __table_args__ = (
        CheckConstraint("kind IN ('create', 'change', 'asset')", name="ck_outbox_kind"),
        # Four states, and none of them is the queue giving up on its own (D5.3):
        #
        # `pending`  — waiting its turn, or waiting out a transport backoff.
        # `sent`     — the server took it.
        # `blocked`  — the server *refused* it: the deck moved there and this
        #              change no longer applies. Retrying that on a timer is a
        #              loop with no exit, so it stops and becomes a question for
        #              a person, which is what "a change that cannot upload is
        #              something a person has to see" actually requires.
        # `superseded` — a person reconciled, and a later change now carries this
        #              one's intent. Terminal because someone decided it, never
        #              because the queue tired of trying.
        CheckConstraint(
            "status IN ('pending', 'sent', 'blocked', 'superseded')", name="ck_outbox_status"
        ),
        # The drain sends a deck's rows in the order they were written. `id` is
        # the tie-break so two changes committed in the same instant keep one
        # order — a log is a sequence, not a set (D5.0).
        Index("ix_outbox_ready", "status", "next_attempt_at"),
        Index("ix_outbox_presentation", "presentation_id", "id"),
        # Per presentation, matching `transactions.change_key`. A key only has
        # to be unique where it is applied, and that is what lets two devices
        # mint keys with no coordinator between them — a global constraint would
        # make an unlucky collision across two unrelated decks silently swallow
        # someone's change.
        UniqueConstraint("presentation_id", "change_key", name="uq_outbox_change_key"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    presentation_id: Mapped[str] = mapped_column(
        ForeignKey("presentations.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    #: The transaction to upload. Null for a `create`, which predates any, and
    #: for an `asset`, which is not a change to the document at all.
    transaction_id: Mapped[str | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE")
    )

    #: The file to upload (D5.5). Set only on an `asset` row.
    #:
    #: Queued against the *deck* rather than its workspace, which is not where an
    #: asset lives but is where the ordering constraint lives: the bytes must
    #: arrive before the change that cites them, and "before" only means anything
    #: inside one deck's sequence. It also keeps the queue honest about what it is
    #: for — an image uploaded and never used in a deck that syncs is bandwidth
    #: nobody asked for.
    asset_id: Mapped[str | None] = mapped_column(
        ForeignKey("assets.id", ondelete="CASCADE")
    )

    #: The key this device will upload under, and the one the server dedupes on.
    #:
    #: Held here as well as on `transactions.change_key` because the two are
    #: different roles that happen to share a value in transit: this is "what I
    #: will send", that is "what I have applied". They are never read by the same
    #: machine, so this is a wire value rather than a second source of truth — and
    #: a `create` has no transaction to borrow one from.
    change_key: Mapped[str] = mapped_column(String(64), nullable=False)

    status: Mapped[str] = mapped_column(String(10), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: What went wrong last time, kept in full. A queue that says only "failed"
    #: sends someone to read logs that a desktop install does not keep.
    last_error: Mapped[str | None] = mapped_column(Text)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: Where it landed on the server. Not the local version id — those are two
    #: chains (D5.0) — so recording it is how this device can later say "the
    #: change I called X is version Y over there".
    remote_version_id: Mapped[str | None] = mapped_column(String(64))

    #: When the server refused it (D5.3), which is the boundary a resolution has
    #: to sit after.
    #:
    #: Queue order is not enough, and that was a real bug: every change already
    #: waiting behind a refusal sits after it in the queue, yet those were
    #: authored before anyone knew there was a conflict and cannot have
    #: incorporated a merge. Accepting one as the resolution retired every change
    #: between it and the refusal (found by review, 2026-09-17). The test is
    #: **time**: a resolution is a change made after the refusal happened.
    refused_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    #: Why the server refused this change, in its own words (D5.3). Separate from
    #: `last_error`, which is the transport failing and will be retried: this one
    #: will not be, and the distinction is the whole of divergence handling.
    refused_reason: Mapped[str | None] = mapped_column(Text)

    #: The deck as the **server** had it when it refused.
    #:
    #: Kept locally, and that is the point: a person who diverged on a plane can
    #: reconcile on the plane. A design that fetched the other side at reconcile
    #: time would make resolving a conflict require the network that was missing
    #: when the conflict happened — which is backwards for a local-first product.
    #:
    #: Held on the row rather than in a table of its own because a deck has at
    #: most one of these at a time: the queue stops at the refusal, so this row
    #: *is* the point of divergence. It is a whole document, so it is written
    #: only for a `blocked` row and cleared when the divergence is resolved.
    remote_document_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn)
