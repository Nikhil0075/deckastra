"""The tool registry (doc 03 §15, doc 05 §18).

Every capability an agent has goes through here, and the registry — not the
agent — does the five things that must not be forgotten:

- **permission checks**, so an agent cannot reach a repository the installation
  does not cover (doc 03 §25),
- **input and output validation**, so a malformed call fails at the boundary
  rather than three layers in,
- **retries**, on the failures a retry can fix,
- **tracing**, so a run can be reconstructed afterwards,
- **the untrusted-content envelope**, applied to every result that carries text
  the agent did not write.

The last one is why the registry exists at all rather than agents importing
functions directly. An envelope applied per agent is an envelope a new agent
forgets; applied here, a tool's output cannot reach a prompt unlabelled.

An agent may only call tools it declared. Doc 03 §28 makes that an acceptance
criterion, and it is enforced by `for_agent()` returning a *narrowed* registry
rather than by a check the caller could skip.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from jsonschema import Draft202012Validator, ValidationError

from ..envelope import Source, contains_injection_attempt, envelope

RiskLevel = Literal["low", "medium", "high"]


class ToolError(RuntimeError):
    """A tool failed in a way the agent should see rather than crash on."""

    def __init__(self, tool_id: str, message: str, *, recoverable: bool = True) -> None:
        super().__init__(f"{tool_id}: {message}")
        self.tool_id = tool_id
        self.recoverable = recoverable


class PermissionDenied(ToolError):
    def __init__(self, tool_id: str, missing: list[str]) -> None:
        super().__init__(
            tool_id,
            f"requires permission(s) {', '.join(sorted(missing))}",
            recoverable=False,
        )
        self.missing = missing


@dataclass(frozen=True)
class ToolDefinition:
    id: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    required_permissions: list[str] = field(default_factory=list)
    risk_level: RiskLevel = "low"
    #: True when the result contains text the agent did not write, and therefore
    #: must be enveloped before it can reach a prompt.
    returns_untrusted_content: bool = False
    #: Retried on failure. False for anything with a side effect — a retried
    #: write is a duplicate write.
    idempotent: bool = True


@dataclass
class ToolCall:
    """One entry in the run's trace."""

    tool_id: str
    agent_id: str
    duration_ms: int
    ok: bool
    error: str | None = None
    attempts: int = 1


Handler = Callable[[dict[str, Any]], Any]


