"""Launch hardening: sharing, quotas, assets and themes (Phase 9).

Four gap-register items in one file because they are one story — the things a
product cannot launch without, none of which is about generating a deck.

The sharing tests get the most attention. A share link is a **bearer
credential**: whoever holds it is authorised, with no identity and no second
factor. That makes it the one place in the product where getting a detail wrong
turns a private deck public, and where the failure is silent.
"""

from __future__ import annotations

import copy
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'launch.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "owner@localhost"})
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def stranger(client):
    response = client.post("/v1/dev/session", json={"email": "stranger@localhost"})
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def deck(client, auth):
    generated = client.post(
        "/v1/generate", headers=auth, json={"instruction": "A deck to share", "slide_count": 3}
    )
    assert generated.status_code == 200, generated.text
    return generated.json()["presentation_id"]


# ------------------------------------------------------------------ sharing


def test_a_link_lets_an_audience_open_a_deck_they_have_no_account_for(client, auth, deck):
    """The gap this closes (doc 01 S2, doc 05 S2).

    Present mode implies an audience, and until now the audience had no access
    path — the Share button in the mockup had nothing behind it.
    """
    created = client.post(f"/v1/presentations/{deck}/shares", headers=auth, json={})
    assert created.status_code == 200, created.text
    token = created.json()["token"]

    # No Authorization header at all: this is what a link in an email is.
    opened = client.get(f"/v1/shared/{token}")
    assert opened.status_code == 200
    assert opened.json()["document"]["slides"]
    assert opened.json()["role"] == "viewer"


def test_the_token_is_returned_once_and_never_again(client, auth, deck):
    """A share link is a bearer credential, stored hashed like an API key.

    A database read must not hand out working links to every deck in the product,
    which means the server genuinely cannot show it again — and the UI has to say
    so rather than letting a user hunt for it.
    """
    created = client.post(f"/v1/presentations/{deck}/shares", headers=auth, json={})
    assert created.json()["token"]

    listed = client.get(f"/v1/presentations/{deck}/shares", headers=auth)
    assert listed.status_code == 200
    for share in listed.json()["shares"]:
        assert "token" not in share


def test_the_stored_form_is_a_hash_not_the_link(client, auth, deck):
    from deckastra_api.db.models import PresentationShare

    token = client.post(f"/v1/presentations/{deck}/shares", headers=auth, json={}).json()["token"]

    with db_session.session_scope() as session:
        row = session.query(PresentationShare).one()
        assert row.token_hash != token
        assert token not in row.token_hash


def test_a_guessed_token_is_refused_the_same_way_as_a_revoked_one(client, auth, deck):
    """Every refusal is the same refusal.

    Telling a holder which of "expired", "revoked" or "never existed" it is
    confirms that a deck exists behind the id they tried.
    """
    created = client.post(f"/v1/presentations/{deck}/shares", headers=auth, json={})
    share_id = created.json()["id"]
    token = created.json()["token"]

    client.delete(f"/v1/shares/{share_id}", headers=auth)

    revoked = client.get(f"/v1/shared/{token}")
    invented = client.get("/v1/shared/definitely-not-a-real-token")

    assert revoked.status_code == invented.status_code == 404
    assert revoked.json()["detail"] == invented.json()["detail"]


def test_an_expired_link_stops_working(client, auth, deck):
    from deckastra_api.db.models import PresentationShare

    token = client.post(
        f"/v1/presentations/{deck}/shares", headers=auth, json={"expires_in_days": 7}
    ).json()["token"]

    assert client.get(f"/v1/shared/{token}").status_code == 200

    with db_session.session_scope() as session:
        share = session.query(PresentationShare).one()
        share.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)

    assert client.get(f"/v1/shared/{token}").status_code == 404


def test_a_revoked_link_is_kept_as_a_record(client, auth, deck):
    """"Who could see this, and when did that stop" is the question asked after
    something leaks, and a deleted row cannot answer it."""
    created = client.post(
        f"/v1/presentations/{deck}/shares", headers=auth, json={"label": "Client review"}
    )
    client.delete(f"/v1/shares/{created.json()['id']}", headers=auth)

    listed = client.get(f"/v1/presentations/{deck}/shares", headers=auth).json()["shares"]
    assert len(listed) == 1
    assert listed[0]["status"] == "revoked"
    assert listed[0]["label"] == "Client review"


def test_a_link_grants_nothing_beyond_the_one_deck(client, auth, deck):
    """A link to one deck is not a foothold in a workspace."""
    token = client.post(f"/v1/presentations/{deck}/shares", headers=auth, json={}).json()["token"]
    body = client.get(f"/v1/shared/{token}").json()

    # No project, no workspace, no siblings, no members, no repositories.
    assert set(body) == {"presentation_id", "title", "document", "version_id", "role"}


