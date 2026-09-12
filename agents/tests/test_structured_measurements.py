"""Observe validation outcomes without persisting model content."""
import pytest
from pydantic import BaseModel

from deckastra_agents.budgets import RunBudget
from deckastra_agents.nodes._common import NodeContext, NodeFailure, ask_model
from deckastra_agents.router import ModelError, ModelResponse
from deckastra_agents.tools.registry import ToolRegistry


class Answer(BaseModel):
    value: int


@pytest.mark.parametrize("responses,attempts,first,outcome", [
    ([ModelResponse('{"value": 3}')], 1, True, "valid"),
    ([ModelResponse('{"value": "private-invalid"}'), ModelResponse('{"value": 3}')], 2, False, "valid"),
    ([ModelResponse('invalid'), ModelResponse('{}')], 2, False, "invalid"),
    ([ModelResponse('', refusal="declined")], 1, False, "refusal"),
    ([ModelError("provider unavailable")], 1, False, "provider_error"),
])
def test_observed_outcomes(responses, attempts, first, outcome):
    answers = iter(responses)

    class Client:
        def complete(self, request, budget):
            answer = next(answers)
            if isinstance(answer, Exception):
                raise answer
            budget.spend_tokens(11, 7)
            return answer

    budget = RunBudget()
    ctx = NodeContext(Client(), budget, lambda event: None, ToolRegistry())
    def invoke():
        return ask_model(ctx, stage="story", task_type="planning", system="private system", user="private user", model=Answer)
    if outcome == "valid":
        assert invoke().value == 3
    else:
        with pytest.raises(NodeFailure):
            invoke()
    report = budget.report()
    assert report["structured_requests"] == [{
        "stage": "story", "contract": "Answer", "attempts": attempts,
        "valid_first_attempt": first, "outcome": outcome,
    }]
    assert "private" not in str(report)
    assert report["used_tokens"] == report["input_tokens"] + report["output_tokens"]
