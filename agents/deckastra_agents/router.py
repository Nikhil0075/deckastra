"""Bounded media-provider request and response contracts.

Deckastra no longer routes text work between models. These small transport
types remain because paid image generation uses the native Vertex client and
the desktop account gateway.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

from .budgets import RunBudget


@dataclass(frozen=True)
class ImageInput:
    data: str
    mime_type: str = "image/png"


@dataclass
class ModelRequest:
    task_type: str
    system: str
    messages: list[dict[str, Any]]
    max_tokens: int = 8_000
    context: list[str] = field(default_factory=list)
    images: list[ImageInput] = field(default_factory=list)
    stage: str = ""
    image_output: bool = False


@dataclass
class ModelResponse:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""
    refusal: str | None = None
    provider_parts: list[dict[str, Any]] = field(default_factory=list)

    def json(self) -> Any:
        return json.loads(self.text)


class ModelClient(Protocol):
    def complete(self, request: ModelRequest, budget: RunBudget) -> ModelResponse: ...


class ModelError(RuntimeError):
    """A provider failure that cannot be recovered automatically."""


class ModelUnavailable(ModelError):
    """The requested media provider is not configured."""


def distribution() -> bool:
    """Whether this process is an installed distribution rather than a checkout."""

    return os.environ.get("DECKASTRA_DISTRIBUTION", "").strip() == "1"
