"""Deterministic composition, for the neutral-language regression guard.

Design languages (UI audit 2026-10-10, unit 5) add geometry beside the
composer's own; the composer's own must not move. This composes every slide pattern's example in
the neutral language with ids from a counter and a fixed clock, and hashes the
canonical JSON, so "neutral is unchanged" is a byte comparison rather than a
belief.

Run as a script to (re)record `goldens/compose_neutral.json`. Re-recording is a
deliberate act after a reviewed change to the neutral look, never a way to make
the test pass.
"""

from __future__ import annotations

import hashlib
import json
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

GOLDEN = Path(__file__).resolve().parent / "goldens" / "compose_neutral.json"


@contextmanager
def deterministic() -> Iterator[None]:
    """Counter ids and a fixed clock, everywhere the composer reads them."""
    from deckastra_api import compose, ids, motion

    counter = {"n": 0}

    def fake_id(prefix: str) -> str:
        counter["n"] += 1
        return f"{prefix}_{counter['n']:026d}"

    patched = [(module, getattr(module, "new_id")) for module in (ids, compose, motion) if hasattr(module, "new_id")]
    original_now = compose._now
    try:
        for module, _ in patched:
            setattr(module, "new_id", fake_id)
        compose._now = lambda: "2026-10-10T00:00:00Z"
        yield
    finally:
        for module, original in patched:
            setattr(module, "new_id", original)
        compose._now = original_now


def digest(document: dict) -> str:
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def neutral_digests() -> dict[str, str]:
    """Every slide pattern's example, composed by the neutral composer and hashed.

    Until unit 7a this hashed the templates that composed in neutral; since then
    every template has a language, so the guard is anchored on the composer
    itself rather than on a catalog that has moved on. One single-slide deck per
    pattern, on one fixed theme and motion style, covers every base layout and
    every slot shape the patterns use.
    """
    from deckastra_api import presets
    from deckastra_api.compose import compose_document

    catalog = presets.catalog()
    theme, theme_id = presets.resolve_theme("neo-technical")
    out: dict[str, str] = {}
    for pattern, definition in sorted((catalog.get("patternDefinitions") or {}).items()):
        preset = {
            "name": f"Pattern {pattern}",
            "summary": definition.get("summary", ""),
            "motionStyle": "restrained",
            "slides": [{"key": pattern, "pattern": pattern, "purpose": definition.get("name", pattern), "slots": definition.get("exampleSlots") or {}}],
        }
        plan = presets.story_plan_from_preset(preset)
        with deterministic():
            document = compose_document(
                plan,
                instruction=f"Pattern: {pattern}",
                motion_plan=presets.motion_plan_from_preset(preset),
                theme_definition=theme,
                theme_id=theme_id,
            )
        out[pattern] = digest(document)
    return out


if __name__ == "__main__":
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(json.dumps(neutral_digests(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"recorded {GOLDEN}")
