"""Supervising the local model runtime (D3).

Driven by a stand-in runtime — a few lines of Python that serve the same OpenAI
surface — rather than by a model. Everything these check is about the *process*:
that a bound port is not taken for a loaded model, that a runtime which dies
while loading is reported with what it printed, that a model nobody is using is
unloaded, and that the API never quietly runs the stub on a local install.

None of that needs weights, and waiting for weights to test it would mean the
process handling was written blind and exercised once, by hand, on a machine that
happened to have a model.
"""

from __future__ import annotations

import json
import sys
import textwrap
import time
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import model_server  # noqa: E402
from deckastra_agents import router  # noqa: E402
from deckastra_agents.model_packs import MODEL_DIR_ENV, MANIFEST  # noqa: E402

#: A runtime that answers the readiness probe, optionally after a delay, and can
#: be told to die instead. Stands in for llama.cpp's server.
STAND_IN = textwrap.dedent(
    """
    import json, sys, time
    from http.server import BaseHTTPRequestHandler, HTTPServer

    port = int(sys.argv[1])
    delay = float(sys.argv[2])
    die = sys.argv[3] == "die"

    if die:
        print("could not allocate 4096 MiB on this device", file=sys.stderr, flush=True)
        raise SystemExit(3)

    time.sleep(delay)

    class Handler(BaseHTTPRequestHandler):
        def _send(self, payload):
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._send({"data": [{"id": "stand-in"}]})

        def do_POST(self):
            # Consume the request before closing HTTP/1.0; unread bytes cause a
            # TCP reset on Windows and conceal the supervisor behavior under test.
            self.rfile.read(int(self.headers.get("content-length", "0")))
            self._send({
                "choices": [{"message": {"content": json.dumps({"ok": True})}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 3},
            })

        def log_message(self, *args):
            pass

    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
    """
)


@pytest.fixture(autouse=True)
def clean(monkeypatch, tmp_path):
    """Nothing here may inherit a real key, a real pack or a live runtime."""
    for name in (
        router.INTELLIGENCE_ENV,
        MODEL_DIR_ENV,
        "DECKASTRA_MODEL_PACK",
        "DECKASTRA_MODEL_SERVER",
        model_server.SERVER_COMMAND_ENV,
        model_server.STARTUP_TIMEOUT_ENV,
        model_server.IDLE_ENV,
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)
    yield
    model_server.stop("test teardown")


def install_pack(root: Path, runtime: Path, *, delay="0", mode="serve") -> Path:
    directory = root / "stand-in-pack"
    directory.mkdir(parents=True)
    (directory / "model.gguf").write_bytes(b"weights")
    (directory / MANIFEST).write_text(
        json.dumps(
            {
                "id": "stand-in-pack",
                "name": "Stand-in",
                "weights": "model.gguf",
                "context_tokens": 4096,
                "quantization": "Q4_K_M",
                "license": "Apache-2.0",
            }
        ),
        encoding="utf-8",
    )
    runtime.write_text(STAND_IN, encoding="utf-8")
    return directory


@pytest.fixture()
def local_install(tmp_path, monkeypatch):
    runtime = tmp_path / "stand_in.py"
    install_pack(tmp_path / "packs", runtime)
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "local")
    monkeypatch.setenv(MODEL_DIR_ENV, str(tmp_path / "packs"))

    def configure(delay: str = "0", mode: str = "serve") -> None:
        monkeypatch.setenv(
            model_server.SERVER_COMMAND_ENV,
            f'"{sys.executable}" "{runtime}" {{port}} {delay} {mode}',
        )

    configure()
    return configure


