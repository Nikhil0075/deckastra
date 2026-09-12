"""Local mode: one account, one secret, and the features a single machine has none of.

The risk this suite exists for is not that local mode fails to work — a broken
local build is obvious the moment the app opens. It is that local mode *works too
well*: that it authorises more than it should, or that it quietly turns on in a
deployment where the shared secret it trusts is a way in.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from deckastra_api import local_mode, object_storage
from deckastra_api.db import session as db_session
from deckastra_api.db.session import session_scope

SECRET = "x" * 40


@pytest.fixture
def local(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'local.db'}")
    monkeypatch.setenv("DECKASTRA_LOCAL_MODE", "1")
    monkeypatch.setenv("DECKASTRA_LOCAL_SECRET", SECRET)
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    monkeypatch.delenv("DECKASTRA_ENV", raising=False)

    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as client:
        yield client

    db_session.reset_engine()


def auth(token: str = SECRET) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_local_mode_refuses_to_run_in_production(monkeypatch):
    # Both settings together mean an OIDC-less server that trusts one shared
    # secret. Guessing which the operator meant is how that ships.
    monkeypatch.setenv("DECKASTRA_LOCAL_MODE", "1")
    monkeypatch.setenv("DECKASTRA_ENV", "production")
    with pytest.raises(local_mode.LocalModeMisconfigured):
        local_mode.enabled()


def test_a_missing_or_short_secret_is_a_configuration_error(monkeypatch):
    # No default, ever. A default bearer on a loopback port is a local
    # privilege-escalation primitive for anything else running as this user.
    monkeypatch.setenv("DECKASTRA_LOCAL_MODE", "1")
    monkeypatch.delenv("DECKASTRA_LOCAL_SECRET", raising=False)
    with pytest.raises(local_mode.LocalModeMisconfigured):
        local_mode.launch_secret()

    monkeypatch.setenv("DECKASTRA_LOCAL_SECRET", "too-short")
    with pytest.raises(local_mode.LocalModeMisconfigured):
        local_mode.launch_secret()


def test_the_launch_secret_is_the_only_way_in(local):
    assert local.get("/v1/account", headers=auth()).status_code == 200
    assert local.get("/v1/account", headers=auth("wrong-" + "x" * 34)).status_code == 401
    assert local.get("/v1/account").status_code == 401


def test_a_development_token_does_not_work_in_local_mode(local):
    # Two ways in is one more than a single-user service should have, and the
    # dev-token path signs with a secret that has a published default.
    from deckastra_api.auth import issue_dev_token

    with session_scope() as session:
        user, _, _ = local_mode.bootstrap(session)
        forged = issue_dev_token(user.id)

    assert local.get("/v1/account", headers=auth(forged)).status_code == 401


def test_the_account_is_a_real_member_so_every_authorisation_check_still_runs(local):
    body = local.get("/v1/account", headers=auth()).json()
    assert body["user"]["email"] == local_mode.LOCAL_EMAIL
    # Not a bypass: a real workspace with a real membership, so `resolve_*`
    # answers the same way it does for a tenant.
    assert body["workspaces"][0]["role"] == "owner"
    assert body["workspaces"][0]["projects"]


def test_the_singleton_account_is_stable_across_launches(local):
    first = local.get("/v1/account", headers=auth()).json()
    second = local.get("/v1/account", headers=auth()).json()
    assert first["user"]["id"] == second["user"]["id"]
    assert len(second["workspaces"]) == 1


def test_creating_and_editing_a_deck_works_end_to_end(local):
    created = local.post(
        "/v1/presentations", headers=auth(), json={"title": "Local deck"}
    )
    assert created.status_code == 201, created.text
    presentation_id = created.json()["presentation_id"]

    read = local.get(f"/v1/presentations/{presentation_id}", headers=auth()).json()
    assert read["can_edit"] is True

    committed = local.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth(),
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "Renamed"}],
            "intent": "Retitle",
            "expected_version_id": read["version_id"],
            "client_id": "desktop-editor",
        },
    )
    assert committed.status_code == 200, committed.text

    again = local.get(f"/v1/presentations/{presentation_id}", headers=auth()).json()
    assert again["document"]["metadata"]["title"] == "Renamed"

    # The invariant the whole persistence design turns on, on this path too.
    stale = local.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth(),
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": "Third"}],
            "intent": "Retitle",
            "expected_version_id": read["version_id"],
            "client_id": "desktop-editor",
        },
    )
    assert stale.status_code == 409


def test_sharing_is_refused_because_nobody_could_open_the_link(local):
    created = local.post("/v1/presentations", headers=auth(), json={"title": "Deck"})
    presentation_id = created.json()["presentation_id"]

    assert local.post(
        f"/v1/presentations/{presentation_id}/shares", headers=auth(), json={"role": "viewer"}
    ).status_code == 404
    assert local.get(
        f"/v1/presentations/{presentation_id}/shares", headers=auth()
    ).status_code == 404
    # The product's only unauthenticated read is not served on a personal machine.
    assert local.get("/v1/shared/anything").status_code == 404


def test_the_development_sign_in_cannot_create_a_second_account(local):
    # It would create a workspace that owns none of this install's decks, and the
    # caller would not find out until a read returned 404.
    assert local.post("/v1/dev/session", json={"email": "someone@else"}).status_code == 404
    assert len(local.get("/v1/account", headers=auth()).json()["workspaces"]) == 1


def test_a_local_install_is_not_metered(local):
    usage = local.get("/v1/workspace/usage", headers=auth()).json()
    assert usage["plan"] == local_mode.LOCAL_PLAN
    # Null is unlimited and it is not zero. Metering one person's own machine is
    # a limit with nobody to enforce it for, and a progress bar against no limit
    # is a bar that means nothing.
    for meter in ("generations", "tokens", "storage_bytes", "repositories"):
        assert usage[meter]["allowed"] is None, meter
        assert usage[meter]["fraction"] is None, meter


class TestLocalAssetStorage:
    def test_bytes_round_trip_through_the_directory(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path))
        key = "workspaces/wsp_1/assets/ast_1"

        object_storage.put_local(key, b"hello", "image/png")
        assert object_storage.read_local(key) == (b"hello", "image/png")

        meta = object_storage.metadata(key)
        assert meta.bytes == 5
        assert meta.content_type == "image/png"
        # An ETag the S3 backend would produce for the same single-part upload, so
        # the two backends describe an object the same way.
        assert meta.etag == "5d41402abc4b2a76b9719d911017c592"

        object_storage.delete(key)
        with pytest.raises(object_storage.ObjectStorageError):
            object_storage.read_local(key)

    def test_a_key_cannot_escape_the_asset_directory(self, tmp_path, monkeypatch):
        # Keys are generated server-side, so this is not the expected case — but
        # this is the one function that turns a database string into a path.
        monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
        with pytest.raises(object_storage.ObjectStorageError):
            object_storage.put_local("../escaped", b"x", "text/plain")

    def test_the_url_is_relative_so_it_cannot_leak_the_loopback_port(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path))
        url = object_storage.presigned_get("workspaces/wsp_1/assets/ast_1")
        assert url.startswith("/v1/workspace/assets/blob/")
        assert "127.0.0.1" not in url and "http" not in url

    def test_the_blob_routes_are_absent_without_a_local_store(self, local, monkeypatch):
        monkeypatch.delenv("DECKASTRA_ASSET_DIR", raising=False)
        response = local.get(
            "/v1/workspace/assets/blob/workspaces/wsp_1/assets/ast_1", headers=auth()
        )
        assert response.status_code == 404


class TestExporterDiagnostics:
    """An exporter that cannot run should say which kind of "cannot".

    A packaged build with no browser fails on every export, forever, and the
    honest report is "this build cannot render" rather than a CommonJS loader
    frame. A deck-specific failure keeps its raw output, because there the stack
    is the only diagnostic there is.
    """

    def test_a_missing_browser_is_explained_on_both_failure_routes(self):
        from deckastra_api.export_service import _no_output_reason, explain_export_failure

        raw = r"Cannot find package 'playwright' imported from C:pp\worker\cli.mjs"

        # The exporter reports its own failures as JSON when it gets far enough to
        # run, and prints nothing when the import fails first. A missing browser
        # can produce either, so both have to say the same thing.
        for message in (explain_export_failure(raw), _no_output_reason(1, raw)):
            assert "cannot render" in message
            # Retrying will never help, so it must not read like a transient
            # failure — and it must still carry the original for a bug report.
            assert "playwright" in message

    def test_an_ordinary_failure_keeps_its_output(self):
        from deckastra_api.export_service import _no_output_reason

        message = _no_output_reason(3, "TypeError: cannot read property 'x' of undefined")
        assert "produced no output (exit 3)" in message
        assert "TypeError" in message

    def test_a_missing_exporter_names_the_path_it_looked_for(self, tmp_path, monkeypatch):
        from deckastra_api import export_service

        monkeypatch.setenv("DECKASTRA_WORKER_CMD", str(tmp_path / "absent" / "cli.mjs"))
        with pytest.raises(export_service.ExportError) as caught:
            export_service._worker_command()
        assert "not installed at" in str(caught.value)


class TestExportLocation:
    """Exports live in the install's data directory, not the system temp folder.

    They went to temp on every desktop install: outside the one directory a
    backup copies, on the system drive, and in a folder Windows' own cleanup may
    empty — so a finished export's "Download" could outlive its file.
    """

    def test_configuring_a_data_directory_puts_exports_inside_it(self, tmp_path, monkeypatch):
        from deckastra_api import export_service
        from deckastra_api.local_server import configure_environment

        # Registered with monkeypatch so the variables configure_environment
        # writes straight into os.environ are restored after the test.
        for key in ("DECKASTRA_LOCAL_MODE", "DATABASE_URL", "DECKASTRA_ASSET_DIR", "DECKASTRA_EXPORT_DIR"):
            monkeypatch.delenv(key, raising=False)

        data_dir = tmp_path / "workspace"
        configure_environment(data_dir)

        # Resolved after the module was already imported above — the case the
        # old import-time constant got wrong.
        root = export_service.export_root()
        assert root == data_dir / "deckastra-exports"
        assert root.is_relative_to(data_dir)

    def test_the_location_is_read_when_an_export_runs_not_when_the_module_loads(self, tmp_path, monkeypatch):
        from deckastra_api import export_service

        monkeypatch.setenv("DECKASTRA_EXPORT_DIR", str(tmp_path / "first"))
        assert export_service.export_root() == tmp_path / "first" / "deckastra-exports"
        monkeypatch.setenv("DECKASTRA_EXPORT_DIR", str(tmp_path / "second"))
        assert export_service.export_root() == tmp_path / "second" / "deckastra-exports"

    def test_without_a_setting_it_still_has_somewhere_to_write(self, monkeypatch):
        import tempfile

        from deckastra_api import export_service

        # A deployed service that never set it keeps the old behaviour rather
        # than failing; only the desktop has a data directory to point at.
        monkeypatch.delenv("DECKASTRA_EXPORT_DIR", raising=False)
        assert export_service.export_root().parent == __import__("pathlib").Path(tempfile.gettempdir())
