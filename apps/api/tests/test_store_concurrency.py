"""Two overlapping PostgreSQL sessions must not both advance the same head."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deckastra_api import store
from deckastra_api.db.models import Base, Presentation, PresentationVersion, Project, TransactionRow, User, Workspace
from deckastra_api.ids import new_id
from deckastra_api.patch import apply_patch


@pytest.mark.parametrize("explicit_version", [True, False])
def test_only_one_overlapping_session_can_advance_the_loaded_head(postgres_url, explicit_version):
    engine = create_engine(postgres_url)
    try:
        Base.metadata.create_all(engine)
        owner, workspace, project = new_id("usr"), new_id("wsp"), new_id("prj")
        document = json.loads((Path(__file__).resolve().parents[3] / "packages/presentation-schema/fixtures/technical-deck.mydeck.json").read_text(encoding="utf-8"))
        document["id"] = new_id("doc")
        with Session(engine) as seed, seed.begin():
            seed.add(User(id=owner, email="concurrency@example.test", name="Concurrency"))
            seed.flush()
            seed.add(Workspace(id=workspace, name="Concurrent writes", owner_id=owner))
            seed.flush()
            seed.add(Project(id=project, workspace_id=workspace, name="Test", created_by=owner))
            seed.flush()
            initial = store.create_presentation(seed, project_id=project, document=document, created_by=owner)

        def save(session, title):
            operations = [{"op": "replace", "path": "/metadata/title", "value": title}]
            changed, inverse = apply_patch(initial.document, operations)
            return store.commit_transaction(session, presentation_id=initial.presentation_id,
                operations=operations, inverse_operations=inverse, document=changed,
                parent_version_id=initial.version_id,
                expected_version_id=initial.version_id if explicit_version else None,
                intent=title, source="user", created_by=owner)

        with Session(engine) as first, Session(engine) as second:
            # Both requests already read the same head. Retain ORM objects so
            # the second identity map still contains that earlier read.
            first_head = first.get(Presentation, initial.presentation_id)
            second_head = second.get(Presentation, initial.presentation_id)
            assert first_head.current_version_id == second_head.current_version_id == initial.version_id
            winner = save(first, "Winning edit")
            first.commit()
            with pytest.raises(store.VersionConflict) as conflict:
                save(second, "Losing edit")
            assert conflict.value.actual == winner.version_id
            # Handling a conflict must not leave orphan versions/history even
            # when the caller commits other work in the outer transaction.
            second.commit()

        with Session(engine) as check:
            loaded = store.load_presentation(check, initial.presentation_id)
            assert loaded.version_id == winner.version_id
            assert loaded.document["metadata"]["title"] == "Winning edit"
            assert check.scalar(select(func.count()).select_from(PresentationVersion)) == 2
            assert check.scalar(select(func.count()).select_from(TransactionRow)) == 1
    finally:
        engine.dispose()
