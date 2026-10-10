"""End-to-end HTTP: compose, edit, version, undo.

The store tests exercise the persistence layer directly. These go through the
actual routes, because that is where authorization, validation and error mapping
live, and none of them are exercised by calling the store.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
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
        "/v1/decks/from-template",
        headers=auth,
        json={"template_id": "technical-architecture", "title": "Our deploy pipeline"},
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
        client.post("/v1/decks/from-template", json={"template_id": "business-pitch"}).status_code == 401
    )


def test_legacy_generation_and_checkpoint_routes_are_removed(
    client: TestClient, auth: dict[str, str]
):
    assert client.post("/v1/generate", headers=auth, json={"instruction": "Draft a deck"}).status_code == 404
    assert client.post("/v1/generate/review", headers=auth, json={}).status_code == 404
    assert client.get("/v1/runs/run_legacy/checkpoint", headers=auth).status_code == 404
    assert (
        client.post(
            "/v1/runs/run_legacy/resume",
            headers=auth,
            json={"action": "approve"},
        ).status_code
        == 404
    )


def test_account_gateway_exposes_paid_media_not_text_tasks(
    client: TestClient, auth: dict[str, str]
):
    capabilities = client.get("/v1/account/capabilities", headers=auth)
    assert capabilities.status_code == 200
    assert set(capabilities.json()["tasks"]) == {"image", "video"}

    text_request = client.post(
        "/v1/assistant/infer",
        headers=auth,
        json={
            "task": "planning",
            "system": "Plan a deck",
            "messages": [{"role": "user", "content": "Plan it"}],
        },
    )
    assert text_request.status_code == 422


def test_account_gateway_quotes_character_services(client: TestClient, auth: dict[str, str], monkeypatch):
    monkeypatch.setenv("DECKASTRA_CREDITS_ENABLED", "1")
    monkeypatch.setenv("DECKASTRA_DEVICE_SECRET", "test-device-secret")
    monkeypatch.setenv("DECKASTRA_TRANSLATION_USD_PER_MILLION", "20")
    monkeypatch.setenv("DECKASTRA_SPEECH_USD_PER_MILLION", "16")
    translated = client.post("/v1/assistant/quote", headers=auth, json={"task": "translation", "units": 2500})
    voiced = client.post("/v1/assistant/quote", headers=auth, json={"task": "speech", "units": 1000})
    assert translated.status_code == 200, translated.text
    assert voiced.status_code == 200, voiced.text
    assert translated.json()["credit_cost"] == 10
    assert voiced.json()["credit_cost"] == 3.2


def test_reviewed_presets_create_a_deterministic_deck(client: TestClient, auth: dict[str, str]):
    catalog = client.get("/v1/presets", headers=auth)
    assert catalog.status_code == 200, catalog.text
    listed = catalog.json()
    assert {preset["purpose"] for preset in listed["presets"]} == {
        "business", "product", "teaching", "technical", "team", "personal"
    }
    assert len(listed["presets"]) == 28
    assert len(listed["themes"]) == 22
    assert len(listed["slidePatterns"]) == 60
    assert set(listed["motionStyles"]) == {
        "restrained", "dynamic", "cinematic", "editorial", "energetic", "technical", "playful"
    }

    made = client.post(
        "/v1/decks/from-template",
        headers=auth,
        json={
            "template_id": "business-pitch",
            "theme_key": "minimal-light",
            "title": "North star proposal",
            "content": {"opening": {"headline": "One clear direction"}},
        },
    )
    assert made.status_code == 200, made.text
    body = made.json()
    assert body["template_id"] == "business-pitch"
    assert body["document"]["metadata"]["title"] == "North star proposal"
    assert body["document"]["metadata"]["templateId"] == "business-pitch"
    assert body["document"]["theme"]["name"] == "Minimal Light"
    assert len(body["document"]["slides"]) == 10
    assert body["document"]["slides"][0]["elements"][1]["content"]["blocks"][0]["spans"][0]["text"] == "One clear direction"
    assert body["document"]["metadata"]["motionStyle"] == "restrained"
    assert body["document"]["metadata"]["voiceStyle"] == "confident"
    assert body["document"]["slides"][0]["layout"]["templateId"] == "preset.title"
    assert body["document"]["slides"][5]["layout"]["templateId"] == "preset.agenda"
    assert all(slide.get("animations") for slide in body["document"]["slides"])


def test_preset_creation_refuses_unknown_slots(client: TestClient, auth: dict[str, str]):
    response = client.post(
        "/v1/decks/from-template",
        headers=auth,
        json={"template_id": "business-pitch", "content": {"opening": {"x": 20}}},
    )
    assert response.status_code == 422
    assert "Unknown slots" in response.json()["detail"]


def test_story_plan_composes_without_a_model(client: TestClient, auth: dict[str, str]):
    response = client.post(
        "/v1/decks/compose",
        headers=auth,
        json={
            "theme_key": "neo-technical",
            "story_plan": {
                "title": "Agent composed",
                "audience": "Reviewers",
                "objective": "Make one decision",
                "narrative_arc": "Context to decision",
                "slides": [{
                    "layout": "statement",
                    "purpose": "Record the decision",
                    "key_message": "Use the deterministic path",
                    "headline": "Compose, do not place",
                    "body": "The caller supplies intent and words; Deckastra owns geometry."
                }],
            },
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["document"]["slides"][0]["semanticIntent"] == "Record the decision"


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


def _oidc_token(monkeypatch, **overrides) -> str:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    monkeypatch.setenv("DECKASTRA_ENV", "production")
    monkeypatch.setenv("DECKASTRA_OIDC_ISSUER", "https://identity.example.test")
    monkeypatch.setenv("DECKASTRA_OIDC_AUDIENCE", "deckastra-api")
    monkeypatch.setenv("DECKASTRA_OIDC_PUBLIC_KEY", public_pem)
    now = datetime.now(timezone.utc)
    claims = {
        "iss": "https://identity.example.test",
        "sub": "provider-user-123",
        "aud": "deckastra-api",
        "iat": now,
        "exp": now + timedelta(minutes=5),
        "email": "Signed.In@Example.com",
        "email_verified": True,
        "name": "Signed In",
        "provider": "google",
        **overrides,
    }
    return jwt.encode(claims, private_key, algorithm="RS256")


def test_a_verified_oidc_identity_bootstraps_one_personal_account(client, monkeypatch):
    from deckastra_api.db.models import AuthIdentity

    token = _oidc_token(monkeypatch)
    headers = {"Authorization": f"Bearer {token}"}

    first = client.get("/v1/workspace/usage", headers=headers)
    second = client.get("/v1/workspace/usage", headers=headers)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    with db_session.session_scope() as session:
        identity = session.query(AuthIdentity).one()
        user = session.get(User, identity.user_id)
        assert identity.issuer == "https://identity.example.test"
        assert identity.subject == "provider-user-123"
        assert identity.provider == "google"
        assert user.email == "signed.in@example.com"
        assert session.query(WorkspaceMember).filter_by(user_id=user.id).count() == 1
        assert session.query(Project).filter_by(created_by=user.id).count() == 1


@pytest.mark.parametrize(
    "overrides",
    [
        {"aud": "some-other-api"},
        {"email_verified": False},
        {"exp": datetime.now(timezone.utc) - timedelta(minutes=1)},
    ],
)
def test_invalid_oidc_claims_are_rejected_without_provisioning(client, monkeypatch, overrides):
    from deckastra_api.db.models import AuthIdentity

    token = _oidc_token(monkeypatch, **overrides)
    response = client.get(
        "/v1/workspace/usage", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid token."
    with db_session.session_scope() as session:
        assert session.query(AuthIdentity).count() == 0
        assert session.query(User).count() == 0


def test_a_development_token_is_never_accepted_in_production(client, monkeypatch):
    from deckastra_api.auth import issue_dev_token

    dev = client.post("/v1/dev/session", json={"email": "dev-only@example.com"}).json()
    monkeypatch.setenv("DECKASTRA_ENV", "production")
    response = client.get(
        "/v1/workspace/usage",
        headers={"Authorization": f"Bearer {issue_dev_token(dev['user_id'])}"},
    )
    assert response.status_code == 401


def test_account_context_and_workspace_project_creation_are_explicit(
    client, auth, session_token
):
    initial = client.get("/v1/account", headers=auth)
    assert initial.status_code == 200, initial.text
    assert initial.json()["user"]["id"] == session_token["user_id"]
    assert initial.json()["workspaces"] == [
        {
            "id": session_token["workspace_id"],
            "name": "dev's workspace",
            "role": "owner",
            # D5.1: where this workspace's authority lives. A seeded one is this
            # machine's own; a mirror of a cloud workspace is not.
            "origin": "local",
            # D5.4: what the membership grants right now. In a local workspace the
            # row is the authority, so there is nothing to confirm it against.
            "access": "authoritative",
            "confirmed_at": None,
            "projects": [
                {
                    "id": session_token["project_id"],
                    "name": "My first project",
                    "description": None,
                }
            ],
        }
    ]

    created_workspace = client.post(
        "/v1/workspaces", headers=auth, json={"name": "Client work"}
    )
    assert created_workspace.status_code == 201, created_workspace.text
    workspace_id = created_workspace.json()["workspace_id"]

    created_project = client.post(
        f"/v1/workspaces/{workspace_id}/projects",
        headers=auth,
        json={"name": "Launch deck", "description": "Q4 launch"},
    )
    assert created_project.status_code == 201, created_project.text
    assert created_project.json()["name"] == "Launch deck"

    refreshed = client.get("/v1/account", headers=auth).json()
    selected = next(item for item in refreshed["workspaces"] if item["id"] == workspace_id)
    assert selected["role"] == "owner"
    assert [project["name"] for project in selected["projects"]] == [
        "Launch deck",
        "My first project",
    ]


def test_project_creation_checks_the_named_workspace_role(client, auth, session_token):
    other = client.post("/v1/dev/session", json={"email": "project-owner@example.com"}).json()
    with db_session.session_scope() as session:
        session.add(
            WorkspaceMember(
                id=new_id("mbr"),
                workspace_id=other["workspace_id"],
                user_id=session_token["user_id"],
                role="viewer",
            )
        )

    assert (
        client.get(f"/v1/workspaces/{other['workspace_id']}/projects", headers=auth).status_code
        == 200
    )
    refused = client.post(
        f"/v1/workspaces/{other['workspace_id']}/projects",
        headers=auth,
        json={"name": "Not allowed"},
    )
    assert refused.status_code == 404


def test_workspace_and_project_names_cannot_be_whitespace(client, auth, session_token):
    assert client.post("/v1/workspaces", headers=auth, json={"name": "   "}).status_code == 422
    assert (
        client.post(
            f"/v1/workspaces/{session_token['workspace_id']}/projects",
            headers=auth,
            json={"name": "\t"},
        ).status_code
        == 422
    )


def test_repository_grounding_routes_are_removed(client, auth, deck):
    assert client.get("/v1/repositories", headers=auth).status_code == 404
    assert client.post("/v1/repositories/search", headers=auth, json={"query": "x"}).status_code == 404
    assert client.post("/v1/github/webhook", content=b"{}").status_code == 404

    # Provenance belongs to the document and remains readable independently of
    # any Deckastra-managed repository connection.
    presentation_id = deck["presentation_id"]
    document = client.get(f"/v1/presentations/{presentation_id}", headers=auth).json()["document"]
    slide_id = document["slides"][0]["id"]
    sources = client.get(
        f"/v1/presentations/{presentation_id}/slides/{slide_id}/sources", headers=auth
    )
    assert sources.status_code == 200
    assert sources.json() == {"slide_id": slide_id, "sources": []}


# --------------------------------------------------------------- create + read


def test_blank_decks_adopt_a_portable_default_theme(client, auth):
    from copy import deepcopy
    from deckastra_api.theme import neo_technical_theme
    definition = neo_technical_theme()
    definition["colors"]["accent"] = "#FF6600"
    saved = client.post("/v1/workspace/themes", headers=auth, json={"name": "Default brand", "definition": definition, "is_default": True})
    assert saved.status_code == 200, saved.text
    created = client.post("/v1/presentations", headers=auth, json={})
    assert created.status_code in (200, 201), created.text
    result = created.json()
    assert result["document"]["theme"] == definition
    assert result["document"]["metadata"]["themeId"] == saved.json()["id"]
    changed = deepcopy(definition)
    changed["colors"]["accent"] = "#00AAFF"
    assert client.post("/v1/workspace/themes", headers=auth, json={"name": "Default brand", "definition": changed, "is_default": True}).status_code == 200
    stored = client.get(f"/v1/presentations/{result['presentation_id']}", headers=auth).json()
    assert stored["document"]["theme"] == definition


def test_default_theme_does_not_cross_workspace_boundary(client, auth):
    from deckastra_api.theme import neo_technical_theme
    other = client.post("/v1/dev/session", json={"email": "default-brand-other@localhost"}).json()
    saved = client.post("/v1/workspace/themes", headers={"Authorization": f"Bearer {other['token']}"}, json={"name": "Other default", "definition": neo_technical_theme(), "is_default": True})
    assert saved.status_code == 200
    created = client.post("/v1/presentations", headers=auth, json={})
    assert created.status_code == 201
    assert "themeId" not in created.json()["document"]["metadata"]


def test_viewer_cannot_create_a_template_deck(client, auth, session_token):
    from deckastra_api.db.models import Presentation
    with db_session.session_scope() as session:
        membership = session.query(WorkspaceMember).filter(WorkspaceMember.user_id == session_token["user_id"]).one()
        membership.role = "viewer"
    for project in (None, session_token["project_id"]):
        response = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "business-pitch", "project_id": project})
        assert response.status_code == 404, response.text
    with db_session.session_scope() as session:
        assert session.query(Presentation).count() == 0


def test_explicit_template_creation_uses_the_authorized_target_workspace(client, auth, session_token):
    from deckastra_api.db.models import Presentation
    other = client.post("/v1/dev/session", json={"email": "template-target@localhost"}).json()
    with db_session.session_scope() as session:
        membership = session.query(WorkspaceMember).filter(WorkspaceMember.user_id == session_token["user_id"]).one()
        membership.role = "viewer"
        session.add(WorkspaceMember(id=new_id("mbr"), workspace_id=other["workspace_id"], user_id=session_token["user_id"], role="editor"))
    # The default target must not silently skip a viewer workspace to obtain
    # editor authority elsewhere. An explicit authorized target is allowed.
    assert client.post("/v1/decks/from-template", headers=auth, json={"template_id": "business-pitch"}).status_code == 404
    response = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "business-pitch", "project_id": other["project_id"]})
    assert response.status_code == 200, response.text
    with db_session.session_scope() as session:
        presentation = session.get(Presentation, response.json()["presentation_id"])
        assert presentation.project_id == other["project_id"]


def test_blank_creation_persists_and_accepts_manual_edits_without_a_run(client, auth):
    from deckastra_api.db.models import AgentRunRow
    from deckastra_api.schema import validate_document
    response = client.post("/v1/presentations", headers=auth, json={"title": "My blank deck"})
    assert response.status_code == 201, response.text
    deck = response.json()
    assert validate_document(deck["document"]) == []
    assert len(deck["document"]["slides"]) == 1
    assert deck["document"]["slides"][0]["elements"] == []
    assert "deckastra.generation" not in deck["document"].get("extensions", {})
    fetched = client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth)
    assert fetched.json()["document"] == deck["document"]
    assert fetched.json()["version_id"] == deck["version_id"]
    assert fetched.json()["can_edit"] is True
    changed = client.post(f"/v1/presentations/{deck['presentation_id']}/transactions", headers=auth, json={
        "expected_version_id": deck["version_id"], "intent": "Rename blank slide",
        "operations": [{"op": "replace", "path": "/slides/0/name", "value": "My opening"}],
    })
    assert changed.status_code == 200, changed.text
    assert client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth).json()["document"]["slides"][0]["name"] == "My opening"
    with db_session.session_scope() as session:
        assert session.query(AgentRunRow).count() == 0


def test_blank_creation_requires_editor_access_and_hides_foreign_projects(client, auth, session_token):
    assert client.post("/v1/presentations", json={}).status_code == 401
    other = client.post("/v1/dev/session", json={"email": "blank-other@localhost"}).json()
    assert client.post("/v1/presentations", headers=auth, json={"project_id": other["project_id"]}).status_code == 404
    with db_session.session_scope() as session:
        membership = session.query(WorkspaceMember).filter(WorkspaceMember.user_id == session_token["user_id"]).one()
        membership.role = "viewer"
    for payload in ({}, {"project_id": session_token["project_id"]}):
        assert client.post("/v1/presentations", headers=auth, json=payload).status_code == 404


def test_template_creation_persists_a_deck(client: TestClient, auth, deck):
    assert deck["presentation_id"].startswith("doc_")
    assert deck["version_id"]
    assert deck["document"]["slides"]

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
