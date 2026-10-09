"""Structured contracts used by the remaining evidence-based review task."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


def strict_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Return a provider-compatible strict JSON Schema for ``model``."""
    schema = model.model_json_schema()
    _tighten(schema)
    return schema


def _tighten(node: Any) -> None:
    if isinstance(node, dict):
        if node.get("type") == "object" and "properties" in node:
            node["additionalProperties"] = False
            node["required"] = sorted(node["properties"].keys())
            for prop in node["properties"].values():
                prop.pop("default", None)
        for value in node.values():
            _tighten(value)
    elif isinstance(node, list):
        for item in node:
            _tighten(item)


class CriticIssue(BaseModel):
    """One review issue addressed to the person who can fix it."""

    slide_id: str = Field(default="", description="Empty only for a deck-wide issue.")
    severity: Literal["blocker", "major", "minor"]
    category: Literal[
        "narrative", "content", "layout", "style", "motion", "accessibility"
    ]
    message: str
    suggested_fix: str = ""


class CriticScores(BaseModel):
    hierarchy: float = Field(ge=0, le=1)
    readability: float = Field(ge=0, le=1)
    contrast: float = Field(ge=0, le=1)
    alignment: float = Field(ge=0, le=1)
    density: float = Field(ge=0, le=1)
    consistency: float = Field(ge=0, le=1)
    narrative_clarity: float = Field(ge=0, le=1)
    motion_quality: float | None = Field(default=None, ge=0, le=1)

    def overall(self) -> float:
        values = [
            self.hierarchy,
            self.readability,
            self.contrast,
            self.alignment,
            self.density,
            self.consistency,
            self.narrative_clarity,
        ]
        if self.motion_quality is not None:
            values.append(self.motion_quality)
        return round(sum(values) / len(values), 4)


class CriticResult(BaseModel):
    verdict: Literal["pass", "revise_story", "revise_layout", "revise_creative", "revise_motion"]
    scores: CriticScores
    issues: list[CriticIssue] = Field(default_factory=list)
    summary: str

    @property
    def score(self) -> float:
        return self.scores.overall()
