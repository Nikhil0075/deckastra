"""Database engine and session handling.

Synchronous SQLAlchemy, not async. FastAPI runs sync endpoint functions in a
thread pool, so a synchronous session is correct there and considerably easier to
reason about — and the alternative buys nothing until there is measured
connection-pool pressure, which there is not.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from starlette.requests import Request

from .models import Base
from .. import assistant_models  # register additive assistant tables for create_all
from .. import credit_models  # register hosted account accounting tables
from .. import account_models  # register cloud erasure queue
from .. import import_models  # exchange package jobs and opaque extras

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


async def session_middleware(request: Request, call_next: Callable[[Request], Any]) -> Any:
    """One session per request, committed *before* the response is sent.

    This is a middleware rather than a dependency with `yield` for one reason.
    FastAPI runs a yield-dependency's teardown after the response has gone out,
    so a client that reads a write's response and immediately issues the next
    request can beat the commit and be told the row does not exist. That is not
    theoretical: connecting a repository and indexing it are two calls a UI makes
    back to back, and the second returned 404 until this moved.

    Rolling back on a 4xx or 5xx keeps the previous behaviour, where an exception
    discarded the partial write.
    """
    session = get_sessionmaker()()
    request.state.db = session

    try:
        response = await call_next(request)
    except Exception:
        session.rollback()
        raise
    else:
        if response.status_code < 400:
            session.commit()
        else:
            session.rollback()
        return response
    finally:
        session.close()


def get_session(request: Request) -> Iterator[Session]:
    """FastAPI dependency: the session the middleware opened for this request."""
    session: Session | None = getattr(request.state, "db", None)
    if session is not None:
        yield session
        return

    # No middleware — a test calling a router directly, or an ASGI path that does
    # not go through it. Owning the transaction here keeps that case correct.
    with session_scope() as fallback:
        yield fallback


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

def supports_row_locks(session: Session) -> bool:
    """Whether `SELECT ... FOR UPDATE` means anything on this engine.

    PostgreSQL locks rows; SQLite has no such statement and SQLAlchemy **silently
    drops the clause**, so code written as though it locks simply does not. That
    is safe here for one reason worth stating rather than assuming: a SQLite
    install is one desktop app with one service process, and SQLite itself
    serialises writers. It is not safe if either of those stops being true.

    Callers branch on this so the difference is visible in the code that depends
    on it, instead of being a clause that reads as protection and is not.
    """
    return session.get_bind().dialect.name == "postgresql"


def ensure_physical_transaction(session: Session) -> None:
    """Make sure a real transaction is open before a savepoint is taken.

    sqlite3's legacy transaction mode does not issue a `BEGIN` for a SELECT or a
    SAVEPOINT, so a savepoint taken outside one is released straight to disk —
    the write survives even if the request afterwards rolls back, which is the
    opposite of what a savepoint is for. PostgreSQL is already in a transaction
    by the time any of this runs and this is a no-op there.

    Call it before every `session.begin_nested()` that must be undoable.
    """
    connection = session.connection()
    if (
        connection.dialect.name == "sqlite"
        and not connection.connection.driver_connection.in_transaction
    ):
        connection.exec_driver_sql("BEGIN")
