"""Upgrading an install that already has someone's work in it (item 15).

The register is explicit that a fresh-database migration test does not close
this gate, and it is right: every migration in this repository has only ever run
against an empty file, where "the upgrade succeeded" and "the upgrade kept
anything" are the same sentence. What an installed user has is a database
several revisions old with decks in it.

So this builds a profile at an **older revision**, puts rows in it, and upgrades
it with the candidate. The rows are written by introspecting the schema as it
was at that revision rather than by a fixed INSERT, because a fixed one would
have to be rewritten — and quietly weakened — every time the columns move.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.script import ScriptDirectory

from deckastra_api import local_server
from deckastra_api.db import session as db_session


def _config(database: Path):
    # `migrations/env.py` reads DATABASE_URL, not the config's own url, so
    # setting the option alone silently migrates the default Postgres instead —
    # which reports success against a file it never touched.
    import os

    os.environ["DATABASE_URL"] = f"sqlite:///{database.as_posix()}"
    config = local_server._alembic_config()
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database.as_posix()}")
    return config


def _revisions() -> list[str]:
    """Every revision, oldest first."""
    script = ScriptDirectory.from_config(local_server._alembic_config())
    return [revision.revision for revision in reversed(list(script.walk_revisions()))]


def _columns(connection: sqlite3.Connection, table: str) -> list[tuple[str, str, int, object]]:
    return [
        (row[1], row[2], row[3], row[4])
        for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
    ]


def _insert(connection: sqlite3.Connection, table: str, **given: object) -> None:
    """Insert a row, filling in whatever else that revision requires.

    Introspection rather than a literal column list: the point of this suite is
    to run against a schema from the past, and a hand-written INSERT would have
    to be edited to keep passing — which is how a rehearsal quietly stops
    rehearsing anything.
    """
    values = dict(given)
    for name, kind, not_null, default in _columns(connection, table):
        if name in values or not not_null or default is not None:
            continue
        upper = kind.upper()
        if "INT" in upper:
            values[name] = 0
        elif "DATETIME" in upper or "TIMESTAMP" in upper:
            values[name] = "2026-09-01 00:00:00"
        elif "JSON" in upper or "BLOB" in upper:
            values[name] = "{}"
        else:
            values[name] = f"seed-{name}"
    names = ", ".join(values)
    marks = ", ".join("?" for _ in values)
    connection.execute(f"INSERT INTO {table} ({names}) VALUES ({marks})", tuple(values.values()))


@pytest.fixture
def old_profile(tmp_path, monkeypatch) -> Path:
    """A data directory at an older revision, with a deck and its history in it."""
    data = tmp_path / "workspace"
    data.mkdir()
    database = data / "deckastra.db"

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{database.as_posix()}")
    revisions = _revisions()
    assert len(revisions) > 3, "this rehearsal needs a history to start partway through"
    # Far enough back that several migrations have to run, and not so far that
    # the tables a deck needs do not exist yet.
    start = revisions[len(revisions) // 2]
    command.upgrade(_config(database), start)

    connection = sqlite3.connect(str(database))
    _insert(connection, "users", id="usr_old", email="someone@example.com")
    _insert(connection, "workspaces", id="wsp_old", name="Their workspace")
    _insert(connection, "projects", id="prj_old", workspace_id="wsp_old", name="Their project")
    _insert(connection, "presentations", id="doc_old", project_id="prj_old", title="A deck from before")
    _insert(
        connection,
        "presentation_versions",
        id="ver_old",
        presentation_id="doc_old",
        snapshot_json='{"id":"doc_old"}',
    )
    connection.commit()
    connection.close()

    db_session.reset_engine()
    yield data
    db_session.reset_engine()


def test_an_older_profile_upgrades_and_keeps_its_decks(old_profile: Path) -> None:
    before = _revisions()
    database = old_profile / "deckastra.db"
    assert local_server._recorded_revision(database) != before[-1]

    local_server.migrate(old_profile)

    assert local_server._recorded_revision(database) == before[-1]
    connection = sqlite3.connect(str(database))
    try:
        assert connection.execute("SELECT title FROM presentations WHERE id='doc_old'").fetchone()[0] == (
            "A deck from before"
        )
        # The version chain is the product's promise; an upgrade that kept the
        # deck row and dropped its history would pass a shallower test.
        assert connection.execute("SELECT count(*) FROM presentation_versions").fetchone()[0] == 1
    finally:
        connection.close()


def test_an_interrupted_upgrade_does_not_go_on_to_seed_an_empty_workspace(
    old_profile: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The failure item 15 names: a half-upgraded install that opens as if new.

    Seeding after a failed migration is what would do it — the account bootstrap
    creates a workspace, the deck list finds nothing in it, and a person
    concludes their work is gone while it is on the disk the whole time.
    """
    import inspect

    # The property is about the *launch sequence*, so it is checked there as
    # well as by driving the failure: `main` must migrate before it seeds, and
    # must not catch what migrating raises. Without this, the case below only
    # asserts that the two calls the test itself wrote ran in the order it wrote
    # them, which is not a fact about the product.
    source = inspect.getsource(local_server.main)
    assert source.index("migrate(") < source.index("seed(")
    assert "except" not in source.split("migrate(")[1].split("seed(")[0]

    seeded: list[str] = []
    monkeypatch.setattr(local_server, "seed", lambda data_dir: seeded.append(str(data_dir)))

    real = command.upgrade

    def fail_partway(config, revision, **kwargs):  # noqa: ANN001
        # One step succeeds, then the machine loses power.
        real(config, "+1")
        raise RuntimeError("the disk went away")

    monkeypatch.setattr(command, "upgrade", fail_partway)

    with pytest.raises(RuntimeError, match="disk went away"):
        local_server.migrate(old_profile)
        local_server.seed(old_profile)

    assert seeded == []
    connection = sqlite3.connect(str(old_profile / "deckastra.db"))
    try:
        # And the deck is still there, which is what makes refusing worthwhile.
        assert connection.execute("SELECT count(*) FROM presentations").fetchone()[0] == 1
    finally:
        connection.close()


