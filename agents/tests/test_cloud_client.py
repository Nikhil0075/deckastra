"""What the cloud client does with a failure (final package review, item 23).

The SDK is stood in for: what is worth testing is ours, which is whether a person
is told something they can act on. A rejected key and an unreachable network are
different problems with different answers, and "Claude API error 401" was one
sentence for both.
"""

from __future__ import annotations

import types

import pytest

from deckastra_agents.budgets import RunBudget
from deckastra_agents.router import AnthropicClient, ModelError, ModelRequest, ModelUnavailable


class FakeStatusError(Exception):
    def __init__(self, status_code: int, message: str = "no") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class FakeConnectionError(Exception):
    pass


class FakeRateLimit(Exception):
    pass


def client_raising(error: Exception) -> AnthropicClient:
    """An `AnthropicClient` whose SDK always fails, built without one."""
    client = object.__new__(AnthropicClient)
    client._anthropic = types.SimpleNamespace(  # noqa: SLF001
        APIStatusError=FakeStatusError,
        APIConnectionError=FakeConnectionError,
        RateLimitError=FakeRateLimit,
    )

    def create(**_kwargs):
        raise error

    client._client = types.SimpleNamespace(messages=types.SimpleNamespace(create=create))  # noqa: SLF001
    client._models = {}  # noqa: SLF001
    return client


def ask(client: AnthropicClient):
    return client.complete(
        ModelRequest(task_type="structured", system="s", messages=[{"role": "user", "content": "u"}]),
        RunBudget(),
    )


@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_key_says_so_and_points_at_where_to_change_it(status, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _s: None)
    with pytest.raises(ModelUnavailable) as refusal:
        ask(client_raising(FakeStatusError(status)))

    # Not "the run failed": nothing failed, the key is wrong, and retrying it
    # forever will not change that.
    assert "refused this API key" in str(refusal.value)
    assert "Intelligence" in str(refusal.value)


def test_a_bad_request_is_still_an_error_about_the_request(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _s: None)
    with pytest.raises(ModelError) as failure:
        ask(client_raising(FakeStatusError(400, "bad request")))
    assert not isinstance(failure.value, ModelUnavailable)
    assert "400" in str(failure.value)


def test_a_network_failure_is_retried_and_then_reported_as_one(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _s: None)
    with pytest.raises(ModelError) as failure:
        ask(client_raising(FakeConnectionError("no route to host")))
    assert not isinstance(failure.value, ModelUnavailable)


def client_answering(response) -> tuple[AnthropicClient, list[dict]]:
    """An `AnthropicClient` whose SDK returns `response`, recording what was sent."""
    client = client_raising(RuntimeError("unused"))
    sent: list[dict] = []

    def create(**kwargs):
        sent.append(kwargs)
        return response

    client._client = types.SimpleNamespace(messages=types.SimpleNamespace(create=create))  # noqa: SLF001
    return client, sent


def _response(text: str, stop_reason: str = "end_turn"):
    return types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text=text)],
        stop_reason=stop_reason,
        usage=types.SimpleNamespace(input_tokens=1, output_tokens=1),
    )


def test_the_schema_sent_is_one_the_api_accepts():
    """The installed app's 400: Pydantic bounds reached `output_config` verbatim."""
    client, sent = client_answering(_response("{}"))
    schema = {
        "type": "object",
        "properties": {"score": {"type": "number", "minimum": 0, "maximum": 1}},
        "required": ["score"],
    }
    client.complete(
        ModelRequest(task_type="structured", system="s", messages=[{"role": "user", "content": "u"}], response_schema=schema),
        RunBudget(),
    )
    sent_schema = sent[0]["output_config"]["format"]["schema"]
    assert sent_schema["properties"]["score"] == {"type": "number"}
    assert sent_schema["additionalProperties"] is False
    assert schema["properties"]["score"]["minimum"] == 0  # the caller's copy is untouched


def test_a_small_stage_limit_still_leaves_room_to_think_and_answer():
    client, sent = client_answering(_response("{}"))
    client.complete(
        ModelRequest(task_type="structured", system="s", messages=[{"role": "user", "content": "u"}], max_tokens=2_000),
        RunBudget(),
    )
    assert sent[0]["max_tokens"] >= 16_000
    assert sent[0]["thinking"] == {"type": "adaptive"}


def test_a_truncated_answer_says_it_was_cut_off():
    client, _ = client_answering(_response('{"slides": [', stop_reason="max_tokens"))
    with pytest.raises(ModelError) as failure:
        ask(client)
    assert "cut off" in str(failure.value)
