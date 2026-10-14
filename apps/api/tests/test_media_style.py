import copy

import json
import re
from pathlib import Path

from deckastra_api.media_style import TREATMENT_PRESETS, compose_media_prompt, deck_treatment
from deckastra_api import presets


def document():
    return {
        "viewport": {"width": 1920, "height": 1080},
        "metadata": {"designLanguage": {"id": "cinema-noir", "version": 1}},
        "theme": {
            "colors": {"background": "#14213D", "accent": "#E76F51", "foreground": "#FFFFFF"},
            "modes": {"light": {"colors": {"background": "#F5F3EE", "foreground": "#222222"}}},
        },
        "slides": [{
            "id": "sld_one",
            "elements": [
                {"id": "el_text", "type": "text", "transform": {"x": 80, "y": 100, "width": 500, "height": 240}},
                {"id": "el_frame", "type": "shape", "transform": {"x": 900, "y": 80, "width": 800, "height": 900},
                 "mediaSlot": {"role": "subject", "focalRegion": {"x": .75, "y": .5},
                               "textSafeArea": {"x": 0, "y": 0, "width": .35, "height": 1}, "treatmentPreset": "mono"}},
            ],
        }],
    }


def test_deck_prompt_is_deterministic_and_exposes_sources():
    first = compose_media_prompt(document(), "sld_one", "A cellist on stage", kind="image", style_source="deck")
    second = compose_media_prompt(copy.deepcopy(document()), "sld_one", "A cellist on stage", kind="image", style_source="deck")
    assert first == second
    assert [part["source"] for part in first["parts"]] == ["subject", "composition", "palette", "language", "treatment", "always"]
    assert "deep navy #14213D" in first["prompt"]
    assert "low-key light" in first["prompt"]


def test_prompt_mode_keeps_fit_rules_without_borrowing_the_look():
    result = compose_media_prompt(document(), "sld_one", "A cellist on stage", kind="image", style_source="prompt")
    assert [part["source"] for part in result["parts"]] == ["subject", "composition", "always"]
    assert "#14213D" not in result["prompt"]
    assert "low-key light" not in result["prompt"]
    assert "words will sit there" in result["prompt"]


def test_slide_mode_changes_the_palette_and_no_frame_uses_slide_shape():
    value = document()
    value["slides"][0]["colorMode"] = "light"
    value["slides"][0]["elements"] = value["slides"][0]["elements"][:1]
    result = compose_media_prompt(value, "sld_one", "Clouds over a city", kind="video", style_source="deck")
    assert "#F5F3EE" in result["prompt"] and "#222222" in result["prompt"]
    assert result["aspect_ratio"] == "16:9"
    assert "words will sit there" in result["prompt"]
    assert any(part["source"] == "camera" for part in result["parts"])


def test_every_language_has_provider_neutral_imagery_words():
    colour_names = {"red", "blue", "green", "yellow", "orange", "violet", "magenta", "coral", "navy", "white", "black"}
    for language in presets.catalog()["designLanguages"].values():
        words = language["imagery"]["promptWords"]
        assert words
        assert not colour_names.intersection(" ".join(words).lower().replace("-", " ").split())


def test_duotone_shadows_take_the_darker_colour_on_either_theme():
    # Dark theme: the background is the darker colour.
    dark = document()
    assert deck_treatment(dark, "sld_one", "duotone") == {"duotone": ["token:colors.background", "token:colors.accent"]}
    # Light colour mode on the same slide: the text is darker, and a background
    # in the shadows would turn the picture into a negative.
    light = document()
    light["slides"][0]["colorMode"] = "light"
    assert deck_treatment(light, "sld_one", "duotone") == {"duotone": ["token:colors.foreground", "token:colors.accent"]}
    assert deck_treatment(dark, "sld_one", "none") is None
    assert deck_treatment(dark, "sld_one", None) is None


def test_treatment_presets_are_the_editors_looks():
    # A second copy of the inspector's numbers is held to the first, so a look
    # tuned in the editor cannot drift from what Match the deck applies.
    source = (Path(__file__).resolve().parents[3] / "packages/editor-ui/src/lib/image-treatment.ts").read_text(encoding="utf-8")
    editor = {}
    for name, body in re.findall(r'value: "(mono|faded|dramatic|film)",[^\n]*?treatment: \{([^}]*)\}', source):
        editor[name] = {key: float(value) for key, value in re.findall(r"(\w+): (-?[\d.]+)", body)}
    assert set(editor) == set(TREATMENT_PRESETS)
    for name, values in TREATMENT_PRESETS.items():
        assert {key: float(value) for key, value in values.items()} == editor[name], name
