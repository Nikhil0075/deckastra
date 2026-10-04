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
import atexit
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path

from . import processes
from .process_job import ChildJob

_child_job = None
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
#: How many requests are in flight. A runtime with work going through it is not
#: idle however long ago the work started, and the idle window is measured from
#: when the last one *finished* rather than when it began.
_active: int = 0
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
    verify_pack(pack)
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
    command = [
        part.replace("{model}", str(pack.weights.resolve()))
        .replace("{port}", str(port))
        .replace("{context}", str(pack.context_tokens))
        .replace("{python}", sys.executable)
        for part in parts
    ]
    if pack.vision_projector and "--mmproj" not in command:
        command.extend(["--mmproj", str(pack.vision_projector)])
    if pack.chat_template and "--chat-template-file" not in command:
        command.extend(["--chat-template-file", str(pack.chat_template)])
    return command


_verified_artifacts = set()


def diagnostics():
    return {"loaded_pack": _pack_id, "runtime_stderr_tail": list(_stderr), "active_requests": _active}


def verify_pack(pack):
    """Verify declared digests before first load, again if the files change."""
    import hashlib, json
    manifest = json.loads((pack.directory / "pack.json").read_text(encoding="utf-8"))
    for path, digest in ((pack.weights, pack.sha256), (pack.vision_projector, manifest.get("projector_sha256"))):
        if path is None or not digest:
            continue  # older manually installed packs retain their original behavior
        stamp = (str(path.resolve()), path.stat().st_size, path.stat().st_mtime_ns, digest)
        if stamp in _verified_artifacts:
            continue
        actual = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                actual.update(chunk)
        if actual.hexdigest() != digest:
            raise ModelUnavailable("A model artifact failed SHA-256 verification. Reinstall the pinned pack.")
        _verified_artifacts.add(stamp)


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
    global _process, _base_url, _pack_id, _child_job
    process = _process
    _process = None
    _base_url = None
    _pack_id = None
    try:
        if process is not None and process.poll() is None:
            processes.terminate_tree(process, grace=10)
    finally:
        if _child_job is not None:
            _child_job.close()
            _child_job = None


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


atexit.register(stop, "parent shutdown")


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
            if _active:
                # Busy is not idle. Touching `_last_used` at the *start* of a
                # request is not enough on its own: one generation outlasts the
                # window, so the timer ran down while the work was still going
                # and this stopped the runtime the caller was talking to. Keep
                # waiting rather than returning — the request will finish, and
                # the window should start from then.
                continue
            if time.monotonic() - _last_used > _idle_seconds():
                _stop_locked("idle")
                return


def ensure_ready(budget=None) -> str:
    """The URL of a runtime that is answering, starting one if needed."""
    global _process, _base_url, _pack_id, _last_used, _reaper, _child_job

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
            _child_job = ChildJob()
            process = subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                # The runtime prints UTF-8; the locale code page would garble it,
                # or raise on a byte cp1252 does not define.
                encoding="utf-8",
                errors="replace",
                cwd=str(Path(pack.directory).resolve()),
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            try:
                _child_job.assign(process)
            except OSError:
                processes.terminate_tree(process)
                raise
        except OSError as error:
            if _child_job is not None:
                _child_job.close()
                _child_job = None
            raise ModelUnavailable(
                f"The local model runtime could not be started ({command[0]}): {error}"
            ) from error

        threading.Thread(target=_drain, args=(process,), daemon=True).start()
        _process, _base_url, _pack_id = process, base_url, pack.id

        loading_from = time.monotonic()
        deadline = loading_from + _startup_timeout()
        while time.monotonic() < deadline:
            if budget is not None:
                # Only cancellation here: loading has its own bound (the deadline
                # above), and its time is handed back to the run below.
                try:
                    getattr(budget, "check_cancelled", budget.check_clock)()
                except Exception:
                    _stop_locked("cancelled during startup")
                    raise
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
                exclude = getattr(budget, "exclude_time", None)
                if exclude is not None:
                    exclude(time.monotonic() - loading_from)
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

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def stream(self, request, budget):
        global _last_used, _active
        with _lock:
            _active += 1
        try:
            base_url = ensure_ready(budget)
            self._inner.retarget(base_url)
            yield from self._inner.stream(request, budget)
        finally:
            with _lock:
                _active -= 1
                _last_used = time.monotonic()

    def complete(self, request, budget):
        # Three things, and the first version of this did only the first.
        #
        # `ensure_ready` answers with the URL, which matters because a restart
        # comes back on a *different port*: a client that outlived one idle
        # shutdown went on addressing a port nothing was listening on, and the
        # next generation failed with "the local model server is not answering"
        # on a machine where it was.
        # Registering the request is what "in use" actually means. Refreshing the
        # timer on the way in leaves the window running down *during* the call,
        # which is how the four benchmark crashes happened and how they went on
        # happening after the fix that was supposed to end them (found by review,
        # 2026-09-16). One story plan is minutes; the window is ten.
        global _last_used, _active
        with _lock:
            _active += 1
        try:
            base_url = ensure_ready(budget)
            retarget = getattr(self._inner, "retarget", None)
            if retarget is not None:
                retarget(base_url)
            return self._inner.complete(request, budget)
        finally:
            # In a `finally`, so a refusal or a cancellation releases the runtime
            # as surely as an answer does — a model held busy by an exception is
            # a model that never unloads.
            with _lock:
                _active -= 1
                _last_used = time.monotonic()


def build_client(fallback=None) -> ModelClient:
    """The client for this install, with a local runtime started if that is the choice.

    Every generation path goes through here rather than calling `default_client`
    directly. Three call sites each remembering to start a server is two that
    will not, and the failure — a local install answering from the stub — is the
    exact one D3's selection exists to refuse.
    """
    if selected_provider() in ("hybrid", "vertex"):
        from deckastra_agents.hybrid_model import configured_client
        from deckastra_agents.local_model import local_client
        def local():
            client = local_client()
            expected = os.environ.get("DECKASTRA_ASSISTANT_PACK", "gemma4-e2b-q4")
            if client.pack.id != expected:
                raise ModelUnavailable(f"Select the measured assistant pack {expected} with DECKASTRA_MODEL_PACK.")
            return _KeptAlive(client)
        return configured_client(local_factory=local)
    if selected_provider() == PROVIDER_LOCAL:
        ensure_ready()
        return _KeptAlive(default_client(fallback=fallback))
    return default_client(fallback=fallback)
