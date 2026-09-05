"""Patch application in Python.

This is a **second implementation** of `@deckastra/transactions`, and that is
normally exactly the thing this project refuses to do — the schema is defined once
and generated downward precisely so nothing can drift.

It exists because the store replays operations to reconstruct a document from a
snapshot (doc 05 §22), and that replay happens server-side, in Python, on a read.
The alternatives were worse: snapshotting every version defeats the operation log,
and shelling out to Node on every read is not a serious design.

The duplication is made safe the only way duplication can be — by a conformance
test that runs generated patches through both implementations and asserts the
results are byte-identical (`tests/test_patch_conformance.py`). If the two ever
disagree, CI fails. Treat that test as part of this module: changing behaviour
here without changing it there is how drift starts.

Semantics follow doc 02 §31: id-addressed paths, atomic application, inverses
captured against the pre-state, inverses returned in reverse application order.
"""

from __future__ import annotations

import copy
from typing import Any

ID_PREFIX = "id:"
APPEND = "-"


class PatchError(Exception):
    """A patch that cannot be applied. Carries a catalog code from doc 02 §42."""

    def __init__(self, message: str, *, code: str = "E303", operation_index: int = -1, path: str | None = None):
        super().__init__(message)
        self.code = code
        self.operation_index = operation_index
        self.path = path


def split_path(path: str) -> list[str]:
    if path == "/":
        return []
    if not path.startswith("/"):
        raise PatchError(f'Patch paths start with "/": {path!r}', code="E301", path=path)
    return [segment.replace("~1", "/").replace("~0", "~") for segment in path[1:].split("/")]


def join_path(segments: list[Any]) -> str:
    return "/" + "/".join(
        str(segment).replace("~", "~0").replace("/", "~1") for segment in segments
    )


def _index_of_id(container: Any, target_id: str, path: str, segment: str) -> int:
    if not isinstance(container, list):
        raise PatchError(
            f'Segment "{segment}" addresses by id, but the value there is not an array.',
            code="E301",
            path=path,
        )

    for index, item in enumerate(container):
        if isinstance(item, dict) and item.get("id") == target_id:
            return index

    available = [item["id"] for item in container if isinstance(item, dict) and "id" in item]
    nearest = _nearest_id(target_id, available)
    hint = (
        f' Nearest existing id is "{nearest}".'
        if nearest
        else " The collection is empty." if not available else ""
    )
    raise PatchError(f'No element with id "{target_id}".{hint}', code="E301", path=path)


def _nearest_id(target: str, candidates: list[str]) -> str | None:
    """Longest shared prefix. Ids are ULIDs, so a shared prefix means created at
    about the same time — usually the sibling the caller meant."""
    best: str | None = None
    best_score = 0
    for candidate in candidates:
        score = 0
        while score < len(target) and score < len(candidate) and target[score] == candidate[score]:
            score += 1
        if score > best_score:
            best_score, best = score, candidate
    return best if best_score >= 4 else None


def _step_key(container: Any, segment: str, path: str, allow_missing: bool = False) -> Any:
    if segment.startswith(ID_PREFIX):
        return _index_of_id(container, segment[len(ID_PREFIX) :], path, segment)

    if isinstance(container, list):
        try:
            index = int(segment)
        except ValueError:
            raise PatchError(
                f'Segment "{segment}" indexes an array, so it must be a non-negative '
                f'integer or an "id:" reference.',
                code="E301",
                path=path,
            ) from None
        if index < 0:
            raise PatchError(f"Negative index {index}.", code="E301", path=path)
        if not allow_missing and index >= len(container):
            raise PatchError(
                f"Index {index} is out of range; the array holds {len(container)} item(s).",
                code="E301",
                path=path,
            )
        return index

    if not isinstance(container, dict):
        raise PatchError(
            f'Segment "{segment}" descends into a {type(container).__name__}, '
            f"which has no properties.",
            code="E301",
            path=path,
        )

    if not allow_missing and segment not in container:
        raise PatchError(f'Property "{segment}" does not exist at this path.', code="E301", path=path)

    return segment