def test_a_link_cannot_be_made_more_powerful_than_an_editor(client, auth, deck):
    """A link granting admin is a link that can revoke the workspace's others."""
    response = client.post(
        f"/v1/presentations/{deck}/shares", headers=auth, json={"role": "admin"}
    )
    # 422 from the schema: the role is a closed set, so it never reaches the
    # service at all.
    assert response.status_code == 422


def test_a_viewer_cannot_widen_who_can_read_a_deck(client, auth, deck, stranger):
    # Someone outside the workspace sees a 404, not a 403 — a 403 on something
    # you cannot see confirms it exists.
    assert (
        client.post(f"/v1/presentations/{deck}/shares", headers=stranger, json={}).status_code
        == 404
    )


def test_the_view_counter_answers_is_anyone_using_this(client, auth, deck):
    token = client.post(f"/v1/presentations/{deck}/shares", headers=auth, json={}).json()["token"]

    for _ in range(3):
        client.get(f"/v1/shared/{token}")

    share = client.get(f"/v1/presentations/{deck}/shares", headers=auth).json()["shares"][0]
    assert share["view_count"] == 3
    assert share["last_viewed_at"]


# ------------------------------------------------------------------- quotas


def test_usage_is_visible_to_a_member(client, auth):
    usage = client.get("/v1/workspace/usage", headers=auth)
    assert usage.status_code == 200

    body = usage.json()
    assert body["plan"] == "free"
    assert body["generations"]["allowed"] == 30
    assert body["resets_at"]


def test_a_generation_is_charged_after_it_runs(client, auth, deck):
    body = client.get("/v1/workspace/usage", headers=auth).json()
    # The `deck` fixture generated one.
    assert body["generations"]["used"] == 1


def test_generation_is_refused_once_the_allowance_is_gone(client, auth):
    """Refused before the work, not after.

    Checking afterwards means paying for the request that broke the limit.
    """
    from deckastra_api.db.models import WorkspaceQuota

    with db_session.session_scope() as session:
        quota = session.query(WorkspaceQuota).one_or_none()
        if quota is None:
            from deckastra_api import quotas
            from deckastra_api.db.models import WorkspaceMember

            workspace_id = session.query(WorkspaceMember).first().workspace_id
            quota = quotas.ensure(session, workspace_id)
        quota.used_generations = quota.monthly_generations

    response = client.post(
        "/v1/generate", headers=auth, json={"instruction": "One too many", "slide_count": 3}
    )

    # 429, not 403: this is a rate the caller can wait out.
    assert response.status_code == 429
    detail = response.json()["detail"]
    # Actionable. "Quota exceeded" is not; "30 of 30, resets on the 14th" is.
    assert detail["limit"] == "generations"
    assert detail["allowed"] == 30
    assert detail["resets_at"]


def test_the_period_rolls_lazily_rather_than_on_a_schedule(client, auth):
    """A cron that misses a month would lock every workspace out of the product,
    and the failure would look like a bug in generation."""
    from deckastra_api import quotas
    from deckastra_api.db.models import WorkspaceMember, WorkspaceQuota

    with db_session.session_scope() as session:
        workspace_id = session.query(WorkspaceMember).first().workspace_id
        quota = quotas.ensure(session, workspace_id)
        quota.used_generations = 30
        quota.used_storage_bytes = 4096
        quota.period_start = datetime.now(timezone.utc) - timedelta(days=quotas.PERIOD_DAYS + 1)

    with db_session.session_scope() as session:
        workspace_id = session.query(WorkspaceMember).first().workspace_id
        rolled = quotas.ensure(session, workspace_id)

        assert rolled.used_generations == 0
        # Storage is a level, not a flow. Zeroing it would let a workspace exceed
        # its disk allowance by waiting a month.
        assert rolled.used_storage_bytes == 4096


def test_unlimited_is_a_plan_not_a_missing_row(client, auth):
    from deckastra_api import quotas
    from deckastra_api.db.models import WorkspaceMember

    with db_session.session_scope() as session:
        workspace_id = session.query(WorkspaceMember).first().workspace_id
        quota = quotas.set_plan(session, workspace_id, "unlimited")
        # Null, not a very large number: "no ceiling" and "allowed nothing" are
        # different things and one integer cannot say both.
        assert quota.monthly_generations is None

    body = client.get("/v1/workspace/usage", headers=auth).json()
    assert body["generations"]["allowed"] is None
    # A progress bar against no limit is a bar that means nothing.
    assert body["generations"]["fraction"] is None


