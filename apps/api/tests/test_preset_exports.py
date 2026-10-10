"""Launch-catalog acceptance: every reviewed template moves and exports.

This is intentionally part of ``presets:check`` rather than a sample export.
Each template is an independent case, each uses its own named motion style, and
both output formats are reopened by implementations outside Deckastra.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import base64  # noqa: E402

from deckastra_api import preset_media, presets, template_compose  # noqa: E402
from deckastra_api.export_service import _invoke_worker  # noqa: E402
from deckastra_api.schema import validate_document  # noqa: E402

pypdf = pytest.importorskip("pypdf", reason="pypdf is the independent PDF reader")
pptx = pytest.importorskip("pptx", reason="python-pptx is the independent PowerPoint reader")

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(shutil.which("npx") is None, reason="the exporter runs through npx"),
]

REVIEWED = presets.public_catalog()["presets"]


@pytest.mark.parametrize("preset_id", [preset["id"] for preset in REVIEWED])
def test_each_reviewed_template_has_motion_and_readable_exports(preset_id: str, tmp_path: Path):
    preset = presets.find_preset(preset_id)
    # Exactly what "Use template" makes: the template's language, its theme and
    # its pictures. This used to compose neutrally, so after unit 7a it was
    # exporting a layout no template uses any more.
    document = template_compose.compose_template(preset_id)
    pictures = [asset for asset in document.get("assets") or [] if asset["storageKey"].startswith(preset_media.KEY_PREFIX)]
    supplied = [
        {"assetId": asset["id"], "storageKey": asset["storageKey"], "mimeType": "image/jpeg",
         "data": base64.b64encode(preset_media.read(asset["fileName"])).decode()}
        for asset in pictures
    ]

    assert validate_document(document) == []
    assert len(document["slides"]) == len(preset["slides"])
    assert all(slide.get("animations") for slide in document["slides"]), preset_id

    style = presets.catalog()["motionStyles"][preset["motionStyle"]]
    allowed_presets = {style["entrance"], "staggerReveal"}
    if style["entrance"] == "wordCascade":
        allowed_presets.add("springIn")
    used_presets = {
        clip["preset"]
        for slide in document["slides"]
        for track in slide.get("animations") or []
        for clip in track.get("clips") or []
    }
    assert used_presets <= allowed_presets, (preset_id, used_presets)
    if preset["motionStyle"] == "playful":
        assert "wordCascade" in used_presets

    pdf_path = tmp_path / f"{preset_id}.pdf"
    pdf_report = _invoke_worker("pdf", document, pdf_path, {}, assets=supplied)
    pdf = pypdf.PdfReader(str(pdf_path))
    assert len(pdf.pages) == len(document["slides"]) == pdf_report["report"]["slideCount"]
    assert all((page.extract_text() or "").strip() for page in pdf.pages), preset_id

    pptx_path = tmp_path / f"{preset_id}.pptx"
    pptx_report = _invoke_worker("pptx", document, pptx_path, {}, assets=supplied)
    powerpoint = pptx.Presentation(str(pptx_path))
    assert len(powerpoint.slides) == len(document["slides"]) == pptx_report["report"]["slideCount"]
    assert all(
        any(shape.has_text_frame and shape.text_frame.text.strip() for shape in slide.shapes)
        for slide in powerpoint.slides
    ), preset_id

    # A template's pictures arrive in both files: images in the PDF pages, and
    # picture shapes in PowerPoint, one per frame the language drew.
    framed = sum(1 for slide in document["slides"] for element in slide["elements"] if element["type"] == "image")
    if framed:
        pdf_images = sum(len(page.images) for page in pdf.pages)
        assert pdf_images >= framed, (preset_id, pdf_images, framed)
        pictures_in_pptx = sum(
            1 for slide in powerpoint.slides for shape in slide.shapes if shape.shape_type == pptx.enum.shapes.MSO_SHAPE_TYPE.PICTURE
        )
        assert pictures_in_pptx >= framed, (preset_id, pictures_in_pptx, framed)
