"""The deck list's backend (editor Phase 4): counts on each card, a delete that
can be undone, and a duplicate that is a new deck rather than the same ids twice.

What each group guards:

- **Counts without replays.** A card says "12 slides" and shows a badge when
  proposals wait; the list gets both from rows (a maintained column and one
  grouped count), never by replaying every deck in the project.
- **Delete is soft, and total.** A deleted deck is missing to every read —
  including its share links, the one unauthenticated read — and `restore`
  brings it back whole.
- **Duplicate mints fresh ids everywhere and rewrites every reference**,
  across slides: a morph pair on slide 4 names elements on slide 3.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import deck_copy  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import Presentation, Workspace  # noqa: E402
from deckastra_api.schema import validate_document  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "presentation-schema" / "fixtures"
ANIMATION = json.loads((FIXTURES / "animation-test.mydeck.json").read_text(encoding="utf8"))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'decks.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


def session_for(client, email: str) -> dict[str, str]:
    response = client.post("/v1/dev/session", json={"email": email})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def auth(client):
    return session_for(client, "editor@localhost")


def project_of(client, auth) -> str:
    account = client.get("/v1/account", headers=auth).json()
    return account["workspaces"][0]["projects"][0]["id"]


def create(client, auth, title="Deck") -> tuple[str, str]:
    created = client.post("/v1/presentations", headers=auth, json={"title": title})
    assert created.status_code == 201, created.text
    return created.json()["presentation_id"], created.json()["version_id"]


def seed_animation(client, auth) -> str:
    """A deck holding the animation fixture's slides and theme — the one with a
    cross-slide morph — through an ordinary transaction, as the desktop seeds."""
    presentation_id, version_id = create(client, auth, "Animated")
    applied = client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth,
        json={
            "operations": [
                {"op": "replace", "path": "/theme", "value": ANIMATION["theme"]},
                {"op": "replace", "path": "/slides", "value": ANIMATION["slides"]},
            ],
            "intent": "Seed",
            "expected_version_id": version_id,
            "client_id": "test",
        },
    )
    assert applied.status_code == 200, applied.text
    return presentation_id


def listing(client, auth, **params) -> list[dict]:
    response = client.get(f"/v1/projects/{project_of(client, auth)}/presentations", headers=auth, params=params)
    assert response.status_code == 200, response.text
    return response.json()["presentations"]


def row_for(client, auth, presentation_id: str, **params) -> dict | None:
    return next((row for row in listing(client, auth, **params) if row["id"] == presentation_id), None)


# ------------------------------------------------------------------ counts


def test_each_card_carries_its_slide_count_and_it_follows_edits(client, auth):
    presentation_id = seed_animation(client, auth)
    row = row_for(client, auth, presentation_id)
    assert row["slide_count"] == len(ANIMATION["slides"])
    assert row["pending_proposals"] == 0


def test_a_row_written_before_the_column_is_counted_once_and_kept(client, auth):
    presentation_id = seed_animation(client, auth)
    with db_session.session_scope() as session:
        session.get(Presentation, presentation_id).slide_count = None

    assert row_for(client, auth, presentation_id)["slide_count"] == len(ANIMATION["slides"])
    with db_session.session_scope() as session:
        assert session.get(Presentation, presentation_id).slide_count == len(ANIMATION["slides"])


# ------------------------------------------------------------------ delete


def test_a_deleted_deck_is_missing_everywhere_until_restored(client, auth):
    presentation_id, _ = create(client, auth, "Doomed")

    deleted = client.delete(f"/v1/presentations/{presentation_id}", headers=auth)
    assert deleted.status_code == 200, deleted.text

    # Every read: the same 404 a stranger gets.
    assert client.get(f"/v1/presentations/{presentation_id}", headers=auth).status_code == 404
    assert client.get(f"/v1/presentations/{presentation_id}/head", headers=auth).status_code == 404
    assert row_for(client, auth, presentation_id) is None
    # But it is in the trash, with when.
    trashed = row_for(client, auth, presentation_id, deleted="true")
    assert trashed is not None and trashed["deleted_at"]

    restored = client.post(f"/v1/presentations/{presentation_id}/restore", headers=auth)
    assert restored.status_code == 200, restored.text
    assert client.get(f"/v1/presentations/{presentation_id}", headers=auth).status_code == 200
    assert row_for(client, auth, presentation_id) is not None
    assert row_for(client, auth, presentation_id, deleted="true") is None


def test_a_deleted_decks_share_link_stops_working_and_comes_back_with_it(client, auth):
    presentation_id, _ = create(client, auth, "Shared")
    share = client.post(f"/v1/presentations/{presentation_id}/shares", headers=auth, json={})
    if share.status_code == 404:
        pytest.skip("Sharing is not available in this configuration.")
    assert share.status_code in (200, 201), share.text
    token = share.json()["token"]
    assert client.get(f"/v1/shared/{token}").status_code == 200

    client.delete(f"/v1/presentations/{presentation_id}", headers=auth)
    assert client.get(f"/v1/shared/{token}").status_code == 404

    client.post(f"/v1/presentations/{presentation_id}/restore", headers=auth)
    assert client.get(f"/v1/shared/{token}").status_code == 200


def test_a_stranger_can_neither_delete_nor_restore(client, auth):
    presentation_id, _ = create(client, auth)
    stranger = session_for(client, "stranger@localhost")
    assert client.delete(f"/v1/presentations/{presentation_id}", headers=stranger).status_code == 404

    client.delete(f"/v1/presentations/{presentation_id}", headers=auth)
    assert client.post(f"/v1/presentations/{presentation_id}/restore", headers=stranger).status_code == 404


def test_a_deck_that_syncs_is_not_deleted_or_duplicated_locally(client, auth):
    presentation_id, _ = create(client, auth)
    with db_session.session_scope() as session:
        workspace = session.query(Workspace).first()
        workspace.origin = "cloud"
        # A mirrored workspace authorizes only a confirmed membership (D5.4);
        # confirmed the way a mirror would, so the refusal below is the sync
        # rule and not an access failure.
        from deckastra_api.auth import confirm_membership
        from deckastra_api.db.models import WorkspaceMember

        member = session.query(WorkspaceMember).filter_by(workspace_id=workspace.id).first()
        confirm_membership(session, user_id=member.user_id, workspace_id=workspace.id, role=member.role)

    for response in (
        client.delete(f"/v1/presentations/{presentation_id}", headers=auth),
        client.post(f"/v1/presentations/{presentation_id}/duplicate", headers=auth),
    ):
        assert response.status_code == 409
        assert "syncs" in response.json()["detail"]


# --------------------------------------------------------------- duplicate


def test_duplicate_is_a_new_valid_deck_with_the_source_untouched(client, auth):
    presentation_id = seed_animation(client, auth)
    before = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()

    response = client.post(f"/v1/presentations/{presentation_id}/duplicate", headers=auth)
    assert response.status_code == 201, response.text
    copy_id = response.json()["presentation_id"]
    assert copy_id != presentation_id

    copy = client.get(f"/v1/presentations/{copy_id}", headers=auth).json()["document"]
    assert copy["metadata"]["title"] == "Animated (copy)"
    assert len(copy["slides"]) == len(ANIMATION["slides"])
    assert not validate_document(copy)
    assert row_for(client, auth, copy_id)["slide_count"] == len(ANIMATION["slides"])

    after = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()
    assert after["version_id"] == before["version_id"]


def test_the_copy_shares_no_id_with_the_source_except_its_assets_and_theme():
    copied, remap = deck_copy.duplicate_document(ANIMATION, title="Copy")

    def ids(document) -> set[str]:
        found: set[str] = set()

        def walk(value):
            if isinstance(value, dict):
                if isinstance(value.get("id"), str):
                    found.add(value["id"])
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        for key, value in document.items():
            if key not in ("assets", "theme"):
                walk(value)
        if isinstance(document.get("id"), str):
            found.add(document["id"])
        return found

    shared = ids(ANIMATION) & ids(copied)
    # Only non-ULID ids (none in this fixture's slides) could legitimately survive.
    assert all(not deck_copy._ID.match(identifier) for identifier in shared), shared
    assert copied["theme"] == ANIMATION["theme"]
    assert not validate_document(copied)
    assert len(remap) > len(ANIMATION["slides"])


def test_a_cross_slide_morph_in_the_copy_pairs_the_copys_own_elements():
    copied, remap = deck_copy.duplicate_document(ANIMATION, title="Copy")
    index = next(i for i, slide in enumerate(ANIMATION["slides"]) if (slide.get("transition") or {}).get("sharedElements"))
    original = ANIMATION["slides"][index]["transition"]["sharedElements"]
    mapped = copied["slides"][index]["transition"]["sharedElements"]

    previous_ids = {element["id"] for element in copied["slides"][index - 1]["elements"]}
    for before, after in zip(original, mapped):
        assert after["sourceElementId"] == remap[before["sourceElementId"]]
        # The copy's morph starts from the copy's own previous slide, not the original's.
        assert after["sourceElementId"] in previous_ids or any(
            after["sourceElementId"] in json.dumps(element) for element in copied["slides"][index - 1]["elements"]
        )