def test_a_repository_beyond_the_plan_is_refused(client, auth, tmp_path, monkeypatch):
    monkeypatch.setenv("DECKASTRA_ALLOW_LOCAL_REPOS", "1")

    first = tmp_path / "one"
    first.mkdir()
    (first / "README.md").write_text("# one", encoding="utf-8")
    second = tmp_path / "two"
    second.mkdir()
    (second / "README.md").write_text("# two", encoding="utf-8")

    assert (
        client.post("/v1/repositories/local", headers=auth, json={"path": str(first)}).status_code
        == 200
    )
    # The free plan allows one.
    refused = client.post("/v1/repositories/local", headers=auth, json={"path": str(second)})
    assert refused.status_code == 429
    assert refused.json()["detail"]["limit"] == "repositories"


# ------------------------------------------------------------------- assets


def test_an_asset_nothing_references_is_a_candidate_not_a_corpse(client, auth):
    """Reaching zero references starts a clock; it does not delete anything.

    A user who deletes a slide and undoes it expects the picture back, and the
    only way to give it to them is to still have it.
    """
    from deckastra_api import assets
    from deckastra_api.db.models import Asset, WorkspaceMember

    with db_session.session_scope() as session:
        workspace_id = session.query(WorkspaceMember).first().workspace_id
        asset = assets.register(
            session,
            workspace_id=workspace_id,
            created_by="usr_x",
            storage_key="uploads/a.png",
            filename="a.png",
            size_bytes=2048,
        )
        asset_id = asset.id

    swept = client.post("/v1/workspace/assets/sweep?dry_run=true", headers=auth).json()
    # Uploaded a moment ago: unreferenced because the user has not placed it yet.
    assert asset_id not in swept["deleted"]

    with db_session.session_scope() as session:
        assert session.get(Asset, asset_id) is not None


def test_an_old_unreferenced_asset_is_swept_and_its_bytes_reclaimed(client, auth):
    from deckastra_api import assets
    from deckastra_api.db.models import Asset, WorkspaceMember

    with db_session.session_scope() as session:
        workspace_id = session.query(WorkspaceMember).first().workspace_id
        asset = assets.register(
            session,
            workspace_id=workspace_id,
            created_by="usr_x",
            storage_key="uploads/old.png",
            size_bytes=4096,
        )
        asset.created_at = datetime.now(timezone.utc) - timedelta(
            days=assets.ORPHAN_GRACE_DAYS + 1
        )
        asset_id = asset.id

    dry = client.post("/v1/workspace/assets/sweep?dry_run=true", headers=auth).json()
    assert asset_id in dry["deleted"]

    with db_session.session_scope() as session:
        # A dry run deletes nothing. This deletes user data by inference, so
        # looking before acting is the default posture.
        assert session.get(Asset, asset_id) is not None

    wet = client.post("/v1/workspace/assets/sweep?dry_run=false", headers=auth).json()
    assert wet["reclaimed_bytes"] == 4096

    with db_session.session_scope() as session:
        assert session.get(Asset, asset_id) is None


def test_an_asset_a_document_cites_is_never_swept(client, auth, deck):
    """Counted from the documents, not incremented on edit.

    An increment missed once is wrong forever; a recount is right every time.
    """
    from deckastra_api import assets
    from deckastra_api.db.models import Asset, PresentationVersion, WorkspaceMember

    with db_session.session_scope() as session:
        workspace_id = session.query(WorkspaceMember).first().workspace_id
        asset = assets.register(
            session,
            workspace_id=workspace_id,
            created_by="usr_x",
            storage_key="uploads/used.png",
            size_bytes=1024,
        )
        asset.created_at = datetime.now(timezone.utc) - timedelta(days=90)
        asset_id = asset.id

        # Put it in a stored snapshot, the way an image element would.
        version = (
            session.query(PresentationVersion)
            .filter(PresentationVersion.snapshot_json.isnot(None))
            .first()
        )
        # A deep copy, deliberately. `JsonColumn` is a plain JSON type rather
        # than a `MutableDict`, so an in-place change to a nested list is
        # invisible to the session — the assignment that follows would be an
        # assignment of an already-equal value and no UPDATE would be issued.
        snapshot = copy.deepcopy(version.snapshot_json)
        snapshot["slides"][0]["elements"].append(
            {"id": "el_probe", "type": "image", "assetId": asset_id}
        )
        version.snapshot_json = snapshot

    swept = client.post("/v1/workspace/assets/sweep?dry_run=false", headers=auth).json()
    assert asset_id not in swept["deleted"]

    with db_session.session_scope() as session:
        assert session.get(Asset, asset_id).reference_count == 1


