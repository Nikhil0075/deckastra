"""D5.6: a bootstrap that reads a prefix and calls it a workspace.

`HttpRemote.presentations` read the deck-list route's default page and stopped,
so a project with more than 200 decks mirrored its first 200 and looked complete
(found by review, 2026-09-17). That is the worst shape of bug this direction can
have: the person sees a workspace, sees decks in it, and has no reason to think
anything is missing.

Driven through the **real route** over `TestClient` rather than a fake, because
the defect was in the agreement between the client and the route — a fake written
from the same misunderstanding would page perfectly.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import bootstrap, store  # noqa: E402
from deckastra_api.compose import blank_document  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'paging.db'}")
    monkeypatch.delenv("DECKASTRA_LOCAL_MODE", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client

    db_session.reset_engine()


class OverTestClient:
    """`HttpRemote`'s paging, against the real app.

    Only `_get` is replaced — the URL building, the cursor loop and the ceiling
    are the production ones, which is the whole point.
    """

    PAGE = bootstrap.HttpRemote.PAGE
    MAX_DECKS = bootstrap.HttpRemote.MAX_DECKS

    def __init__(self, client: TestClient, token: str) -> None:
        self._client = client
        self._token = token
        self.requests: list[str] = []

    def _get(self, path: str):
        self.requests.append(path)
        answer = self._client.get(path, headers={"Authorization": f"Bearer {self._token}"})
        if answer.status_code >= 400:
            raise bootstrap.RemoteUnavailable(f"{answer.status_code} for {path}")
        return answer.json()

    presentations = bootstrap.HttpRemote.presentations


def a_session(client: TestClient, email: str) -> tuple[dict, str, str]:
    body = client.post("/v1/dev/session", json={"email": email}).json()
    headers = {"Authorization": f"Bearer {body['token']}"}
    project_id = client.get("/v1/account", headers=headers).json()["workspaces"][0][
        "projects"
    ][0]["id"]
    return body, headers, project_id


def some_decks(project_id: str, created_by: str, count: int) -> list[str]:
    made: list[str] = []
    with db_session.session_scope() as session:
        for index in range(count):
            created = store.create_presentation(
                session,
                project_id=project_id,
                document=blank_document(title=f"Deck {index:02d}"),
                created_by=created_by,
            )
            made.append(created.presentation_id)
    return made


def page(client: TestClient, headers: dict, project_id: str, *, limit: int, after: str = ""):
    answer = client.get(
        f"/v1/projects/{project_id}/presentations?limit={limit}&after={after}",
        headers=headers,
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


def test_every_deck_is_listed_even_past_a_page(client, monkeypatch):
    body, _headers, project_id = a_session(client, "many@local")

    # More decks than one page holds, with the page shrunk so the test stays
    # fast. Shrinking the page rather than making 500 decks exercises the same
    # walk: what is checked is that the loop follows the cursor, not the number.
    monkeypatch.setattr(OverTestClient, "PAGE", 3, raising=False)
    made = some_decks(project_id, body["user_id"], 10)

    remote = OverTestClient(client, body["token"])
    listed = remote.presentations(project_id)

    assert sorted(one["id"] for one in listed) == sorted(made)
    # It really paged, rather than getting lucky with one big answer.
    assert len(remote.requests) >= 4
    assert any(one.rstrip("&").endswith("after=") is False for one in remote.requests[1:])


def test_a_full_page_carries_a_cursor_and_the_last_one_does_not(client):
    """The shape of the original bug, stated as a property of the route.

    A caller loops while there is a cursor rather than comparing a count against
    a limit it has to remember — which is the comparison nobody makes.
    """
    body, headers, project_id = a_session(client, "exact@local")
    some_decks(project_id, body["user_id"], 4)

    first = page(client, headers, project_id, limit=2)
    assert len(first["presentations"]) == 2
    assert first["next_after"] == first["presentations"][-1]["id"]

    second = page(client, headers, project_id, limit=2, after=first["next_after"])
    assert len(second["presentations"]) == 2

    # Exactly a page, and nothing after it — so the cursor is present and the
    # *next* request discovers the end. A route guessing "a full page means more"
    # would be wrong here; one guessing "a short page means the end" would be
    # wrong above.
    following = page(client, headers, project_id, limit=2, after=second["next_after"])
    assert following["presentations"] == []
    assert "next_after" not in following


def test_paging_is_by_id_so_an_edit_cannot_move_a_deck_between_pages(client):
    """Why the cursor is not "most recently changed".

    The default ordering is recency, which is right for a picker reading one
    page. A reader walking every deck cannot use it: editing a deck moves it to
    the front, so a walk in that order can hand back the same deck twice and skip
    another entirely. Ids never change.
    """
    body, headers, project_id = a_session(client, "stable@local")
    made = some_decks(project_id, body["user_id"], 6)

    first = page(client, headers, project_id, limit=3)

    # Somebody edits the oldest deck between pages, which in recency order would
    # drag it to the front of a list this reader has already walked past.
    opened = client.get(f"/v1/presentations/{made[0]}", headers=headers).json()
    edited = client.post(
        f"/v1/presentations/{made[0]}/transactions",
        headers=headers,
        json={
            "expected_version_id": opened["version_id"],
            "intent": "Touch it",
            "operations": [
                {"op": "replace", "path": "/metadata/title", "value": "Touched"}
            ],
        },
    )
    assert edited.status_code == 200, edited.text

    second = page(client, headers, project_id, limit=3, after=first["next_after"])

    seen = [one["id"] for one in first["presentations"]]
    seen += [one["id"] for one in second["presentations"]]

    assert sorted(seen) == sorted(made)
    assert len(seen) == len(set(seen)), "a deck appeared on two pages"


def test_the_default_listing_is_unchanged_for_the_ui(client):
    """Paging is an addition, not a replacement.

    The picker asks for one page and wants the decks someone touched most
    recently at the top. Changing that to id order to suit a sync reader would
    have made every deck list in the product answer in creation order.
    """
    body, headers, project_id = a_session(client, "recency@local")
    made = some_decks(project_id, body["user_id"], 3)

    opened = client.get(f"/v1/presentations/{made[0]}", headers=headers).json()
    client.post(
        f"/v1/presentations/{made[0]}/transactions",
        headers=headers,
        json={
            "expected_version_id": opened["version_id"],
            "intent": "Touch it",
            "operations": [
                {"op": "replace", "path": "/metadata/title", "value": "Touched"}
            ],
        },
    )

    listed = client.get(
        f"/v1/projects/{project_id}/presentations", headers=headers
    ).json()["presentations"]

    assert listed[0]["id"] == made[0]
    # And no cursor, because a caller that did not ask to page must not be
    # handed one it will not use.
    assert "next_after" not in listed[0]