class Resolved:
    __slots__ = ("parent", "key", "is_array", "concrete")

    def __init__(self, parent: Any, key: Any, is_array: bool, concrete: list[Any]) -> None:
        self.parent = parent
        self.key = key
        self.is_array = is_array
        self.concrete = concrete


def resolve_path(document: Any, path: str, *, allow_missing_leaf: bool = False) -> Resolved:
    segments = split_path(path)
    if not segments:
        raise PatchError("The root path cannot be the target of an operation.", code="E301", path=path)

    cursor: Any = document
    concrete: list[Any] = []

    # Intermediate structure is never created: silently materializing a missing
    # slide turns a typo into a data-shaped bug.
    for segment in segments[:-1]:
        key = _step_key(cursor, segment, path)
        concrete.append(key)
        cursor = cursor[key]
        if cursor is None:
            raise PatchError(
                f'Path stops resolving at segment "{segment}" — nothing exists there.',
                code="E301",
                path=path,
            )

    last = segments[-1]

    if last == APPEND:
        if not isinstance(cursor, list):
            raise PatchError(
                '"-" appends to an array, but the value at this path is not an array.',
                code="E301",
                path=path,
            )
        return Resolved(cursor, len(cursor), True, [*concrete, len(cursor)])

    key = _step_key(cursor, last, path, allow_missing_leaf)
    return Resolved(cursor, key, isinstance(cursor, list), [*concrete, key])


def _insert_at(array: list[Any], index: int, value: Any, path: str) -> None:
    """Insert with a bounds check.

    `list.insert` clamps out-of-range indices, so the operation would appear to
    succeed while the index recorded for the inverse points at a position that
    never existed. RFC 6902 allows index == length (append) and nothing beyond.
    """
    if index > len(array) or index < 0:
        raise PatchError(
            f"Cannot insert at index {index}; the array holds {len(array)} item(s).",
            code="E303",
            path=path,
        )
    array.insert(index, value)


