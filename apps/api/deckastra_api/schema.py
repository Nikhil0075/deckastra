"""Validation against the generated JSON Schema.

The Python service does not carry its own model of a `.mydeck` document. It
validates against `packages/presentation-schema/generated/mydeck-document.schema.json`,
which is generated from the Zod definitions — one definition, one generated
artifact, two consumers. A hand-written Python mirror would drift within a week,
and the drift would surface as an agent producing documents the renderer rejects.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .paths import resource_root

# apps/api/deckastra_api/schema.py -> repo root
REPO_ROOT = resource_root()
SCHEMA_PATH = (
    REPO_ROOT / "packages" / "presentation-schema" / "generated" / "mydeck-document.schema.json"
)


class SchemaUnavailable(RuntimeError):
    """The generated artifact is missing. Actionable, because the fix is one command."""


@lru_cache(maxsize=1)
def document_validator() -> Draft202012Validator:
    if not SCHEMA_PATH.exists():
        raise SchemaUnavailable(
            f"{SCHEMA_PATH} is missing. Run: npm run schema:emit"
        )
    with SCHEMA_PATH.open(encoding="utf-8") as handle:
        return Draft202012Validator(json.load(handle))


def validate_document(document: dict[str, Any], *, limit: int = 12) -> list[str]:
    """Return human-readable errors, empty when the document is valid.

    Every error is reported rather than only the first: a composition bug usually
    produces a cluster, and fixing them one round-trip at a time is slow.
    """
    errors = sorted(
        document_validator().iter_errors(document), key=lambda e: list(e.absolute_path)
    )

    out: list[str] = []
    for error in errors[:limit]:
        location = "/" + "/".join(str(part) for part in error.absolute_path)
        out.append(f"{location}: {error.message}")

    if len(errors) > limit:
        out.append(f"... and {len(errors) - limit} more")
    return out


THEME_SCHEMA_PATH = (
    REPO_ROOT / "packages" / "presentation-schema" / "generated" / "mydeck-theme.schema.json"
)


@lru_cache(maxsize=1)
def theme_validator() -> Draft202012Validator:
    if not THEME_SCHEMA_PATH.exists():
        raise SchemaUnavailable(f"{THEME_SCHEMA_PATH} is missing. Run: npm run schema:emit")
    with THEME_SCHEMA_PATH.open(encoding="utf-8") as handle:
        return Draft202012Validator(json.load(handle))


def validate_theme(theme: dict[str, Any], *, limit: int = 12) -> list[str]:
    """Errors in a workspace theme, empty when it is valid.

    Against the generated artifact, like everything else. A workspace theme is
    the same `ThemeDefinition` a document embeds, so validating it with a second
    hand-written check would be the drift the generated-downward pipeline exists
    to prevent.
    """
    errors = sorted(theme_validator().iter_errors(theme), key=lambda e: list(e.absolute_path))

    out: list[str] = []
    for error in errors[:limit]:
        location = "/" + "/".join(str(part) for part in error.absolute_path)
        out.append(f"{location}: {error.message}")

    if len(errors) > limit:
        out.append(f"... and {len(errors) - limit} more")
    return out
