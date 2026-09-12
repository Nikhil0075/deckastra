"""PostgreSQL lease claiming prevents duplicate export execution."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from deckastra_api import export_service, store
from deckastra_api.compose import blank_document
from deckastra_api.db.models import Base, Project, User, Workspace
from deckastra_api.ids import new_id
from tests.conftest import requires_postgres


@requires_postgres
def test_parallel_workers_claim_different_jobs(postgres_url: str):
    engine = create_engine(postgres_url)
    Base.metadata.create_all(engine)
    user_id, workspace_id, project_id = new_id("usr"), new_id("wsp"), new_id("prj")
    with Session(engine) as session:
        session.add(User(id=user_id, email="export-workers@localhost", name="Export owner"))
        session.flush()
        session.add(Workspace(id=workspace_id, name="Exports", owner_id=user_id))
        session.flush()
        session.add(Project(id=project_id, workspace_id=workspace_id, name="Exports", created_by=user_id))
        session.flush()
        created = store.create_presentation(
            session, project_id=project_id, document=blank_document(), created_by=user_id
        )
        for kind in ("pdf", "pptx"):
            export_service.create_job(
                session,
                presentation_id=created.presentation_id,
                version_id=created.version_id,
                created_by=user_id,
                kind=kind,
            )
        session.commit()

    barrier = Barrier(2)

    def claim(worker: str) -> str:
        with Session(engine) as session:
            barrier.wait(timeout=10)
            job = export_service.claim_next(session, worker)
            assert job is not None
            claimed = job.id
            session.commit()
            return claimed

    with ThreadPoolExecutor(max_workers=2) as pool:
        claimed = [future.result(timeout=30) for future in [pool.submit(claim, "one"), pool.submit(claim, "two")]]

    assert len(set(claimed)) == 2
    engine.dispose()
