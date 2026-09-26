"""Duplicating a whole deck (editor Phase 4, the deck list's "Duplicate").

Ids are stable forever and never reused (CLAUDE.md, conventions), so a copy is
not the same JSON under a new title: every id the deck *defines* is replaced, and
every reference to one is rewritten to its replacement — across slides too, which
is exactly what a per-slide copy (`withFreshIds` in presentation-core) cannot do.
A morph on slide 4 names elements on slide 3; a jump-to-slide link names a slide
id; the Critic's unresolved issues are keyed by slide id. Remapped one slide at a
time, each of those would point back into the original deck.

The rule is generic on purpose, so a field added to the schema tomorrow is not a
reference this forgets:

- **What is remapped:** every value under an ``id`` key that is a ULID-shaped id,
  anywhere in the document *except* the asset manifest and the theme. Asset ids
  name stored files in this workspace and theme ids name workspace themes; both
  are shared with the original on purpose, and a copy that minted new ones would
  cite pictures and a theme that do not exist.
- **What is rewritten:** every string value, and every mapping key, equal to a
  remapped id. ULIDs are unique, so a string equal to one *is* a reference to
  it; there is no false positive to guard against.
"""

from __future__ import annotations

import copy
import re
from typing import Any

from .ids import new_id

#: `{prefix}_{ULID}` (doc 02 §0.2). Crockford base32: no I, L, O, U.
_ID = re.compile(r"^([a-z][a-z0-9]*)_[0-9A-HJKMNP-TV-Z]{26}$")

#: Top-level subtrees whose ids name things outside the document.
_SHARED = ("assets", "theme")


def duplicate_document(document: dict[str, Any], *, title: str) -> tuple[dict[str, Any], dict[str, str]]:
    """A deep copy with fresh ids, and the old-to-new map (for tests and callers
    that need to find something in the copy)."""
    copied = copy.deepcopy(document)
    remap: dict[str, str] = {}

    def collect(value: Any) -> None:
        if isinstance(value, dict):
            identifier = value.get("id")
            if isinstance(identifier, str):
                match = _ID.match(identifier)
                if match and identifier not in remap:
                    remap[identifier] = new_id(match.group(1))
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    # The document's own id, then everything below it except the shared subtrees.
    root_id = copied.get("id")
    if isinstance(root_id, str) and (match := _ID.match(root_id)):
        remap[root_id] = new_id(match.group(1))
    for key, value in copied.items():
        if key not in _SHARED and key != "id":
            collect(value)

    def rewrite(value: Any) -> Any:
        if isinstance(value, str):
            return remap.get(value, value)
        if isinstance(value, list):
            return [rewrite(child) for child in value]
        if isinstance(value, dict):
            return {remap.get(key, key): rewrite(child) for key, child in value.items()}
        return value

    duplicated = rewrite(copied)
    duplicated.setdefault("metadata", {})["title"] = title
    return duplicated, remap


def copy_title(title: str) -> str:
    """"Quarterly review" → "Quarterly review (copy)", within the title limit."""
    suffix = " (copy)"
    return (title.strip() or "Untitled presentation")[: 255 - len(suffix)] + suffix
