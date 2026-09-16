"""D5.5: a deck reaches other people whole.

Two halves of one idea. A deck that syncs must take its **pictures** with it, or
it arrives somewhere as text and a row of broken images — which is the failure
that looks like the product losing someone's work. And a deck that is *presented*
must stop moving: an audience watching a link should not have a slide change
under them because a colleague edited it, and on a projector that is not an
annoyance, it is the talk going wrong in front of a room.

The ordering case is the one to read first. It is not enough for the files to be
queued; they have to be queued **ahead** of the change that names them.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import auth, object_storage, sync  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import Asset, Workspace  # noqa: E402
from deckastra_api.ids import new_id  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'present.db'}")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
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


def local_project(client, who) -> str:
    return client.get("/v1/account", headers=headers(who)).json()["workspaces"][0][
        "projects"
    ][0]["id"]


def a_syncing_workspace(client: TestClient, who: dict[str, str]) -> str:
    created = client.post("/v1/workspaces", headers=headers(who), json={"name": "Acme"}).json()
    with db_session.session_scope() as session:
        session.get(Workspace, created["workspace_id"]).origin = "cloud"
        auth.confirm_membership(
            session,
            user_id=who["user_id"],
            workspace_id=created["workspace_id"],
            role="owner",
        )
    return created["project_id"]


def a_deck(client, who, project_id: str, title="Deck") -> str:
    created = client.post(
        "/v1/presentations",
        headers=headers(who),
        json={"title": title, "project_id": project_id},
    )
    assert created.status_code == 201, created.text
    return created.json()["presentation_id"]


PIXEL = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100ffff03000006000557bfabd400"
    "00000049454e44ae426082"
)


def an_image(who, *, workspace_id: str | None = None) -> str:
    """A real file on disk plus its row, because the shared read serves bytes."""
    asset_id = new_id("ast")
    workspace_id = workspace_id or who["workspace_id"]
    key = f"workspaces/{workspace_id}/assets/{asset_id}.png"
    object_storage.put_local(key, PIXEL, "image/png")
    with db_session.session_scope() as session:
        session.add(
            Asset(
                id=asset_id,
                workspace_id=workspace_id,
                created_by=who["user_id"],
                kind="image",
                storage_key=key,
                filename="pixel.png",
                content_type="image/png",
                bytes=len(PIXEL),
            )
        )
    return asset_id


def place(client, who, deck: str, asset_id: str):
    opened = client.get(f"/v1/presentations/{deck}", headers=headers(who)).json()
    slide_id = opened["document"]["slides"][0]["id"]
    applied = client.post(
        f"/v1/presentations/{deck}/transactions",
        headers=headers(who),
        json={
            "expected_version_id": opened["version_id"],
            "intent": "Place the picture",
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
    return applied.json()


def retitle(client, who, deck: str, title: str):
    opened = client.get(f"/v1/presentations/{deck}", headers=headers(who)).json()
    return client.post(
        f"/v1/presentations/{deck}/transactions",
        headers=headers(who),
        json={
            "expected_version_id": opened["version_id"],
            "intent": f"Retitle to {title}",
            "operations": [{"op": "replace", "path": "/metadata/title", "value": title}],
        },
    )


# ------------------------------------------------------- pictures in the outbox


def test_a_picture_is_queued_before_the_change_that_names_it(client):
    """The ordering property, and the whole reason this is in the outbox at all.

    A document arriving with an `assetId` the server has never received is a deck
    that is broken for everyone except the person who uploaded it — and broken in
    the way that looks like the product losing their picture.
    """
    me = sign_in(client)
    deck = a_deck(client, me, a_syncing_workspace(client, me))

    with db_session.session_scope() as session:
        workspace_id = session.scalar(
            __import__("sqlalchemy").select(Workspace.id).where(Workspace.name == "Acme")
        )
    asset_id = an_image(me, workspace_id=workspace_id)
    place(client, me, deck, asset_id)

    with db_session.session_scope() as session:
        kinds = [row.kind for row in sync.pending_for(session, deck)]

    # create, then the file, then the change citing it.
    assert kinds == ["create", "asset", "change"]

    sent: list[str] = []
    with db_session.session_scope() as session:
        report = sync.drain(session, lambda outgoing: (sent.append(outgoing.kind), "ver")[1])

    assert report.sent == 3
    assert sent == ["create", "asset", "change"]


def test_the_file_travels_by_reference_not_by_value(client):
    """A transport handed a 20MB image inline would hold every queued picture in
    memory to send one. It gets the key and reads the bytes itself, the same way
    the exporter and the blob route do."""
    me = sign_in(client)
    deck = a_deck(client, me, a_syncing_workspace(client, me))
    with db_session.session_scope() as session:
        workspace_id = session.scalar(
            __import__("sqlalchemy").select(Workspace.id).where(Workspace.name == "Acme")
        )
    asset_id = an_image(me, workspace_id=workspace_id)
    place(client, me, deck, asset_id)

    seen: list[sync.Outgoing] = []
    with db_session.session_scope() as session:
        sync.drain(session, lambda outgoing: (seen.append(outgoing), "ver")[1])

    asset = next(one for one in seen if one.kind == "asset").asset
    assert asset is not None
    assert asset.asset_id == asset_id
    assert asset.content_type == "image/png"
    assert asset.bytes == len(PIXEL)
    # The key, so the transport can read them; not the bytes.
    assert asset.storage_key.endswith(".png")


def test_a_picture_is_queued_once_however_often_it_is_used(client):
    """A deck that uses one logo on nine slides owes the server one logo."""
    me = sign_in(client)
    deck = a_deck(client, me, a_syncing_workspace(client, me))
    with db_session.session_scope() as session:
        workspace_id = session.scalar(
            __import__("sqlalchemy").select(Workspace.id).where(Workspace.name == "Acme")
        )
    asset_id = an_image(me, workspace_id=workspace_id)

    place(client, me, deck, asset_id)
    place(client, me, deck, asset_id)
    place(client, me, deck, asset_id)

    with db_session.session_scope() as session:
        assert [row.kind for row in sync.pending_for(session, deck)].count("asset") == 1


def test_a_local_decks_pictures_are_not_queued(client):
    """Nothing is owed by a deck that syncs nowhere (D5.1)."""
    me = sign_in(client)
    deck = a_deck(client, me, local_project(client, me), "Private")
    place(client, me, deck, an_image(me))

    with db_session.session_scope() as session:
        assert sync.pending_for(session, deck) == []


def test_a_reference_to_a_file_this_workspace_does_not_hold_is_not_an_error(client):
    """An imported deck, or a stale manifest entry.

    The renderer already draws a placeholder for one. Refusing the change instead
    would let a single bad reference block every later edit to the deck.
    """
    me = sign_in(client)
    deck = a_deck(client, me, a_syncing_workspace(client, me))

    applied = place(client, me, deck, new_id("ast"))
    assert applied["version_id"]

    with db_session.session_scope() as session:
        kinds = [row.kind for row in sync.pending_for(session, deck)]
    assert "asset" not in kinds
    assert kinds == ["create", "change"]


# ------------------------------------------------------------ pinned presenting


def a_share(client, who, deck: str, **body) -> dict:
    created = client.post(
        f"/v1/presentations/{deck}/shares", headers=headers(who), json=body
    )
    assert created.status_code in (200, 201), created.text
    return created.json()


def test_an_unpinned_link_follows_the_deck(client):
    """The control, and still the default: "send this to a client while I fix the
    typos" is a real use, and pinning would freeze the typos in."""
    me = sign_in(client)
    deck = a_deck(client, me, local_project(client, me))
    share = a_share(client, me, deck)

    retitle(client, me, deck, "Edited afterwards")

    opened = client.get(f"/v1/shared/{share['token']}").json()
    assert opened["document"]["metadata"]["title"] == "Edited afterwards"
    assert opened["pinned"] is False