def test_a_model_is_loaded_on_demand_and_reused(local_install):
    """Not started with the app: a window is useless without the workspace
    service, and nothing is useless without a model until someone generates."""
    first = model_server.ensure_ready()
    second = model_server.ensure_ready()

    assert first == second
    assert httpx.get(f"{first}/v1/models", timeout=5).status_code == 200
    # And the address reaches the agents through the environment, not an import:
    # `agents/` must not know how this product deploys (doc 05 §17).
    import os

    assert os.environ["DECKASTRA_MODEL_SERVER"] == first


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Object lifetime")
def test_child_is_killed_when_parent_is_force_terminated(tmp_path):
    import subprocess
    import psutil
    parent_script = tmp_path / "job_parent.py"
    api_root = str(Path(__file__).resolve().parents[1])
    parent_script.write_text(
        "import sys, subprocess, time\n"
        f"sys.path.insert(0, {api_root!r})\n"
        "from deckastra_api.process_job import ChildJob\n"
        "job=ChildJob()\n"
        "child=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], creationflags=subprocess.CREATE_NO_WINDOW)\n"
        "job.assign(child)\n"
        "print(child.pid, flush=True)\n"
        "time.sleep(120)\n", encoding="utf-8")
    parent = subprocess.Popen([sys.executable, str(parent_script)], stdout=subprocess.PIPE, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
    child_pid = None
    try:
        child_pid = int(parent.stdout.readline().strip())
        assert psutil.pid_exists(child_pid)
        parent.kill(); parent.wait(timeout=5)
        deadline = time.monotonic() + 5
        while psutil.pid_exists(child_pid) and time.monotonic() < deadline:
            time.sleep(.05)
        assert not psutil.pid_exists(child_pid), "The child survived an abrupt parent exit"
    finally:
        if parent.poll() is None: parent.kill(); parent.wait(timeout=5)
        if child_pid and psutil.pid_exists(child_pid): psutil.Process(child_pid).kill()


def test_ready_means_answering_not_merely_started(local_install):
    """D1's lesson, and it is worse here.

    A model server binds its port and then spends tens of seconds reading weights
    off disk. Treating the bind as readiness sends the first generation of every
    session into a connection error.
    """
    local_install(delay="1.5")

    started = time.monotonic()
    base_url = model_server.ensure_ready()

    assert time.monotonic() - started >= 1.4
    assert httpx.get(f"{base_url}/v1/models", timeout=5).status_code == 200


def test_loading_the_model_is_not_charged_to_the_job(local_install):
    """2026-10-04 recheck: a cold start spent most of a one-slide job's 180 s.

    Loading is bounded by its own start-up timeout. A job whose clock is shorter
    than the load must still get its whole allowance once the model answers.
    """
    from deckastra_agents.budgets import RunBudget

    local_install(delay="1.5")
    budget = RunBudget(max_wall_clock_seconds=1.0)

    model_server.ensure_ready(budget)

    budget.check_clock()  # would raise: 1.5 s of loading against a 1 s clock
    assert budget.startup_seconds >= 1.4
    assert budget.max_wall_clock_seconds - budget.elapsed_seconds > 0.5
    assert budget.report()["startup_seconds"] >= 1.4


def test_cancelling_during_load_still_stops_it(local_install):
    from deckastra_agents.budgets import RunBudget, RunCancelled

    local_install(delay="5")
    budget = RunBudget(max_wall_clock_seconds=600, cancelled=lambda: True)

    with pytest.raises(RunCancelled):
        model_server.ensure_ready(budget)


def test_a_runtime_that_dies_while_loading_is_reported_with_what_it_said(local_install):
    """The failure this machine class actually produces.

    "It did not start" is useless; the runtime's own line about the allocation it
    could not make is the whole diagnosis, and it is the difference between "try a
    smaller pack" and "file a bug".
    """
    local_install(mode="die")

    with pytest.raises(router.ModelUnavailable) as refusal:
        model_server.ensure_ready()

    assert "could not allocate" in str(refusal.value)
    assert "Stand-in" in str(refusal.value)


def test_a_model_nobody_is_using_is_unloaded(local_install, monkeypatch):
    """Gigabytes resident an hour after the deck was written is the kind of thing
    people find in Task Manager and never trust again."""
    monkeypatch.setenv(model_server.IDLE_ENV, "0.5")

    base_url = model_server.ensure_ready()
    assert model_server._process is not None

    for _ in range(80):
        time.sleep(0.5)
        if model_server._process is None:
            break

    assert model_server._process is None
    # And the next request brings it back rather than refusing.
    assert model_server.ensure_ready() != "" and model_server._process is not None


def test_no_runtime_configured_says_so_rather_than_failing_obscurely(local_install, monkeypatch):
    monkeypatch.delenv(model_server.SERVER_COMMAND_ENV, raising=False)

    with pytest.raises(router.ModelUnavailable) as refusal:
        model_server.ensure_ready()

    assert model_server.SERVER_COMMAND_ENV in str(refusal.value)


def test_no_pack_defers_to_the_refusal_that_knows_the_detail(tmp_path, monkeypatch):
    """One message about this, not two. `local_client` knows which directories
    were tried and why each failed; a second refusal written here would be the
    worse one, and it is the one a user would see."""
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "local")
    monkeypatch.setenv(MODEL_DIR_ENV, str(tmp_path))

    with pytest.raises(router.ModelUnavailable) as refusal:
        model_server.ensure_ready()

    assert "no model pack is installed" in str(refusal.value)