def apply_patch(
    document: dict[str, Any], operations: list[dict[str, Any]]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Apply a patch. Returns (new document, inverse operations).

    Atomic: the work happens on a copy, which is only returned once every
    operation has succeeded.
    """
    draft = copy.deepcopy(document)
    inverse: list[dict[str, Any]] = []

    for index, operation in enumerate(operations):
        try:
            _apply_one(draft, operation, inverse)
        except PatchError as error:
            error.operation_index = index
            raise

    inverse.reverse()
    return draft, inverse


def _id_of(value: Any) -> str | None:
    """The id of a value, when it carries one."""
    if isinstance(value, dict):
        identifier = value.get("id")
        if isinstance(identifier, str):
            return identifier
    return None


def _apply_one(draft: Any, operation: dict[str, Any], inverse: list[dict[str, Any]]) -> None:
    op = operation.get("op")
    path = operation.get("path", "")

    if op == "test":
        resolved = _try_resolve(draft, path)
        actual = None if resolved is None else _read(resolved)
        if actual != operation.get("value"):
            raise PatchError(
                f"test failed at {path}: the document no longer holds the expected value. "
                f"Someone else changed it between the read and this write.",
                code="E302",
                path=path,
            )
        return

    if op == "add":
        resolved = resolve_path(draft, path, allow_missing_leaf=True)
        if resolved.is_array:
            _insert_at(resolved.parent, resolved.key, copy.deepcopy(operation["value"]), path)
            # The original path cannot be reused — it may have been "-" (append),
            # which names no position. Address the inverse by the added value's own
            # id where it has one, so removing it later finds the right item even
            # if siblings have shifted; fall back to the index otherwise.
            added_id = _id_of(operation["value"])
            inverse.append(
                {
                    "op": "remove",
                    "path": join_path([*resolved.concrete[:-1], f"id:{added_id}"])
                    if added_id
                    else join_path(resolved.concrete),
                }
            )
            return

        existed = resolved.key in resolved.parent
        previous = resolved.parent.get(resolved.key)
        resolved.parent[resolved.key] = copy.deepcopy(operation["value"])
        # `add` onto an existing key overwrites (RFC 6902), so its inverse restores
        # rather than removes.
        inverse.append(
            {"op": "replace", "path": path, "value": copy.deepcopy(previous)}
            if existed
            else {"op": "remove", "path": path}
        )
        return

    if op == "remove":
        resolved = resolve_path(draft, path)
        removed = copy.deepcopy(_read(resolved))
        if resolved.is_array:
            resolved.parent.pop(resolved.key)
        else:
            del resolved.parent[resolved.key]
        inverse.append({"op": "add", "path": join_path(resolved.concrete), "value": removed})
        return

    if op == "replace":
        resolved = resolve_path(draft, path)
        previous = copy.deepcopy(_read(resolved))
        resolved.parent[resolved.key] = copy.deepcopy(operation["value"])
        # Reuse the caller's path rather than the resolved indices. A replace moves
        # nothing, so the original path still addresses the same node — and if it
        # was id-addressed the inverse stays id-addressed, which keeps a deferred
        # undo from silently landing on whatever now occupies that index.
        inverse.append({"op": "replace", "path": path, "value": previous})
        return

    if op == "move":
        # Detach first, then resolve the destination against the shortened array.
        # Resolving both up front gives an off-by-one whenever source and
        # destination share a parent — the reorder case.
        source = resolve_path(draft, operation["from"])
        value = copy.deepcopy(_read(source))

        if source.is_array:
            source.parent.pop(source.key)
        else:
            del source.parent[source.key]

        destination = resolve_path(draft, path, allow_missing_leaf=True)
        if destination.is_array:
            _insert_at(destination.parent, destination.key, value, path)
        else:
            destination.parent[destination.key] = value

        inverse.append(
            {
                "op": "move",
                "from": join_path(destination.concrete),
                "path": join_path(source.concrete),
            }
        )
        return

    if op == "copy":
        source = resolve_path(draft, operation["from"])
        value = copy.deepcopy(_read(source))
        destination = resolve_path(draft, path, allow_missing_leaf=True)

        if destination.is_array:
            _insert_at(destination.parent, destination.key, value, path)
        else:
            destination.parent[destination.key] = value

        inverse.append({"op": "remove", "path": join_path(destination.concrete)})
        return

    raise PatchError(f'Unknown patch operation "{op}".', code="E303", path=path)


def _read(resolved: Resolved) -> Any:
    return resolved.parent[resolved.key]


def _try_resolve(document: Any, path: str) -> Resolved | None:
    try:
        return resolve_path(document, path, allow_missing_leaf=True)
    except PatchError:
        return None


def read_path(document: Any, path: str) -> Any:
    resolved = _try_resolve(document, path)
    if resolved is None:
        return None
    try:
        return _read(resolved)
    except (KeyError, IndexError):
        return None


def path_ids(path: str) -> list[str]:
    """Every id an "id:" segment of a path names, outermost first."""
    return [
        segment[len(ID_PREFIX) :]
        for segment in split_path(path)
        if segment.startswith(ID_PREFIX)
    ]


def operation_ids(operations: list[dict[str, Any]]) -> tuple[set[str], set[str]]:
    """(every id mentioned, innermost target ids) for a patch.

    Two sets, because the safe overlap rule needs both: see `disturbs` below.
    """
    mentioned: set[str] = set()
    targets: set[str] = set()

    for operation in operations:
        for key in ("path", "from"):
            path = operation.get(key)
            if not path:
                continue
            ids = path_ids(path)
            mentioned.update(ids)
            if ids:
                targets.add(ids[-1])

    return mentioned, targets


def disturbs(earlier: list[dict[str, Any]], later: list[dict[str, Any]]) -> set[str]:
    """Ids where `later` would make undoing `earlier` unsafe.

    The rule is asymmetric on purpose, and both halves are needed:

    * `later`'s target appearing anywhere in `earlier`'s paths catches
      containment — deleting a slide disturbs every edit made inside it.
    * `earlier`'s target appearing anywhere in `later`'s paths catches the
      reverse — a later edit reaching into what the earlier one changed.

    Comparing every mentioned id against every mentioned id would instead make any
    two edits on the same slide conflict, because both paths name the slide, which
    turns undo off in practice.
    """
    earlier_mentioned, earlier_targets = operation_ids(earlier)
    later_mentioned, later_targets = operation_ids(later)

    return (later_targets & earlier_mentioned) | (earlier_targets & later_mentioned)
