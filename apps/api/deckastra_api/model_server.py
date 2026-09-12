"""Supervising the local model runtime (D3).

`agents/` owns what a model *is* asked; this owns the process that answers. The
separation is doc 05 §17's — an agent that knew how to spawn a server would know
about deployment — and it is why the two talk through the environment variable
`local_model` already reads rather than through an import.

Three things decide the shape here, and all three are about size: a loaded model
is gigabytes resident, takes tens of seconds to load, and belongs to a user who
may have asked for one deck.

- **Started on demand, not with the app.** The desktop supervises the workspace
  service because a window is useless without it. Nothing is useless without a
  model until someone generates, and holding 4GB for the other 95% of a session
  is a cost the user did not agree to.
- **Stopped when idle.** Same argument from the other end. A model still resident
  an hour after the deck was written is the kind of thing people notice in Task
  Manager and never trust again.
- **A crash is not retried in a loop.** D1's sidecar restarts with backoff
  because a workspace service that has died must come back. A model that died is
  usually a model this machine cannot hold, and each attempt costs tens of
  seconds and several gigabytes. It starts again on the *next request*, and the
  refusal in between carries what the process actually printed.

"Ready means answering" is D1's lesson applied again: binding a port says nothing
about a model that is still reading weights off disk, so readiness is a poll of
the OpenAI surface both runtimes expose.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path

from . import processes
from deckastra_agents.model_packs import ModelPack, selected_pack
from deckastra_agents.router import (
    PROVIDER_LOCAL,
    ModelClient,
    ModelUnavailable,
    default_client,
    selected_provider,
)

#: The runtime to run. Not shipped yet, and deliberately configurable: this
#: supervisor does not care whether it is llama.cpp's own `llama-server` or
#: another runtime with the same surface — it cares that something answers on the
#: port it was given. `{model}` and `{port}` are substituted; `{context}` is the
#: pack's context length.
SERVER_COMMAND_ENV = "DECKASTRA_MODEL_SERVER_CMD"

#: How long a model may take to load before the request gives up. A 4B at Q4 off
#: a cold disk is tens of seconds, and the first generation after a reboot is
#: exactly when someone is watching.
STARTUP_TIMEOUT_ENV = "DECKASTRA_MODEL_STARTUP_SECONDS"
DEFAULT_STARTUP_TIMEOUT = 180.0

#: How long a loaded model stays resident with nothing to do.
IDLE_ENV = "DECKASTRA_MODEL_IDLE_SECONDS"
DEFAULT_IDLE_SECONDS = 600.0

#: Kept from the runtime's stderr so a refusal can say what it printed. Bounded,
#: because a runtime that logs every token would otherwise be held in memory.
STDERR_LINES = 40

_lock = threading.RLock()
_process: subprocess.Popen | None = None
_base_url: str | None = None
_pack_id: str | None = None
_stderr: deque[str] = deque(maxlen=STDERR_LINES)
_last_used: float = 0.0
_reaper: threading.Thread | None = None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _startup_timeout() -> float:
    return float(os.environ.get(STARTUP_TIMEOUT_ENV, "") or DEFAULT_STARTUP_TIMEOUT)


def _idle_seconds() -> float:
    return float(os.environ.get(IDLE_ENV, "") or DEFAULT_IDLE_SECONDS)


def _command(pack: ModelPack, port: int) -> list[str]:
    template = os.environ.get(SERVER_COMMAND_ENV, "").strip()
    if not template:
        raise ModelUnavailable(
            "Local intelligence is selected and no model runtime is configured. Set "
            f"{SERVER_COMMAND_ENV} to the command that serves a model — this build does "
            "not ship one yet."
        )

    import shlex

    # Windows needs `posix=False` or a path's backslashes are eaten as escapes —
    # and that mode *keeps* the quotes it split on, so `"C:\Python\python.exe"`
    # arrives complete with its quotation marks and cannot be executed. Both
    # halves are required; either alone produces a command that does not run.
    if os.name == "nt":
        parts = [part.strip('"') for part in shlex.split(template, posix=False)]
    else:
        parts = shlex.split(template)
    return [
        part.replace("{model}", str(pack.weights))
        .replace("{port}", str(port))
        .replace("{context}", str(pack.context_tokens))
        .replace("{python}", sys.executable)
        for part in parts
    ]


def _drain(process: subprocess.Popen) -> None:
    """Keep the tail of what the runtime said.

    On its own thread because a pipe nobody reads fills and blocks the writer —
    which for a model server means it stops answering while looking alive.
    """
    assert process.stderr is not None
    for line in process.stderr:
        _stderr.append(line.rstrip()[:500])


def _answering(base_url: str, timeout: float = 2.0) -> bool:
    import httpx

    try:
        # The OpenAI surface both runtimes expose. A bound port proves nothing
        # here: the process listens long before the weights are in memory.
        answer = httpx.get(f"{base_url}/v1/models", timeout=timeout)
        return answer.status_code < 500
    except Exception:
        return False


def _stop_locked(reason: str = "") -> None:
    global _process, _base_url, _pack_id
    process = _process
    _process = None
    _base_url = None
    _pack_id = None
    if process is None or process.poll() is not None:
        return

    # The tree, for the same reason the exporter kills one: a runtime that started
    # a helper leaves it holding the port and the VRAM.
    processes.terminate_tree(process, grace=10)


def last_output() -> list[str]:
    """The tail of what the runtime printed, for whoever has to explain a failure.

    Kept because the interesting line is written by the process that died, and by
    the time anyone asks, the process is gone.
    """
    with _lock:
        return list(_stderr)


def stop(reason: str = "") -> None:
    with _lock:
        _stop_locked(reason)


def _reap() -> None:
    """Unload a model nobody has asked anything for a while."""
    while True:
        # A quarter of the window, so the check is proportionate to what it is
        # waiting for: a fixed fifteen seconds is idle polling on a ten-minute
        # timeout and a four-times overshoot on a short one.
        time.sleep(max(0.25, min(15.0, _idle_seconds() / 4)))
        with _lock:
            if _process is None:
                return
            if time.monotonic() - _last_used > _idle_seconds():
                _stop_locked("idle")
                return


def ensure_ready() -> str:
    """The URL of a runtime that is answering, starting one if needed."""
    global _process, _base_url, _pack_id, _last_used, _reaper

    pack = selected_pack()
    if pack is None:
        # `local_client` composes the useful version of this refusal — which pack
        # ids exist, which directories failed and why — so defer to it rather
        # than writing a second, worse message here.
        from deckastra_agents.local_model import local_client

        local_client()
        raise ModelUnavailable("No model pack is selected.")

    with _lock:
        if _process is not None and _process.poll() is None and _pack_id == pack.id:
            _last_used = time.monotonic()
            assert _base_url is not None
            return _base_url

        # A different pack, or a dead one. Either way what is running is not what
        # is wanted.
        _stop_locked("replaced")
        _stderr.clear()

        port = _free_port()
        base_url = f"http://127.0.0.1:{port}"
        command = _command(pack, port)

        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(Path(pack.directory)),
            )
        except OSError as error:
            raise ModelUnavailable(
                f"The local model runtime could not be started ({command[0]}): {error}"
            ) from error

        threading.Thread(target=_drain, args=(process,), daemon=True).start()

        deadline = time.monotonic() + _startup_timeout()
        while time.monotonic() < deadline:
            if process.poll() is not None:
                said = "\n".join(_stderr)
                raise ModelUnavailable(
                    f"The local model runtime stopped while loading '{pack.name}' "
                    f"(exit {process.returncode}). It said:\n{said}"
                )
            if _answering(base_url):
                _process = process
                _base_url = base_url
                _pack_id = pack.id
                _last_used = time.monotonic()
                # The address is how `agents/` finds it: the two trees talk
                # through the environment rather than an import, because an agent
                # that imported this module would know how the product deploys.
                os.environ["DECKASTRA_MODEL_SERVER"] = base_url
                if _reaper is None or not _reaper.is_alive():
                    _reaper = threading.Thread(target=_reap, daemon=True)
                    _reaper.start()
                return base_url
            time.sleep(0.5)

        _stop_locked("startup timeout")
        raise ModelUnavailable(
            f"'{pack.name}' did not finish loading within {_startup_timeout():.0f}s. "
            "On this machine the model may be too large to load at a usable speed; "
            f"raise {STARTUP_TIMEOUT_ENV} if it is simply slow."
        )


class _KeptAlive:
    """A local client that tells the supervisor it is still being used.

    Without this, "idle" means *time since the runtime started*, because the
    client learns the URL once and then talks to the port directly — the
    supervisor never hears about the work going through it. The reaper then
    unloads a model in the middle of a generation, and the caller sees the
    connection drop with no explanation on either side.

    It is not a hypothetical. Every crash in the first four benchmark runs landed
    within a second of the 600s idle window — 600.8, 600.9, 600.8, 600.5 — while
    three separate hardware explanations were investigated and discarded. One
    generation on this hardware takes minutes, so a run of any length crosses the
    window with work still in flight.

    `ensure_ready` is the touch: it returns immediately when the runtime is up,
    and restarts it when something else has stopped it.
    """

    def __init__(self, inner: ModelClient) -> None:
        self._inner = inner

    def complete(self, request, budget):
        ensure_ready()
        return self._inner.complete(request, budget)


def build_client(fallback=None) -> ModelClient:
    """The client for this install, with a local runtime started if that is the choice.

    Every generation path goes through here rather than calling `default_client`
    directly. Three call sites each remembering to start a server is two that
    will not, and the failure — a local install answering from the stub — is the
    exact one D3's selection exists to refuse.
    """
    if selected_provider() == PROVIDER_LOCAL:
        ensure_ready()
        return _KeptAlive(default_client(fallback=fallback))
    return default_client(fallback=fallback)
