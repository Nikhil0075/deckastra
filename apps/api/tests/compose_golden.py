"""Deterministic composition, for the neutral-language regression guard.

Design languages (UI audit 2026-10-10, unit 5) add geometry beside the
composer's own; the composer's own must not move. This composes every reviewed
template with ids from a counter and a fixed clock, and hashes the canonical
JSON, so "neutral is unchanged" is a byte comparison rather than a belief.

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
    """Every reviewed template in the neutral language, composed and hashed."""
    from deckastra_api import presets, template_compose

    out: dict[str, str] = {}
    for preset in presets.public_catalog()["presets"]:
        if preset.get("designLanguage", "neutral") != "neutral":
            continue
        with deterministic():
            document = template_compose.compose_template(preset["id"])
        out[preset["id"]] = digest(document)
    return out


if __name__ == "__main__":
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(json.dumps(neutral_digests(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"recorded {GOLDEN}")