def test_storage_is_recounted_from_the_assets_themselves(client, auth):
    from deckastra_api import assets, quotas
    from deckastra_api.db.models import WorkspaceMember

    with db_session.session_scope() as session:
        workspace_id = session.query(WorkspaceMember).first().workspace_id
        for index in range(3):
            assets.register(
                session,
                workspace_id=workspace_id,
                created_by="usr_x",
                storage_key=f"uploads/{index}.png",
                size_bytes=1000,
            )

    body = client.get("/v1/workspace/usage", headers=auth).json()
    assert body["storage_bytes"]["used"] == 3000


def test_an_upload_over_the_storage_allowance_is_refused(client, auth):
    from deckastra_api import assets, quotas
    from deckastra_api.db.models import WorkspaceMember

    with db_session.session_scope() as session:
        workspace_id = session.query(WorkspaceMember).first().workspace_id
        quota = quotas.ensure(session, workspace_id)
        quota.storage_bytes = 1000

        with pytest.raises(quotas.QuotaExceeded):
            assets.register(
                session,
                workspace_id=workspace_id,
                created_by="usr_x",
                storage_key="uploads/huge.png",
                size_bytes=2000,
            )


# ------------------------------------------------------------------- themes


def test_a_theme_is_validated_against_the_generated_schema(client, auth):
    response = client.post(
        "/v1/workspace/themes",
        headers=auth,
        json={"name": "Broken", "definition": {"name": "no tokens"}},
    )
    assert response.status_code == 400
    assert "schema" in response.json()["detail"]


def test_a_theme_can_be_saved_and_applied_as_a_transaction(client, auth, deck):
    """Re-applying a brand is an edit like any other, so it undoes like one.

    Writing the document directly would make it the single change in the product
    with no inverse.
    """
    current = client.get(f"/v1/presentations/{deck}", headers=auth).json()["document"]

    definition = dict(current["theme"])
    definition["name"] = "Client brand"
    definition["colors"] = {**definition["colors"], "accent": "#FF6600"}

    saved = client.post(
        "/v1/workspace/themes",
        headers=auth,
        json={"name": "Client brand", "definition": definition, "is_default": True},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["preview"]["accent"] == "#FF6600"

    applied = client.post(
        f"/v1/presentations/{deck}/theme/{saved.json()['id']}", headers=auth
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["document"]["theme"]["colors"]["accent"] == "#FF6600"

    # In the history, with an inverse, like every other change.
    history = client.get(f"/v1/presentations/{deck}/transactions", headers=auth).json()
    themed = next(entry for entry in history if "theme" in entry["intent"].lower())
    assert themed["source"] == "system"

    # And it undoes: the inverse restores the accent the deck had before.
    reverted = client.post(
        f"/v1/presentations/{deck}/transactions/{themed['id']}/revert", headers=auth
    )
    assert reverted.status_code == 200, reverted.text
    assert reverted.json()["document"]["theme"]["colors"]["accent"] != "#FF6600"


def test_the_document_keeps_both_the_id_and_the_resolved_tokens(client, auth, deck):
    """A `themeId` alone would make a `.mydeck` file unopenable outside the
    workspace that owns the theme, and doc 02's first rule is that a document is
    portable and safe to email."""
    current = client.get(f"/v1/presentations/{deck}", headers=auth).json()["document"]
    definition = {**current["theme"], "name": "Portable"}

    theme_id = client.post(
        "/v1/workspace/themes", headers=auth, json={"name": "Portable", "definition": definition}
    ).json()["id"]

    applied = client.post(f"/v1/presentations/{deck}/theme/{theme_id}", headers=auth).json()

    assert applied["document"]["metadata"]["themeId"] == theme_id
    # And the full token set, so it renders with no lookup.
    assert applied["document"]["theme"]["colors"]["background"]


def test_only_one_theme_is_default_at_a_time(client, auth, deck):
    current = client.get(f"/v1/presentations/{deck}", headers=auth).json()["document"]

    for name in ("First", "Second"):
        client.post(
            "/v1/workspace/themes",
            headers=auth,
            json={
                "name": name,
                "definition": {**current["theme"], "name": name},
                "is_default": True,
            },
        )

    themes = client.get("/v1/workspace/themes", headers=auth).json()["themes"]
    assert [theme["name"] for theme in themes if theme["is_default"]] == ["Second"]


def test_a_theme_from_another_workspace_cannot_be_applied(client, auth, deck, stranger):
    current = client.get(f"/v1/presentations/{deck}", headers=auth).json()["document"]

    theirs = client.post(
        "/v1/workspace/themes",
        headers=stranger,
        json={"name": "Theirs", "definition": {**current["theme"], "name": "Theirs"}},
    )
    assert theirs.status_code == 200

    response = client.post(
        f"/v1/presentations/{deck}/theme/{theirs.json()['id']}", headers=auth
    )
    assert response.status_code == 404
