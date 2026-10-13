"""The V2 catalogue must create structural variety, not aliases with new names."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import presets, template_compose, variety  # noqa: E402
from deckastra_api.compose import compose_document  # noqa: E402
from deckastra_api.languages import apply_density  # noqa: E402
from deckastra_api.models import SlidePlan, StoryPlan  # noqa: E402
from deckastra_api.pattern_layouts_v2 import FAMILY_BUILDERS  # noqa: E402
from deckastra_api.schema import validate_document  # noqa: E402


def _signature(slide: dict) -> tuple:
    return tuple(
        (
            element.get("type"),
            round(float((element.get("transform") or {}).get("x", 0)) / 40),
            round(float((element.get("transform") or {}).get("y", 0)) / 40),
            round(float((element.get("transform") or {}).get("width", 0)) / 40),
            round(float((element.get("transform") or {}).get("height", 0)) / 40),
        )
        for element in slide.get("elements") or []
        if element.get("semanticRole") != "decoration"
    )


def test_catalog_has_twenty_real_structural_families():
    catalog = presets.public_catalog()
    definitions = catalog["patternDefinitions"]
    families = {definition["family"] for definition in definitions.values()}
    assert catalog["catalogVersion"] == 2
    assert len(families) >= 20
    assert set(FAMILY_BUILDERS).issubset(families)
    assert all(definition["previewKey"].startswith("v2.") for definition in definitions.values())


def test_pattern_id_accepts_the_camel_case_public_alias():
    plan = SlidePlan.model_validate({
        "layout": "bullets",
        "patternId": "roadmap",
        "purpose": "Show the sequence",
        "key_message": "Scale in stages",
        "headline": "Scale in stages",
        "bullets": ["Pilot — prove", "Launch — expand"],
    })
    assert plan.pattern_id == "roadmap"


def test_asterloop_is_eight_distinct_native_compositions():
    document = template_compose.compose_template("asterloop-energy")
    assert validate_document(document) == []
    assert len(document["slides"]) == 8
    families = [(slide.get("layout") or {}).get("family") for slide in document["slides"]]
    assert len(set(families)) == 8
    assert len({_signature(slide) for slide in document["slides"]}) == 8
    element_types = {element["type"] for slide in document["slides"] for element in slide["elements"]}
    assert "chart" in element_types
    assert "diagram" in element_types
    report = variety.report(document)
    assert report["structures"] == 8
    assert report["longest_run"] == 1
    assert report["warnings"] == []


def test_flagship_picture_fill_and_play_lab_depth_order_are_explicit():
    asterloop = template_compose.compose_template("asterloop-energy")
    number = next(
        element
        for element in asterloop["slides"][1]["elements"]
        if element.get("name") == "AsterLoop image number"
    )
    assert number["type"] == "text"
    assert number["pictureFill"]["assetId"] in {asset["id"] for asset in asterloop["assets"]}
    assert number["pictureFill"]["fit"] == "cover"

    play_lab = template_compose.compose_template("team-kickoff")
    cover_names = {element.get("name") for element in play_lab["slides"][0]["elements"]}
    assert "Play Lab hero frame" in cover_names
    assert "Play sun" not in cover_names


def test_every_pattern_composes_in_every_reviewed_language():
    catalog = presets.catalog()
    plans = [presets.slide_plan_from_pattern(pattern) for pattern in catalog["slidePatterns"]]
    languages = sorted({preset["designLanguage"] for preset in presets.public_catalog()["presets"]})
    for language in languages:
        story = StoryPlan(title="Pattern contact sheet", audience="", objective="", narrative_arc="", slides=plans)
        story, _ = apply_density(story, language)
        theme, theme_id = presets.resolve_theme(catalog["designLanguages"][language]["defaults"]["themeKey"])
        document = compose_document(
            story,
            theme_definition=theme,
            theme_id=theme_id,
            language=language,
            language_version=presets.language_version(language),
        )
        assert validate_document(document) == [], language
        # Several semantic patterns intentionally share one family, but the
        # actual contact sheet must still expose far more than the old seven.
        assert len({_signature(slide) for slide in document["slides"]}) >= 30, language
