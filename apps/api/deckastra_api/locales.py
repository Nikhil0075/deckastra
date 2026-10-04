"""Language overlays, read from Python (integration plan 01 §3.1).

The overlay model is defined once, in `packages/presentation-schema/src/locales.ts`.
Python needs three answers from it to translate a deck on the server: which text
slots a document has, what the allowlist of slot paths is, and the fingerprint an
entry keeps of the source text it translated. A translation written against a
different idea of either would land outdated.

So the parts that are *data* come down the generated pipeline — the allowlist
patterns and hash samples live in `generated/locale-rules.json` under the drift
gate — and the one part that is code, walking a document for its slots, is
written twice and held to one answer by `tests/test_locale_conformance.py`,
which runs the TypeScript enumeration over every fixture and compares. That is
the rule the patch appliers follow, for the same reason: a second
implementation is tolerable only when something fails the build the day it
drifts.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator

from .paths import resource_root

RULES_PATH = resource_root() / "packages" / "presentation-schema" / "generated" / "locale-rules.json"


@lru_cache(maxsize=1)
def _rules() -> dict[str, Any]:
    with Path(RULES_PATH).open(encoding="utf-8") as handle:
        return json.load(handle)


@lru_cache(maxsize=1)
def localizable_patterns() -> list[re.Pattern[str]]:
    return [re.compile(source) for source in _rules()["localizablePathPatterns"]]


def is_localizable_path(path: str) -> bool:
    return any(pattern.match(path) for pattern in localizable_patterns())


def sound_library() -> list[str]:
    return list(_rules()["soundLibrary"])


# ------------------------------------------------------------------- hashes


def text_content(value: Any) -> str:
    """Plain text of a slot: a string as it is, rich text's spans joined, blocks by newline."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        blocks = value.get("blocks") or []
        return "\n".join("".join(str(span.get("text", "")) for span in (block.get("spans") or [])) for block in blocks)
    return ""


