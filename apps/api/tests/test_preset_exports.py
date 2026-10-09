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

from deckastra_api import presets  # noqa: E402
from deckastra_api.compose import compose_document  # noqa: E402
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
    plan = presets.story_plan_from_preset(preset)
    theme, theme_id = presets.resolve_theme(preset["themeKey"])
    motion_plan = presets.motion_plan_from_preset(preset)
    document = compose_document(
        plan,
        instruction=f"Preset acceptance: {preset_id}",
        motion_plan=motion_plan,
        theme_definition=theme,
        theme_id=theme_id,
    )
    document["metadata"]["templateId"] = preset_id
    document["metadata"]["motionStyle"] = preset["motionStyle"]
    document["metadata"]["voiceStyle"] = preset["voiceStyle"]

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
    pdf_report = _invoke_worker("pdf", document, pdf_path, {})
    pdf = pypdf.PdfReader(str(pdf_path))
    assert len(pdf.pages) == len(document["slides"]) == pdf_report["report"]["slideCount"]
    assert all((page.extract_text() or "").strip() for page in pdf.pages), preset_id

    pptx_path = tmp_path / f"{preset_id}.pptx"
    pptx_report = _invoke_worker("pptx", document, pptx_path, {})
    powerpoint = pptx.Presentation(str(pptx_path))
    assert len(powerpoint.slides) == len(document["slides"]) == pptx_report["report"]["slideCount"]
    assert all(
        any(shape.has_text_frame and shape.text_frame.text.strip() for shape in slide.shapes)
        for slide in powerpoint.slides
    ), preset_id
