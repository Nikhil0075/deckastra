"""Database engine and session handling.

Synchronous SQLAlchemy, not async. FastAPI runs sync endpoint functions in a
thread pool, so a synchronous session is correct there and considerably easier to
reason about — and the alternative buys nothing until there is measured
connection-pool pressure, which there is not.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from .models import Base

DEFAULT_URL = "postgresql+psycopg://deckastra:deckastra_local@localhost:5432/deckastra"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_URL)


_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def get_engine() -> Engine:
    global _engine, _SessionLocal

    if _engine is None:
        url = database_url()
        _engine = create_engine(
            url,
            # Recycle before typical idle-connection timeouts so a pooled
            # connection is never handed out already dead.
            pool_pre_ping=True,
            future=True,
            # SQLite is used by the tests; it needs the same connection across
            # threads for an in-memory database to survive.
            connect_args={"check_same_thread": False} if url.startswith("sqlite") else {},
        )

        if url.startswith("sqlite"):
            # SQLite ignores foreign keys unless asked. The store relies on
            # cascades and FK integrity, so a test database that quietly does not
            # enforce them would pass tests the real database would fail.
            @event.listens_for(_engine, "connect")
            def _fk_on(dbapi_connection, _record):  # type: ignore[no-untyped-def]
                cursor = dbapi_connection.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()

        _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)

    return _engine


def get_sessionmaker() -> sessionmaker[Session]:
    get_engine()
    assert _SessionLocal is not None
    return _SessionLocal


@contextmanager
def session_scope() -> Iterator[Session]:
    """A transactional scope. Commits on success, rolls back on any exception."""
    session = get_sessionmaker()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""
    with session_scope() as session:
        yield session


def create_all() -> None:
    """Create the schema directly, for tests and first-run local development.

    Production uses Alembic. This exists so a test does not need a migration run,
    and the two are kept honest by a test that asserts the migration produces the
    same tables as the models.
    """
    Base.metadata.create_all(get_engine())


def reset_engine() -> None:
    """Drop the cached engine. Tests use it to point at a fresh database."""
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None
