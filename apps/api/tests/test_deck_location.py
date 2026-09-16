"""D5.1: what signing in does *not* do.

A desktop install has a singleton account and a workspace full of decks that have
never left the machine. Signing in adds a workspace — and the tempting next step,
the one every sync product takes by default, is to upload what is already there.
That is a privacy decision taken on the user's behalf in the one direction that
cannot be taken back, and it is the same argument D3 used to refuse a silent
fall-back to a cloud model.

So the rule is: **local decks stay local until someone explicitly moves one.**
These tests are mostly about things that must *not* happen, which is the hard
half to keep true — an implicit move is invisible in a diff and obvious only to
the person whose work turned up somewhere they did not put it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import (  # noqa: E402
    Asset,
    Project,
    Workspace,
    WorkspaceMember,
)
from deckastra_api.ids import new_id  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'location.db'}")
    monkeypatch.delenv("DECKASTRA_LOCAL_MODE", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client

    db_session.reset_engine()


def sign_in(client: TestClient, email: str) -> dict[str, str]:
    """A whole identity, the way the product makes one.

    `/v1/dev/session` runs `provision_personal_account`, which is the same
    function real sign-in uses — so a workspace seeded here is seeded the way a
    user's is, rather than by a test writing rows that look plausible.
    """
    answer = client.post("/v1/dev/session", json={"email": email})
    assert answer.status_code == 200, answer.text
    body = answer.json()
    return {
        "user_id": body["user_id"],
        "workspace_id": body["workspace_id"],
        "auth": f"Bearer {body['token']}",
    }


def headers(who: dict[str, str]) -> dict[str, str]:
    return {"Authorization": who["auth"]}


def own_workspace(client: TestClient, who: dict[str, str]) -> dict:
    """The workspace this identity owns, by id rather than by position."""
    workspaces = client.get("/v1/account", headers=headers(who)).json()["workspaces"]
    return next(one for one in workspaces if one["id"] == who["workspace_id"])


def a_deck(client: TestClient, who: dict[str, str], title: str = "Private") -> dict:
    project = own_workspace(client, who)["projects"][0]["id"]
    created = client.post(
        "/v1/presentations",
        headers=headers(who),
        json={"title": title, "project_id": project},
    )
    assert created.status_code == 201, created.text
    return {**created.json(), "project_id": project}


def decks_in(client: TestClient, who: dict[str, str], project_id: str) -> list[str]:
    answer = client.get(f"/v1/projects/{project_id}/presentations", headers=headers(who))
    assert answer.status_code == 200, answer.text
    return [row["id"] for row in answer.json()["presentations"]]


def a_second_workspace(client: TestClient, who: dict[str, str]) -> dict:
    created = client.post("/v1/workspaces", headers=headers(who), json={"name": "Acme"})
    assert created.status_code == 201, created.text
    return created.json()


# ------------------------------------------------------- where a workspace lives


def test_a_seeded_workspace_says_it_is_this_machines_own(client):
    """The column the rest of D5 branches on.

    Without it a desktop that has signed in cannot tell its own decks from a
    mirror of someone else's, and local mode's "the one account owns everything"
    posture would quietly extend over both.
    """
    me = sign_in(client, "solo@local")

    assert own_workspace(client, me)["origin"] == "local"


def test_the_workspace_row_refuses_an_origin_nobody_can_interpret(client):
    """A closed set, because there is no sensible behaviour for a third value.

    `local` and `cloud` decide who authorizes; a row saying anything else would
    be read as one of them by whichever branch happened to run first.
    """
    from sqlalchemy.exc import IntegrityError

    me = sign_in(client, "constraint@local")

    with pytest.raises(IntegrityError):
        with db_session.session_scope() as session:
            session.add(
                Workspace(
                    id=new_id("wsp"),
                    name="Elsewhere",
                    owner_id=me["user_id"],
                    origin="somewhere-else",
                )
            )


# --------------------------------------------------- signing in conscripts nothing


def test_a_second_workspace_does_not_collect_the_decks_already_here(client):
    """The whole point of D5.1.

    Adding a workspace is an addition. The deck authored before it existed is
    where its author left it, and the new workspace is empty — not because
    nothing has run yet, but because nothing ever will.
    """
    me = sign_in(client, "owner@local")
    deck = a_deck(client, me)

    company = a_second_workspace(client, me)

    assert decks_in(client, me, deck["project_id"]) == [deck["presentation_id"]]
    assert decks_in(client, me, company["project_id"]) == []


def test_someone_elses_sign_in_reaches_nothing_of_mine(client):
    """A second identity on the same install is a second identity, not a co-owner."""
    me = sign_in(client, "me@local")
    deck = a_deck(client, me)

    them = sign_in(client, "them@local")

    # 404 rather than 403: a refusal that confirms the deck exists is an
    # enumeration oracle, and this is the same refusal a stranger gets.
    assert (
        client.get(
            f"/v1/presentations/{deck['presentation_id']}", headers=headers(them)
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/v1/projects/{deck['project_id']}/presentations", headers=headers(them)
        ).status_code
        == 404
    )


def test_moving_is_the_only_thing_that_moves_a_deck(client):
    """The negative control for every "nothing moved" assertion here.

    If a deck could end up in the second workspace without this route being
    called, those assertions would be passing on a product that never moves
    anything at all.
    """
    me = sign_in(client, "control@local")
    deck = a_deck(client, me)
    company = a_second_workspace(client, me)

    # Everything an ordinary session does short of asking for a move: read the
    # account, open the deck, poll its head.
    client.get("/v1/account", headers=headers(me))
    client.get(f"/v1/presentations/{deck['presentation_id']}", headers=headers(me))
    client.get(f"/v1/presentations/{deck['presentation_id']}/head", headers=headers(me))

    assert decks_in(client, me, company["project_id"]) == []


# ------------------------------------------------------------- the explicit move


def test_moving_a_deck_keeps_it_the_same_deck(client):
    me = sign_in(client, "mover@local")
    deck = a_deck(client, me)
    presentation_id = deck["presentation_id"]

    before = client.get(
        f"/v1/presentations/{presentation_id}", headers=headers(me)
    ).json()
    versions_before = client.get(
        f"/v1/presentations/{presentation_id}/versions", headers=headers(me)
    ).json()

    company = a_second_workspace(client, me)

    moved = client.post(
        f"/v1/presentations/{presentation_id}/move",
        headers=headers(me),
        json={"project_id": company["project_id"]},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["moved"] is True
    assert moved.json()["workspace_id"] == company["workspace_id"]

    after = client.get(
        f"/v1/presentations/{presentation_id}", headers=headers(me)
    ).json()
    versions_after = client.get(
        f"/v1/presentations/{presentation_id}/versions", headers=headers(me)
    ).json()

    # Identity, content and history all survive. A "move" that minted a new
    # presentation id would break every link, every share and every agent that
    # had read the deck — it would be a copy with the original deleted.
    assert after["version_id"] == before["version_id"]
    assert after["document"] == before["document"]
    assert versions_after == versions_before

    # And it is somewhere else now, which is the only thing that changed.
    assert decks_in(client, me, deck["project_id"]) == []
    assert decks_in(client, me, company["project_id"]) == [presentation_id]


def test_a_move_to_where_it_already_is_changes_nothing(client):
    me = sign_in(client, "noop@local")
    deck = a_deck(client, me)

    answer = client.post(
        f"/v1/presentations/{deck['presentation_id']}/move",
        headers=headers(me),
        json={"project_id": deck["project_id"]},
    )

    assert answer.status_code == 200
    assert answer.json()["moved"] is False
    assert "already" in answer.json()["refusal"]


# ------------------------------------------------------------------- refusals


def join(session, *, workspace_id: str, user_id: str, role: str) -> None:
    session.add(
        WorkspaceMember(
            id=new_id("mbr"), workspace_id=workspace_id, user_id=user_id, role=role
        )
    )


def first_project(session, workspace_id: str) -> str:
    project = session.scalar(
        select(Project)
        .where(Project.workspace_id == workspace_id)
        .order_by(Project.id)
        .limit(1)
    )
    assert project is not None
    return project.id


def test_a_viewer_on_the_destination_cannot_put_a_deck_there(client):
    """Moving a deck in is a write, and a viewer does not write."""
    me = sign_in(client, "author@local")
    deck = a_deck(client, me)
    them = sign_in(client, "host@local")

    with db_session.session_scope() as session:
        destination = first_project(session, them["workspace_id"])
        join(
            session,
            workspace_id=them["workspace_id"],
            user_id=me["user_id"],
            role="viewer",
        )

    refused = client.post(
        f"/v1/presentations/{deck['presentation_id']}/move",
        headers=headers(me),
        json={"project_id": destination},
    )

    assert refused.status_code == 404
    assert decks_in(client, me, deck["project_id"]) == [deck["presentation_id"]]


def test_a_viewer_on_the_source_cannot_move_a_deck_out(client):
    """A move is a removal from everyone else who could see it.

    Read access to a deck is not permission to take it somewhere the people who
    shared it with you cannot follow.
    """
    keeper = sign_in(client, "keeper@local")
    deck = a_deck(client, keeper)
    guest = sign_in(client, "guest@local")

    with db_session.session_scope() as session:
        join(
            session,
            workspace_id=keeper["workspace_id"],
            user_id=guest["user_id"],
            role="viewer",
        )
        destination = first_project(session, guest["workspace_id"])

    # The guest really can read it — otherwise this test would be refusing for
    # the ordinary reason rather than the one it is about.
    assert (
        client.get(
            f"/v1/presentations/{deck['presentation_id']}", headers=headers(guest)
        ).status_code
        == 200
    )

    refused = client.post(
        f"/v1/presentations/{deck['presentation_id']}/move",
        headers=headers(guest),
        json={"project_id": destination},
    )

    assert refused.status_code == 404
    assert decks_in(client, keeper, deck["project_id"]) == [deck["presentation_id"]]


def test_a_deck_with_a_change_awaiting_approval_does_not_move(client):
    """The approver has to still be someone who can see it.

    A pending proposal is a question put to the people in *this* workspace, about
    a preview they were shown. Moving the deck hands that question to a different
    set of people — which is precisely what the proposal lifecycle exists to
    prevent.
    """
    me = sign_in(client, "pending@local")
    deck = a_deck(client, me)
    company = a_second_workspace(client, me)

    # A real pending proposal, through the route an external agent uses. A
    # hand-written row would be a test of my typing, and the thing under test is
    # what the product does with a change a human has not answered yet.
    opened = client.get(
        f"/v1/presentations/{deck['presentation_id']}", headers=headers(me)
    ).json()
    proposed = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals",
        headers=headers(me),
        json={
            # Changing the viewport is high risk, computed server-side, so this
            # waits for a person rather than applying.
            "operations": [{"op": "replace", "path": "/viewport/width", "value": 1600}],
            "intent": "Make it 16:10",
            "expected_version_id": opened["version_id"],
        },
    )
    assert proposed.status_code == 200, proposed.text
    assert proposed.json()["outcome"] == "pending"

    refused = client.post(
        f"/v1/presentations/{deck['presentation_id']}/move",
        headers=headers(me),
        json={"project_id": company["project_id"]},
    )

    assert refused.status_code == 409
    assert "approval" in refused.json()["detail"]
    assert decks_in(client, me, deck["project_id"]) == [deck["presentation_id"]]


def test_a_deck_that_uses_an_upload_is_refused_by_name(client):
    """An upload belongs to the workspace that holds it (`Asset.workspace_id`).

    So a deck citing images would arrive with every picture unreadable by the
    people it arrived for — a move that looks like it worked and produces a
    broken deck. Carrying the files is a per-file copy-or-move decision, because
    an asset can be cited by other decks in the source workspace, and that is
    D5.5's work. Until then this refuses and says how many.
    """
    me = sign_in(client, "pictures@local")
    deck = a_deck(client, me)
    company = a_second_workspace(client, me)

    asset_id = new_id("ast")
    with db_session.session_scope() as session:
        session.add(
            Asset(
                id=asset_id,
                workspace_id=me["workspace_id"],
                created_by=me["user_id"],
                kind="image",
                storage_key=f"{me['workspace_id']}/{asset_id}",
                filename="logo.png",
                content_type="image/png",
                bytes=12,
            )
        )

    opened = client.get(
        f"/v1/presentations/{deck['presentation_id']}", headers=headers(me)
    ).json()
    slide_id = opened["document"]["slides"][0]["id"]
    applied = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transactions",
        headers=headers(me),
        json={
            "expected_version_id": opened["version_id"],
            "intent": "Place the logo",
            "operations": [
                {
                    "op": "add",
                    "path": f"/slides/id:{slide_id}/elements/-",
                    "value": {
                        "id": new_id("el"),
                        "type": "image",
                        "assetId": asset_id,
                        "transform": {"x": 10, "y": 10, "width": 100, "height": 100},
                    },
                }
            ],
        },
    )
    assert applied.status_code == 200, applied.text

    refused = client.post(
        f"/v1/presentations/{deck['presentation_id']}/move",
        headers=headers(me),
        json={"project_id": company["project_id"]},
    )

    assert refused.status_code == 409
    assert "uploaded file" in refused.json()["detail"]
    assert decks_in(client, me, deck["project_id"]) == [deck["presentation_id"]]
