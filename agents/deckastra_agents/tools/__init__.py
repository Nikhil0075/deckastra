"""Tools agents may call, and the registry that mediates every call."""

from .registry import (
    PermissionDenied,
    ScopedRegistry,
    ToolCall,
    ToolDefinition,
    ToolError,
    ToolRegistry,
)

__all__ = [
    "PermissionDenied",
    "ScopedRegistry",
    "ToolCall",
    "ToolDefinition",
    "ToolError",
    "ToolRegistry",
]
