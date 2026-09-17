"""The S3 backend, against a real object store (2026-09-17).

`object_storage` has two backends and only one of them was ever executed by a
test. The local directory is what a desktop install uses, so it is covered
everywhere; the S3 path is what the *deployed* product uses, and it ran only when
somebody happened to have MinIO up — which, until this file, nothing asked them
to do and nothing checked.

That is the shape of gap this project keeps finding: a branch that is right in
the code everyone reads and unexercised in the one deployment that matters. It is
the same argument `test_postgres.py` makes about JSONB, so it gets the same
treatment — skip without the service rather than pass vacuously, and run for real
when `docker compose up -d minio` is up.

`read()` is the reason this was written now. It was added so a headless render
could be handed the bytes of a deck's pictures (D5.7), and its S3 half had never
been run at all: on a deployed install every export would have reached for a
function nobody had executed.
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import object_storage  # noqa: E402
from tests.conftest import requires_object_store  # noqa: E402

#: Eight bytes of PNG signature and a marker. Not a valid image — nothing here
#: decodes it, and a real one would only obscure which bytes came back.
PROBE = bytes([137, 80, 78, 71, 13, 10, 26, 10]) + b"object-storage-probe"


@pytest.fixture()
def no_local_directory(monkeypatch):
    """Force the S3 branch.

    `local_root()` decides the backend, and a machine with `DECKASTRA_ASSET_DIR`
    set — every desktop one — would otherwise run these against a directory and
    report the S3 path as covered when it was not.
    """
    monkeypatch.delenv("DECKASTRA_ASSET_DIR", raising=False)
    assert object_storage.local_root() is None


@pytest.fixture()
def stored(no_local_directory):
    """An object that really exists in the bucket, removed afterwards."""
    key = "tests/object-storage-round-trip.png"
    url = object_storage.presigned_put(key, "image/png")
    request = urllib.request.Request(
        url, data=PROBE, method="PUT", headers={"Content-Type": "image/png"}
    )
    with urllib.request.urlopen(request, timeout=30) as answer:
        assert answer.status in (200, 204)
    try:
        yield key
    finally:
        try:
            object_storage.delete(key)
        except object_storage.ObjectStorageError:
            pass


@requires_object_store
def test_a_presigned_put_is_all_the_credential_a_client_needs(stored):
    # The signature *is* the credential, which is why `assets.upload()` must not
    # attach a bearer to an absolute upload URL. This is the other end of that
    # rule: an unauthenticated PUT with only the signature has to work.
    meta = object_storage.metadata(stored)
    assert meta.bytes == len(PROBE)
    assert meta.content_type == "image/png"
    assert meta.etag


@requires_object_store
def test_read_returns_the_bytes_and_the_type(stored):
    # The function a headless export depends on (D5.7). Its local half is covered
    # by `test_render_assets.py`; this is the half a deployed install runs, and
    # before this test nothing had ever executed it.
    data, content_type = object_storage.read(stored)
    assert data == PROBE
    assert content_type == "image/png"


@requires_object_store
def test_a_presigned_get_serves_the_same_bytes(stored):
    # What a shared deck's images resolve to on a deployment with an object store:
    # the API redirects rather than putting every viewer's download through itself.
    with urllib.request.urlopen(object_storage.presigned_get(stored), timeout=30) as answer:
        assert answer.read() == PROBE


@requires_object_store
def test_deleting_removes_it(no_local_directory):
    # The sweeper's last step. Reference counting alone does not prove bytes were
    # reclaimed — this is the part that does.
    key = "tests/object-storage-delete.png"
    url = object_storage.presigned_put(key, "image/png")
    request = urllib.request.Request(
        url, data=PROBE, method="PUT", headers={"Content-Type": "image/png"}
    )
    with urllib.request.urlopen(request, timeout=30):
        pass
    assert object_storage.metadata(key).bytes == len(PROBE)

    object_storage.delete(key)

    with pytest.raises(object_storage.ObjectStorageError):
        object_storage.metadata(key)


@requires_object_store
def test_reading_something_that_is_not_there_is_an_error_not_an_empty_answer(no_local_directory):
    # An empty answer would reach an export as a zero-byte picture, which is a
    # broken image in a customer's PDF rather than a reported one.
    with pytest.raises(object_storage.ObjectStorageError):
        object_storage.read("tests/never-uploaded.png")


@requires_object_store
def test_an_export_gets_its_picture_from_the_object_store(no_local_directory, tmp_path):
    """The deployed shape of D5.7: rows in the database, bytes in the bucket.

    `test_render_assets.py` covers this against a local directory, which is what a
    desktop install has. A deployment has neither the directory nor the local blob
    route, so the whole picture path for every cloud export runs through code that
    file never touches.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from deckastra_api import assets as asset_service
    from deckastra_api.db.models import Asset, Base, Presentation, Project, User, Workspace
    from deckastra_api.ids import new_id

    engine = create_engine(f"sqlite:///{tmp_path / 'deployed.db'}")
    Base.metadata.create_all(engine)

    key = "tests/export-picture.png"
    url = object_storage.presigned_put(key, "image/png")
    request = urllib.request.Request(
        url, data=PROBE, method="PUT", headers={"Content-Type": "image/png"}
    )
    with urllib.request.urlopen(request, timeout=30):
        pass

    try:
        with Session(engine) as session:
            user_id = new_id("usr")
            session.add(User(id=user_id, email="deployed@localhost", name="deployed"))
            session.flush()
            workspace_id = new_id("wsp")
            session.add(Workspace(id=workspace_id, name="deployed", owner_id=user_id))
            session.flush()
            project_id = new_id("prj")
            session.add(
                Project(
                    id=project_id,
                    workspace_id=workspace_id,
                    name="deployed",
                    created_by=user_id,
                )
            )
            session.flush()
            presentation_id = new_id("doc")
            session.add(
                Presentation(
                    id=presentation_id,
                    project_id=project_id,
                    title="deployed",
                    schema_version="1.1",
                )
            )
            asset_id = new_id("ast")
            session.add(
                Asset(
                    id=asset_id,
                    workspace_id=workspace_id,
                    created_by=user_id,
                    kind="image",
                    storage_key=key,
                    filename="picture.png",
                    content_type="image/png",
                    bytes=len(PROBE),
                )
            )
            session.commit()

            supplied = asset_service.inline_for_render(
                session,
                presentation_id=presentation_id,
                document={
                    "id": new_id("doc"),
                    "assets": [{"id": asset_id, "type": "image", "storageKey": key}],
                    "slides": [
                        {
                            "id": new_id("sld"),
                            "elements": [
                                {"id": new_id("el"), "type": "image", "assetId": asset_id}
                            ],
                        }
                    ],
                },
            )

        import base64

        assert len(supplied) == 1
        assert "problem" not in supplied[0]
        assert base64.b64decode(supplied[0]["data"]) == PROBE
        assert supplied[0]["mimeType"] == "image/png"
    finally:
        engine.dispose()
        try:
            object_storage.delete(key)
        except object_storage.ObjectStorageError:
            pass
