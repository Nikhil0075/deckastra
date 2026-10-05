"""Checks outside the model: JSON integrity, response locale and bounded scope."""
from __future__ import annotations

import copy
import json
import re
from typing import Any


def load_json(text: str) -> Any:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON property; return each property once.")
            result[key] = value
        return result
    def constant(_):
        raise ValueError("Non-finite numbers are not valid JSON.")
    return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)


def require_locale(text: str, locale: str) -> None:
    """Reject an obvious wrong script; this is not a claim of language fluency."""
    scripts = {"hi": r"[\u0900-\u097f]", "mr": r"[\u0900-\u097f]",
               "ar": r"[\u0600-\u06ff]", "ja": r"[\u3040-\u30ff\u3400-\u9fff]",
               "zh": r"[\u3400-\u9fff]", "ko": r"[\uac00-\ud7af]",
               "ru": r"[\u0400-\u04ff]", "bn": r"[\u0980-\u09ff]",
               "ta": r"[\u0b80-\u0bff]", "te": r"[\u0c00-\u0c7f]"}
    pattern = scripts.get(locale.split("-")[0].lower())
    if pattern and len(re.findall(pattern, text)) < 2:
        raise ValueError(f"User-facing prose must use the requested locale {locale}; keep IDs and proper names unchanged.")


def walk_elements(elements):
    for element in elements:
        yield element
        yield from walk_elements(element.get("children", []))


def selected_element_ids(document, scope):
    """A selected group includes its descendants; a selected child stays narrow."""
    chosen, found = set(scope.get("element_ids", [])), set()
    wanted = set(scope.get("slide_ids", []))
    def walk(items, inherited=False):
        for element in items:
            selected = inherited or scope.get("kind") != "elements" or element["id"] in chosen
            if selected: found.add(element["id"])
            walk(element.get("children", []), selected)
    for slide in document.get("slides", []):
        if scope.get("kind") == "deck" or slide["id"] in wanted:
            walk(slide.get("elements", []))
    return found


def require_story_locale(plan, locale):
    """Check prose as well as headings; preserve original code and quotations."""
    data = plan.model_dump(mode="json") if hasattr(plan, "model_dump") else plan
    prose = [data.get("title", ""), data.get("narrative_arc", "")]
    for slide in data.get("slides", []):
        prose += [slide.get(key, "") for key in ("headline", "key_message", "eyebrow", "subtitle", "body", "caption", "speaker_notes")]
        prose += slide.get("bullets", [])
    for text in prose:
        if isinstance(text, str) and text.strip() and any(c.isalpha() for c in text):
            require_locale(text, locale)


def scoped_document(document: dict, scope: dict) -> dict:
    """Never show unselected slide content to a scoped tool. Do not mutate input."""
    kind = scope.get("kind")
    if kind not in {"deck", "slide", "elements"}:
        raise ValueError("Unknown requested scope.")
    result = copy.deepcopy(document)
    if kind == "deck":
        return result
    wanted = set(scope.get("slide_ids", []))
    available = {s["id"] for s in document.get("slides", [])}
    if not wanted or not wanted <= available:
        raise ValueError("Selected slides must exist and cannot be empty.")
    result["slides"] = [s for s in result["slides"] if s["id"] in wanted]
    if kind == "elements":
        ids = set(scope.get("element_ids", []))
        available_elements = {e["id"] for s in result["slides"] for e in walk_elements(s.get("elements", []))}
        if not ids or not ids <= available_elements:
            raise ValueError("Selected elements must exist on the requested slides.")
        def keep(elements):
            out = []
            for e in elements:
                if e["id"] in ids:
                    out.append(e)
                elif e.get("children"):
                    children = keep(e["children"])
                    if children:
                        # The group's transform is needed to interpret child placement.
                        out.append({k: v for k, v in e.items() if k in {"id", "type", "transform"}} | {"children": children})
            return out
        for s in result["slides"]:
            s["elements"] = keep(s.get("elements", []))
            for key in ("speakerNotes", "narration", "animations", "sounds", "transition", "extensions"):
                s.pop(key, None)
    # Deck-wide metadata and unrelated source material are not selected content.
    result.pop("metadata", None)
    references = set()
    def collect(value):
        if isinstance(value, dict):
            if isinstance(value.get("assetId"), str): references.add(value["assetId"])
            for child in value.values(): collect(child)
        elif isinstance(value, list):
            for child in value: collect(child)
    collect(result["slides"])
    result["assets"] = [a for a in result.get("assets", []) if a["id"] in references]
    for overlay in result.get("locales", {}).values():
        overlay["entries"] = {p: v for p, v in overlay.get("entries", {}).items()
                              if any(p.startswith(f"/slides/id:{sid}/") for sid in wanted)
                              and (kind != "elements" or any(f"/id:{eid}/" in p for eid in ids))}
    # Keep only sources cited by the selected slides, not arbitrary deck extensions.
    cited = set()
    def citations(value):
        if isinstance(value, dict):
            for k, v in value.items():
                if k in {"citationIds", "sourceIds", "deckastra.sourceIds"} and isinstance(v, list):
                    cited.update(x for x in v if isinstance(x, str))
                citations(v)
        elif isinstance(value, list):
            for v in value: citations(v)
    citations(result["slides"])
    sources = result.get("extensions", {}).get("deckastra.sources", [])
    result["extensions"] = {"deckastra.sources": [s for s in sources if s.get("id") in cited]}
    return result