def test_a_failed_upgrade_leaves_the_original_database_byte_for_byte(
    old_profile: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Alembic may leave SQLite batch tables behind when it is terminated.

    Migrations therefore run against a staging database.  A failure may damage
    that disposable file, but it must not change the profile the next launch
    will retry from.
    """
    database = old_profile / "deckastra.db"
    before = database.read_bytes()
    real = command.upgrade

    def fail_after_one_revision(config, revision, **kwargs):  # noqa: ANN001
        real(config, "+1")
        raise RuntimeError("power was lost after one revision")

    monkeypatch.setattr(command, "upgrade", fail_after_one_revision)

    with pytest.raises(RuntimeError, match="power was lost"):
        local_server.migrate(old_profile)

    assert database.read_bytes() == before


def test_a_stale_migration_stage_is_discarded_before_retry(old_profile: Path) -> None:
    database = old_profile / "deckastra.db"
    stale = old_profile / "deckastra.db.migrating"
    stale.write_bytes(b"an interrupted, unusable staging file")

    local_server.migrate(old_profile)

    assert not stale.exists()
    assert local_server._recorded_revision(database) == _revisions()[-1]


def test_a_database_from_the_future_is_refused_by_name(old_profile: Path) -> None:
    """An older binary meeting a newer schema, which manual upgrades make real.

    Alembic refuses this by accident — it cannot find the recorded revision — but
    the message is about revision identifiers, and the person has to be told
    which of the two things to do.
    """
    connection = sqlite3.connect(str(old_profile / "deckastra.db"))
    connection.execute("UPDATE alembic_version SET version_num = 'from_a_later_build'")
    connection.commit()
    connection.close()

    with pytest.raises(local_server.SchemaFromTheFuture) as refusal:
        local_server.migrate(old_profile)

    message = str(refusal.value)
    assert "newer version" in message
    assert "restore a backup" in message
    # It refuses rather than repairing: there is no downgrade path, and running
    # this build's migrations against that file would be guessing with decks.
    assert "has not been changed" in message


def test_the_refusal_leaves_the_data_exactly_as_it_found_it(old_profile: Path) -> None:
    database = old_profile / "deckastra.db"
    connection = sqlite3.connect(str(database))
    connection.execute("UPDATE alembic_version SET version_num = 'from_a_later_build'")
    connection.commit()
    connection.close()
    before = database.read_bytes()

    with pytest.raises(local_server.SchemaFromTheFuture):
        local_server.migrate(old_profile)

    assert database.read_bytes() == before


def test_a_fresh_install_is_not_mistaken_for_one_from_the_future(tmp_path: Path) -> None:
    """No database yet, and no `alembic_version` table, are both ordinary."""
    data = tmp_path / "fresh"
    data.mkdir()
    local_server.check_schema_supported(data)

    sqlite3.connect(str(data / "deckastra.db")).close()
    local_server.check_schema_supported(data)


def test_a_backup_taken_before_the_upgrade_still_restores_after_it(old_profile: Path, tmp_path: Path) -> None:
    """The route out of a bad upgrade, which is the whole reason item 14 is first.

    A backup is a database at the revision it was taken at. Restoring one into
    an install that has since moved on has to leave something the next launch
    can migrate — not something already at head that nothing would touch again.
    """
    from deckastra_api import backup

    taken_at = local_server._recorded_revision(old_profile / "deckastra.db")
    backup.snapshot(tmp_path / "before-upgrade", asset_root=None)

    local_server.migrate(old_profile)
    assert local_server._recorded_revision(old_profile / "deckastra.db") == _revisions()[-1]

    db_session.reset_engine()
    backup.restore(tmp_path / "before-upgrade", old_profile)
    assert local_server._recorded_revision(old_profile / "deckastra.db") == taken_at

    # And the next launch brings it forward again, with the deck intact.
    local_server.migrate(old_profile)
    connection = sqlite3.connect(str(old_profile / "deckastra.db"))
    try:
        assert connection.execute("SELECT count(*) FROM presentations").fetchone()[0] == 1
    finally:
        connection.close()


def test_a_backup_from_a_newer_build_is_refused_before_anything_is_replaced(
    old_profile: Path, tmp_path: Path
) -> None:
    """Found by checking the claim in `docs/UPGRADING.md`, 2026-09-20.

    A restore verified the backup's *files* and then replaced the data, and only
    the migration afterwards noticed the schema was from a later build. Nothing
    was lost — the previous data is moved aside, not deleted — but the person
    was left with an install that would not open and a folder to find, which is
    a recovery they should not have been put through for a refusal that could
    have come first.
    """
    import json

    from deckastra_api import backup

    backup.snapshot(tmp_path / "newer", asset_root=None)
    database = tmp_path / "newer" / backup.DATABASE
    connection = sqlite3.connect(str(database))
    connection.execute("UPDATE alembic_version SET version_num = 'from_a_later_build'")
    connection.commit()
    connection.close()
    # Re-hashed, because a genuine newer build's manifest would be correct — the
    # refusal has to come from the schema, not from a checksum that happens to
    # disagree.
    manifest = json.loads((tmp_path / "newer" / backup.MANIFEST).read_text(encoding="utf8"))
    manifest["files"][backup.DATABASE] = {
        "bytes": database.stat().st_size,
        "sha256": backup._digest(database),
    }
    (tmp_path / "newer" / backup.MANIFEST).write_text(json.dumps(manifest), encoding="utf8")
    assert backup.verify(tmp_path / "newer")

    before = (old_profile / "deckastra.db").read_bytes()
    with pytest.raises(local_server.SchemaFromTheFuture):
        backup.restore(tmp_path / "newer", old_profile)

    assert (old_profile / "deckastra.db").read_bytes() == before
    assert not list(old_profile.glob("replaced-*"))
