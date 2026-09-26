"""The single-shot planner's schema is one Anthropic's structured output accepts.

`story.py` calls the SDK directly rather than through the agents' router, so it
sends its own schema and needs its own check (see `agents/tests/test_api_schema.py`).
"""

from __future__ import annotations

from deckastra_agents.router import api_schema

from deckastra_api.story import _plan_schema

REFUSED = {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "maxItems"}


def _keys(node):
    if isinstance(node, dict):
        for key, value in node.items():
            yield key
            yield from _keys(value)
    elif isinstance(node, list):
        for item in node:
            yield from _keys(item)


def test_the_single_shot_plan_sends_nothing_the_api_refuses():
    assert REFUSED.isdisjoint(_keys(api_schema(_plan_schema())))
