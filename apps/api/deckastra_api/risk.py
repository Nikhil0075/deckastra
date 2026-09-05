"""Risk tiering (doc 02 §31.7).

Computed server-side from the operations, never declared by the caller. A tier a
client can set is a security boundary a client controls, which is no boundary at
all.

This mirrors `computeRiskTier` in `@deckastra/presentation-schema`. The two are
kept honest the same way the patch appliers are — by a conformance test, not by
hoping.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .patch import split_path

Tier = Literal["low", "medium", "high"]
Behavior = Literal["autoApply", "pendingPreview", "explicitApproval"]


@dataclass(frozen=True)
class RiskAssessment:
    tier: Tier
    reasons: list[str] = field(default_factory=list)
    behavior: Behavior = "autoApply"

    @property
    def requires_approval(self) -> bool:
        return self.behavior != "autoApply"


def assess_risk(operations: list[dict[str, Any]]) -> RiskAssessment:
    """
    low     <= 3 ops on one slide, no deletions, no theme/viewport change
    medium  one slide restructured, image replaced, slide added
    high    > 3 slides touched, any slide deleted, theme or viewport changed
    """
    reasons: list[str] = []
    touched_slides: set[str] = set()
    removes_slide = False
    touches_theme_or_viewport = False
    has_deletion = False

    for operation in operations:
        segments = split_path(operation.get("path", "/"))
        root = segments[0] if segments else ""

        if root in {"theme", "viewport"}:
            touches_theme_or_viewport = True
            reasons.append(f"Changes {root}")

        if root == "slides" and len(segments) >= 2:
            touched_slides.add(segments[1])
            if operation.get("op") == "remove" and len(segments) == 2:
                removes_slide = True
                reasons.append("Deletes a slide")

        if operation.get("op") == "remove":
            has_deletion = True

        if operation.get("op") in {"move", "copy"}:
            source = split_path(operation.get("from", "/"))
            if source and source[0] == "slides" and len(source) >= 2:
                touched_slides.add(source[1])

    if len(touched_slides) > 3:
        reasons.append(f"Touches {len(touched_slides)} slides")

    if removes_slide or touches_theme_or_viewport or len(touched_slides) > 3:
        return RiskAssessment(tier="high", reasons=reasons, behavior="explicitApproval")

    if len(operations) <= 3 and len(touched_slides) <= 1 and not has_deletion:
        return RiskAssessment(tier="low", reasons=reasons, behavior="autoApply")

    if has_deletion:
        reasons.append("Removes content")
    return RiskAssessment(tier="medium", reasons=reasons, behavior="pendingPreview")
