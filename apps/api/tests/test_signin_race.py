"""Two first sign-ins for one identity, arriving together (2026-09-17).

Found by an independent test run: a parallel web E2E suite issued concurrent
`POST /v1/dev/session` calls for `dev@localhost`, and the loser got an HTTP 500
carrying `UNIQUE constraint failed: users.email`. Serialising the tests made it
go away, which is the wrong fix — the race is in provisioning, not in the test
runner, and real sign-in provisions through the same function. A person double
clicking a sign-in button is this case.

The property worth pinning is not "no error". It is that the loser ends up in
the **winner's** workspace: retrying the insert would satisfy any assertion
about status codes while quietly giving one person two personal workspaces, and
they would not find out until a deck they created answered 404 from the other
one.
"""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.auth import provision_personal_account  # noqa: E402
from deckastra_api.db.models import Base, Project, User, Workspace  # noqa: E402


def test_the_loser_of_a_provisioning_race_joins_the_winners_workspace(tmp_path):
    # A file database rather than in-memory: two connections have to see one
    # another's committed rows, which `:memory:` per-connection does not give.
    engine = create_engine(f"sqlite:///{tmp_path / 'race.db'}")
    Base.metadata.create_all(engine)

    barrier = Barrier(2)

    def sign_in() -> tuple[str, str, str]:
        with Session(engine) as session:
            # Read, then wait, then insert — the interleaving the report caught,
            # forced rather than hoped for. Without the barrier both calls
            # usually finish before the other begins and the test proves nothing.
            barrier.wait(timeout=10)
            user, workspace, project = provision_personal_account(
                session, email="Dev@Localhost", name="dev"
            )
            ids = (user.id, workspace.id, project.id)
            session.commit()
            return ids

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = (future.result(timeout=30) for future in [
            pool.submit(sign_in),
            pool.submit(sign_in),
        ])

    # Neither raised, and both are the same person in the same place.
    assert first == second

    with Session(engine) as session:
        # One of each. Two workspaces would be the plausible-looking repair —
        # catch the error and try again — and it is the one that loses decks.
        assert len(session.scalars(select(User)).all()) == 1
        assert len(session.scalars(select(Workspace)).all()) == 1
        assert len(session.scalars(select(Project)).all()) == 1

    engine.dispose()


def test_provisioning_twice_in_sequence_is_still_idempotent(tmp_path):
    # The ordinary path, unchanged by the race fix — and the control for the test
    # above, which would pass against a function that refused every second call.
    engine = create_engine(f"sqlite:///{tmp_path / 'sequential.db'}")
    Base.metadata.create_all(engine)

    with Session(engine) as session:
        first = provision_personal_account(session, email="dev@localhost", name="dev")
        first_ids = (first[0].id, first[1].id, first[2].id)
        session.commit()

    with Session(engine) as session:
        second = provision_personal_account(session, email="dev@localhost", name="dev")
        assert (second[0].id, second[1].id, second[2].id) == first_ids
        session.commit()

    engine.dispose()