def test_building_a_client_starts_the_runtime_and_never_falls_back(local_install):
    """The one that matters: three call sites each remembering to start a server
    is two that will not, and the failure — a local install answering from the
    stub — is exactly what D3's selection exists to refuse."""
    from deckastra_agents.budgets import RunBudget
    from deckastra_agents.local_model import LlamaServerClient
    from deckastra_agents.router import ModelRequest

    sentinel = object()
    client = model_server.build_client(fallback=lambda: sentinel)

    # Wrapped, so that using it keeps it loaded — but it is still the local
    # client underneath, never the fallback.
    assert isinstance(client._inner, LlamaServerClient)
    assert client._inner is not sentinel
    assert model_server._process is not None

    # And it really is the process this supervisor started that answers.
    answer = client.complete(
        ModelRequest(task_type="fast", system="s", messages=[{"role": "user", "content": "go"}]),
        RunBudget(),
    )
    assert answer.json() == {"ok": True}


def test_using_a_model_keeps_it_loaded(local_install, monkeypatch):
    """The regression that cost four benchmark runs and three wrong diagnoses.

    "Idle" was time since the runtime started, because the client learns the URL
    once and then talks to the port directly — the supervisor never hears about
    the work going through it. So the reaper unloaded the model *during* a
    generation, and the caller saw a dropped connection with no explanation on
    either side. Every crash landed within a second of the 600s window while VRAM,
    context size and a second GPU were each investigated and discarded.
    """
    from deckastra_agents.budgets import RunBudget
    from deckastra_agents.router import ModelRequest

    monkeypatch.setenv(model_server.IDLE_ENV, "1")
    client = model_server.build_client()
    started = model_server._process

    # Longer than the idle window, with work going through the client the whole
    # time — which is exactly the shape of one real generation.
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        client.complete(
            ModelRequest(task_type="fast", system="s", messages=[{"role": "user", "content": "go"}]),
            RunBudget(),
        )
        time.sleep(0.2)

    assert model_server._process is started, "the model was unloaded while it was being used"


def test_a_model_really_left_alone_is_still_unloaded(local_install, monkeypatch):
    """The other half: keeping it alive must not mean keeping it for ever."""
    monkeypatch.setenv(model_server.IDLE_ENV, "1")
    model_server.build_client()
    assert model_server._process is not None

    for _ in range(40):
        time.sleep(0.5)
        if model_server._process is None:
            break

    assert model_server._process is None


def test_a_cloud_install_starts_nothing(monkeypatch):
    monkeypatch.setenv(router.INTELLIGENCE_ENV, "cloud")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-looks-real")

    model_server.build_client()

    assert model_server._process is None


def test_one_long_request_is_not_reaped_out_from_under_itself(local_install, monkeypatch):
    """The half of the idle bug that the test above does not catch.

    `test_using_a_model_keeps_it_loaded` drives *repeated short* calls, and every
    one of them touches the supervisor on the way in — so the window never
    elapses between touches and the test passes on a runtime that is never
    actually left alone mid-request.

    A real generation is the opposite shape: **one** call lasting minutes. The
    supervisor was told at the start and heard nothing again, so the window ran
    down while the work was still going and the reaper stopped the runtime the
    caller was talking to. That is the same failure the four benchmark crashes
    were, surviving the fix that was supposed to end it — found by review, 2026-09-16.

    Driven through a slow inner client rather than a slow runtime, because the
    bug is in the wrapper's relationship with the reaper and nothing about it
    involves HTTP.
    """
    monkeypatch.setenv(model_server.IDLE_ENV, "1")
    model_server.ensure_ready()
    started = model_server._process
    assert started is not None

    class Slow:
        def complete(self, request, budget):
            # Comfortably past the idle window, as one story plan is past ten
            # minutes on the hardware D3 measured.
            time.sleep(1.6)
            return "answered"

    kept = model_server._KeptAlive(Slow())
    assert kept.complete(object(), object()) == "answered"

    assert model_server._process is started, "the runtime was stopped during an active request"
    assert started.poll() is None, "the runtime process exited while it was answering"


def test_a_client_kept_across_an_idle_shutdown_still_reaches_the_new_runtime(
    local_install, monkeypatch
):
    """A restart comes back on a different port.

    `ensure_ready()` answers with the URL for exactly this reason, and the
    wrapper discarded it — so a client that outlived one idle shutdown went on
    addressing a port nothing was listening on, and the next generation failed
    with "the local model server is not answering" on a machine where it was.
    """
    monkeypatch.setenv(model_server.IDLE_ENV, "1")
    client = model_server.build_client()
    first_url = model_server._base_url
    assert first_url is not None

    # Left alone long enough to be unloaded, the way a session goes quiet.
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline and model_server._process is not None:
        time.sleep(0.1)
    assert model_server._process is None, "the idle runtime should have been unloaded"

    from deckastra_agents.budgets import RunBudget
    from deckastra_agents.router import ModelRequest

    answer = client.complete(
        ModelRequest(task_type="fast", system="s", messages=[{"role": "user", "content": "go"}]),
        RunBudget(),
    )

    assert answer is not None
    assert model_server._base_url != first_url, "a restart should take a fresh port"
