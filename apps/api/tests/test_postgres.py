"""PostgreSQL specifics.

Two kinds of check live here.

The first runs everywhere, with no server: the schema is *compiled* against the
PostgreSQL dialect and inspected. That catches the failures that come from the
schema being dialect-dependent — a JSON column that was supposed to be JSONB, a
type that has no PostgreSQL rendering — without needing a container, so they
cannot silently stop being checked.

The second needs a real server (``POSTGRES_TEST_URL``) and does what only a real
server can: runs the migration, writes documents through the store, and reads
them back. A migration that has only ever run on SQLite is a migration that has
not been tested, and the day it first runs on PostgreSQL should not be the day
it runs in production.
"""

from __future__ import annotations

import copy
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import store  # noqa: E402
from deckastra_api.db.models import Base, Project, User, Workspace  # noqa: E402
from tests.conftest import requires_postgres  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
ALEMBIC_DIR = REPO_ROOT / "infrastructure" / "database"
ALEMBIC_INI = ALEMBIC_DIR / "alembic.ini"

FIXTURE = (
    REPO_ROOT / "packages" / "presentation-schema" / "fixtures" / "technical-deck.mydeck.json"
)


def _document() -> dict:
    import json

    return json.loads(FIXTURE.read_text(encoding="utf-8"))


# --------------------------------------------------------------- no server


def test_document_columns_compile_to_jsonb():
    """`JsonColumn` must resolve to JSONB, not JSON.

    The difference is not cosmetic: JSONB is stored parsed and can be indexed,
    JSON is stored as text. Losing the variant would work in every test and
    quietly cost an index on the column the whole product reads most.
    """
    dialect = postgresql.dialect()
    ddl = str(CreateTable(Base.metadata.tables["presentation_versions"]).compile(dialect=dialect))

    assert "JSONB" in ddl
    assert " JSON " not in ddl.replace("JSONB", "")


def test_every_table_compiles_for_postgres():
    # A type with no PostgreSQL rendering raises here rather than on deploy.
    dialect = postgresql.dialect()
    for table in Base.metadata.sorted_tables:
        ddl = str(CreateTable(table).compile(dialect=dialect))
        assert ddl.startswith("\nCREATE TABLE") or ddl.startswith("CREATE TABLE")


def test_sqlite_still_gets_plain_json():
    """The variant has to fall back, or local development stops working."""
    from sqlalchemy.dialects import sqlite

    ddl = str(
        CreateTable(Base.metadata.tables["presentation_versions"]).compile(dialect=sqlite.dialect())
    )
    assert "JSONB" not in ddl
    assert "JSON" in ddl


# ------------------------------------------------------------- real server


def run_alembic(args: list[str], database_url: str) -> subprocess.CompletedProcess[str]:
    import os

    env = {**os.environ, "DATABASE_URL": database_url}
    return subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ALEMBIC_INI), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=ALEMBIC_DIR,
        env=env,
        timeout=300,
    )


@requires_postgres
def test_the_migration_runs_on_postgres(postgres_url: str):
    result = run_alembic(["upgrade", "head"], postgres_url)
    assert result.returncode == 0, f"alembic upgrade failed:\n{result.stderr}"

    engine = create_engine(postgres_url)
    tables = set(inspect(engine).get_table_names())
    engine.dispose()

    assert {"users", "workspaces", "workspace_members", "projects", "presentations"} <= tables


@requires_postgres
def test_the_migration_is_reversible_on_postgres(postgres_url: str):
    assert run_alembic(["upgrade", "head"], postgres_url).returncode == 0

    down = run_alembic(["downgrade", "base"], postgres_url)
    assert down.returncode == 0, f"alembic downgrade failed:\n{down.stderr}"

    engine = create_engine(postgres_url)
    remaining = set(inspect(engine).get_table_names()) - {"alembic_version"}
    engine.dispose()
    assert remaining == set()


@requires_postgres
def test_columns_are_jsonb_on_a_real_server(postgres_url: str):
    assert run_alembic(["upgrade", "head"], postgres_url).returncode == 0

    engine = create_engine(postgres_url)
    columns = {c["name"]: c for c in inspect(engine).get_columns("presentation_versions")}
    engine.dispose()

    # The snapshot is the biggest JSON the product stores and the one every read
    # goes through, so it is the column the variant matters most for.
    assert "JSONB" in str(columns["snapshot_json"]["type"]).upper()


