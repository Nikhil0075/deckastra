import hashlib
import io
import json
import stat
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deckastra_api import mydeck, mydeck_import as imports, store, object_storage
from deckastra_api.auth import Principal, provision_personal_account
from deckastra_api.compose import blank_document
from deckastra_api.db import session as db
from deckastra_api.db.models import Presentation, Asset


def package(doc=None, *, extra=None, corrupt_hash=False, version=1, unlisted=None):
    doc = doc or blank_document("File fixture")
    payload = json.dumps(doc).encode()
    files = [{"path": "document.json", "sha256": "bad" if corrupt_hash else hashlib.sha256(payload).hexdigest(), "bytes": len(payload), "contentType": "application/json"}]
    manifest = {"format": "mydeck", "formatVersion": version, "schemaVersion": doc["schemaVersion"], "presentationId": doc["id"], "files": files}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("mimetype", mydeck.MIME)
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("document.json", payload)
        if extra: archive.writestr(*extra)
        if unlisted: archive.writestr(unlisted, b"arbitrary")
    return stream.getvalue()


@pytest.mark.parametrize("kwargs,code", [({"extra": ("../evil", b"x")}, "M004"), ({"extra": ("/absolute", b"x")}, "M004"),
    ({"extra": ("C:\\evil", b"x")}, "M004"), ({"extra": ("document.json", b"x")}, "M005"),
    ({"unlisted": "unlisted"}, "M006"), ({"corrupt_hash": True}, "M008"), ({"version": 2}, "M007")])
def test_hostile_container_rejected_before_mutation(kwargs, code):
    with pytest.raises(mydeck.PackageError, match=code): mydeck.read_package(package(**kwargs))


def test_symlink_and_compression_bomb_refused():
    for symlink in [False, True]:
        stream = io.BytesIO(package())
        with zipfile.ZipFile(stream, "a", compression=zipfile.ZIP_DEFLATED) as archive:
            info = zipfile.ZipInfo("extras/link" if symlink else "extras/bomb")
            info.create_system = 3
            if symlink: info.external_attr = (stat.S_IFLNK | 0o777) << 16
            else: info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, b"x" if symlink else b"0" * 100000)
        with pytest.raises(mydeck.PackageError, match="M004" if symlink else "M003"): mydeck.read_package(stream.getvalue())


@pytest.fixture
def account(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'imports.db'}")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "objects"))
    db.reset_engine(); db.create_all()
    with db.session_scope() as session:
        user, workspace, project = provision_personal_account(session, email="person@example.com")
        ids = user.id, project.id
    yield ids
    db.reset_engine()


def submit(account, payload, *, make_copy=False):
    user, project = account
    with db.session_scope() as session:
        reply = imports.begin(project, imports.Begin(size_bytes=len(payload), copy=make_copy), Principal(user, "person@example.com"), session)
        row = session.get(imports.ImportJob, reply["id"])
        object_storage.put_local(row.storage_key, payload, mydeck.MIME)
        imports.complete(row.id, Principal(user, "person@example.com"), session)
    imports.process_one()
    with db.session_scope() as session:
        row = session.get(imports.ImportJob, reply["id"])
        return imports.describe(row)


def test_import_identity_copy_extras_and_invalid_archive_leave_no_rows(account):
    document = blank_document("Round trip")
    document["futureProperty"] = {"opaque": True}
    payload = package(document, extra=("extras/unknown.bin", b"future opaque bytes"))
    first = submit(account, payload)
    assert first["status"] == "completed", first
    assert first["presentation_id"] == document["id"]
    assert submit(account, payload)["status"] == "existing"
    second = submit(account, payload, make_copy=True)
    assert second["status"] == "completed", second
    assert second["presentation_id"] != first["presentation_id"]
    with db.session_scope() as session:
        assert store.load_presentation(session, first["presentation_id"]).document["futureProperty"] == {"opaque": True}
        extras = session.get(imports.PackageExtras, first["presentation_id"])
        asset = session.get(Asset, extras.assets_json["extras/unknown.bin"])
        assert object_storage.read(asset.storage_key)[0] == b"future opaque bytes"
        from deckastra_api import assets
        assert asset.id in assets.cited_by_history(session, first["presentation_id"])
        assert asset.id in assets.cited_elsewhere(session, workspace_id=asset.workspace_id, except_presentation_id=second["presentation_id"])
        before = len(list(session.scalars(select(Presentation))))
    assert submit(account, package(extra=("../evil", b"x")))["status"] == "failed"
    with db.session_scope() as session: assert len(list(session.scalars(select(Presentation)))) == before


def test_an_agent_grant_cannot_import(account):
    with db.session_scope() as session, pytest.raises(HTTPException) as error:
        imports.begin(account[1], imports.Begin(size_bytes=10), Principal(account[0], "person@example.com", frozenset({"read", "write"})), session)
    assert error.value.status_code == 403
