"""Composed captions are readable on the theme they render in (2026-10-04 rerun).

The composer drew 18px captions in `colors.foregroundSubtle`, which is 4.49:1 on
Neo Technical's background. The assistant's layout gate refused every generated
slide that had one, whatever the model wrote; ordinary generation shipped them.
"""
import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deckastra_api import assistant_design, compose  # noqa: E402
from deckastra_api.models import Metric, SlidePlan, StoryPlan  # noqa: E402
from deckastra_api.office_theme import contrast  # noqa: E402
from deckastra_api.theme import neo_technical_theme  # noqa: E402

PRESETS = Path(__file__).resolve().parents[3] / "packages/presentation-schema/generated/theme-presets.json"


def presets():
    value = json.loads(PRESETS.read_text(encoding="utf-8"))
    value = value if isinstance(value, list) else value.get("presets", value)
    items = value.values() if isinstance(value, dict) else value
    return [preset.get("theme", preset) for preset in items]


def captioned_plan():
    slide = SlidePlan(layout="metrics", purpose="Show growth", key_message="Both regions grew", headline="Revenue grew in both regions",
                      metrics=[Metric(value="+21%", label="India"), Metric(value="+24%", label="GCC")],
                      caption="Source: finance export, unaudited.")
    return StoryPlan(title="FY26", audience="Board", objective="Decide", narrative_arc="Growth", slides=[slide])


def captions(document):
    """The slide's source line. Metric labels also carry the caption role."""
    def walk(elements):
        for element in elements:
            text = " ".join(span["text"] for block in (element.get("content") or {}).get("blocks", []) for span in block.get("spans", []))
            if element.get("semanticRole") == "caption" and text.startswith("Source:"):
                yield element
            yield from walk(element.get("children") or [])
    return [element for slide in document["slides"] for element in walk(slide["elements"])]


def test_a_composed_caption_passes_design_check_on_the_default_theme():
    document = compose.compose_document(captioned_plan())
    [caption] = captions(document)
    assert caption["typography"]["color"] != "token:colors.foregroundSubtle"
    findings = assistant_design.check(document)["findings"]
    assert not [f for f in findings if f["code"] == "A102" and f.get("elementId") == caption["id"]]


@pytest.mark.parametrize("index", range(len(presets())))
def test_every_preset_gets_a_caption_colour_that_reads(index):
    theme = presets()[index]
    chosen = compose.caption_colour(theme).removeprefix("token:colors.")
    assert contrast(compose._theme_colour(theme, chosen), compose._theme_colour(theme, "background")) >= compose.CAPTION_MINIMUM


def test_a_theme_whose_subtle_colour_reads_keeps_it():
    passing = next(theme for theme in presets() if contrast(theme["colors"]["foregroundSubtle"], theme["colors"]["background"]) >= 4.5)
    assert compose.caption_colour(passing) == "token:colors.foregroundSubtle"


def test_slides_appended_to_a_deck_are_recoloured_for_the_deck_theme():
    passing = next(theme for theme in presets() if contrast(theme["colors"]["foregroundSubtle"], theme["colors"]["background"]) >= 4.5)
    slides = compose.compose_document(captioned_plan(), theme_definition=passing)["slides"]
    assert captions({"slides": slides})[0]["typography"]["color"] == "token:colors.foregroundSubtle"
    compose.readable_captions(slides, neo_technical_theme())  # the deck they are appended to
    assert captions({"slides": slides})[0]["typography"]["color"] == "token:colors.foregroundMuted"


def test_a_colour_that_cannot_be_measured_falls_back_to_foreground():
    theme = copy.deepcopy(neo_technical_theme())
    theme["colors"]["foregroundSubtle"] = "#6B7C9080"  # alpha: depends on what is behind it
    theme["colors"]["foregroundMuted"] = "token:colors.missing"
    assert compose.caption_colour(theme) == "token:colors.foreground"
