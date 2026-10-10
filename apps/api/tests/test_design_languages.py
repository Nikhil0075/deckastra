"""Design languages in the composer (UI audit 2026-10-10, unit 5).

Four properties: the neutral composer did not move by a byte; each pilot
composes a valid deck that records its language; a pilot deck is structurally
unlike a neutral one, not a recolour; and nothing a language draws leaves the
slide.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import compose_golden  # noqa: E402
from deckastra_api import languages, presets, template_compose  # noqa: E402
from deckastra_api.compose import VIEWPORT_H, VIEWPORT_W, compose_slide  # noqa: E402
from deckastra_api.models import SlideLayout, SlidePlan  # noqa: E402
from deckastra_api.schema import validate_document  # noqa: E402

PILOTS = {
    "swiss-strategy-brief": "swiss-signal",
    "swiss-launch-signal": "swiss-signal",
    "noir-case-file": "cinema-noir",
    "noir-night-story": "cinema-noir",
}


def _walk(elements):
    for element in elements:
        yield element
        yield from _walk(element.get("children") or [])


def test_the_neutral_composer_has_not_moved_a_byte():
    recorded = json.loads(compose_golden.GOLDEN.read_text(encoding="utf-8"))
    assert compose_golden.neutral_digests() == recorded


def test_the_catalog_carries_the_languages_and_every_template_names_one():
    catalog = presets.catalog()
    assert set(catalog["designLanguages"]) == {
        "neutral", "swiss-signal", "cinema-noir",
        "play-lab", "system-terminal", "quiet-luxe", "data-desk", "earth-story", "spatial-future",
    }
    for preset in catalog["presets"]:
        assert preset["designLanguage"] in catalog["designLanguages"], preset["id"]


@pytest.mark.parametrize("template_id, language", sorted(PILOTS.items()))
def test_a_pilot_composes_a_valid_deck_that_records_its_language(template_id, language):
    document = template_compose.compose_template(template_id)
    assert validate_document(document) == []
    assert document["metadata"]["designLanguage"] == {"id": language, "version": presets.language_version(language)}
    # The language's theme, from its defaults.
    expected_theme = presets.catalog()["designLanguages"][language]["defaults"]["themeKey"]
    assert document["theme"]["name"] == presets.themes()[expected_theme]["name"]


def test_a_neutral_deck_records_no_language():
    from deckastra_api.compose import compose_document
    from deckastra_api.models import StoryPlan

    plan = StoryPlan(title="Plain", audience="", objective="", narrative_arc="", slides=[SlidePlan(layout=SlideLayout.TITLE, purpose="Open", key_message="Plain", headline="Plain")])
    document = compose_document(plan, instruction="neutral")
    assert "designLanguage" not in document["metadata"]


ALL_TEMPLATES = sorted(preset["id"] for preset in presets.catalog()["presets"])


@pytest.mark.parametrize("template_id", ALL_TEMPLATES)
def test_every_template_composes_a_valid_deck_in_its_language(template_id):
    """Unit 7a moved all 24 original templates onto languages; each must still be a deck."""
    document = template_compose.compose_template(template_id)
    assert validate_document(document) == []
    language = presets.find_preset(template_id)["designLanguage"]
    assert language != "neutral"
    assert document["metadata"]["designLanguage"]["id"] == language


def _box(element):
    t = element["transform"]
    return t["x"], t["y"], t["x"] + t["width"], t["y"] + t["height"]


@pytest.mark.parametrize("template_id", ALL_TEMPLATES)
def test_no_language_puts_text_over_text(template_id):
    """Motifs sit under words on purpose; words never sit on words."""
    document = template_compose.compose_template(template_id)
    for slide in document["slides"]:
        texts = [
            element for element in _walk(slide["elements"])
            if element["type"] == "text" and element.get("semanticRole") != "decoration"
        ]
        for i, a in enumerate(texts):
            ax0, ay0, ax1, ay1 = _box(a)
            for b in texts[i + 1:]:
                bx0, by0, bx1, by1 = _box(b)
                overlap = min(ax1, bx1) - max(ax0, bx0) > 1 and min(ay1, by1) - max(ay0, by0) > 1
                assert not overlap, (template_id, slide.get("name"), a.get("semanticRole"), b.get("semanticRole"), _box(a), _box(b))


@pytest.mark.parametrize("template_id", ALL_TEMPLATES)
def test_nothing_a_language_draws_leaves_the_slide(template_id):
    document = template_compose.compose_template(template_id)
    for slide in document["slides"]:
        for element in _walk(slide["elements"]):
            box = element["transform"]
            assert box["x"] >= 0 and box["y"] >= 0, (template_id, element.get("name"), box)
            assert box["x"] + box["width"] <= VIEWPORT_W + 0.01, (template_id, element.get("name"), box)
            assert box["y"] + box["height"] <= VIEWPORT_H + 0.01, (template_id, element.get("name"), box)


def _signature(slide):
    """What a slide is made of and where its headline sits: the grammar, not the colour."""
    headline = next(element for element in _walk(slide["elements"]) if element.get("semanticRole") == "headline")
    shapes = sorted(element.get("name", "") for element in _walk(slide["elements"]) if element["type"] == "shape")
    align = headline.get("paragraph", {}).get("align")
    return (shapes, align, round(headline["transform"]["x"]), round(headline["typography"]["fontSize"]))


def test_each_language_composes_the_same_plan_differently():
    plan = SlidePlan(layout=SlideLayout.TITLE, purpose="Open", key_message="Focus wins", headline="Focus wins", eyebrow="01", subtitle="A brief")
    signatures = {language: _signature(compose_slide(plan, 0, language)) for language in languages.LANGUAGE_LAYOUTS}
    # Nine languages, nine grammars: no two compose the title the same way.
    assert len(set(map(repr, signatures.values()))) == len(signatures), signatures
    assert "Signal disc" in signatures["swiss-signal"][0]
    assert "Letterbox top" in signatures["cinema-noir"][0]
    assert signatures["cinema-noir"][1] == "center"
    assert signatures["swiss-signal"][1] == "left"


@pytest.mark.parametrize("layout", [SlideLayout.BULLETS, SlideLayout.METRICS, SlideLayout.QUOTE, SlideLayout.SPLIT])
def test_each_language_composes_every_layout_differently(layout):
    plan = SlidePlan(
        layout=layout, purpose="Check", key_message="Three moves", headline="Three moves", eyebrow="02",
        body="A body paragraph.", bullets=["One", "Two", "Three"], quote="A quotation.", attribution="Someone",
        metrics=[{"value": "62%", "label": "faster"}, {"value": "3", "label": "teams"}],
    )
    shapes = {language: tuple(sorted(e.get("name", "") for e in _walk(compose_slide(plan, 0, language)["elements"]) if e["type"] == "shape")) for language in languages.LANGUAGE_LAYOUTS}
    named = {language: names for language, names in shapes.items() if language != "neutral"}
    assert len(set(named.values())) == len(named), named


@pytest.mark.parametrize("layout", list(SlideLayout))
def test_every_layout_composes_in_every_language(layout):
    plan = SlidePlan(
        layout=layout,
        purpose="Check",
        key_message="A short headline",
        headline="A short headline",
        eyebrow="01",
        subtitle="A subtitle",
        body="A body paragraph.",
        bullets=["One", "Two", "Three", "Four", "Five"],
        quote="A quotation.",
        attribution="Someone",
        caption="A caption",
        metrics=[{"value": "62%", "label": "faster"}, {"value": "3", "label": "teams"}],
        code="print('hi')",
    )
    for language in languages.LANGUAGE_LAYOUTS:
        slide = compose_slide(plan, 0, language)
        assert slide["elements"], (language, layout)


def test_a_language_with_no_geometry_is_refused_by_name():
    with pytest.raises(languages.UnknownLanguage, match="not a design language"):
        compose_slide(SlidePlan(layout=SlideLayout.TITLE, purpose="x", key_message="x", headline="x"), 0, "vaporwave")


def test_a_preview_carries_its_language_version_and_keys_on_it(monkeypatch):
    template_compose.PREVIEWS.clear()
    body, _ = template_compose.preview("noir-case-file", theme_key=None, content=None, slides="cover")
    assert body["language_version"] == presets.language_version("cinema-noir")
    before = template_compose.preview_key("noir-case-file", None, "cover")
    monkeypatch.setattr(template_compose, "template_language_version", lambda template_id: 99)
    assert template_compose.preview_key("noir-case-file", None, "cover") != before
