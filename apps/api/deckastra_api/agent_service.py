"""Tool wiring shared by the remaining bounded assistant tasks.

Deck creation now uses reviewed presets or a caller-supplied ``StoryPlan``.
This module only wires read-only tools used by surviving assistant paths.
"""

from __future__ import annotations

from typing import Any, Callable

from deckastra_agents.tools.presentation import register_presentation_tools
from deckastra_agents.tools.registry import ToolRegistry
from .patch import PatchError, apply_patch
from .risk import assess_risk
from .schema import SchemaUnavailable, validate_document


def build_registry(document_provider: Callable[[], dict[str, Any]]) -> ToolRegistry:
    """Build a read-only presentation registry with deterministic patch checks."""

    def validate_patch(operations: list[dict[str, Any]]) -> dict[str, Any]:
        try:
            document, _ = apply_patch(document_provider(), operations)
        except PatchError as error:
            return {"valid": False, "errors": [str(error)], "risk_tier": "unknown"}

        try:
            errors = validate_document(document)
        except SchemaUnavailable as exc:
            return {"valid": False, "errors": [str(exc)], "risk_tier": "unknown"}

        return {
            "valid": not errors,
            "errors": errors,
            "risk_tier": assess_risk(operations).tier,
        }

    registry = ToolRegistry(permissions={"presentation.read"})
    register_presentation_tools(
        registry,
        document_provider=document_provider,
        validate_patch=validate_patch,
    )
    return registry