@requires_postgres
def test_a_document_round_trips_through_postgres(postgres_url: str, monkeypatch):
    """The check SQLite cannot make.

    JSONB does not preserve key order or duplicate keys, and it normalises
    numbers. The document is serialised canonically before storage precisely so
    that none of that matters — but "precisely so that" is a claim, and this is
    where it gets tested against the engine that would break it.
    """
    assert run_alembic(["upgrade", "head"], postgres_url).returncode == 0

    monkeypatch.setenv("DATABASE_URL", postgres_url)
    from deckastra_api.db import session as db_session

    db_session.reset_engine()

    document = _document()

    with db_session.session_scope() as session:
        user = User(id="usr_01JB8Z9K2QW4RN7F3XPGTEST01", email="pg@localhost")
        workspace = Workspace(
            id="wsp_01JB8Z9K2QW4RN7F3XPGTEST02", name="PG", owner_id=user.id
        )
        project = Project(
            id="prj_01JB8Z9K2QW4RN7F3XPGTEST03",
            name="PG",
            workspace_id=workspace.id,
            created_by=user.id,
        )
        session.add_all([user, workspace, project])
        session.flush()

        created = store.create_presentation(
            session,
            project_id=project.id,
            document=document,
            created_by=user.id,
        )
        presentation_id = created.presentation_id

    with db_session.session_scope() as session:
        loaded = store.load_presentation(session, presentation_id)

    # Deep equality, not string equality: the point is that nothing was lost or
    # reordered in a way that changes what the document means.
    assert loaded.document == document

    # And the arrays kept their order, which is the ordering authority for both
    # slides and z-order (doc 02 §8.4). A JSON store that reordered them would
    # silently rearrange every deck.
    assert [slide["id"] for slide in loaded.document["slides"]] == [
        slide["id"] for slide in document["slides"]
    ]


@requires_postgres
def test_optimistic_concurrency_holds_on_postgres(postgres_url: str, monkeypatch):
    """A version conflict must be a conflict on the real engine too.

    Last-write-wins is the worst failure a document product can have, and the
    guard depends on how the database serialises concurrent writers — which is
    exactly the thing SQLite models differently.
    """
    assert run_alembic(["upgrade", "head"], postgres_url).returncode == 0

    monkeypatch.setenv("DATABASE_URL", postgres_url)
    from deckastra_api.db import session as db_session

    db_session.reset_engine()

    document = _document()

    with db_session.session_scope() as session:
        user = User(id="usr_01JB8Z9K2QW4RN7F3XPGTEST11", email="pg2@localhost")
        workspace = Workspace(
            id="wsp_01JB8Z9K2QW4RN7F3XPGTEST12", name="PG", owner_id=user.id
        )
        project = Project(
            id="prj_01JB8Z9K2QW4RN7F3XPGTEST13",
            name="PG",
            workspace_id=workspace.id,
            created_by=user.id,
        )
        session.add_all([user, workspace, project])
        session.flush()

        created = store.create_presentation(
            session,
            project_id=project.id,
            document=document,
            created_by=user.id,
        )
        presentation_id = created.presentation_id
        stale_version = created.version_id

    updated = copy.deepcopy(document)
    updated["metadata"]["title"] = "First writer"

    with db_session.session_scope() as session:
        store.commit_transaction(
            session,
            presentation_id=presentation_id,
            operations=[
                {"op": "replace", "path": "/metadata/title", "value": "First writer"}
            ],
            inverse_operations=[
                {"op": "replace", "path": "/metadata/title", "value": document["metadata"]["title"]}
            ],
            document=updated,
            parent_version_id=stale_version,
            expected_version_id=stale_version,
            intent="first",
            source="user",
            created_by="usr_01JB8Z9K2QW4RN7F3XPGTEST11",
        )

    second = copy.deepcopy(document)
    second["metadata"]["title"] = "Second writer"

    with pytest.raises(store.VersionConflict):
        with db_session.session_scope() as session:
            store.commit_transaction(
                session,
                presentation_id=presentation_id,
                operations=[
                    {"op": "replace", "path": "/metadata/title", "value": "Second writer"}
                ],
                inverse_operations=[
                    {
                        "op": "replace",
                        "path": "/metadata/title",
                        "value": document["metadata"]["title"],
                    }
                ],
                document=second,
                parent_version_id=stale_version,
                # Deliberately the version the first writer already superseded.
                expected_version_id=stale_version,
                intent="second",
                source="user",
                created_by="usr_01JB8Z9K2QW4RN7F3XPGTEST11",
            )
