"""Template pictures: attached, previewed, adopted, budgeted (UI audit 2026-10-10, unit 7b).

The shipped manifest is empty until pictures made under terms that allow
commercial use are reviewed (docs/design-audit/MEDIA.md), so these tests build
their own media folder with JPEGs drawn here and full provenance, and point the
service at it.
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import assets, object_storage, preset_media, template_compose  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.schema import validate_document  # noqa: E402


def _jpeg(width: int, height: int, colour: tuple[int, int, int]) -> bytes:
    image = Image.new("RGB", (width, height), colour)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=82)
    return buffer.getvalue()


def _entry(name: str, data: bytes, size: tuple[int, int], uses: list[dict], **overrides) -> dict:
    entry = {
        "file": name,
        "model": "test-drawn",
        "mode": "code",
        "generatedAt": "2026-10-10",
        "prompt": "A flat test colour, drawn by the test.",
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "width": size[0],
        "height": size[1],
        "alt": f"A flat colour standing in for {name}",
        "review": {"result": "approved", "reviewer": "test", "date": "2026-10-10"},
        "license": {"use": "commercial", "plan": "Plus", "commercialUse": True, "termsUrl": "https://openart.ai/terms", "termsRetrievedAt": "2026-10-10", "termsSha256": "0" * 64},
        "templates": uses,
    }
    entry.update(overrides)
    return entry


@pytest.fixture()
def media(tmp_path, monkeypatch):
    folder = tmp_path / "media"
    folder.mkdir()
    hero = _jpeg(600, 1200, (180, 140, 90))
    scene = _jpeg(900, 1200, (60, 90, 120))
    (folder / "luxe-hero.jpg").write_bytes(hero)
    (folder / "luxe-scene.jpg").write_bytes(scene)
    manifest = {
        "version": 1,
        "media": [
            _entry("luxe-hero.jpg", hero, (600, 1200), [{"template": "business-pitch", "role": "hero"}]),
            _entry("luxe-scene.jpg", scene, (900, 1200), [{"template": "business-pitch", "role": "scene"}]),
        ],
    }
    (folder / "MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setenv("DECKASTRA_PRESET_MEDIA_DIR", str(folder))
    preset_media._load.cache_clear()
    template_compose.catalog_revision.cache_clear()
    template_compose.PREVIEWS.clear()
    yield folder
    preset_media._load.cache_clear()
    template_compose.catalog_revision.cache_clear()
    template_compose.PREVIEWS.clear()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'media.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "media@localhost"})
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _pictures(document):
    return [
        (index, element)
        for index, slide in enumerate(document["slides"])
        for element in slide["elements"]
        if element["type"] == "image"
    ]


SHIPPED = Path(__file__).resolve().parents[3] / "packages" / "deck-presets" / "media"


def test_the_shipped_manifest_is_within_budget():
    """The check that holds every picture in the build."""
    preset_media._load.cache_clear()
    assert preset_media.problems(SHIPPED) == []


def test_demo_pictures_are_usable_and_never_releasable(tmp_path):
    """Demo use is non-commercial, which every plan allows; a release is not a demo."""
    folder = tmp_path / "demo"
    folder.mkdir()
    data = _jpeg(400, 300, (9, 9, 9))
    (folder / "demo-shot.jpg").write_bytes(data)
    licence = {"use": "demo", "plan": "Starter", "commercialUse": False, "termsUrl": "https://openart.ai/terms", "termsRetrievedAt": "2026-10-10", "termsSha256": "0" * 64}
    manifest = {"media": [_entry("demo-shot.jpg", data, (400, 300), [{"template": "x", "role": "scene"}], license=licence)]}
    (folder / "MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")
    preset_media._load.cache_clear()
    assert preset_media.problems(folder) == []
    assert preset_media.demo_only(folder) == ["demo-shot.jpg"]
    assert "may not ship in a release" in " ".join(preset_media.problems(folder, release=True))
    preset_media._load.cache_clear()


def test_with_no_pictures_a_frame_stays_a_frame(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKASTRA_PRESET_MEDIA_DIR", str(tmp_path))
    preset_media._load.cache_clear()
    document = template_compose.compose_template("business-pitch")
    assert _pictures(document) == []
    preset_media._load.cache_clear()


def test_every_shipped_template_with_a_frame_shows_a_picture_and_none_is_releasable():
    """The 22 demo pictures fill every frame the catalog draws, and a release refuses all of them."""
    from deckastra_api import presets

    preset_media._load.cache_clear()
    for preset in presets.public_catalog()["presets"]:
        document = template_compose.compose_template(preset["id"])
        frames = [e for s in document["slides"] for e in s["elements"] if e.get("name") in preset_media.FRAME_NAMES]
        assert len(_pictures(document)) == len(frames), preset["id"]
        assert validate_document(document) == [], preset["id"]
    refused = preset_media.problems(SHIPPED, release=True)
    assert len(preset_media.demo_only(SHIPPED)) == len(preset_media.entries()) == 22
    assert all("demo use" in line or "reviewed by a person" in line for line in refused)


def test_a_template_puts_its_pictures_in_its_frames(media):
    document = template_compose.compose_template("business-pitch")
    assert validate_document(document) == []
    pictures = _pictures(document)
    frames = [(i, e) for i, s in enumerate(document["slides"]) for e in s["elements"] if e.get("name") in preset_media.FRAME_NAMES]
    assert len(pictures) == len(frames) > 0
    keys = {asset["id"]: asset["storageKey"] for asset in document["assets"]}
    for index, picture in pictures:
        # The title slides take the hero, the others the scene.
        expected = "preset-media/luxe-hero.jpg" if index in (0, 9) else "preset-media/luxe-scene.jpg"
        assert keys[picture["assetId"]] == expected, index
        assert picture["altText"].startswith("A flat colour")
        assert picture["fit"] == "cover"
    # One asset entry per file, however many frames cite it.
    assert sorted(keys.values()) == ["preset-media/luxe-hero.jpg", "preset-media/luxe-scene.jpg"]


def test_a_preview_reads_a_picture_by_name_and_nothing_else(client, auth, media):
    ok = client.get("/v1/presets/media/luxe-hero.jpg", headers=auth)
    assert ok.status_code == 200
    assert ok.headers["content-type"] == "image/jpeg"
    assert ok.content == (media / "luxe-hero.jpg").read_bytes()
    assert client.get("/v1/presets/media/unlisted.jpg", headers=auth).status_code == 404
    assert client.get("/v1/presets/media/..%2FMANIFEST.json", headers=auth).status_code == 404
    assert client.get("/v1/presets/media/luxe-hero.jpg").status_code == 401
    assert object_storage.blob_url("preset-media/luxe-hero.jpg") == "/v1/presets/media/luxe-hero.jpg"


def test_a_deck_made_from_a_template_owns_its_pictures(client, auth, media):
    made = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "business-pitch"})
    assert made.status_code == 200, made.text
    document = made.json()["document"]
    stored = client.get(f"/v1/presentations/{made.json()['presentation_id']}", headers=auth).json()["document"]
    for doc in (document, stored):
        keys = [asset["storageKey"] for asset in doc["assets"]]
        assert keys and all(key.startswith("workspaces/") for key in keys), keys
        cited = {picture["assetId"] for _, picture in _pictures(doc)}
        assert cited == {asset["id"] for asset in doc["assets"]}
    # The bytes are the workspace's now, and a render is handed them.
    with db_session.session_scope() as session:
        supplied = assets.inline_for_render(session, presentation_id=made.json()["presentation_id"], document=stored)
    assert len(supplied) == 2 and all(not one.get("problem") for one in supplied), supplied
    hero_key = next(asset["storageKey"] for asset in stored["assets"] if asset["fileName"] == "luxe-hero.jpg")
    assert object_storage.read(hero_key)[0] == (media / "luxe-hero.jpg").read_bytes()


def test_the_budget_refuses_what_may_not_ship(tmp_path):
    folder = tmp_path / "bad"
    folder.mkdir()
    data = _jpeg(400, 300, (1, 2, 3))
    (folder / "starter.jpg").write_bytes(data)
    (folder / "changed.jpg").write_bytes(data)
    (folder / "unreviewed.jpg").write_bytes(data)
    big = _jpeg(1900, 1900, (0, 0, 0))
    manifest = {"media": [
        _entry("starter.jpg", data, (400, 300), [{"template": "x", "role": "scene"}], license={"use": "commercial", "plan": "Starter", "commercialUse": False, "termsUrl": "u", "termsRetrievedAt": "d", "termsSha256": "s"}),
        _entry("changed.jpg", data, (400, 300), [{"template": "x", "role": "scene"}], sha256="0" * 64),
        _entry("unreviewed.jpg", data, (400, 300), [{"template": "x", "role": "scene"}], review={}),
        _entry("missing.jpg", big, (1900, 1900), [{"template": "x", "role": "scene"}]),
        _entry("Bad Name.png", data, (1, 1), []),
    ]}
    (folder / "MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")
    preset_media._load.cache_clear()
    found = " | ".join(preset_media.problems(folder))
    assert "starter.jpg is marked for commercial use but was not made under terms that allow it" in found
    assert "changed.jpg does not match its recorded sha256" in found
    assert "unreviewed.jpg has no recorded approval" in found
    assert "missing.jpg is in the manifest and not on disk" in found
    assert "Bad Name.png: file names are lower-case words and hyphens ending .jpg" in found
    preset_media._load.cache_clear()


def test_a_deck_is_made_without_its_pictures_when_they_cannot_be_stored(tmp_path, monkeypatch, media):
    """No object store: the deck still arrives, frames empty, and says why."""
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'nostore.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.delenv("DECKASTRA_ASSET_DIR", raising=False)
    monkeypatch.setattr(object_storage, "put", lambda *a, **k: (_ for _ in ()).throw(object_storage.ObjectStorageError("offline")))
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api.main import app

    with TestClient(app) as client:
        token = client.post("/v1/dev/session", json={"email": "nostore@localhost"}).json()["token"]
        made = client.post("/v1/decks/from-template", headers={"Authorization": f"Bearer {token}"}, json={"template_id": "business-pitch"})
    assert made.status_code == 200, made.text
    body = made.json()
    assert _pictures(body["document"]) == []
    assert not any(str(a.get("storageKey", "")).startswith("preset-media/") for a in body["document"].get("assets") or [])
    assert "could not be stored" in body["warnings"][0]
    frames = [e for s in body["document"]["slides"] for e in s["elements"] if e.get("name") in preset_media.FRAME_NAMES]
    assert frames, "the frames stay"
