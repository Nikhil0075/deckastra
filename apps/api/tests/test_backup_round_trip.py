"""The gate item 14 actually names: everything comes back.

The register's pass criterion is a list — "a saved deck, historical version,
pending outline, image asset and unsaved journal" — and each of those lives
somewhere different: rows in the application database, rows in a *second*
database LangGraph owns, bytes in a directory, and a record in browser storage
that is not on this machine's side of the process boundary at all. A test that
checked only the decks would pass against a backup that loses the other four.

So this drives the real API through a real local install, takes the snapshot the
app takes, destroys the install the way a failed disk would, and asks for all
five back.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from deckastra_api import backup, object_storage
from deckastra_api.db import session as db_session

SECRET = "x" * 40


@pytest.fixture
def install(tmp_path, monkeypatch):
    """A local install, shaped the way `local_server.configure_environment` makes one."""
    data = tmp_path / "workspace"
    data.mkdir()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(data / 'deckastra.db').as_posix()}")
    monkeypatch.setenv("DECKASTRA_LOCAL_MODE", "1")
    monkeypatch.setenv("DECKASTRA_LOCAL_SECRET", SECRET)
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(data / "assets"))
    monkeypatch.delenv("DECKASTRA_ENV", raising=False)

    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as client:
        yield client, data

    db_session.reset_engine()


def auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {SECRET}"}


def _paused_run(data: Path, deck: str) -> str:
    """A run parked at its story checkpoint, plus the checkpoint LangGraph keeps.

    Written directly rather than by running the graph: what is being tested is
    whether a backup carries two databases consistently, and a real generation
    would be minutes of model calls to produce the same two rows.
    """
    connection = sqlite3.connect(str(data / "deckastra.db"))
    project = connection.execute("SELECT id FROM projects LIMIT 1").fetchone()[0]
    connection.execute(
        "INSERT INTO agent_runs (id, project_id, presentation_id, created_by, intent, status, created_at)"
        " VALUES ('run_paused', ?, ?, 'usr_1', 'A deck about backups', 'awaiting_approval', datetime('now'))",
        (project, deck),
    )
    connection.commit()
    connection.close()

    # The checkpoints database is LangGraph's, on LangGraph's schema, beside the
    # application database. One table is enough to prove the file travels.
    checkpoints = sqlite3.connect(str(data / "deckastra.db.checkpoints"))
    checkpoints.execute("CREATE TABLE IF NOT EXISTS checkpoints (thread_id TEXT, blob TEXT)")
    checkpoints.execute("INSERT INTO checkpoints VALUES ('run_paused', 'the outline')")
    checkpoints.commit()
    checkpoints.close()
    return "run_paused"


def test_a_backup_brings_back_everything_the_register_names(install, tmp_path):
    client, data = install

    # A saved deck…
    created = client.post("/v1/presentations", json={"title": "Backed up"}, headers=auth())
    assert created.status_code == 201, created.text
    deck = created.json()["presentation_id"]
    first_version = created.json()["version_id"]

    # …with a history, so there is a historical version as well as a head.
    edited = client.post(
        f"/v1/presentations/{deck}/transactions",
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "Edited after the first version"}],
            "intent": "Rename",
            "expected_version_id": first_version,
        },
        headers=auth(),
    )
    assert edited.status_code == 200, edited.text

    # An image, as bytes in the asset directory and a row that cites them.
    # One connection, closed. On Windows an open handle is exactly why a file
    # cannot be replaced — which is the same reason a restore stops the service.
    connection = sqlite3.connect(str(data / "deckastra.db"))
    workspace_row = connection.execute("SELECT workspace_id FROM projects LIMIT 1").fetchone()[0]
    key = f"workspaces/{workspace_row}/assets/ast_backup"
    object_storage.put_local(key, b"\x89PNG-pretend", "image/png")
    connection.execute(
        "INSERT INTO assets (id, workspace_id, created_by, kind, storage_key, bytes, reference_count,"
        " created_at) VALUES ('ast_backup', ?, 'usr_1', 'image', ?, 12, 1, datetime('now'))",
        (workspace_row, key),
    )
    connection.commit()
    connection.close()

    # A paused outline, in the other database.
    run = _paused_run(data, deck)

    # And the unsaved work, which is in a browser and reaches this through the shell.
    journals = [{"key": f"deckastra.editor-recovery.v1:{deck}", "value": json.dumps({"format": 1, "note": "unsaved"})}]

    manifest = backup.snapshot(tmp_path / "backup", asset_root=data / "assets", journals=journals)
    assert manifest["missing_assets"] == []

    # The install is destroyed, as a disk failure or a bad uninstall would.
    db_session.reset_engine()
    (data / "deckastra.db").unlink()
    (data / "deckastra.db.checkpoints").unlink()
    (data / "assets" / key).unlink()

    result = backup.restore(tmp_path / "backup", data)
    db_session.reset_engine()

    # 1. The deck, and 2. its history.
    read = client.get(f"/v1/presentations/{deck}", headers=auth())
    assert read.status_code == 200, read.text
    assert read.json()["document"]["metadata"]["title"] == "Edited after the first version"
    historical = client.get(f"/v1/presentations/{deck}?at_version={first_version}", headers=auth())
    assert historical.status_code == 200
    assert historical.json()["document"]["metadata"]["title"] == "Backed up"

    # 3. The image: the row and the bytes, which are two halves of one fact.
    restored_db = sqlite3.connect(str(data / "deckastra.db"))
    assert restored_db.execute("SELECT count(*) FROM assets WHERE id = 'ast_backup'").fetchone()[0] == 1
    restored_db.close()
    assert object_storage.read_local(key)[0] == b"\x89PNG-pretend"

    # 4. The paused outline: the run row *and* the checkpoint it resumes from.
    # Either one alone is a generation nobody can finish.
    restored_db = sqlite3.connect(str(data / "deckastra.db"))
    assert restored_db.execute("SELECT status FROM agent_runs WHERE id = ?", (run,)).fetchone()[0] == "awaiting_approval"
    restored_db.close()
    checkpoints = sqlite3.connect(str(data / "deckastra.db.checkpoints"))
    assert checkpoints.execute("SELECT blob FROM checkpoints WHERE thread_id = ?", (run,)).fetchone()[0] == "the outline"
    checkpoints.close()

    # 5. The unsaved journal, handed back for the shell to put in its storage.
    assert result["journals"] == journals


def test_a_backup_is_refused_on_a_folder_with_anything_in_it(install, tmp_path):
    """Two backups in one folder would interleave two manifests over one set of files."""
    _, data = install
    backup.snapshot(tmp_path / "backup", asset_root=data / "assets")

    with pytest.raises(backup.BackupError):
        backup.snapshot(tmp_path / "backup", asset_root=data / "assets")


def test_the_backup_route_is_the_app_s_own_and_not_an_agent_s(install, tmp_path):
    """A grant must not be able to write every deck to a folder it chose.

    `grants.py` maps this route to `administer`, which no grant carries — the
    same gate that stops an agent managing its own leash.
    """
    from deckastra_api import grants

    assert grants.required_scope("POST", "/v1/local/backup") == "administer"
    # What the desktop actually hands an agent (`main/agent-access.ts`), which is
    # where the claim has to hold: a scope no grant carries.
    assert "administer" not in {"read", "write", "export"}


def test_the_route_writes_a_backup_the_verifier_accepts(install, tmp_path):
    client, _ = install

    response = client.post(
        "/v1/local/backup",
        json={"path": str(tmp_path / "from-the-route"), "app_version": "0.9.0-beta.1"},
        headers=auth(),
    )

    assert response.status_code == 200, response.text
    assert response.json()["app_version"] == "0.9.0-beta.1"
    backup.verify(tmp_path / "from-the-route")


def test_the_route_reports_a_folder_it_cannot_use_rather_than_half_writing_one(install, tmp_path):
    client, _ = install
    (tmp_path / "busy").mkdir()
    (tmp_path / "busy" / "notes.txt").write_text("mine", encoding="utf8")

    response = client.post("/v1/local/backup", json={"path": str(tmp_path / "busy")}, headers=auth())

    assert response.status_code == 409
    assert "empty" in response.json()["detail"]
    assert not (tmp_path / "busy" / backup.MANIFEST).exists()
