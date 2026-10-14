"""Template cut-outs (subject cut-outs, 2026-10-13).

A template may ship a transparent PNG of its subject alongside its JPEG
photographs, with the depth it should take. A PNG is accepted only as a
cut-out: one with no transparency is a photograph in the wrong format and is
refused, like any other picture that may not ship.
"""

from __future__ import annotations

import io
import json

import pytest
from PIL import Image

from deckastra_api import object_storage, preset_media, template_compose
from deckastra_api.schema import validate_document
from tests.test_preset_media import _entry, _jpeg, _pictures, auth, client  # noqa: F401  fixtures


def _png(width: int, height: int, *, transparent: bool) -> bytes:
    mode = "RGBA" if transparent else "RGB"
    image = Image.new(mode, (width, height), (200, 40, 40, 0) if transparent else (200, 40, 40))
    if transparent:
        # A person-shaped blob of opaque pixels in a transparent field.
        for x in range(width // 4, 3 * width // 4):
            for y in range(height // 5, height):
                image.putpixel((x, y), (200, 40, 40, 255))
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=True)
    return buffer.getvalue()


def _folder(tmp_path, monkeypatch, *, cutout: bytes, layer: str = "subject"):
    folder = tmp_path / "media"
    folder.mkdir()
    scene = _jpeg(900, 1200, (60, 90, 120))
    (folder / "pitch-scene.jpg").write_bytes(scene)
    (folder / "pitch-subject.png").write_bytes(cutout)
    manifest = {
        "version": 1,
        "media": [
            _entry("pitch-scene.jpg", scene, (900, 1200), [{"template": "business-pitch", "role": "hero"}]),
            _entry("pitch-subject.png", cutout, (300, 500), [{"template": "business-pitch", "role": "hero", "layer": layer}]),
        ],
    }
    (folder / "MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setenv("DECKASTRA_PRESET_MEDIA_DIR", str(folder))
    preset_media._load.cache_clear()
    template_compose.catalog_revision.cache_clear()
    template_compose.PREVIEWS.clear()
    return folder


@pytest.fixture()
def cleanup():
    yield
    preset_media._load.cache_clear()
    template_compose.catalog_revision.cache_clear()
    template_compose.PREVIEWS.clear()


def test_a_transparent_cutout_is_accepted_and_an_opaque_png_is_not(tmp_path, monkeypatch, cleanup):
    folder = _folder(tmp_path, monkeypatch, cutout=_png(300, 500, transparent=True))
    assert preset_media.problems(folder) == []

    (tmp_path / "opaque").mkdir()
    opaque = _folder(tmp_path / "opaque", monkeypatch, cutout=_png(300, 500, transparent=False))
    problems = preset_media.problems(opaque)
    assert any("no transparency" in problem for problem in problems), problems


def test_a_missing_cutout_and_a_png_labelled_as_jpeg_are_deliberate_failures(tmp_path, monkeypatch, cleanup):
    """The release gate fails loudly for both broken-asset cases.

    A missing file must never become an empty subject silently, and a PNG with
    a JPEG name/MIME must not reach PowerPoint as a corrupt picture part.
    """
    folder = _folder(tmp_path, monkeypatch, cutout=_png(300, 500, transparent=True))
    subject = folder / "pitch-subject.png"
    raw = subject.read_bytes()
    subject.unlink()
    preset_media._load.cache_clear()
    assert any("pitch-subject.png is in the manifest and not on disk" in problem for problem in preset_media.problems(folder))

    manifest = json.loads((folder / "MANIFEST.json").read_text(encoding="utf-8"))
    entry = next(one for one in manifest["media"] if one["file"] == "pitch-subject.png")
    entry["file"] = "pitch-subject.jpg"
    entry["sha256"] = entry["sourceSha256"] = __import__("hashlib").sha256(raw).hexdigest()
    entry["bytes"] = len(raw)
    (folder / "pitch-subject.jpg").write_bytes(raw)
    (folder / "MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")
    preset_media._load.cache_clear()
    assert any("pitch-subject.jpg is not a JPEG" in problem for problem in preset_media.problems(folder))


def test_a_template_names_a_depth_it_may_have(tmp_path, monkeypatch, cleanup):
    folder = _folder(tmp_path, monkeypatch, cutout=_png(300, 500, transparent=True), layer="hovering")
    assert any("no valid template media selector" in problem for problem in preset_media.problems(folder))


def test_a_cutout_lands_as_the_subject_above_the_photograph(tmp_path, monkeypatch, cleanup):
    _folder(tmp_path, monkeypatch, cutout=_png(300, 500, transparent=True))
    document = template_compose.compose_template("business-pitch")
    assert validate_document(document) == []
    assets = {asset["id"]: asset for asset in document["assets"]}
    subjects = [picture for _, picture in _pictures(document) if picture.get("layerRole") == "subject"]
    assert subjects, "the cut-out was not placed"
    for picture in subjects:
        asset = assets[picture["assetId"]]
        assert asset["mimeType"] == "image/png"
        assert asset["hasAlpha"] is True
        assert picture["name"] == "Template subject"
    # On each slide, the subject is stacked above the photograph it stands in front of.
    for slide in document["slides"]:
        order = [e for e in slide["elements"] if e["type"] == "image"]
        if any(e.get("layerRole") == "subject" for e in order):
            kinds = [assets[e["assetId"]]["mimeType"] for e in order]
            assert kinds.index("image/png") > kinds.index("image/jpeg")


def test_a_deck_keeps_its_cutout_as_a_png(client, auth, tmp_path, monkeypatch, cleanup):  # noqa: F811
    folder = _folder(tmp_path, monkeypatch, cutout=_png(300, 500, transparent=True))
    served = client.get("/v1/presets/media/pitch-subject.png", headers=auth)
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/png"

    made = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "business-pitch"})
    assert made.status_code == 200, made.text
    stored = client.get(f"/v1/presentations/{made.json()['presentation_id']}", headers=auth).json()["document"]
    cutout = next(asset for asset in stored["assets"] if asset["fileName"] == "pitch-subject.png")
    assert cutout["storageKey"].endswith(".png")
    assert object_storage.read(cutout["storageKey"])[0] == (folder / "pitch-subject.png").read_bytes()
