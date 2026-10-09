"""Stopping a child and everything it started.

The interesting case is the grandchild, because that is the one the product
actually has: the exporter starts the app's Chromium, and killing the exporter
alone leaves a browser holding a profile directory and a GPU process after a
cancellation that reported success.

It used to be `taskkill /F /T`, which walks the tree through WMI. On a machine
with a damaged WMI repository every call answers "Provider not found", and
because the failure was swallowed the only symptom was a process left behind.
That machine is what these tests were written on.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import processes  # noqa: E402

#: A process that starts a child of its own and writes down both pids, so a test
#: can check the grandchild died rather than trusting the call that killed it.
PARENT = textwrap.dedent(
    """
    import subprocess, sys, time
    from pathlib import Path

    report = Path(sys.argv[1])
    child = subprocess.Popen([sys.executable, "-c", "import time\\nwhile True: time.sleep(0.2)"])
    report.write_text(f"{child.pid}", encoding="utf-8")
    while True:
        time.sleep(0.2)
    """
)


def alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED
        if not handle:
            return False
        exit_code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return exit_code.value == 259  # STILL_ACTIVE
    try:
        import os
        if sys.platform.startswith("linux"):
            # A stopped orphan can await reaping by a container's PID 1. It is
            # dead and holds no browser resources, even though kill(pid, 0) works.
            status = Path(f"/proc/{pid}/stat")
            if status.exists() and status.read_text(encoding="utf-8", errors="replace").rsplit(")", 1)[1].split()[0] == "Z":
                return False
        os.kill(pid, 0)
        return True
    except OSError:
        return False


@pytest.fixture()
def family(tmp_path):
    script = tmp_path / "parent.py"
    script.write_text(PARENT, encoding="utf-8")
    report = tmp_path / "child.pid"

    parent = subprocess.Popen([sys.executable, str(script), str(report)])
    for _ in range(100):
        if report.exists() and report.read_text(encoding="utf-8").strip():
            break
        time.sleep(0.05)
    child_pid = int(report.read_text(encoding="utf-8").strip())
    assert alive(child_pid)

    yield parent, child_pid

    if parent.poll() is None:
        parent.kill()


def test_the_grandchild_dies_too(family):
    parent, child_pid = family

    processes.terminate_tree(parent)

    assert parent.poll() is not None
    for _ in range(40):
        if not alive(child_pid):
            break
        time.sleep(0.05)
    # This is the assertion taskkill was silently failing: the child of the
    # process we spawned is what keeps a browser and its profile alive.
    assert not alive(child_pid)


def test_it_returns_promptly_rather_than_waiting_out_a_grace_period(family):
    """A kill that works takes milliseconds.

    The broken-WMI path took the full ten-second grace on every cancellation and
    then killed the parent alone — slow *and* wrong, and the slowness was the
    only part anyone noticed.
    """
    parent, _ = family

    started = time.monotonic()
    processes.terminate_tree(parent)

    assert time.monotonic() - started < 5.0


def test_stopping_something_already_stopped_is_not_an_error(family):
    parent, _ = family
    parent.kill()
    parent.wait(timeout=10)

    processes.terminate_tree(parent)
