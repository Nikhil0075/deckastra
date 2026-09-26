"""A backup is one moment, and a bad one is refused first (item 14).

These drive `backup.py` against a real SQLite database with real asset files,
because everything interesting about this module is a fact about files: whether
the copy is consistent, whether the assets a snapshot references came with it,
and whether a damaged backup is caught before it replaces anything.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from deckastra_api import backup


def _database(path: Path, *, assets: list[tuple[str, str]] | None = None) -> None:
    """A database with the handful of tables the snapshot reads."""
    connection = sqlite3.connect(str(path))
    connection.executescript(
        """
        CREATE TABLE presentations (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE presentation_versions (id TEXT PRIMARY KEY);
        CREATE TABLE agent_runs (id TEXT PRIMARY KEY);
        CREATE TABLE assets (id TEXT PRIMARY KEY, storage_key TEXT, bytes INTEGER);
        """
    )
    connection.execute("INSERT INTO presentations VALUES ('doc_1', 'A deck')")
    connection.execute("INSERT INTO presentation_versions VALUES ('ver_1')")
    for asset_id, key in assets or []:
        connection.execute("INSERT INTO assets VALUES (?, ?, 3)", (asset_id, key))
    connection.commit()
    connection.close()


def _asset(root: Path, key: str, data: bytes = b"png") -> None:
    path = root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.with_name(path.name + ".meta.json").write_text('{"content_type":"image/png"}', encoding="utf8")


@pytest.fixture()
def install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A data directory shaped like one a desktop install has."""
    data = tmp_path / "workspace"
    data.mkdir()
    _database(data / "deckastra.db", assets=[("ast_1", "workspaces/w1/assets/ast_1")])
    _database(data / "deckastra.db.checkpoints")
    _asset(data / "assets", "workspaces/w1/assets/ast_1")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(data / 'deckastra.db').as_posix()}")
    return data


def test_snapshot_carries_the_database_checkpoints_and_referenced_assets(install: Path, tmp_path: Path) -> None:
    manifest = backup.snapshot(tmp_path / "out", asset_root=install / "assets", app_version="0.9.0-beta.1")

    assert manifest["format"] == backup.FORMAT
    assert manifest["counts"] == {"presentations": 1, "versions": 1, "assets": 1, "runs": 0}
    assert manifest["missing_assets"] == []
    assert (tmp_path / "out" / "deckastra.db").is_file()
    assert (tmp_path / "out" / "deckastra.db.checkpoints").is_file()
    assert (tmp_path / "out" / "assets" / "workspaces/w1/assets/ast_1").read_bytes() == b"png"
    # The sidecar metadata travels with the blob: without it the local backend
    # cannot answer `metadata()` and a restored asset has no content type.
    assert (tmp_path / "out" / "assets" / "workspaces/w1/assets/ast_1.meta.json").is_file()
    assert backup.verify(tmp_path / "out")["created_at"] == manifest["created_at"]


