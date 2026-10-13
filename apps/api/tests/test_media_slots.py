"""What each picture frame is for (template media slots, 2026-10-13).

Every frame a composed slide draws must say what belongs in it, the
geometry-derived parts (orientation, text-safe area, focal region, mask) must
come from the slide as composed, and every picture a template ships must suit
the slot it fills: the wrong way round is a crop that takes most of it away.
"""

from __future__ import annotations

import pytest

from deckastra_api import media_slots, preset_media, presets, template_compose
from deckastra_api.compose import compose_document
from deckastra_api.models import StoryPlan
from deckastra_api.schema import validate_document


def _plan(*slides: dict) -> StoryPlan:
    return StoryPlan.model_validate({"title": "T", "audience": "", "objective": "", "narrative_arc": "", "slides": list(slides)})


def _frames(document: dict) -> list[tuple[dict, dict]]:
    return [
        (slide, element)
        for slide in document["slides"]
        for element in slide["elements"]
        if element.get("type") == "shape" and element.get("name") in preset_media.FRAME_NAMES
    ]


def test_every_frame_in_every_template_says_what_it_is_for():
    seen = 0
    for preset in presets.catalog()["presets"]:
        document = template_compose.compose_template(preset["id"])
        assert validate_document(document) == [], preset["id"]
        for _slide, frame in _frames(document):
            seen += 1
            slot = frame.get("mediaSlot")
            assert slot, f"{preset['id']}: {frame['name']} has no media slot"
            assert slot["role"] in ("background", "subject", "product", "texture", "detail")
            assert slot["orientation"] in ("portrait", "landscape", "square")
    assert seen > 20, "the check looked at too few frames to mean anything"


def test_a_full_bleed_photograph_keeps_its_words_side_calm_and_its_subject_opposite():
    plan = presets.slide_plan_from_pattern("full-bleed-photo")
    document = compose_document(_plan(plan.model_dump(mode="json")))
    _slide, frame = _frames(document)[0]
    slot = frame["mediaSlot"]
    assert slot["role"] == "background" and slot["layerRole"] == "background"
    safe = slot["textSafeArea"]
    assert 0 < safe["width"] <= 1 and 0 < safe["height"] <= 1
    # The subject stands on the side the words leave free.
    centre = safe["x"] + safe["width"] / 2
    if safe["width"] < 0.8:
        assert (slot["focalRegion"]["x"] > 0.5) == (centre <= 0.5)


def test_a_language_says_how_its_photographs_are_graded():
    frame = {"type": "shape", "name": "Image frame", "shape": "rectangle", "transform": {"x": 0, "y": 0, "width": 1920, "height": 1080}}
    assert media_slots.slot_for(frame, {"elements": [frame]}, "cinema-noir")["treatmentPreset"] == "mono"
    assert "treatmentPreset" not in media_slots.slot_for(frame, {"elements": [frame]}, "neutral")


def test_a_pill_frame_in_portrait_is_an_arch_and_a_portrait_frame_wants_a_person():
    arch = {"type": "shape", "name": "Arch frame", "shape": "pill", "transform": {"x": 100, "y": 100, "width": 600, "height": 900}}
    assert media_slots.slot_for(arch, {"elements": [arch]}, "earth-story")["mask"] == "arch"
    portrait = {"type": "shape", "name": "Portrait frame", "shape": "rectangle", "transform": {"x": 100, "y": 100, "width": 600, "height": 900}}
    slot = media_slots.slot_for(portrait, {"elements": [portrait]}, "quiet-luxe")
    assert slot["role"] == "subject" and slot["layerRole"] == "subject" and "person" in slot["subject"]


def test_a_shape_that_is_not_a_frame_gets_no_slot_and_a_slot_set_by_hand_is_kept():
    card = {"type": "shape", "name": "Card", "shape": "rectangle", "transform": {"x": 0, "y": 0, "width": 100, "height": 100}}
    own = {"role": "texture"}
    framed = {"type": "shape", "name": "Image frame", "shape": "rectangle", "mediaSlot": own, "transform": {"x": 0, "y": 0, "width": 100, "height": 100}}
    slide = media_slots.annotate({"elements": [card, framed]}, "neutral")
    assert "mediaSlot" not in slide["elements"][0]
    assert slide["elements"][1]["mediaSlot"] is own


#: Template pictures that fill a frame the wrong way round, cropped to well
#: under half their height. Listed with the reason so the list can only
#: shrink: a new one fails, and so does fixing one without removing it here.
KNOWN_MISFITS = {
    # Earth Story and Quiet Luxe ship portrait scene pictures, made for their
    # arch and portrait frames, which these templates also put in a landscape
    # image frame. A landscape scene picture for each is the fix.
    ("customer-case-study", "earth-customer-case-study-scene.jpg"),
    ("wedding-story", "luxe-wedding-story-scene.jpg"),
}


def _orientation(width: float, height: float) -> str:
    ratio = width / height
    return "square" if 0.9 <= ratio <= 1.1 else "landscape" if ratio > 1 else "portrait"


def test_no_template_picture_fills_its_frame_the_wrong_way_round():
    found: set[tuple[str, str]] = set()
    for preset in presets.catalog()["presets"]:
        document = template_compose.compose_template(preset["id"])
        assets = {asset["id"]: asset for asset in document.get("assets", [])}
        for slide in document["slides"]:
            elements = slide["elements"]
            for index, frame in enumerate(elements):
                slot = frame.get("mediaSlot") if frame.get("type") == "shape" else None
                picture = elements[index + 1] if index + 1 < len(elements) else None
                if not slot or not picture or picture.get("type") != "image" or picture.get("assetId") not in assets:
                    continue
                asset = assets[picture["assetId"]]
                shape = _orientation(asset["width"], asset["height"])
                if {shape, slot["orientation"]} == {"portrait", "landscape"}:
                    found.add((preset["id"], asset["fileName"]))
                # A cut-out slot needs a transparent picture, never a photograph.
                if slot.get("transparentRequired"):
                    assert asset.get("hasAlpha") is True, f"{preset['id']}: {asset['fileName']} fills a cut-out slot without transparency"
    assert found - KNOWN_MISFITS == set(), "a template picture fills its frame the wrong way round"
    assert KNOWN_MISFITS - found == set(), "a known misfit is fixed: remove it from KNOWN_MISFITS"


@pytest.mark.parametrize("role", ["background", "subject", "product", "texture", "detail"])
def test_every_slot_role_validates(role):
    plan = presets.slide_plan_from_pattern("full-bleed-photo")
    document = compose_document(_plan(plan.model_dump(mode="json")))
    _frames(document)[0][1]["mediaSlot"]["role"] = role
    assert validate_document(document) == []
