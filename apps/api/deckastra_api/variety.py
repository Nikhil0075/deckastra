"""How varied a deck's structure is, measured from the document (2026-10-11).

A review of agent-built decks found them converging on the same shape: card
rows and bullet lists, slide after slide, one transition throughout. Nothing in
the product said so. This measures it from what a deck *is*, so the same
numbers describe a composed deck, a template, and a deck an agent edited by
hand, and `deck_compose` can say "four bullet slides running" while the agent
is still there to change it.

Deterministic and model-free: a slide's structure is its composed layout where
the composer recorded one, and otherwise the kinds of thing on it.
"""

from __future__ import annotations

from typing import Any

#: Element types that make a slide carry evidence rather than words.
DATA_TYPES = {"chart", "diagram", "table", "image", "video"}

#: A run of this many slides with one structure is called out.
RUN_LIMIT = 3


def _walk(elements: list[dict[str, Any]]):
    for element in elements or []:
        yield element
        if element.get("type") == "group":
            yield from _walk(element.get("children") or [])


def structure(slide: dict[str, Any]) -> str:
    """The slide's shape: its pattern or layout when composed, else what it holds."""
    recorded_family = str((slide.get("layout") or {}).get("family") or "")
    if recorded_family:
        return recorded_family
    template = str((slide.get("layout") or {}).get("templateId") or "")
    if template.startswith("preset."):
        name = template.removeprefix("preset.")
        # A pattern is named for what it says ("process", "risks"); several
        # compose with one layout and look alike. Variety is about the look.
        from . import presets

        definition = (presets.catalog().get("patternDefinitions") or {}).get(name) or {}
        return str(definition.get("family") or definition.get("composerLayout") or name)
    kinds = sorted({str(e.get("type")) for e in _walk(slide.get("elements") or []) if e.get("type") != "group"})
    return "+".join(kinds) or "empty"


def _carries_data(slide: dict[str, Any]) -> bool:
    if any(e.get("type") in DATA_TYPES for e in _walk(slide.get("elements") or [])):
        return True
    # A photo slide's frame is a placeholder until a picture fills it; the
    # layout still committed to a photograph.
    return any(e.get("name") == "Image frame" for e in _walk(slide.get("elements") or []))


def report(document: dict[str, Any]) -> dict[str, Any]:
    slides = document.get("slides") or []
    shapes = [structure(slide) for slide in slides]
    longest, run, worst_at = 0, 0, 0
    for index, shape in enumerate(shapes):
        run = run + 1 if index and shape == shapes[index - 1] else 1
        if run > longest:
            longest, worst_at = run, index - run + 1
    transitions = [str((slide.get("transition") or {}).get("type") or "none") for slide in slides[1:]]
    data_slides = sum(1 for slide in slides if _carries_data(slide))
    warnings: list[str] = []
    if longest >= RUN_LIMIT:
        warnings.append(
            f"Slides {worst_at + 1}–{worst_at + longest} all use the {shapes[worst_at]} structure. "
            "Vary it: a chart, diagram, timeline, photograph, statement or quote breaks the run."
        )
    if len(slides) >= 6 and data_slides == 0:
        warnings.append("No slide carries a chart, diagram, table or picture; every claim is words.")
    if len(transitions) >= 5 and len(set(transitions)) == 1:
        warnings.append(f"Every slide enters with one transition ({transitions[0]}).")
    return {
        "slides": len(slides),
        "structures": len(set(shapes)),
        "longest_run": longest,
        "data_slides": data_slides,
        "transitions": len(set(transitions)),
        "warnings": warnings,
    }
