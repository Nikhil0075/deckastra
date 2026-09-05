"""Persistence for agent runs and project memory.

Kept out of `agent_service.py` for the same reason the agent package has no
database imports: the boundary is easier to keep when crossing it means changing
files.

`SqlMemoryStore` implements the `MemoryStore` protocol the agent package
declares, so the agents talk to an interface and this talks to SQLAlchemy.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from deckastra_agents.memory import MemoryEntry
from sqlalchemy.orm import Session

from .db.models import AgentMemoryRow, AgentRunRow
from .ids import new_id


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------- runs


def start_run(
    session: Session,
    *,
    project_id: str,
    presentation_id: str | None,
    created_by: str,
    intent: str,
    scope: dict[str, Any] | None = None,
) -> AgentRunRow:
    run = AgentRunRow(
        id=new_id("run"),
        presentation_id=presentation_id,
        project_id=project_id,
        created_by=created_by,
        status="running",
        stage="orchestrate",
        intent=intent,
        scope_json=scope,
    )
    session.add(run)
    session.flush()
    return run


def finish_run(
    session: Session,
    run: AgentRunRow,
    *,
    status: str,
    stage: str | None = None,
    warnings: list[str] | None = None,
    errors: list[dict[str, Any]] | None = None,
    budget: dict[str, Any] | None = None,
) -> AgentRunRow:
    run.status = status
    run.stage = stage or run.stage
    run.warnings_json = warnings or []
    run.errors_json = errors or []
    run.budget_json = budget or {}
    run.finished_at = _now()
    session.flush()
    return run


def get_run(session: Session, run_id: str) -> AgentRunRow | None:
    return session.get(AgentRunRow, run_id)


def recent_runs(session: Session, presentation_id: str, limit: int = 20) -> list[AgentRunRow]:
    return (
        session.query(AgentRunRow)
        .filter(AgentRunRow.presentation_id == presentation_id)
        .order_by(AgentRunRow.created_at.desc())
        .limit(limit)
        .all()
    )


# -------------------------------------------------------------------- memory


class SqlMemoryStore:
    """The agent package's `MemoryStore`, backed by a session.

    Holds the session rather than opening one: memory writes belong to the same
    transaction as the decision that produced them. A rejection that is recorded
    but whose memory write fails would teach the Critic nothing and leave nobody
    the wiser.
    """

    def __init__(self, session: Session, created_by: str | None = None) -> None:
        self._session = session
        self._created_by = created_by

    def add(self, entry: MemoryEntry) -> None:
        self._session.add(
            AgentMemoryRow(
                id=new_id("mem"),
                project_id=entry.project_id,
                kind=entry.kind,
                subject=entry.subject[:128],
                note=entry.note,
                created_by=self._created_by,
            )
        )
        self._session.flush()

    def recent(self, project_id: str, limit: int = 50) -> list[MemoryEntry]:
        rows = (
            self._session.query(AgentMemoryRow)
            .filter(AgentMemoryRow.project_id == project_id)
            .order_by(AgentMemoryRow.created_at.desc())
            .limit(limit)
            .all()
        )

        return [
            MemoryEntry(
                project_id=row.project_id,
                kind=row.kind,  # type: ignore[arg-type]
                subject=row.subject,
                note=row.note,
                created_at=(
                    row.created_at.replace(tzinfo=timezone.utc)
                    if row.created_at and not row.created_at.tzinfo
                    else row.created_at
                ).timestamp()
                if row.created_at
                else _now().timestamp(),
            )
            # Reversed so callers see oldest first, which is what `recent(limit)`
            # in the protocol means — the query orders by newest to get the last
            # N, not to return them backwards.
            for row in reversed(rows)
        ]
