"""A SQLite writer waits for another's lock instead of failing (2026-10-04).

The desktop smoke sweep lost a translation one run in three: the request's
INSERT met another request's open write transaction, waited the driver's
default 5 seconds, and failed with "database is locked". The engine now waits
`SQLITE_LOCK_WAIT_SECONDS`. These pin the setting where SQLite itself reports
it, and show a write that overlaps another write going through.
"""

from __future__ import annotations

import threading
import time

import pytest
from sqlalchemy import text

from deckastra_api.db import session as db_session


@pytest.fixture
def file_engine(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'lock.db'}")
    previous = (db_session._engine, db_session._SessionLocal)
    db_session._engine = None
    db_session._SessionLocal = None
    try:
        yield db_session.get_engine()
    finally:
        db_session._engine.dispose()
        db_session._engine, db_session._SessionLocal = previous


def test_sqlite_connections_wait_for_a_lock(file_engine):
    with file_engine.connect() as connection:
        waited = connection.exec_driver_sql("PRAGMA busy_timeout").scalar()
    assert waited == db_session.SQLITE_LOCK_WAIT_SECONDS * 1000
    # Longer than the driver's default, which is what failed.
    assert db_session.SQLITE_LOCK_WAIT_SECONDS > 5


def test_a_write_that_overlaps_another_write_waits_and_succeeds(file_engine):
    with file_engine.begin() as connection:
        connection.execute(text("CREATE TABLE t (n INTEGER)"))

    holding = threading.Event()

    def hold_the_lock() -> None:
        with file_engine.begin() as connection:
            connection.execute(text("INSERT INTO t VALUES (1)"))
            holding.set()
            time.sleep(1.0)

    holder = threading.Thread(target=hold_the_lock)
    holder.start()
    assert holding.wait(5)
    with file_engine.begin() as connection:
        connection.execute(text("INSERT INTO t VALUES (2)"))
    holder.join()
    with file_engine.connect() as connection:
        assert sorted(connection.execute(text("SELECT n FROM t")).scalars()) == [1, 2]


def test_two_writers_that_read_first_take_turns_instead_of_deadlocking(file_engine):
    """The failure the sweep actually hit. Each request reads, then writes, in a
    transaction `ensure_physical_transaction` opened. With a deferred `BEGIN`,
    both read under shared locks, the second's write took the reserved lock,
    and the first's write was refused at once: SQLite does not wait out a lock
    the waiter is itself blocking, whatever the timeout. A transaction that is
    going to write takes the write lock when it begins, so the second waits.
    """
    with file_engine.begin() as connection:
        connection.execute(text("CREATE TABLE t (n INTEGER)"))
    maker = db_session.get_sessionmaker()
    first_read = threading.Event()
    errors: list[BaseException] = []

    def writer(n: int, read_first: threading.Event | None, wait_for: threading.Event | None) -> None:
        try:
            if wait_for is not None:
                assert wait_for.wait(5)
            session = maker()
            try:
                db_session.ensure_physical_transaction(session)
                session.execute(text("SELECT count(*) FROM t")).scalar()
                if read_first is not None:
                    read_first.set()
                    time.sleep(0.5)
                session.execute(text("INSERT INTO t VALUES (:n)"), {"n": n})
                session.commit()
            finally:
                session.close()
        except BaseException as error:  # noqa: BLE001 - reported below
            errors.append(error)

    a = threading.Thread(target=writer, args=(1, first_read, None))
    b = threading.Thread(target=writer, args=(2, None, first_read))
    a.start()
    b.start()
    a.join(40)
    b.join(40)
    assert errors == []
    with file_engine.connect() as connection:
        assert sorted(connection.execute(text("SELECT n FROM t")).scalars()) == [1, 2]
