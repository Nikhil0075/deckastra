"""Presentation tools (doc 03 §15).

The set an agent needs to read a deck and propose a change to it. Note what is
absent: there is no `presentation.save`, no `presentation.applyPatch`. An agent
can build a patch and validate it; only the transaction service applies one
(doc 03 §2.2, §25). That boundary is the reason an agent cannot corrupt a
document even if its output is nonsense.

Every tool returning slide text marks itself `returns_untrusted_content`. Text on
a slide came from somewhere — a user typed it, a model wrote it, a repository
supplied it — and by the time an agent reads it back none of that is
distinguishable.
"""

from __future__ import annotations

from typing import Any, Callable

from ..envelope import Source
from .registry import ToolDefinition, ToolRegistry

#: Reused: nearly every tool here names a slide or an element.
_ID = {"type": "string", "minLength": 1}


def _text_of(node: Any) -> str:
    """Plain text of a rich-text document or a bare string."""
    if isinstance(node, str):
        return node
    if isinstance(node, dict) and isinstance(node.get("blocks"), list):
        return "\n".join(
            "".join(span.get("text", "") for span in block.get("spans", []) if isinstance(span, dict))
            for block in node["blocks"]
            if isinstance(block, dict)
        )
    return ""


def summarise_element(element: dict[str, Any]) -> dict[str, Any]:
    """What an agent needs to reason about an element, and nothing more.

    Context minimisation (doc 03 §23): handing an agent a whole element hands it
    resolved styling, animation timelines and metadata it will never use, and
    costs tokens on every call. Geometry is included because the Layout Agent
    reasons about relative position — it still never *emits* coordinates.
    """
    transform = element.get("transform", {})
    summary: dict[str, Any] = {
        "id": element.get("id", ""),
        "type": element.get("type", ""),
        "bounds": {
            "x": transform.get("x", 0),
            "y": transform.get("y", 0),
            "width": transform.get("width", 0),
            "height": transform.get("height", 0),
        },
    }
    if element.get("semanticRole"):
        summary["semanticRole"] = element["semanticRole"]
    if element.get("name"):
        summary["name"] = element["name"]

    text = _text_of(element.get("content") or element.get("text"))
    if text:
        summary["text"] = text

    if element.get("type") == "group":
        summary["children"] = [
            summarise_element(child) for child in element.get("children", [])
        ]

    return summary


def register_presentation_tools(
    registry: ToolRegistry,
    *,
    document_provider: Callable[[], dict[str, Any]],
    validate_patch: Callable[[list[dict[str, Any]]], dict[str, Any]],
) -> None:
    """Wire the presentation tools to a specific document.

    The document arrives through a provider rather than as a value so a tool
    called after an earlier patch sees the current state. Agents do not know
    about the database (doc 05 §17); they know about this callable.
    """

    def get_slide(payload: dict[str, Any]) -> dict[str, Any]:
        document = document_provider()
        slide_id = payload["slide_id"]
        for index, slide in enumerate(document.get("slides", [])):
            if slide.get("id") == slide_id:
                return {
                    "id": slide_id,
                    "index": index,
                    "name": slide.get("name", ""),
                    "key_message": slide.get("keyMessage", ""),
                    "elements": [summarise_element(e) for e in slide.get("elements", [])],
                }
        raise KeyError(f"No slide {slide_id}")

    registry.register(
        ToolDefinition(
            id="presentation.getSlide",
            description="Read one slide: its name, key message and a summary of every element on it.",
            input_schema={
                "type": "object",
                "properties": {"slide_id": _ID},
                "required": ["slide_id"],
                "additionalProperties": False,
            },
            output_schema={
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "index": {"type": "integer"},
                    "name": {"type": "string"},
                    "key_message": {"type": "string"},
                    "elements": {"type": "array"},
                },
                "required": ["id", "index", "elements"],
            },
            returns_untrusted_content=True,
        ),
        get_slide,
    )

    def get_outline(payload: dict[str, Any]) -> dict[str, Any]:
        document = document_provider()
        return {
            "title": document.get("metadata", {}).get("title", ""),
            "slides": [
                {
                    "id": slide.get("id", ""),
                    "index": index,
                    "name": slide.get("name", ""),
                    "key_message": slide.get("keyMessage", ""),
                    "element_count": len(slide.get("elements", [])),
                }
                for index, slide in enumerate(document.get("slides", []))
            ],
        }

    registry.register(
        ToolDefinition(
            id="presentation.getOutline",
            description="The whole deck at one line per slide. Use this before asking for a slide.",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            output_schema={
                "type": "object",
                "properties": {"title": {"type": "string"}, "slides": {"type": "array"}},
                "required": ["slides"],
            },
            returns_untrusted_content=True,
        ),
        get_outline,
    )

    def get_element(payload: dict[str, Any]) -> dict[str, Any]:
        document = document_provider()
        wanted = payload["element_id"]

        def walk(elements: list[dict[str, Any]], slide_id: str) -> dict[str, Any] | None:
            for element in elements:
                if element.get("id") == wanted:
                    return {"slide_id": slide_id, "element": summarise_element(element)}
                if element.get("type") == "group":
                    found = walk(element.get("children", []), slide_id)
                    if found:
                        return found
            return None

        for slide in document.get("slides", []):
            found = walk(slide.get("elements", []), slide.get("id", ""))
            if found:
                return found
        raise KeyError(f"No element {wanted}")

    registry.register(
        ToolDefinition(
            id="presentation.getElement",
            description="Read one element by id, with the slide it is on.",
            input_schema={
                "type": "object",
                "properties": {"element_id": _ID},
                "required": ["element_id"],
                "additionalProperties": False,
            },
            output_schema={
                "type": "object",
                "properties": {"slide_id": {"type": "string"}, "element": {"type": "object"}},
                "required": ["slide_id", "element"],
            },
            returns_untrusted_content=True,
        ),
        get_element,
    )

    def validate(payload: dict[str, Any]) -> dict[str, Any]:
        return validate_patch(payload["operations"])

    registry.register(
        ToolDefinition(
            id="presentation.validatePatch",
            description=(
                "Check that a patch applies to the current document and produces a valid one. "
                "Use it before proposing; a patch that does not validate is not a proposal."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "operations": {"type": "array", "items": {"type": "object"}, "minItems": 1}
                },
                "required": ["operations"],
                "additionalProperties": False,
            },
            output_schema={
                "type": "object",
                "properties": {
                    "valid": {"type": "boolean"},
                    "errors": {"type": "array", "items": {"type": "string"}},
                    "risk_tier": {"type": "string"},
                },
                "required": ["valid", "errors"],
            },
            # Applying a patch twice is not the same as applying it once, but
            # *validating* one is free of side effects.
            idempotent=True,
        ),
        validate,
    )


def slide_source(slide_id: str, name: str | None = None) -> Source:
    return Source(id=slide_id, kind="slide", label=name)
