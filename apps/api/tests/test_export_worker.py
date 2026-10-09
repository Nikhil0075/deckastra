"""The background worker: one kind of failing work must not stop the others.

On 2026-10-06 an abandoned `.mydeck` upload whose bytes had never arrived made
every pass of the cloud worker raise before it reached the export queue. PDF
exports sat at `queued` for three days while the service reported itself
healthy, and only the deploy smoke test noticed. These tests hold the three
things that had to be true for that to happen to being false.
"""

from __future__ import annotations

import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deckastra_api import export_service, export_worker, mydeck_import as imports, object_storage  # noqa: E402
from deckastra_api.auth import Principal, provision_personal_account  # noqa: E402
from deckastra_api.db import session as db  # noqa: E402


@pytest.fixture
def account(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'worker.db'}")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "objects"))
    db.reset_engine(); db.create_all()
    with db.session_scope() as session:
        user, _workspace, project = provision_personal_account(session, email="person@example.com")
        ids = user.id, project.id
    yield ids
    db.reset_engine()


def test_a_failing_import_and_erasure_do_not_block_exports(monkeypatch):
    calls = []

    def boom():
        calls.append("failed")
        raise object_storage.ObjectStorageError("missing object")

    @contextmanager
    def session_scope():
        yield object()

    monkeypatch.setattr(export_worker, "_imports", boom)
    monkeypatch.setattr(export_worker, "_erasures", boom)
    monkeypatch.setattr(export_worker, "session_scope", session_scope)
    monkeypatch.setattr(export_service, "process_one", lambda session, worker: calls.append("export") or "job")

    assert export_worker.run_once("test", {}) is True
    assert calls == ["failed", "failed", "export"]


def test_a_failing_export_does_not_stop_the_next_pass(monkeypatch):
    @contextmanager
    def session_scope():
        yield object()

    def broken(session, worker):
        raise RuntimeError("render host died")

    monkeypatch.setattr(export_worker, "_imports", lambda: None)
    monkeypatch.setattr(export_worker, "_erasures", lambda: None)
    monkeypatch.setattr(export_worker, "session_scope", session_scope)
    monkeypatch.setattr(export_service, "process_one", broken)
    assert export_worker.run_once("test", {}) is False


class _NotFound(Exception):
    """Shape of google.api_core.exceptions.NotFound: a class name and code 404."""
    code = 404


NotFound = type("NotFound", (_NotFound,), {})


class _Blob:
    def __init__(self, error):
        self.error = error

    def delete(self):
        raise self.error


def test_deleting_a_gcs_object_that_is_already_gone_succeeds(monkeypatch):
    monkeypatch.delenv("DECKASTRA_ASSET_DIR", raising=False)
    monkeypatch.setenv("DECKASTRA_GCS_ASSETS_BUCKET", "bucket")
    monkeypatch.setattr(object_storage, "_gcs_blob", lambda key: _Blob(NotFound("No such object")))
    object_storage.delete("imports/never-uploaded")


def test_any_other_gcs_delete_failure_is_still_reported(monkeypatch):
    monkeypatch.delenv("DECKASTRA_ASSET_DIR", raising=False)
    monkeypatch.setenv("DECKASTRA_GCS_ASSETS_BUCKET", "bucket")
    monkeypatch.setattr(object_storage, "_gcs_blob", lambda key: _Blob(PermissionError("denied")))
    with pytest.raises(object_storage.ObjectStorageError):
        object_storage.delete("imports/somewhere")


def test_an_abandoned_upload_is_closed_even_when_its_bytes_cannot_be_removed(account, monkeypatch):
    user, project = account
    with db.session_scope() as session:
        reply = imports.begin(project, imports.Begin(size_bytes=10, copy=False), Principal(user, "person@example.com"), session)
        row = session.get(imports.ImportJob, reply["id"])
        row.created_at = datetime.now(timezone.utc) - timedelta(days=2)

    def refuse(key):
        raise object_storage.ObjectStorageError("cannot delete")

    monkeypatch.setattr(object_storage, "delete", refuse)
    imports.process_one()
    with db.session_scope() as session:
        row = session.get(imports.ImportJob, reply["id"])
        assert row.status == "failed"
        assert "expired" in row.error
