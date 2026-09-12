"""Local intelligence: what is installed, what is chosen, and what is refused (D3).

These tests need no model. That is the point of running them first: the part of
D3 that is easy to get wrong is not the inference, it is what happens when the
inference is not there — and the wrong answer to that is a quiet cloud call from
an install whose user chose local precisely so that would not happen.
"""

from __future__ import annotations

import json

import httpx
import pytest

from deckastra_agents import model_packs
from deckastra_agents.budgets import RunBudget
from deckastra_agents.local_model import LlamaServerClient
from deckastra_agents.router import (
    INTELLIGENCE_ENV,
    ModelError,
    ModelRequest,
    ModelUnavailable,
    StubClient,
    default_client,
)


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    """No test here may inherit a real key or a real model directory.

    `monkeypatch.delenv(raising=False)` records nothing when a variable is absent,
    so a test that *sets* one leaks it into every later test in the process. That
    cost a whole afternoon once. Snapshot and restore instead.
    """
    for name in (
        INTELLIGENCE_ENV,
        model_packs.MODEL_DIR_ENV,
        "DECKASTRA_MODEL_PACK",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)


def write_pack(root, pack_id, *, license="Apache-2.0", weights="model.gguf", **overrides):
    directory = root / pack_id
    directory.mkdir(parents=True)
    if weights is not None:
        (directory / weights).write_bytes(b"not really weights")
    manifest = {
        "id": pack_id,
        "name": pack_id.replace("-", " "),
        "weights": weights or "model.gguf",
        "context_tokens": 32_768,
        "quantization": "Q4_K_M",
        "license": license,
        **overrides,
    }
    (directory / model_packs.MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
    return directory


# ------------------------------------------------------------------ discovery


def test_a_pack_is_a_directory_with_a_manifest_beside_its_weights(tmp_path):
    write_pack(tmp_path, "qwen3-4b-q4", min_ram_mb=6_000)

    packs, problems = model_packs.scan(tmp_path)

    assert problems == []
    assert [pack.id for pack in packs] == ["qwen3-4b-q4"]
    assert packs[0].context_tokens == 32_768
    assert packs[0].min_ram_mb == 6_000
    assert packs[0].weights.is_file()


def test_a_half_finished_download_says_so_rather_than_disappearing(tmp_path):
    """The failure a user actually hits, and the one silence is worst for.

    A manifest arrives in milliseconds and the weights take twenty minutes. A
    product that simply did not list the pack sends someone to re-download it.
    """
    write_pack(tmp_path, "qwen3-4b-q4", weights=None)

    packs, problems = model_packs.scan(tmp_path)

    assert packs == []
    assert "model.gguf" in problems[0].reason
    assert "interrupted download" in problems[0].reason


def test_a_pack_that_cannot_say_what_license_it_is_under_is_refused(tmp_path):
    """Redistribution is a release gate, so the fact has to exist before then.

    Not paternalism about which license: the product has to be able to tell a
    user what they are running, and "nobody wrote it down" is discovered at
    release otherwise.
    """
    write_pack(tmp_path, "mystery-7b", license="   ")

    packs, problems = model_packs.scan(tmp_path)

    assert packs == []
    assert "license" in problems[0].reason


def test_a_manifest_that_cannot_be_read_is_a_problem_not_a_crash(tmp_path):
    directory = tmp_path / "broken"
    directory.mkdir()
    (directory / model_packs.MANIFEST).write_text("{ not json", encoding="utf-8")

    packs, problems = model_packs.scan(tmp_path)

    assert packs == []
    assert problems[0].directory.name == "broken"


# ------------------------------------------------------------------ selection


def test_local_intelligence_never_reaches_for_a_key(tmp_path, monkeypatch):
    """The refusal this whole slice exists for.

    Someone selects local because nothing of theirs should leave the machine.
    With no pack installed, a fallback chain would answer from Anthropic — a
    privacy decision taken on their behalf, in the one direction that cannot be
    taken back once the request has been sent. A key being present must change
    nothing about that.
    """
    monkeypatch.setenv(INTELLIGENCE_ENV, "local")
    monkeypatch.setenv(model_packs.MODEL_DIR_ENV, str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-a-real-looking-key")

    with pytest.raises(ModelUnavailable) as refusal:
        default_client()

    assert "no model pack is installed" in str(refusal.value)
    assert "cloud generation" in str(refusal.value)


def test_local_intelligence_with_no_directory_names_what_to_set(monkeypatch):
    monkeypatch.setenv(INTELLIGENCE_ENV, "local")

    with pytest.raises(ModelUnavailable) as refusal:
        default_client()

    assert model_packs.MODEL_DIR_ENV in str(refusal.value)


def test_the_refusal_carries_the_reason_a_pack_was_not_usable(tmp_path, monkeypatch):
    write_pack(tmp_path, "qwen3-4b-q4", weights=None)
    monkeypatch.setenv(INTELLIGENCE_ENV, "local")
    monkeypatch.setenv(model_packs.MODEL_DIR_ENV, str(tmp_path))

    with pytest.raises(ModelUnavailable) as refusal:
        default_client()

    # Otherwise the message says "no pack installed" to someone looking at one.
    assert "qwen3-4b-q4" in str(refusal.value)


def test_two_packs_and_no_choice_is_a_refusal_rather_than_a_guess(tmp_path, monkeypatch):
    write_pack(tmp_path, "qwen3-4b-q4")
    write_pack(tmp_path, "llama-8b-q4")
    monkeypatch.setenv(INTELLIGENCE_ENV, "local")
    monkeypatch.setenv(model_packs.MODEL_DIR_ENV, str(tmp_path))

    with pytest.raises(ModelUnavailable) as refusal:
        default_client()

    assert "llama-8b-q4" in str(refusal.value) and "qwen3-4b-q4" in str(refusal.value)

    # Named, and it runs.
    monkeypatch.setenv("DECKASTRA_MODEL_PACK", "llama-8b-q4")
    assert default_client().pack.id == "llama-8b-q4"


def test_one_installed_pack_needs_no_choosing(tmp_path, monkeypatch):
    write_pack(tmp_path, "qwen3-4b-q4")
    monkeypatch.setenv(INTELLIGENCE_ENV, "local")
    monkeypatch.setenv(model_packs.MODEL_DIR_ENV, str(tmp_path))

    client = default_client()

    assert isinstance(client, LlamaServerClient)
    assert client.pack.id == "qwen3-4b-q4"


def test_cloud_without_a_key_refuses_rather_than_quietly_stubbing(monkeypatch):
    """A stub deck is not the answer to a missing key.

    It looks like a generated deck that came out badly, which is the most
    expensive way to learn that nothing was configured.
    """
    monkeypatch.setenv(INTELLIGENCE_ENV, "cloud")

    with pytest.raises(ModelUnavailable) as refusal:
        default_client()

    assert "ANTHROPIC_API_KEY" in str(refusal.value)


def test_saying_nothing_keeps_exactly_the_old_behaviour():
    """The web app, CI and every existing test come through here."""
    assert isinstance(default_client(), StubClient)


# -------------------------------------------------------------------- the client


def fake_server(handler, pack_dir):
    packs, _ = model_packs.scan(pack_dir)
    return LlamaServerClient(packs[0], transport=httpx.MockTransport(handler))


def answer(content="{}", usage={"prompt_tokens": 120, "completion_tokens": 40}):
    payload = {"choices": [{"message": {"content": content}}]}
    if usage is not None:
        payload["usage"] = usage
    return httpx.Response(200, json=payload)


def test_a_contract_is_sent_as_a_grammar_and_charged_as_it_was_reported(tmp_path):
    write_pack(tmp_path, "qwen3-4b-q4")
    sent = {}

    def handler(request):
        sent.update(json.loads(request.content))
        return answer(content='{"ok": true}')

    client = fake_server(handler, tmp_path)
    budget = RunBudget()
    response = client.complete(
        ModelRequest(
            task_type="structured",
            system="Be brief.",
            messages=[{"role": "user", "content": "go"}],
            response_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
        ),
        budget,
    )

    assert sent["response_format"]["type"] == "json_schema"
    assert sent["response_format"]["json_schema"]["schema"]["type"] == "object"
    assert sent["model"] == "qwen3-4b-q4"
    # The envelope policy travels with every request, the same as on the cloud path.
    assert "Be brief." in sent["messages"][0]["content"]

    assert response.json() == {"ok": True}
    assert (budget.input_tokens, budget.output_tokens) == (120, 40)


def test_unreported_tokens_are_charged_as_nothing_and_said_out_loud(tmp_path):
    """A run that looks free because nobody counted it is worse than one that
    admits the total is short. Comparing packs is the whole point of D3's
    benchmark, and an invented number would make one of them look cheaper."""
    write_pack(tmp_path, "qwen3-4b-q4")
    client = fake_server(lambda request: answer(usage=None), tmp_path)
    budget = RunBudget()

    client.complete(
        ModelRequest(task_type="fast", system="s", messages=[{"role": "user", "content": "go"}]),
        budget,
    )

    assert budget.used_tokens == 0
    assert any("reported no token counts" in warning for warning in budget.warnings)


def test_a_request_cannot_outlive_the_run_it_belongs_to(tmp_path):
    """Without this a wedged model holds the user past the wall-clock ceiling the
    budget exists to enforce, and the ceiling reports a time that had already
    passed when it was finally checked."""
    write_pack(tmp_path, "qwen3-4b-q4")
    seen = {}

    def handler(request):
        return answer()

    client = fake_server(handler, tmp_path)
    real_client = client._client

    def recording(timeout):
        seen["timeout"] = timeout
        return real_client(timeout)

    client._client = recording
    budget = RunBudget(max_wall_clock_seconds=30.0)
    client.complete(
        ModelRequest(task_type="fast", system="s", messages=[{"role": "user", "content": "go"}]),
        budget,
    )

    assert 0 < seen["timeout"] <= 30.0


def test_a_server_that_is_not_running_is_named_as_the_server(tmp_path):
    """'Installed but not started' and 'not installed' are different problems with
    different fixes, and the message has to say which one this is."""
    write_pack(tmp_path, "qwen3-4b-q4")

    def handler(request):
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ModelUnavailable) as refusal:
        fake_server(handler, tmp_path).complete(
            ModelRequest(task_type="fast", system="s", messages=[{"role": "user", "content": "go"}]),
            RunBudget(),
        )

    assert "not answering" in str(refusal.value)
    assert "is installed" in str(refusal.value)


def test_a_runtime_that_dies_mid_answer_is_named_as_memory(tmp_path):
    """Measured on a 4GB card: this is what running out of VRAM looks like.

    The failure arrives as a dropped connection partway through generation, not
    as a refusal at load, because the allocation that fails is the one made while
    generating. A raw `ReadError: [WinError 10054]` reaching a user is a fact
    about sockets; the useful sentence is the one about context size.
    """
    write_pack(tmp_path, "qwen3-4b-q4")

    def handler(request):
        raise httpx.ReadError("forcibly closed", request=request)

    with pytest.raises(ModelUnavailable) as refusal:
        fake_server(handler, tmp_path).complete(
            ModelRequest(task_type="fast", system="s", messages=[{"role": "user", "content": "go"}]),
            RunBudget(),
        )

    assert "stopped while answering" in str(refusal.value)
    assert "smaller context" in str(refusal.value)


def test_a_contract_the_runtime_cannot_turn_into_a_grammar_says_that(tmp_path):
    """The failure that separates a local model from a cloud one, and the one a
    generic '400' would send someone looking in the wrong place for."""
    write_pack(tmp_path, "qwen3-4b-q4")

    def handler(request):
        return httpx.Response(400, text="Failed to parse grammar from JSON schema")

    with pytest.raises(ModelError) as failure:
        fake_server(handler, tmp_path).complete(
            ModelRequest(
                task_type="structured",
                system="s",
                messages=[{"role": "user", "content": "go"}],
                response_schema={"type": "object", "patternProperties": {"^x": {}}},
            ),
            RunBudget(),
        )

    assert "grammar" in str(failure.value)


def test_an_answer_this_client_does_not_understand_is_not_an_empty_deck(tmp_path):
    write_pack(tmp_path, "qwen3-4b-q4")

    def handler(request):
        return httpx.Response(200, text="<html>a proxy sign-in page</html>")

    with pytest.raises(ModelError):
        fake_server(handler, tmp_path).complete(
            ModelRequest(task_type="fast", system="s", messages=[{"role": "user", "content": "go"}]),
            RunBudget(),
        )
