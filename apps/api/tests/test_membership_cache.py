"""D5.4: a local membership cache is not authorization.

`workspace_members` decides what every route in the product will do. Once a
device mirrors a workspace, some of those rows are copies of decisions made
somewhere else — and a copy of a decision is not the decision. Nothing in the
schema could tell the two apart, so a mirrored row would have authorized exactly
as a real one does, including long after the person it describes was removed
upstream.

The tests here are mostly about a row that *exists and grants nothing*, which is
an unusual enough state that it is worth pinning down precisely. The one to read
first is the local-mode case at the bottom: it is the D5.1 promise — that the
singleton account's "owner of everything here" posture must not extend over
decks the server owns — and it holds without a special case anywhere, because
nothing can confirm a membership for an identity this machine invented.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import auth  # noqa: E402
from deckastra_api.auth import Role  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import (  # noqa: E402
    Project,
    User,
    Workspace,
    WorkspaceMember,
)
from deckastra_api.ids import new_id  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'members.db'}")
    monkeypatch.delenv("DECKASTRA_LOCAL_MODE", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client

    db_session.reset_engine()


def sign_in(client: TestClient, email: str = "me@local") -> dict[str, str]:
    body = client.post("/v1/dev/session", json={"email": email}).json()
    return {
        "user_id": body["user_id"],
        "workspace_id": body["workspace_id"],
        "auth": f"Bearer {body['token']}",
    }


def headers(who: dict[str, str]) -> dict[str, str]:
    return {"Authorization": who["auth"]}


def a_mirrored_workspace(session, *, owner_email: str = "them@acme.example") -> tuple[str, str]:
    """A workspace the *server* owns, as a device that had signed in would hold it.

    Written directly because nothing in the product mirrors a workspace yet.
    That is the honest way to test this: the enforcement is real, the way a row
    comes to be a copy is not built — and building the enforcement afterwards is
    how mirroring lands with nothing checking it.
    """
    them = User(id=new_id("usr"), email=owner_email, name="Them")
    session.add(them)
    workspace = Workspace(
        id=new_id("wsp"), name="Acme", owner_id=them.id, origin="cloud"
    )
    session.add(workspace)
    project = Project(
        id=new_id("prj"), workspace_id=workspace.id, name="Their project", created_by=them.id
    )
    session.add(project)
    session.flush()
    return workspace.id, project.id


def cached_membership(session, *, workspace_id: str, user_id: str, role: str, confirmed_at):
    """The row a mirror would write, with whatever freshness the case needs."""
    membership = WorkspaceMember(
        id=new_id("mbr"),
        workspace_id=workspace_id,
        user_id=user_id,
        role=role,
        confirmed_at=confirmed_at,
    )
    session.add(membership)
    session.flush()
    return membership


def ago(days: float) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


# ------------------------------------------------------------- the local case


def test_a_local_workspace_needs_no_confirmation(client):
    """The row *is* the authority there (D5.1), so there is nothing to confirm it
    against and nothing that could go stale."""
    me = sign_in(client)

    with db_session.session_scope() as session:
        status = auth.membership_status(session, me["user_id"], me["workspace_id"])

    assert status.state == "authoritative"
    assert status.role is Role.OWNER


def test_nothing_stamps_a_local_membership_as_confirmed(client):
    """Fail-closed, and the reason is subtle.

    `confirmed_at` means "the authority vouched for this". For a local workspace
    nothing ever did, so stamping one would let a month of access fall out of a
    value recording a fact nobody established.
    """
    me = sign_in(client)

    with db_session.session_scope() as session:
        membership = session.scalar(
            __import__("sqlalchemy").select(WorkspaceMember).where(
                WorkspaceMember.user_id == me["user_id"]
            )
        )
        assert membership.confirmed_at is None


# --------------------------------------------------------- the mirrored cases


def test_a_mirrored_membership_nobody_confirmed_grants_nothing(client):
    """The row a buggy mirror writes: right shape, no provenance.

    This is the case that makes every other rule here unnecessary as a special
    case. A row that appeared without a confirmation carries no claim about what
    the server decided, so it decides nothing.
    """
    me = sign_in(client)

    with db_session.session_scope() as session:
        workspace_id, project_id = a_mirrored_workspace(session)
        cached_membership(
            session,
            workspace_id=workspace_id,
            user_id=me["user_id"],
            role="owner",
            confirmed_at=None,
        )

    with db_session.session_scope() as session:
        status = auth.membership_status(session, me["user_id"], workspace_id)
        assert status.state == "lapsed"
        assert status.role is None
        assert status.authorizes is False

    # And the routes agree, which is the part that matters.
    assert (
        client.get(f"/v1/workspaces/{workspace_id}/projects", headers=headers(me)).status_code
        == 404
    )
    assert (
        client.get(f"/v1/projects/{project_id}/presentations", headers=headers(me)).status_code
        == 404
    )


def test_a_freshly_confirmed_membership_works(client):
    me = sign_in(client)

    with db_session.session_scope() as session:
        workspace_id, project_id = a_mirrored_workspace(session)
        auth.confirm_membership(
            session, user_id=me["user_id"], workspace_id=workspace_id, role="editor"
        )

    with db_session.session_scope() as session:
        status = auth.membership_status(session, me["user_id"], workspace_id)
        assert status.state == "confirmed"
        assert status.role is Role.EDITOR

    assert (
        client.get(f"/v1/projects/{project_id}/presentations", headers=headers(me)).status_code
        == 200
    )


def test_a_stale_cache_keeps_working_and_says_so(client):
    """A week on a plane is not a reason to lock someone out of their own work.

    Expiring at the first missed confirmation would make a local-first product
    useless offline, which is the thing it exists to be good at.
    """
    me = sign_in(client)

    with db_session.session_scope() as session:
        workspace_id, project_id = a_mirrored_workspace(session)
        cached_membership(
            session,
            workspace_id=workspace_id,
            user_id=me["user_id"],
            role="editor",
            confirmed_at=ago(auth.MEMBERSHIP_STALE_DAYS + 1),
        )

    with db_session.session_scope() as session:
        status = auth.membership_status(session, me["user_id"], workspace_id)
        assert status.state == "stale"
        assert status.role is Role.EDITOR

    assert (
        client.get(f"/v1/projects/{project_id}/presentations", headers=headers(me)).status_code
        == 200
    )

    listed = client.get("/v1/account", headers=headers(me)).json()["workspaces"]
    mirrored = next(one for one in listed if one["id"] == workspace_id)
    assert mirrored["access"] == "stale"


def test_a_cache_nobody_has_confirmed_for_a_month_stops(client):
    """The other half. Never expiring makes "a cache is not authorization" a
    sentence rather than a rule, and leaves a removed colleague holding a working
    copy of the workspace for as long as the laptop stays shut."""
    me = sign_in(client)

    with db_session.session_scope() as session:
        workspace_id, project_id = a_mirrored_workspace(session)
        cached_membership(
            session,
            workspace_id=workspace_id,
            user_id=me["user_id"],
            role="owner",
            confirmed_at=ago(auth.MEMBERSHIP_LAPSE_DAYS + 1),
        )

    with db_session.session_scope() as session:
        assert auth.membership_status(session, me["user_id"], workspace_id).state == "lapsed"

    assert (
        client.get(f"/v1/projects/{project_id}/presentations", headers=headers(me)).status_code
        == 404
    )


def test_a_known_revocation_is_immediate(client):
    """Not "in up to thirty days". A revocation that is known and still honoured
    while a window runs down is not a revocation."""
    me = sign_in(client)

    with db_session.session_scope() as session:
        workspace_id, project_id = a_mirrored_workspace(session)
        auth.confirm_membership(
            session, user_id=me["user_id"], workspace_id=workspace_id, role="editor"
        )

    assert (
        client.get(f"/v1/projects/{project_id}/presentations", headers=headers(me)).status_code
        == 200
    )

    with db_session.session_scope() as session:
        assert auth.revoke_cached_membership(
            session, user_id=me["user_id"], workspace_id=workspace_id
        )

    with db_session.session_scope() as session:
        assert auth.membership_status(session, me["user_id"], workspace_id).state == "revoked"

    assert (
        client.get(f"/v1/projects/{project_id}/presentations", headers=headers(me)).status_code
        == 404
    )


def test_a_revoked_membership_is_kept_not_deleted(client):
    """"Who could see this, and when did that stop" is the question asked after."""
    me = sign_in(client)

    with db_session.session_scope() as session:
        workspace_id, _project_id = a_mirrored_workspace(session)
        auth.confirm_membership(
            session, user_id=me["user_id"], workspace_id=workspace_id, role="editor"
        )
        auth.revoke_cached_membership(
            session, user_id=me["user_id"], workspace_id=workspace_id
        )

    with db_session.session_scope() as session:
        membership = session.scalar(
            __import__("sqlalchemy").select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == me["user_id"],
            )
        )
        assert membership is not None
        assert membership.revoked_at is not None


def test_being_granted_access_again_works(client):
    """A membership revoked and re-granted is an ordinary membership; leaving the
    mark would refuse it forever."""
    me = sign_in(client)

    with db_session.session_scope() as session:
        workspace_id, project_id = a_mirrored_workspace(session)
        auth.confirm_membership(
            session, user_id=me["user_id"], workspace_id=workspace_id, role="editor"
        )
        auth.revoke_cached_membership(
            session, user_id=me["user_id"], workspace_id=workspace_id
        )
        auth.confirm_membership(
            session, user_id=me["user_id"], workspace_id=workspace_id, role="viewer"
        )

    with db_session.session_scope() as session:
        status = auth.membership_status(session, me["user_id"], workspace_id)
        assert status.state == "confirmed"
        assert status.role is Role.VIEWER

    assert (
        client.get(f"/v1/projects/{project_id}/presentations", headers=headers(me)).status_code
        == 200
    )


def test_confirming_carries_the_role_not_only_the_freshness(client):
    """A subtler version of the same bug.

    A mirror that refreshed freshness without refreshing the role would keep
    honouring an editor who has since been demoted to viewer — the cache would be
    provably current and still wrong.
    """
    me = sign_in(client)

    with db_session.session_scope() as session:
        workspace_id, project_id = a_mirrored_workspace(session)
        auth.confirm_membership(
            session, user_id=me["user_id"], workspace_id=workspace_id, role="editor"
        )
        auth.confirm_membership(
            session, user_id=me["user_id"], workspace_id=workspace_id, role="viewer"
        )

    with db_session.session_scope() as session:
        assert auth.membership_status(session, me["user_id"], workspace_id).role is Role.VIEWER

    # Reading is still allowed; writing is not.
    assert (
        client.get(f"/v1/projects/{project_id}/presentations", headers=headers(me)).status_code
        == 200
    )
    created = client.post(
        "/v1/presentations",
        headers=headers(me),
        json={"title": "Not mine to make", "project_id": project_id},
    )
    assert created.status_code == 404


# ------------------------------------------------- the routes that bypassed it


def test_the_workspace_scoped_routes_go_through_the_same_check(client):
    """`resolve_workspace_access` read the role straight off the row.

    It is the entry point for themes, assets, usage and the sweeper that deletes
    files — so the moment a device mirrored a workspace, all of them would have
    honoured a cached role as readily as a real one. This is the regression test
    for that bypass, and it works by making the *only* membership a lapsed one.
    """
    me = sign_in(client, "orphan@local")

    with db_session.session_scope() as session:
        # Take away the local workspace, leaving a lapsed mirrored one as the
        # first (and only) membership these routes would resolve.
        session.query(WorkspaceMember).filter(
            WorkspaceMember.user_id == me["user_id"]
        ).delete()
        workspace_id, _project_id = a_mirrored_workspace(session)
        cached_membership(
            session,
            workspace_id=workspace_id,
            user_id=me["user_id"],
            role="owner",
            confirmed_at=ago(auth.MEMBERSHIP_LAPSE_DAYS + 1),
        )

    with pytest.raises(auth.Forbidden):
        with db_session.session_scope() as session:
            auth.resolve_workspace_access(
                session, user_id=me["user_id"], require=Role.VIEWER
            )

    # And through HTTP, where the refusal is what a caller actually meets. 404
    # rather than 403, like every other refusal in the product.
    assert client.get("/v1/usage", headers=headers(me)).status_code == 404


def test_a_lapsed_workspace_is_listed_but_empty(client):
    """Named rather than hidden.

    The person knows the workspace exists — it is on their machine — so dropping
    it from the list looks like data loss. Listing it with nothing in it, and a
    reason, is something they can act on.
    """
    me = sign_in(client)

    with db_session.session_scope() as session:
        workspace_id, _project_id = a_mirrored_workspace(session)
        cached_membership(
            session,
            workspace_id=workspace_id,
            user_id=me["user_id"],
            role="editor",
            confirmed_at=ago(auth.MEMBERSHIP_LAPSE_DAYS + 1),
        )

    listed = client.get("/v1/account", headers=headers(me)).json()["workspaces"]
    mirrored = next(one for one in listed if one["id"] == workspace_id)

    assert mirrored["access"] == "lapsed"
    assert mirrored["projects"] == []
    # The local one is unaffected, or the test would be passing on a broken
    # account context rather than on the rule.
    mine = next(one for one in listed if one["id"] == me["workspace_id"])
    assert mine["access"] == "authoritative"
    assert mine["projects"] != []


# ------------------------------------------------------------- and local mode


def test_the_local_singleton_cannot_hold_a_server_granted_role(tmp_path, monkeypatch):
    """D5.1's promise, made structural.

    Local mode's caller is an identity this machine invented. Its "owner of
    everything here" posture must not extend over decks the server owns — and it
    cannot, without any special case for local mode anywhere in the authorization
    code, because nothing can confirm a membership for an invented identity. The
    row below is exactly what a careless mirror would write, and it grants
    nothing.
    """
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'singleton.db'}")
    monkeypatch.setenv("DECKASTRA_LOCAL_MODE", "1")
    monkeypatch.setenv("DECKASTRA_LOCAL_SECRET", "x" * 40)
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    monkeypatch.delenv("DECKASTRA_ENV", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as local:
        auth_header = {"Authorization": f"Bearer {'x' * 40}"}

        # One ordinary request, because the singleton account is seeded on first
        # use rather than at import.
        assert local.get("/v1/account", headers=auth_header).status_code == 200

        with db_session.session_scope() as session:
            singleton = session.scalar(
                __import__("sqlalchemy").select(User).where(
                    User.email == "local@deckastra.invalid"
                )
            )
            assert singleton is not None
            workspace_id, project_id = a_mirrored_workspace(session)
            cached_membership(
                session,
                workspace_id=workspace_id,
                user_id=singleton.id,
                role="owner",
                confirmed_at=None,
            )

        assert (
            local.get(f"/v1/projects/{project_id}/presentations", headers=auth_header).status_code
            == 404
        )
        created = local.post(
            "/v1/presentations",
            headers=auth_header,
            json={"title": "Theirs now", "project_id": project_id},
        )
        assert created.status_code == 404

    db_session.reset_engine()