def test_a_pinned_link_keeps_showing_what_was_pinned(client):
    me = sign_in(client)
    deck = a_deck(client, me, local_project(client, me), "As rehearsed")
    rehearsed = client.get(f"/v1/presentations/{deck}", headers=headers(me)).json()[
        "version_id"
    ]

    share = a_share(client, me, deck, version_id=rehearsed)

    # A colleague edits it while the talk is on.
    retitle(client, me, deck, "Edited mid-talk")

    opened = client.get(f"/v1/shared/{share['token']}").json()
    assert opened["document"]["metadata"]["title"] == "As rehearsed"
    assert opened["version_id"] == rehearsed
    # Said out loud, because a presenter handing the link round needs to know
    # which kind they sent.
    assert opened["pinned"] is True


def test_a_link_cannot_be_pinned_to_another_decks_version(client):
    """The token is the only credential, so whatever it resolves to is what the
    holder gets — a link naming another deck's version would be a link to that
    deck."""
    me = sign_in(client)
    mine = a_deck(client, me, local_project(client, me), "Mine")
    other = a_deck(client, me, local_project(client, me), "Other")
    elsewhere = client.get(f"/v1/presentations/{other}", headers=headers(me)).json()[
        "version_id"
    ]

    refused = client.post(
        f"/v1/presentations/{mine}/shares",
        headers=headers(me),
        json={"version_id": elsewhere},
    )

    assert refused.status_code == 400
    assert "not part of this deck" in refused.json()["detail"]


