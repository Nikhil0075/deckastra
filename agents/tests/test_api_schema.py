"""Every schema the product sends is one Anthropic's structured output accepts.

Cloud generation and AI edits on an installed app failed with a 400 on every
request — "For 'number' type, properties maximum, minimum are not supported" —
because Pydantic's `Field(ge=..., le=...)` bounds went straight into
`output_config`. Nothing had caught it: every suite runs the stub client, which
never sends a schema anywhere. This checks the schemas themselves, so it runs
without a key and without a network.
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel, ValidationError

from deckastra_agents import contracts
from deckastra_agents.contracts import strict_schema
from deckastra_agents.nodes.research import ResearchQuestions
from deckastra_agents.router import api_schema

FORBIDDEN = {
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
}
FORMATS = {"date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"}

CONTRACTS: list[type[BaseModel]] = [
    contracts.OrchestratorPlan,
    contracts.StoryPlan,
    contracts.CreativeDirection,
    contracts.LayoutProposal,
    contracts.MotionPlan,
    contracts.CriticResult,
    contracts.EditPlan,
    contracts.AuthorPlan,
    ResearchQuestions,
]


def _problems(node, path="$"):
    found = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key in FORBIDDEN:
                found.append(f"{path}.{key}")
            if key == "minItems" and value not in (0, 1):
                found.append(f"{path}.minItems={value}")
            if key == "format" and value not in FORMATS:
                found.append(f"{path}.format={value}")
            found += _problems(value, f"{path}.{key}")
        if "properties" in node and node.get("additionalProperties") is not False:
            found.append(f"{path} is not closed")
    elif isinstance(node, list):
        for index, item in enumerate(node):
            found += _problems(item, f"{path}[{index}]")
    return found


@pytest.mark.parametrize("model", CONTRACTS, ids=lambda m: m.__name__)
def test_every_graph_contract_is_accepted_after_cleaning(model):
    assert _problems(api_schema(strict_schema(model))) == []


def test_the_raw_schemas_did_carry_what_the_api_refuses():
    """The control: without it, the tests above pass on a sanitizer that is never needed."""
    raw = [p for model in CONTRACTS for p in _problems(strict_schema(model))]
    assert any(p.endswith((".minimum", ".maximum")) for p in raw), raw


def test_cleaning_does_not_modify_the_callers_schema():
    schema = strict_schema(contracts.CriticResult)
    before = repr(schema)
    api_schema(schema)
    assert repr(schema) == before


def test_the_bounds_are_still_enforced_by_our_own_validation():
    """The API no longer constrains the numbers; Pydantic still refuses them."""
    bounded = [
        (name, field)
        for model in CONTRACTS
        for name, field in model.model_fields.items()
        if any(type(m).__name__ in ("Ge", "Le", "Gt", "Lt") for m in field.metadata)
    ]
    assert bounded, "no bounded field found; the control above should have failed too"
    with pytest.raises(ValidationError):
        contracts.CriticScores.model_validate({k: 7.0 for k in contracts.CriticScores.model_fields})

