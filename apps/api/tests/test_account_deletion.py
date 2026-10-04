from datetime import datetime, timezone
from types import SimpleNamespace
import sys
from pathlib import Path
import pytest
from fastapi import HTTPException
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deckastra_api import account_deletion as deletion, credits, store
from deckastra_api.auth import Principal, provision_personal_account
from deckastra_api.compose import blank_document
from deckastra_api.db import session as db
from deckastra_api.db.models import User, Workspace, AuthIdentity, WorkspaceMember, Presentation
from deckastra_api.credit_models import CreditAccount


@pytest.fixture
def account(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'erase.db'}")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "fixture")
    monkeypatch.setenv("DECKASTRA_ACCOUNT_DELETION_ENABLED", "1")
    db.reset_engine(); db.create_all()
    with db.session_scope() as session:
        user, workspace, project = provision_personal_account(session, email="person@example.com")
        session.add(AuthIdentity(id="identity", user_id=user.id, issuer="https://securetoken.google.com/fixture", subject="immutable-user", email_at_link=user.email))
        deck = store.create_presentation(session, project_id=project.id, document=blank_document("Private deck"), created_by=user.id)
        credits.account(session, user.id)
        ids = user.id, workspace.id, deck.presentation_id
    yield ids
    db.reset_engine()


def test_erasure_blocks_existing_identity_and_removes_personal_cloud_rows(account, monkeypatch):
    user_id, workspace_id, presentation_id = account
    deleted_prefixes = []
    fake_storage = SimpleNamespace(list_blobs=lambda bucket, prefix: (deleted_prefixes.append(prefix), [])[1])
    monkeypatch.setenv("DECKASTRA_GCS_ASSETS_BUCKET", "fixture-assets")
    monkeypatch.setenv("DECKASTRA_GCS_EXPORTS_BUCKET", "fixture-exports")
    from deckastra_api import gcs_storage, google_credentials
    monkeypatch.setattr(gcs_storage, "client", lambda: fake_storage)
    monkeypatch.setattr(google_credentials, "bearer_token", lambda: "fixture-only")
    class Http:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, **kwargs):
            assert kwargs["json"] == {"localId": "immutable-user"}
            return SimpleNamespace(status_code=200, text="")
    monkeypatch.setattr("httpx.Client", Http)
    with db.session_scope() as session:
        response = deletion.request_deletion(deletion.DeleteRequest(confirm="DELETE"), Principal(user_id, "person@example.com"), session)
        assert deletion.blocked(session, "https://securetoken.google.com/fixture", "immutable-user")
        assert not deletion.blocked(session, "https://securetoken.google.com/fixture", "other-user")
        row = session.get(deletion.AccountDeletion, response["id"])
        deletion.erase(session, row)
        assert row.status == "completed" and row.identities_json == [] and row.user_id is None
        assert session.get(User, user_id) is None
        assert session.get(Workspace, workspace_id) is None
        assert session.get(Presentation, presentation_id) is None
        assert session.get(CreditAccount, user_id) is None
    assert deleted_prefixes == [f"workspaces/{workspace_id}/"]


def test_shared_workspace_requires_ownership_transfer(account):
    user_id, workspace_id, _ = account
    with db.session_scope() as session:
        other, _, _ = provision_personal_account(session, email="other@example.com")
        session.add(WorkspaceMember(id="member", workspace_id=workspace_id, user_id=other.id, role="editor"))
        session.flush()
        with pytest.raises(HTTPException) as error:
            deletion.request_deletion(deletion.DeleteRequest(confirm="DELETE"), Principal(user_id, "person@example.com"), session)
        assert error.value.status_code == 409
        assert not deletion.blocked(session, "https://securetoken.google.com/fixture", "immutable-user")
