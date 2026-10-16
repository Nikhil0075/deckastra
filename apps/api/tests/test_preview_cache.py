"""Versioned preview pixels are reused without hiding renderer warnings."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import export_service  # noqa: E402


def _png(width: int, height: int) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + (b"\x00" * 8) + width.to_bytes(4, "big") + height.to_bytes(4, "big")


def test_identical_slide_preview_reuses_pixels_and_keeps_warnings(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setenv("DECKASTRA_EXPORT_DIR", str(tmp_path))
    export_service.clear_preview_cache()

    def render(kind, document, output, options, **_kwargs):
        calls.append((kind, options))
        output.write_bytes(_png(1024, 576))
        return {"width": 1920, "height": 1080, "metricsEstimated": False, "warnings": ["ast_missing could not be decoded"]}

    monkeypatch.setattr(export_service, "_invoke_worker", render)
    document = {"viewport": {"width": 1920, "height": 1080}, "slides": [{"id": "sld_one", "elements": []}]}

    first = export_service.render_slide_png(document, "sld_one")
    second = export_service.render_slide_png(document, "sld_one")

    assert len(calls) == 1
    assert first["cache_hit"] is False
    assert second["cache_hit"] is True
    assert second["warnings"] == ["ast_missing could not be decoded"]
    assert second["bytes"] == first["bytes"]


def test_preview_cache_key_changes_with_document_assets_and_motion_samples(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setenv("DECKASTRA_EXPORT_DIR", str(tmp_path))
    export_service.clear_preview_cache()

    def render(kind, document, output, options, **_kwargs):
        calls.append((kind, options, document))
        output.write_bytes(_png(1536 if kind == "motion-strip" else 1024, 900))
        return {
            "width": 1920,
            "height": 1080,
            "durationMs": 1200,
            "frameTimesMs": [0, 600, 1200],
            "metricsEstimated": False,
            "warnings": [],
        }

    monkeypatch.setattr(export_service, "_invoke_worker", render)
    original = {"viewport": {"width": 1920, "height": 1080}, "slides": [{"id": "sld_one", "elements": []}]}
    changed = {**original, "metadata": {"title": "Changed"}}
    export_service.render_slide_png(original, "sld_one", assets=[{"id": "ast_one", "base64": "AA=="}])
    export_service.render_slide_png(changed, "sld_one", assets=[{"id": "ast_one", "base64": "AA=="}])
    export_service.render_slide_png(original, "sld_one", assets=[{"id": "ast_one", "base64": "AQ=="}])
    export_service.render_motion_strip_png(original, "sld_one", frame_count=3)
    export_service.render_motion_strip_png(original, "sld_one", frame_count=4)

    assert len(calls) == 5

