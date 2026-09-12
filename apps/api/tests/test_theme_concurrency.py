"""Default selection must use database state, not stale identity-map values."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from deckastra_api import themes
from deckastra_api.db.models import Base, User, Workspace, Theme
from deckastra_api.ids import new_id
from deckastra_api.theme import neo_technical_theme


@pytest.fixture(params=["sqlite", "postgres"])
def theme_database(request, tmp_path):
    url = f"sqlite:///{tmp_path / 'themes.db'}" if request.param == "sqlite" else request.getfixturevalue("postgres_url")
    engine = create_engine(url)
    Base.metadata.create_all(engine)
    user_id, workspace_id = new_id("usr"), new_id("wsp")
    with Session(engine) as session:
        session.add(User(id=user_id, email="theme-race@localhost", name="Theme owner"))
        session.flush()
        session.add(Workspace(id=workspace_id, name="Themes", owner_id=user_id))
        session.flush()
        for name in ["A", "B"]:
            themes.save(session, workspace_id=workspace_id, created_by=user_id, name=name, definition=neo_technical_theme())
        session.commit()
    yield engine, user_id, workspace_id
    engine.dispose()


def test_stale_session_does_not_leave_two_defaults(theme_database):
    engine, user_id, workspace_id = theme_database
    with Session(engine) as first, Session(engine) as second:
        stale = second.scalars(select(Theme)).all()
        themes.save(first, workspace_id=workspace_id, created_by=user_id, name="A", definition=neo_technical_theme(), is_default=True)
        first.commit()
        assert all(not theme.is_default for theme in stale)
        themes.save(second, workspace_id=workspace_id, created_by=user_id, name="B", definition=neo_technical_theme(), is_default=True)
        second.commit()
    with Session(engine) as session:
        defaults = session.scalars(select(Theme).where(Theme.is_default.is_(True))).all()
        assert [theme.name for theme in defaults] == ["B"]


def test_parallel_default_writes_leave_one_default(theme_database):
    engine, user_id, workspace_id = theme_database
    barrier = Barrier(2)
    def save(name):
        with Session(engine) as session:
            barrier.wait(timeout=10)
            themes.save(session, workspace_id=workspace_id, created_by=user_id, name=name, definition=neo_technical_theme(), is_default=True)
            session.commit()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(save, name) for name in ["A", "B"]]
        for future in futures:
            future.result(timeout=30)
    with Session(engine) as session:
        defaults = session.scalars(select(Theme).where(Theme.is_default.is_(True))).all()
        assert len(defaults) == 1
        assert themes.default_for(session, workspace_id).id == defaults[0].id