def text_hash(value: Any) -> str:
    """FNV-1a 64 over the UTF-8 of the slot's plain text (`localeTextHash` in TypeScript)."""
    data = text_content(value).encode("utf-8")
    hashed = 0xCBF29CE484222325
    for byte in data:
        hashed ^= byte
        hashed = (hashed * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"fnv1a64:{hashed:016x}"


# -------------------------------------------------------------------- slots


@dataclass(frozen=True)
class Slot:
    path: str
    kind: str  # "rich" | "string" | "either"
    value: Any
    slide_id: str | None = None
    element_id: str | None = None


def _is_rich(value: Any) -> bool:
    return isinstance(value, dict) and value.get("version") == 1 and isinstance(value.get("blocks"), list)


def _escape(segment: str) -> str:
    return segment.replace("~", "~0").replace("/", "~1")


def locale_slots(document: dict[str, Any]) -> list[Slot]:
    """Every text slot, in document order, id-addressed. Mirrors `localeSlots`."""
    out: list[Slot] = []

    def push(path: str, kind: str, value: Any, slide_id: str | None = None, element_id: str | None = None) -> None:
        if not (isinstance(value, str) or _is_rich(value)):
            return
        if kind == "string" and not isinstance(value, str):
            return
        if kind == "rich" and isinstance(value, str):
            return
        out.append(Slot(path, kind, value, slide_id, element_id))

    push("/metadata/title", "string", (document.get("metadata") or {}).get("title"))
    for slide in document.get("slides") or []:
        slide_path = f"/slides/id:{slide['id']}"
        push(f"{slide_path}/speakerNotes", "either", slide.get("speakerNotes"), slide["id"])
        for element, path in _walk(slide.get("elements") or [], f"{slide_path}/elements"):
            for sub_path, kind, value in _element_slots(element, path):
                push(sub_path, kind, value, slide["id"], element["id"])
        narration = slide.get("narration") or {}
        for cue in narration.get("cues") or []:
            push(f"{slide_path}/narration/cues/id:{cue['id']}/text", "string", cue.get("text"), slide["id"])
    return out


def _walk(elements: list[dict[str, Any]], container: str) -> Iterator[tuple[dict[str, Any], str]]:
    for element in elements:
        path = f"{container}/id:{element['id']}"
        yield element, path
        if element.get("type") == "group" and isinstance(element.get("children"), list):
            yield from _walk(element["children"], f"{path}/children")


_NUMERIC = re.compile(r"^[\s\d.,%+\-]*$")


def _element_slots(element: dict[str, Any], path: str) -> Iterator[tuple[str, str, Any]]:
    kind = element.get("type")
    if kind == "text":
        yield f"{path}/content", "rich", element.get("content")
    elif kind == "shape":
        yield f"{path}/text", "rich", element.get("text")
    elif kind == "line":
        yield f"{path}/label", "rich", element.get("label")
    elif kind == "audio":
        yield f"{path}/transcript", "string", element.get("transcript")
    elif kind == "chart":
        style = element.get("chartStyle") or {}
        yield f"{path}/chartStyle/axisX/title", "string", (style.get("axisX") or {}).get("title")
        yield f"{path}/chartStyle/axisY/title", "string", (style.get("axisY") or {}).get("title")
        data = element.get("data") or {}
        encoding = element.get("encoding") or {}
        if data.get("type") == "inline" and isinstance(data.get("rows"), list):
            keys: list[str] = []
            for key in (encoding.get("category"), encoding.get("series")):
                if isinstance(key, str) and key not in keys:
                    keys.append(key)
            for index, row in enumerate(data["rows"]):
                for key in keys:
                    cell = (row or {}).get(key)
                    if isinstance(cell, str) and not _NUMERIC.match(cell):
                        yield f"{path}/data/rows/{index}/{_escape(key)}", "string", cell
    elif kind == "table":
        for column in element.get("columns") or []:
            yield f"{path}/columns/id:{column['id']}/label", "string", column.get("label")
        for row in element.get("rows") or []:
            for index, cell in enumerate(row.get("cells") or []):
                yield f"{path}/rows/id:{row['id']}/cells/{index}/content", "either", (cell or {}).get("content")
    elif kind == "diagram":
        for node in element.get("nodes") or []:
            yield f"{path}/nodes/id:{node['id']}/label", "string", node.get("label")
            yield f"{path}/nodes/id:{node['id']}/sublabel", "string", node.get("sublabel")
        for edge in element.get("edges") or []:
            yield f"{path}/edges/id:{edge['id']}/label", "string", edge.get("label")
        for group in element.get("groups") or []:
            yield f"{path}/groups/id:{group['id']}/label", "string", group.get("label")
    yield f"{path}/altText", "string", element.get("altText")
    yield f"{path}/metadata/altText", "string", (element.get("metadata") or {}).get("altText")


# ------------------------------------------------------------------ helpers


def source_locale(document: dict[str, Any]) -> str:
    language = (document.get("metadata") or {}).get("language")
    return language if isinstance(language, str) and language else "en"


def same_language(a: str, b: str) -> bool:
    return a.lower() == b.lower()


def entry_path(locale: str, slot_path: str) -> str:
    return f"/locales/{_escape(locale)}/entries/{_escape(slot_path)}"


def worth_translating(value: Any) -> bool:
    """Words, not just digits and punctuation (`isWorthTranslating`)."""
    return any(ch.isalpha() for ch in text_content(value))


LOCALE_TAG = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$")


def valid_locale(locale: str) -> bool:
    return bool(LOCALE_TAG.match(locale))


def script_entry(document: dict[str, Any], slide_id: str, cue: dict[str, Any], locale: str) -> str:
    """The script a cue has in one language: the overlay's words, or the source."""
    if same_language(locale, source_locale(document)):
        return str(cue.get("text") or "")
    entry = (((document.get("locales") or {}).get(locale) or {}).get("entries") or {}).get(
        f"/slides/id:{slide_id}/narration/cues/id:{cue['id']}/text"
    )
    value = (entry or {}).get("value")
    return value if isinstance(value, str) else str(cue.get("text") or "")
