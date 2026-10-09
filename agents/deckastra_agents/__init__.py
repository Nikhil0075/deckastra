"""Deckastra's agent system (doc 03).

The rule that shapes every module here, from doc 03 §29:

    Agents manipulate intent and structured presentation operations, not pixels
    and not opaque rendered images.

Concretely, that means an agent in this package:

- returns a typed contract, never prose the next stage has to parse,
- never emits a coordinate, a font size or a colour literal,
- never writes to the store — it produces operations and hands them over,
- never calls a tool it did not declare,
- never treats retrieved content as instruction.

The last four are enforced structurally rather than requested: the transaction
service is the only writer, `ToolRegistry.for_agent` narrows rather than checks,
and the envelope is applied at the tool boundary. A rule that depends on every
future agent remembering it is a rule that lasts until the next agent.
"""

from .budgets import BudgetExceeded, RunBudget
from .envelope import POLICY, Source, envelope
from .events import AgentEvent, collector, fan_out
from .memory import InMemoryStore, ProjectMemory
from .tools.registry import ToolDefinition, ToolRegistry

__all__ = [
    "AgentEvent",
    "BudgetExceeded",
    "InMemoryStore",
    "POLICY",
    "ProjectMemory",
    "RunBudget",
    "Source",
    "ToolDefinition",
    "ToolRegistry",
    "collector",
    "envelope",
    "fan_out",
]
