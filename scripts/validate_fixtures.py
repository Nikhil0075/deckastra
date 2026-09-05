#!/usr/bin/env python3
"""Validate the seed fixtures from Python against the generated JSON Schema.

This is the cross-language half of the Phase 0 exit criteria. The point is not
that Python can parse JSON — it is that the Python service and the TypeScript
packages agree on what a valid `.mydeck` document is.

The way they agree matters. There is no hand-written Python model of the schema
here, and there must never be one: Python validates against
`packages/presentation-schema/generated/*.schema.json`, which is generated from
the Zod definitions. One definition, one generated artifact, two consumers. A
second hand-maintained model would drift within a week and the drift would surface
as an agent emitting documents the renderer rejects.

Pydantic request models for FastAPI arrive in Phase 1. When they do, they are
generated from this same artifact, not written by hand.

    python scripts/validate_fixtures.py
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError:  # pragma: no cover - environment guidance, not logic
    sys.exit(
        "jsonschema is required.\n"
        "  pip install jsonschema\n"
        "It is listed in requirements-dev.txt."
    )

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "packages" / "presentation-schema" / "generated"
FIXTURE_DIR = ROOT / "packages" / "presentation-schema" / "fixtures"

DOCUMENT_SCHEMA = SCHEMA_DIR / "mydeck-document.schema.json"


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)



# A validator that accepts everything passes every fixture too. These cases exist
# so that a generated schema which has quietly lost its constraints - through a
# lossy emit, an over-permissive additionalProperties, or a regression in the
# generator - fails loudly here instead of silently letting an agent ship
# documents the renderer will reject.
NEGATIVE_CASES: list[tuple[str, str]] = [
    ("missing required top-level property", "delete-viewport"),
    ("zero-size element", "zero-width"),
    ("malformed id", "bad-slide-id"),
    ("chart palette below the six-series minimum", "short-chart-series"),
    ("opacity outside 0..1", "opacity-out-of-range"),
    ("unparseable schemaVersion", "bad-semver"),
]


def corrupt(document: dict, kind: str) -> dict:
    """Return a copy of `document` broken in one specific, named way."""
    broken = copy.deepcopy(document)
    if kind == "delete-viewport":
        broken.pop("viewport", None)
    elif kind == "zero-width":
        broken["slides"][0]["elements"][0]["transform"]["width"] = 0
    elif kind == "bad-slide-id":
        broken["slides"][0]["id"] = "not-an-id"
    elif kind == "short-chart-series":
        broken["theme"]["colors"]["chartSeries"] = ["#ffffff"]
    elif kind == "opacity-out-of-range":
        broken["slides"][0]["elements"][0]["opacity"] = 5
    elif kind == "bad-semver":
        broken["schemaVersion"] = "nope"
    else:  # pragma: no cover - guards against a typo in NEGATIVE_CASES
        raise ValueError(f"unknown corruption {kind!r}")
    return broken


def check_schema_has_teeth(validator: Draft202012Validator, document: dict) -> bool:
    """True when every deliberately-broken document is rejected."""
    all_rejected = True
    for label, kind in NEGATIVE_CASES:
        broken = corrupt(document, kind)
        if next(validator.iter_errors(broken), None) is None:
            all_rejected = False
            print(f"  LEAK  schema accepted an invalid document: {label}")
        else:
            print(f"  ok    rejects {label}")
    return all_rejected


def main() -> int:
    if not DOCUMENT_SCHEMA.exists():
        print(
            f"Missing {DOCUMENT_SCHEMA.relative_to(ROOT)}.\n"
            "Run: npm run schema:emit",
            file=sys.stderr,
        )
        return 1

    schema = load_json(DOCUMENT_SCHEMA)
    validator = Draft202012Validator(schema)

    fixtures = sorted(FIXTURE_DIR.glob("*.mydeck.json"))
    if not fixtures:
        print(
            f"No fixtures found in {FIXTURE_DIR.relative_to(ROOT)}.\n"
            "Run: npm run fixtures:build --workspace @deckastra/presentation-schema",
            file=sys.stderr,
        )
        return 1

    failed = False
    for fixture in fixtures:
        document = load_json(fixture)
        errors = sorted(validator.iter_errors(document), key=lambda e: list(e.absolute_path))

        if errors:
            failed = True
            print(f"  FAIL  {fixture.name}")
            # Report every error, not just the first: a schema mismatch usually
            # produces a cluster, and fixing them one round-trip at a time is slow.
            for error in errors[:20]:
                location = "/" + "/".join(str(part) for part in error.absolute_path)
                print(f"          {location}: {error.message}")
            if len(errors) > 20:
                print(f"          ... and {len(errors) - 20} more")
        else:
            slides = len(document.get("slides", []))
            print(f"  ok    {fixture.name} ({slides} slides)")

    if failed:
        print(
            "\nA fixture that validates in TypeScript but not in Python means the "
            "generated JSON Schema is stale or lossy.\n"
            'Regenerate with "npm run schema:emit" and re-run.',
            file=sys.stderr,
        )
        return 1

    print()
    reference = load_json(fixtures[-1])
    if not check_schema_has_teeth(validator, reference):
        print(
            "The generated schema accepted a document it should have rejected. "
            "It has lost constraints somewhere between the Zod definitions and "
            "the emitted artifact; do not trust it until this passes.",
            file=sys.stderr,
        )
        return 1

    print(
        f"{len(fixtures)} fixtures validate; "
        f"schema rejects all {len(NEGATIVE_CASES)} negative cases."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
