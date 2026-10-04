"""Bounded native tool use through a narrowed, validating registry."""
from dataclasses import replace
from typing import Callable
from .router import ModelClient, ModelRequest, ModelResponse, ModelTool, ModelError
from .budgets import RunBudget
from .tools.registry import ToolRegistry


def run_tools(client: ModelClient, request: ModelRequest, registry: ToolRegistry, allowed: list[str], budget: RunBudget, *, agent_id: str, max_calls: int = 12, emit: Callable[[str], None] = lambda name: None) -> ModelResponse:
    scoped = registry.for_agent(agent_id, allowed)
    definitions = {d.id.replace(".", "__"): d for d in registry.definitions() if d.id in allowed}
    request = replace(request, messages=list(request.messages), tools=[ModelTool(name, d.description, d.input_schema) for name, d in definitions.items()])
    used = 0
    while True:
        budget.check_clock()
        answer = client.complete(request, budget)
        if not answer.tool_calls:
            return answer
        if used + len(answer.tool_calls) > max_calls:
            raise ModelError("The assistant tool-call ceiling was reached.")
        import json
        request.messages.append({"role": "assistant", "content": answer.text, "provider_parts": answer.provider_parts, "tool_calls": [{"id": call.id, "type": "function", "function": {"name": call.name, "arguments": json.dumps(call.arguments)}} for call in answer.tool_calls]})
        for call in answer.tool_calls:
            budget.check_clock()
            definition = definitions.get(call.name)
            if definition is None:
                raise ModelError("The model requested an undeclared tool.")
            result = scoped.call(definition.id, call.arguments)
            used += 1
            emit(definition.id)
            request.messages.append({"role": "tool", "name": call.name, "tool_call_id": call.id, "content": result})