def test_the_asset_list_comes_from_the_snapshot_not_the_live_database(
    install: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The rows and the files copied are one moment, not two.

    This is the seam the review named, and it only appears when the live
    database moves **after** the snapshot has been taken — so the test forces
    exactly that interleaving by committing a new asset row from inside the copy
    step. Reading the list from the live database would then copy a file for a
    row the backup does not contain, and record in the manifest a count that
    disagrees with the files beside it.

    The direction matters more than it looks. Here the mistake is harmless (one
    file too many); the same mistake with the timings reversed is an asset the
    backup references and does not carry, which is a restored deck with a hole
    in it.
    """
    real = backup._copy_database

    def copy_then_move_on(source: Path, destination: Path) -> None:
        real(source, destination)
        if destination.name == backup.DATABASE:
            live = sqlite3.connect(str(install / "deckastra.db"))
            live.execute("INSERT INTO assets VALUES ('ast_late', 'workspaces/w1/assets/ast_late', 3)")
            live.commit()
            live.close()
            _asset(install / "assets", "workspaces/w1/assets/ast_late")

    monkeypatch.setattr(backup, "_copy_database", copy_then_move_on)
    manifest = backup.snapshot(tmp_path / "out", asset_root=install / "assets")

    assert manifest["counts"]["assets"] == 1
    assert not (tmp_path / "out" / "assets" / "workspaces/w1/assets/ast_late").exists()
    # And the manifest is a true description of what is on disk beside it.
    backup.verify(tmp_path / "out")


def test_an_asset_whose_file_is_already_gone_is_named_not_omitted(install: Path, tmp_path: Path) -> None:
    (install / "assets" / "workspaces/w1/assets/ast_1").unlink()

    manifest = backup.snapshot(tmp_path / "out", asset_root=install / "assets")

    assert [entry["asset_id"] for entry in manifest["missing_assets"]] == ["ast_1"]
    # And it still verifies: the backup is an honest record of what was there.
    backup.verify(tmp_path / "out")


def test_deleting_bytes_waits_for_a_snapshot(install: Path, tmp_path: Path) -> None:
    """The sweeper cannot remove a file between the row being read and the copy.

    Driven as two threads rather than asserted about the lock, because "there is
    a mutex" and "the deletion actually waited" are different claims.
    """
    order: list[str] = []
    started = threading.Event()

    def sweeper() -> None:
        started.wait(2)
        with backup.deletions_held():
            order.append("deleted")

    with backup.deletions_held():
        thread = threading.Thread(target=sweeper)
        thread.start()
        started.set()
        time.sleep(0.05)
        order.append("snapshot")
    thread.join(2)

    assert order == ["snapshot", "deleted"]


def test_journals_travel_verbatim(install: Path, tmp_path: Path) -> None:
    """The renderer owns the journal format; a backup that parsed it would drift."""
    journals = [{"key": "deckastra.editor-recovery.v1:doc_1", "value": '{"format":1}'}]
    backup.snapshot(tmp_path / "out", asset_root=install / "assets", journals=journals)

    assert json.loads((tmp_path / "out" / "journals.json").read_text(encoding="utf8")) == journals


def test_a_folder_that_already_holds_something_is_refused(install: Path, tmp_path: Path) -> None:
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "something.txt").write_text("mine", encoding="utf8")

    with pytest.raises(backup.BackupError, match="already has something"):
        backup.snapshot(tmp_path / "out", asset_root=install / "assets")


def test_a_server_database_is_refused_rather_than_half_supported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://x/y")

    with pytest.raises(backup.BackupError, match="local install"):
        backup.snapshot(tmp_path / "out", asset_root=None)


# ----------------------------------------------------------------- verification


def test_verify_refuses_a_damaged_backup_before_anything_is_replaced(install: Path, tmp_path: Path) -> None:
    backup.snapshot(tmp_path / "out", asset_root=install / "assets")
    (tmp_path / "out" / "deckastra.db").write_bytes(b"not a database")

    with pytest.raises(backup.BackupError, match="damaged"):
        backup.verify(tmp_path / "out")

    # And restore refuses on the same check, with the live data untouched.
    before = (install / "deckastra.db").read_bytes()
    with pytest.raises(backup.BackupError):
        backup.restore(tmp_path / "out", install)
    assert (install / "deckastra.db").read_bytes() == before


def test_verify_refuses_an_incomplete_backup(install: Path, tmp_path: Path) -> None:
    backup.snapshot(tmp_path / "out", asset_root=install / "assets")
    (tmp_path / "out" / "assets" / "workspaces/w1/assets/ast_1").unlink()

    with pytest.raises(backup.BackupError, match="incomplete"):
        backup.verify(tmp_path / "out")


def test_verify_refuses_a_format_this_build_does_not_read(install: Path, tmp_path: Path) -> None:
    backup.snapshot(tmp_path / "out", asset_root=install / "assets")
    manifest = json.loads((tmp_path / "out" / backup.MANIFEST).read_text(encoding="utf8"))
    manifest["format"] = backup.FORMAT + 1
    (tmp_path / "out" / backup.MANIFEST).write_text(json.dumps(manifest), encoding="utf8")

    with pytest.raises(backup.BackupError, match="format"):
        backup.verify(tmp_path / "out")


def test_verify_refuses_a_file_that_hashes_right_and_is_not_a_database(install: Path, tmp_path: Path) -> None:
    """A faithful copy of something that was never a database still cannot be restored."""
    backup.snapshot(tmp_path / "out", asset_root=install / "assets")
    (tmp_path / "out" / "deckastra.db").write_bytes(b"still not a database")
    manifest = json.loads((tmp_path / "out" / backup.MANIFEST).read_text(encoding="utf8"))
    manifest["files"][backup.DATABASE] = {
        "bytes": (tmp_path / "out" / "deckastra.db").stat().st_size,
        "sha256": backup._digest(tmp_path / "out" / "deckastra.db"),
    }
    (tmp_path / "out" / backup.MANIFEST).write_text(json.dumps(manifest), encoding="utf8")

    with pytest.raises(backup.BackupError, match="cannot be opened"):
        backup.verify(tmp_path / "out")


def test_a_folder_that_is_not_a_backup_says_so(tmp_path: Path) -> None:
    (tmp_path / "holiday-photos").mkdir()

    with pytest.raises(backup.BackupError, match="does not look like"):
        backup.verify(tmp_path / "holiday-photos")


# --------------------------------------------------------------------- restore


def test_restore_puts_the_data_back_and_keeps_what_it_replaced(install: Path, tmp_path: Path) -> None:
    backup.snapshot(tmp_path / "out", asset_root=install / "assets")

    # The install moves on: a second deck, and the image deleted.
    live = sqlite3.connect(str(install / "deckastra.db"))
    live.execute("INSERT INTO presentations VALUES ('doc_2', 'Later')")
    live.commit()
    live.close()
    (install / "assets" / "workspaces/w1/assets/ast_1").unlink()

    result = backup.restore(tmp_path / "out", install)

    restored = sqlite3.connect(str(install / "deckastra.db"))
    titles = [row[0] for row in restored.execute("SELECT id FROM presentations")]
    restored.close()
    assert titles == ["doc_1"]
    assert (install / "assets" / "workspaces/w1/assets/ast_1").read_bytes() == b"png"
    assert (install / "deckastra.db.checkpoints").is_file()

    # What was replaced is beside it, not gone: a restore is reached for when
    # something already went wrong.
    aside = Path(result["replaced"])
    superseded = sqlite3.connect(str(aside / "deckastra.db"))
    assert sorted(row[0] for row in superseded.execute("SELECT id FROM presentations")) == ["doc_1", "doc_2"]
    superseded.close()


def test_restore_hands_back_the_journals_it_carried(install: Path, tmp_path: Path) -> None:
    journals = [{"key": "deckastra.editor-recovery.v1:doc_1", "value": "{}"}]
    backup.snapshot(tmp_path / "out", asset_root=install / "assets", journals=journals)

    assert backup.restore(tmp_path / "out", install)["journals"] == journals


def test_a_stale_write_ahead_file_does_not_survive_the_restore(install: Path, tmp_path: Path) -> None:
    """A `-wal` beside a replaced database is a journal for a database that left."""
    backup.snapshot(tmp_path / "out", asset_root=install / "assets")
    (install / "deckastra.db-wal").write_bytes(b"stale")

    backup.restore(tmp_path / "out", install)

    assert not (install / "deckastra.db-wal").exists()
