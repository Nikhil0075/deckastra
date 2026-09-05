"""End-to-end HTTP: generate, edit, version, undo.

The store tests exercise the persistence layer directly. These go through the
actual routes, because that is where authorization, validation and error mapping
live, and none of them are exercised by calling the store.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import Project, User, Workspace, WorkspaceMember  # noqa: E402
from deckastra_api.ids import new_id  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'api.db'}")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)

    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client

    db_session.reset_engine()


@pytest.fixture()
def session_token(client: TestClient) -> dict[str, str]:
    response = client.post("/v1/dev/session", json={"email": "dev@localhost"})
    assert response.status_code == 200
    return response.json()


@pytest.fixture()
def auth(session_token: dict[str, str]) -> dict[str, str]:
    return {"Authorization": f"Bearer {session_token['token']}"}


@pytest.fixture()
def deck(client: TestClient, auth: dict[str, str]) -> dict:
    response = client.post(
        "/v1/generate",
        headers=auth,
        json={"instruction": "Explain our deploy pipeline", "slide_count": 5},
    )
    assert response.status_code == 200, response.text
    return response.json()


# ------------------------------------------------------------------- auth


def test_health_does_not_leak_the_connection_string(client: TestClient):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["database"] in {"sqlite", "postgresql+psycopg"}
    assert "password" not in str(body)
    assert "@" not in body["database"]


def test_endpoints_require_a_token(client: TestClient):
    assert client.get("/v1/presentations/doc_x").status_code == 401
    assert (
        client.post("/v1/generate", json={"instruction": "x"}).status_code == 401
    )


def test_a_forged_token_is_rejected(client: TestClient, session_token: dict[str, str]):
    # Signed, so a token cannot be forged by typing someone else's id into a
    # header.
    forged = f"{session_token['user_id']}.deadbeefdeadbeefdeadbeefdeadbeef"
    response = client.get("/v1/presentations/doc_x", headers={"Authorization": f"Bearer {forged}"})
    assert response.status_code == 401


def test_dev_session_is_idempotent(client: TestClient):
    first = client.post("/v1/dev/session", json={"email": "same@localhost"}).json()
    second = client.post("/v1/dev/session", json={"email": "same@localhost"}).json()
    assert first["user_id"] == second["user_id"]
    assert first["workspace_id"] == second["workspace_id"]


def test_dev_session_is_absent_in_production(client: TestClient, monkeypatch):
    monkeypatch.setenv("DECKASTRA_ENV", "production")
    assert client.post("/v1/dev/session", json={"email": "x@y.z"}).status_code == 404


# -------------------------------------------------------------- generate + read


def test_generate_persists_a_deck(client: TestClient, auth, deck):
    assert deck["presentation_id"].startswith("doc_")
    assert deck["version_id"]
    assert len(deck["document"]["slides"]) == 5

    # It survives the request that made it — the point of Phase 2.
    fetched = client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth)
    assert fetched.status_code == 200
    assert fetched.json()["document"] == deck["document"]
    assert fetched.json()["can_edit"] is True


def test_a_stranger_gets_not_found_for_someone_elses_deck(client: TestClient, deck):
    other = client.post("/v1/dev/session", json={"email": "other@localhost"}).json()
    response = client.get(
        f"/v1/presentations/{deck['presentation_id']}",
        headers={"Authorization": f"Bearer {other['token']}"},
    )
    # 404, not 403: a 403 on a resource you cannot see confirms it exists.
    assert response.status_code == 404


# ------------------------------------------------------------------ editing


def edit_payload(deck: dict, value: str, **extra) -> dict:
    slide_id = deck["document"]["slides"][0]["id"]
    return {
        "operations": [
            {"op": "replace", "path": f"/slides/id:{slide_id}/keyMessage", "value": value}
        ],
        "intent": "Sharpen the key message",
        "expected_version_id": deck["version_id"],
        **extra,
    }


def test_applying_a_patch_advances_the_version(client: TestClient, auth, deck):
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transactions",
        headers=auth,
        json=edit_payload(deck, "changed"),
    )
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["version_id"] != deck["version_id"]
    assert body["document"]["slides"][0]["keyMessage"] == "changed"
    # Risk is computed server-side from the operations, never sent by the caller.
    assert body["risk_tier"] == "low"


def test_a_stale_expected_version_conflicts(client: TestClient, auth, deck):
    url = f"/v1/presentations/{deck['presentation_id']}/transactions"
    assert client.post(url, headers=auth, json=edit_payload(deck, "first")).status_code == 200

    # Second writer still holds the original version id.
    conflict = client.post(url, headers=auth, json=edit_payload(deck, "second"))
    assert conflict.status_code == 409
    detail = conflict.json()["detail"]
    assert detail["code"] == "E304"
    assert detail["current_version_id"]


def test_an_unresolvable_path_is_a_409_naming_the_operation(client: TestClient, auth, deck):
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transactions",
        headers=auth,
        json={
            "operations": [
                {"op": "replace", "path": "/slides/id:sld_NOPE00000000000000000000/name", "value": "x"}
            ],
            "intent": "Broken",
            "expected_version_id": deck["version_id"],
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "E301"
    assert response.json()["detail"]["operation_index"] == 0


def test_a_patch_that_would_invalidate_the_document_is_refused(client: TestClient, auth, deck):
    # Doc 04 §6.4 refuses to render an invalid document, so storing one only moves
    # the failure somewhere less diagnosable.
    slide_id = deck["document"]["slides"][0]["id"]
    element_id = deck["document"]["slides"][0]["elements"][0]["id"]

    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transactions",
        headers=auth,
        json={
            "operations": [
                {
                    "op": "replace",
                    "path": f"/slides/id:{slide_id}/elements/id:{element_id}/transform/width",
                    "value": 0,
                }
            ],
            "intent": "Zero width",
            "expected_version_id": deck["version_id"],
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"]["errors"]


def test_risk_escalates_for_a_slide_deletion(client: TestClient, auth, deck):
    slide_id = deck["document"]["slides"][1]["id"]
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/transactions",
        headers=auth,
        json={
            "operations": [{"op": "remove", "path": f"/slides/id:{slide_id}"}],
            "intent": "Drop a slide",
            "expected_version_id": deck["version_id"],
        },
    )
    assert response.status_code == 200
    assert response.json()["risk_tier"] == "high"


def test_a_viewer_cannot_edit(client: TestClient, auth, deck, session_token):
    with db_session.session_scope() as session:
        viewer_id = new_id("usr")
        session.add(User(id=viewer_id, email="viewer@localhost", name="viewer"))
        session.add(
            WorkspaceMember(
                id=new_id("mbr"),
                workspace_id=session_token["workspace_id"],
                user_id=viewer_id,
                role="viewer",
            )
        )
        session.flush()

    from deckastra_api.auth import issue_dev_token

    viewer_auth = {"Authorization": f"Bearer {issue_dev_token(viewer_id)}"}

    # A viewer can read.
    assert (
        client.get(f"/v1/presentations/{deck['presentation_id']}", headers=viewer_auth).status_code
        == 200
    )
    # But not write.
    assert (
        client.post(
            f"/v1/presentations/{deck['presentation_id']}/transactions",
            headers=viewer_auth,
            json=edit_payload(deck, "nope"),
        ).status_code
        == 404
    )


# ------------------------------------------------------------------- history


def test_history_lists_every_change_with_attribution(client: TestClient, auth, deck):
    url = f"/v1/presentations/{deck['presentation_id']}/transactions"
    applied = client.post(url, headers=auth, json=edit_payload(deck, "one")).json()

    history = client.get(url, headers=auth).json()
    assert len(history) == 1

    entry = history[0]
    assert entry["id"] == applied["transaction_id"]
    assert entry["status"] == "applied"
    assert entry["intent"] == "Sharpen the key message"
    assert entry["parent_version_id"] == deck["version_id"]
    assert entry["result_version_id"] == applied["version_id"]
    assert entry["operation_count"] == 1


def test_versions_list_marks_snapshots(client: TestClient, auth, deck):
    versions = client.get(
        f"/v1/presentations/{deck['presentation_id']}/versions", headers=auth
    ).json()
    assert len(versions) == 1
    assert versions[0]["is_snapshot"] is True


def test_reverting_undoes_the_change_and_appends_to_history(client: TestClient, auth, deck):
    url = f"/v1/presentations/{deck['presentation_id']}/transactions"
    original_message = deck["document"]["slides"][0]["keyMessage"]

    applied = client.post(url, headers=auth, json=edit_payload(deck, "changed")).json()

    reverted = client.post(f"{url}/{applied['transaction_id']}/revert", headers=auth)
    assert reverted.status_code == 200
    assert reverted.json()["document"]["slides"][0]["keyMessage"] == original_message

    history = client.get(url, headers=auth).json()
    # Append-only: "this was undone" is a fact worth keeping, and a version
    # lineage with holes cannot be replayed.
    assert len(history) == 2
    statuses = {entry["id"]: entry["status"] for entry in history}
    assert statuses[applied["transaction_id"]] == "reverted"
    assert any(entry["intent"].startswith("Undo:") for entry in history)


def test_a_transaction_cannot_be_reverted_twice(client: TestClient, auth, deck):
    url = f"/v1/presentations/{deck['presentation_id']}/transactions"
    applied = client.post(url, headers=auth, json=edit_payload(deck, "changed")).json()

    assert client.post(f"{url}/{applied['transaction_id']}/revert", headers=auth).status_code == 200
    second = client.post(f"{url}/{applied['transaction_id']}/revert", headers=auth)
    assert second.status_code == 409
    assert "reverted" in second.json()["detail"]


def test_reverting_refuses_when_a_later_edit_broke_the_inverse(client: TestClient, auth, deck):
    url = f"/v1/presentations/{deck['presentation_id']}/transactions"
    slide_id = deck["document"]["slides"][1]["id"]
    element_id = deck["document"]["slides"][1]["elements"][0]["id"]

    applied = client.post(
        url,
        headers=auth,
        json={
            "operations": [
                {
                    "op": "replace",
                    "path": f"/slides/id:{slide_id}/elements/id:{element_id}/transform/x",
                    "value": 400,
                }
            ],
            "intent": "Nudge",
            "expected_version_id": deck["version_id"],
        },
    ).json()

    # Someone deletes the slide the change lived on.
    client.post(
        url,
        headers=auth,
        json={
            "operations": [{"op": "remove", "path": f"/slides/id:{slide_id}"}],
            "intent": "Delete the slide",
            "expected_version_id": applied["version_id"],
        },
    )

    response = client.post(f"{url}/{applied['transaction_id']}/revert", headers=auth)
    # Refused with a reason rather than half-applied.
    assert response.status_code == 409
    assert "later edit" in response.json()["detail"]["message"]


def test_reads_at_a_historical_version(client: TestClient, auth, deck):
    url = f"/v1/presentations/{deck['presentation_id']}/transactions"
    original = deck["document"]["slides"][0]["keyMessage"]
    client.post(url, headers=auth, json=edit_payload(deck, "changed"))

    at_origin = client.get(
        f"/v1/presentations/{deck['presentation_id']}",
        headers=auth,
        params={"at_version": deck["version_id"]},
    )
    assert at_origin.status_code == 200
    assert at_origin.json()["document"]["slides"][0]["keyMessage"] == original


def test_many_edits_replay_correctly(client: TestClient, auth, deck):
    """The Phase 2 exit shape, over HTTP."""
    url = f"/v1/presentations/{deck['presentation_id']}/transactions"
    version = deck["version_id"]

    for i in range(12):
        response = client.post(
            url,
            headers=auth,
            json={
                "operations": [
                    {
                        "op": "replace",
                        "path": f"/slides/id:{deck['document']['slides'][0]['id']}/keyMessage",
                        "value": f"round {i}",
                    }
                ],
                "intent": f"Edit {i}",
                "expected_version_id": version,
            },
        )
        assert response.status_code == 200, response.text
        version = response.json()["version_id"]

    final = client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth).json()
    assert final["document"]["slides"][0]["keyMessage"] == "round 11"
    assert final["version_id"] == version
    assert len(client.get(url, headers=auth).json()) == 12
