"""Template previews: the real composer's output, returned and never stored.

UI audit 2026-10-10, unit 2. The gallery drew every template as the same CSS
mock; a preview is what "Use template" would make, so these hold the preview to
that composition, to storing nothing, and to its cache answering only for the
catalog it was composed from.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import grants, template_compose  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import Presentation, PresentationVersion  # noqa: E402
from deckastra_api.schema import validate_document  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'api.db'}")
    db_session.reset_engine()
    db_session.create_all()
    template_compose.PREVIEWS.clear()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client

    db_session.reset_engine()


@pytest.fixture()
def auth(client: TestClient) -> dict[str, str]:
    token = client.post("/v1/dev/session", json={"email": "dev@localhost"}).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _texts(slide: dict) -> list[str]:
    found: list[str] = []

    def walk(value):
        if isinstance(value, dict):
            if isinstance(value.get("text"), str):
                found.append(value["text"])
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(slide.get("elements"))
    return found


def _stored_rows() -> tuple[int, int]:
    with db_session.session_scope() as session:
        return (
            session.scalar(select(func.count()).select_from(Presentation)) or 0,
            session.scalar(select(func.count()).select_from(PresentationVersion)) or 0,
        )


def test_a_cover_is_the_first_slide_use_template_would_make(client, auth):
    preview = client.post("/v1/presets/business-pitch/preview", headers=auth, json={"theme_key": "minimal-light"})
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["template_id"] == "business-pitch"
    assert body["slides"] == "cover"
    assert body["catalog_revision"] == template_compose.catalog_revision()
    assert "presentation_id" not in body and "version_id" not in body
    document = body["document"]
    assert len(document["slides"]) == 1
    assert "transition" not in document["slides"][0]
    assert validate_document(document) == []

    made = client.post(
        "/v1/decks/from-template",
        headers=auth,
        json={"template_id": "business-pitch", "theme_key": "minimal-light"},
    ).json()["document"]
    # Ids are minted per composition; everything a person sees must agree.
    assert document["theme"] == made["theme"]
    assert document["slides"][0]["layout"] == made["slides"][0]["layout"]
    assert _texts(document["slides"][0]) == _texts(made["slides"][0])


def test_all_slides_for_the_detail_drawer(client, auth):
    body = client.post("/v1/presets/technical-architecture/preview", headers=auth, json={"slides": "all"}).json()
    assert body["slides"] == "all"
    assert len(body["document"]["slides"]) == 10
    assert validate_document(body["document"]) == []


def test_a_preview_stores_nothing(client, auth):
    before = _stored_rows()
    for slides in ("cover", "all"):
        assert client.post("/v1/presets/business-pitch/preview", headers=auth, json={"slides": slides}).status_code == 200
    assert client.post(
        "/v1/presets/business-pitch/preview",
        headers=auth,
        json={"content": {"opening": {"headline": "Mine"}}},
    ).status_code == 200
    assert _stored_rows() == before


def test_an_unchanged_preview_answers_304_to_its_etag(client, auth):
    first = client.post("/v1/presets/business-pitch/preview", headers=auth, json={})
    tag = first.headers["etag"]
    assert tag.startswith('"') and first.headers["cache-control"] == "private, max-age=3600"
    again = client.post("/v1/presets/business-pitch/preview", headers={**auth, "If-None-Match": tag}, json={})
    assert again.status_code == 304
    assert again.content == b""
    # A different theme is a different preview, with a different tag.
    other = client.post("/v1/presets/business-pitch/preview", headers={**auth, "If-None-Match": tag}, json={"theme_key": "midnight"})
    assert other.status_code == 200
    assert other.headers["etag"] != tag


def test_the_cache_answers_only_for_the_catalog_it_was_composed_from(client, auth, monkeypatch):
    key = template_compose.preview_key("business-pitch", None, "cover")
    monkeypatch.setattr(template_compose, "catalog_revision", lambda: "a-newer-catalog")
    assert template_compose.preview_key("business-pitch", None, "cover") != key
    assert template_compose.preview_key("business-pitch", None, "all") != template_compose.preview_key("business-pitch", None, "cover")


def test_the_persons_words_are_previewed_and_never_cached(client, auth):
    response = client.post(
        "/v1/presets/business-pitch/preview",
        headers=auth,
        json={"content": {"opening": {"headline": "Our private launch"}}},
    )
    assert response.status_code == 200, response.text
    assert "etag" not in response.headers
    assert response.headers["cache-control"] == "no-store"
    assert "Our private launch" in _texts(response.json()["document"]["slides"][0])
    # And the next plain preview is not that one.
    plain = client.post("/v1/presets/business-pitch/preview", headers=auth, json={}).json()
    assert "Our private launch" not in _texts(plain["document"]["slides"][0])


def test_refusals(client, auth):
    assert client.post("/v1/presets/business-pitch/preview", json={}).status_code == 401
    assert client.post("/v1/presets/no-such-template/preview", headers=auth, json={}).status_code == 422
    assert client.post("/v1/presets/business-pitch/preview", headers=auth, json={"theme_key": "no-such-theme"}).status_code == 422
    unknown = client.post("/v1/presets/business-pitch/preview", headers=auth, json={"content": {"opening": {"x": "y"}}})
    assert unknown.status_code == 422 and "Unknown slots" in unknown.json()["detail"]
    huge = {"opening": {"headline": "x" * (template_compose.MAX_CONTENT_BYTES + 1)}}
    assert client.post("/v1/presets/business-pitch/preview", headers=auth, json={"content": huge}).status_code == 413
    assert client.post("/v1/presets/business-pitch/preview", headers=auth, json={"slides": "some"}).status_code == 422


def test_an_agent_grant_reads_a_preview_and_still_cannot_create(client):
    assert grants.required_scope("POST", "/v1/presets/business-pitch/preview") == "read"
    assert grants.required_scope("POST", "/v1/decks/from-template") == "write"