class ToolRegistry:
    """Holds tool definitions and their handlers, and mediates every call."""

    MAX_ATTEMPTS = 2

    def __init__(
        self,
        *,
        permissions: set[str] | None = None,
        timeout_seconds: float = 20.0,
    ) -> None:
        self._tools: dict[str, tuple[ToolDefinition, Handler]] = {}
        self._permissions = permissions or set()
        self._timeout = timeout_seconds
        self.trace: list[ToolCall] = []
        #: Sources whose content looked like it was addressing the model. Reported
        #: to the user, never used to reject content — the envelope is what makes
        #: it safe, and a filter would block a legitimate document about the topic.
        self.injection_warnings: list[str] = []

    # ------------------------------------------------------------ definition

    def register(self, definition: ToolDefinition, handler: Handler) -> None:
        if definition.id in self._tools:
            raise ValueError(f"Tool {definition.id} is already registered.")
        Draft202012Validator.check_schema(definition.input_schema)
        Draft202012Validator.check_schema(definition.output_schema)
        self._tools[definition.id] = (definition, handler)

    def definitions(self) -> list[ToolDefinition]:
        return [definition for definition, _ in self._tools.values()]

    def describe(self, tool_ids: list[str] | None = None) -> list[dict[str, Any]]:
        """Tool descriptions for a prompt. Schemas included, handlers never."""
        ids = tool_ids if tool_ids is not None else list(self._tools)
        return [
            {
                "id": self._tools[tool_id][0].id,
                "description": self._tools[tool_id][0].description,
                "input_schema": self._tools[tool_id][0].input_schema,
            }
            for tool_id in ids
            if tool_id in self._tools
        ]

    # ---------------------------------------------------------------- access

    def for_agent(self, agent_id: str, tool_ids: list[str]) -> "ScopedRegistry":
        """The only way an agent gets to call anything.

        Narrowed rather than checked: an agent holding a scoped registry cannot
        name a tool outside its declaration, so "agents cannot call undeclared
        tools" is a property of the object graph rather than of a code path
        someone has to remember to run.
        """
        unknown = [tool_id for tool_id in tool_ids if tool_id not in self._tools]
        if unknown:
            raise ValueError(f"{agent_id} declared unknown tool(s): {', '.join(unknown)}")
        return ScopedRegistry(self, agent_id, set(tool_ids))

    # ----------------------------------------------------------------- calls

    def _invoke(self, agent_id: str, tool_id: str, payload: dict[str, Any]) -> Any:
        definition, handler = self._tools[tool_id]

        missing = [
            permission
            for permission in definition.required_permissions
            if permission not in self._permissions
        ]
        if missing:
            self.trace.append(
                ToolCall(
                    tool_id=tool_id,
                    agent_id=agent_id,
                    duration_ms=0,
                    ok=False,
                    error=f"permission denied: {', '.join(sorted(missing))}",
                )
            )
            raise PermissionDenied(tool_id, missing)

        try:
            Draft202012Validator(definition.input_schema).validate(payload)
        except ValidationError as exc:
            self.trace.append(
                ToolCall(tool_id=tool_id, agent_id=agent_id, duration_ms=0, ok=False, error=str(exc.message))
            )
            raise ToolError(tool_id, f"invalid input: {exc.message}", recoverable=False) from exc

        attempts = self.MAX_ATTEMPTS if definition.idempotent else 1
        started = time.monotonic()
        last_error: Exception | None = None

        for attempt in range(1, attempts + 1):
            try:
                result = handler(payload)
            except Exception as exc:  # noqa: BLE001 - recorded and re-raised below
                last_error = exc
                continue

            elapsed_ms = int((time.monotonic() - started) * 1000)

            if elapsed_ms > self._timeout * 1000:
                # Recorded even though the work finished: a tool that overran its
                # timeout is a tool that will hang a run under load.
                self.trace.append(
                    ToolCall(
                        tool_id=tool_id,
                        agent_id=agent_id,
                        duration_ms=elapsed_ms,
                        ok=False,
                        error="timeout",
                        attempts=attempt,
                    )
                )
                raise ToolError(tool_id, f"took {elapsed_ms}ms, over the {self._timeout}s limit")

            try:
                Draft202012Validator(definition.output_schema).validate(result)
            except ValidationError as exc:
                self.trace.append(
                    ToolCall(
                        tool_id=tool_id,
                        agent_id=agent_id,
                        duration_ms=elapsed_ms,
                        ok=False,
                        error=f"invalid output: {exc.message}",
                        attempts=attempt,
                    )
                )
                raise ToolError(tool_id, f"returned invalid output: {exc.message}") from exc

            self.trace.append(
                ToolCall(tool_id=tool_id, agent_id=agent_id, duration_ms=elapsed_ms, ok=True, attempts=attempt)
            )
            return result

        elapsed_ms = int((time.monotonic() - started) * 1000)
        self.trace.append(
            ToolCall(
                tool_id=tool_id,
                agent_id=agent_id,
                duration_ms=elapsed_ms,
                ok=False,
                error=str(last_error),
                attempts=attempts,
            )
        )
        raise ToolError(tool_id, f"failed after {attempts} attempt(s): {last_error}")

    def wrap_untrusted(self, tool_id: str, text: str, source: Source) -> str:
        """Envelope a tool result, and note it if it looks like it is addressing the model."""
        if contains_injection_attempt(text):
            warning = (
                f"{source.label or source.id} appears to contain instructions addressed "
                "to an AI. They were treated as content, not followed."
            )
            if warning not in self.injection_warnings:
                self.injection_warnings.append(warning)
        return envelope(text, source)


class ScopedRegistry:
    """A registry narrowed to one agent's declared tools."""

    def __init__(self, registry: ToolRegistry, agent_id: str, tool_ids: set[str]) -> None:
        self._registry = registry
        self._agent_id = agent_id
        self._tool_ids = tool_ids

    @property
    def tool_ids(self) -> list[str]:
        return sorted(self._tool_ids)

    def call(self, tool_id: str, payload: dict[str, Any] | None = None) -> Any:
        if tool_id not in self._tool_ids:
            # Not a permission error: the agent asked for something outside its
            # own declaration, which is a bug in the agent rather than a policy
            # decision about the user.
            raise ToolError(
                tool_id,
                f"{self._agent_id} did not declare this tool; declared: {', '.join(self.tool_ids)}",
                recoverable=False,
            )
        return self._registry._invoke(self._agent_id, tool_id, payload or {})

    def describe(self) -> list[dict[str, Any]]:
        return self._registry.describe(self.tool_ids)

    def untrusted(self, tool_id: str, text: str, source: Source) -> str:
        return self._registry.wrap_untrusted(tool_id, text, source)
