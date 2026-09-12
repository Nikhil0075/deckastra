"""PostgreSQL proves storage quota decisions serialize per workspace."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from deckastra_api import assets, quotas
from deckastra_api.db.models import Base, User, Workspace
from deckastra_api.ids import new_id
from tests.conftest import requires_postgres


@requires_postgres
def test_parallel_asset_completions_cannot_overspend_storage(postgres_url: str):
    engine = create_engine(postgres_url)
    Base.metadata.create_all(engine)
    user_id, workspace_id = new_id("usr"), new_id("wsp")
    with Session(engine) as session:
        session.add(User(id=user_id, email="asset-race@localhost", name="Asset owner"))
        session.flush()
        session.add(Workspace(id=workspace_id, name="Assets", owner_id=user_id))
        session.flush()
        quota = quotas.ensure(session, workspace_id)
        quota.storage_bytes = 100
        session.commit()

    barrier = Barrier(2)

    def complete(index: int) -> str:
        with Session(engine) as session:
            barrier.wait(timeout=10)
            try:
                assets.register(
                    session,
                    workspace_id=workspace_id,
                    created_by=user_id,
                    storage_key=f"race/{index}",
                    size_bytes=80,
                )
                session.commit()
                return "stored"
            except quotas.QuotaExceeded:
                session.rollback()
                return "refused"

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = [future.result(timeout=30) for future in [pool.submit(complete, 1), pool.submit(complete, 2)]]

    assert sorted(outcomes) == ["refused", "stored"]
    with Session(engine) as session:
        usage = quotas.usage(session, workspace_id)
        assert usage.storage_bytes == (80, 100)
    engine.dispose()
