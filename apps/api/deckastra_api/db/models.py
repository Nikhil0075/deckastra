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
    CheckConstraint,
    DateTime,
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


__all__ = [
    "AgentMemoryRow",
    "AgentRunRow",
    "Base",
    "JsonColumn",
    "Presentation",
    "PresentationVersion",
    "Project",
    "TransactionRow",
    "User",
    "Workspace",
    "WorkspaceMember",
]
