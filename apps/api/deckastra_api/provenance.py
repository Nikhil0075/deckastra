"""Read source evidence embedded in a presentation document (doc 02 §30)."""

from __future__ import annotations

from typing import Any


def for_slide(document: dict[str, Any], slide_id: str) -> list[dict[str, Any]]:
    """Every record for anything on a slide.

    The slide-level view: a user clicks a slide, not an element id.
    """
    slide = next(
        (candidate for candidate in (document.get("slides") or []) if candidate.get("id") == slide_id),
        None,
    )
    if slide is None:
        return []

    ids: set[str] = set()

    def walk(elements: list[dict[str, Any]]) -> None:
        for element in elements:
            ids.add(element.get("id", ""))
            if element.get("type") == "group":
                walk(element.get("children") or [])

    walk(slide.get("elements") or [])

    return [
        record
        for record in (document.get("provenance") or [])
        if record.get("targetId") in ids
    ]
