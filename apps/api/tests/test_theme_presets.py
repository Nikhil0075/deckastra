"""The theme gallery, as Python reads it (Design tab review, 2026-09-26).

The presets are defined once, in TypeScript, and emitted to
`generated/theme-presets.json`. This checks that artifact against the same
generated theme schema workspace themes are validated with, so an agent or the
composer offering a preset offers one the service would accept.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.schema import validate_theme  # noqa: E402

PRESETS = Path(__file__).resolve().parents[3] / "packages/presentation-schema/generated/theme-presets.json"


def test_every_preset_is_a_theme_the_service_accepts():
    presets = json.loads(PRESETS.read_text(encoding="utf-8"))["presets"]
    assert len(presets) >= 12
    for preset in presets:
        assert validate_theme(preset["theme"]) == [], preset["key"]


def test_the_named_styles_are_there():
    keys = {preset["key"] for preset in json.loads(PRESETS.read_text(encoding="utf-8"))["presets"]}
    assert {"flat", "neumorphism", "glassmorphism", "neo-brutalism", "bento", "skeuomorphic"} <= keys
