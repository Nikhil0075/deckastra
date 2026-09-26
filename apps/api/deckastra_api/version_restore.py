"""Restoring a past version (editor Phase 5, the version history drawer's
"Restore this version").

A restore is **an ordinary change**, not a rewind: it appends a transaction whose
operations take the current head to the chosen version, through the same applier,
validation, concurrency check and history as any edit. Nothing is deleted from
the version chain — "this deck was put back to how it was on Tuesday" is itself a
fact worth keeping — and the restore can be undone like any other change, because
its inverse is computed at apply time against the head it replaced.

The operations are **top-level replaces**, one per document key that differs.
Coarser than a structural diff on purpose: a diff that walked into slides would
emit index-addressed operations whose correctness depends on getting every move
right, while replacing `/slides` whole is obviously correct and produces exactly
the chosen version. Its inverse is equally whole, so undoing a restore puts back
exactly what was there.
"""

from __future__ import annotations

import json
from typing import Any

#: Never replaced: the document's identity is the deck's, and a restore that
#: rewrote it would detach the head from the presentation row.
_IMMUTABLE = frozenset({"id"})


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def restore_operations(head: dict[str, Any], target: dict[str, Any]) -> list[dict[str, Any]]:
    """The operations that turn `head` into `target`, one per top-level key that
    differs, in sorted key order so the same pair always yields the same patch.
    Empty when the two are already the same document."""
    operations: list[dict[str, Any]] = []
    for key in sorted((set(head) | set(target)) - _IMMUTABLE):
        path = "/" + key.replace("~", "~0").replace("/", "~1")
        if key not in target:
            operations.append({"op": "remove", "path": path})
        elif key not in head:
            operations.append({"op": "add", "path": path, "value": target[key]})
        elif _canonical(head[key]) != _canonical(target[key]):
            operations.append({"op": "replace", "path": path, "value": target[key]})
    return operations


def same_document(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return _canonical(a) == _canonical(b)