# ------------------------------------------------- the pictures in a shared deck


def test_a_shared_deck_can_load_its_pictures(client):
    """Without this a share link was half a link.

    The blob route needs a session and a membership, so on any install storing
    files locally — every desktop one — an audience got the text and broken
    images. Sharing exists to show a deck to people, and a deck with no pictures
    is not the deck.
    """
    me = sign_in(client)
    deck = a_deck(client, me, local_project(client, me))
    asset_id = an_image(me)
    place(client, me, deck, asset_id)
    share = a_share(client, me, deck)

    # No credential of any kind, which is the situation an audience is in.
    answer = client.get(f"/v1/shared/{share['token']}/assets/{asset_id}")

    assert answer.status_code == 200, answer.text
    assert answer.content == PIXEL
    assert answer.headers["content-type"].startswith("image/png")


def test_a_link_reaches_only_the_pictures_in_its_own_deck(client):
    """A token authorises one deck. It must not become a way to read the
    workspace's picture library."""
    me = sign_in(client)
    shared_deck = a_deck(client, me, local_project(client, me), "Shared")
    private_deck = a_deck(client, me, local_project(client, me), "Private")

    place(client, me, shared_deck, an_image(me))
    somebody_elses = an_image(me)
    place(client, me, private_deck, somebody_elses)

    share = a_share(client, me, shared_deck)

    refused = client.get(f"/v1/shared/{share['token']}/assets/{somebody_elses}")

    # The same 404 an unknown id gets. "That file exists but is not in this deck"
    # tells a probing holder what the workspace contains.
    assert refused.status_code == 404


def test_a_pinned_link_serves_the_pictures_of_the_version_it_pinned(client):
    """The two features meeting.

    A picture taken off a slide after the link was pinned is still in the deck
    the audience is looking at, and must still load; one added afterwards is not
    in it, and must not.
    """
    me = sign_in(client)
    deck = a_deck(client, me, local_project(client, me))
    rehearsed_image = an_image(me)
    place(client, me, deck, rehearsed_image)
    rehearsed = client.get(f"/v1/presentations/{deck}", headers=headers(me)).json()[
        "version_id"
    ]
    share = a_share(client, me, deck, version_id=rehearsed)

    # After pinning: one picture removed, another added.
    opened = client.get(f"/v1/presentations/{deck}", headers=headers(me)).json()
    slide = opened["document"]["slides"][0]
    element = next(
        one for one in slide["elements"] if one.get("assetId") == rehearsed_image
    )
    removed = client.post(
        f"/v1/presentations/{deck}/transactions",
        headers=headers(me),
        json={
            "expected_version_id": opened["version_id"],
            "intent": "Remove it",
            "operations": [
                {"op": "remove", "path": f"/slides/id:{slide['id']}/elements/id:{element['id']}"}
            ],
        },
    )
    assert removed.status_code == 200, removed.text
    added_later = an_image(me)
    place(client, me, deck, added_later)

    # The pinned version still has the first and not the second.
    assert client.get(f"/v1/shared/{share['token']}/assets/{rehearsed_image}").status_code == 200
    assert client.get(f"/v1/shared/{share['token']}/assets/{added_later}").status_code == 404


def test_a_revoked_link_stops_serving_pictures_too(client):
    """A revocation that left the images readable would leave the deck readable
    to anyone who had already loaded a slide list."""
    me = sign_in(client)
    deck = a_deck(client, me, local_project(client, me))
    asset_id = an_image(me)
    place(client, me, deck, asset_id)
    share = a_share(client, me, deck)

    assert client.get(f"/v1/shared/{share['token']}/assets/{asset_id}").status_code == 200

    revoked = client.delete(f"/v1/shares/{share['id']}", headers=headers(me))
    assert revoked.status_code in (200, 204), revoked.text

    assert client.get(f"/v1/shared/{share['token']}/assets/{asset_id}").status_code == 404
