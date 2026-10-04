"""Stopping a child and everything it started.

Two places need this and both need the *tree*: the exporter starts the app's own
Chromium in render-host mode, and a model runtime may start helpers. On Windows a
child survives its parent, so killing the process we spawned leaves a browser
holding a profile directory and a GPU process — which is exactly the thing
cancelling an export is supposed to stop.

It used to be `taskkill /F /T`, and on a machine here that tool answers
**"ERROR: Provider not found"** for every call: taskkill's tree walk goes through
WMI, and a damaged WMI repository is a common enough state on Windows that this
is not an exotic machine. Nothing failed loudly — `subprocess.run(..., check=False)`
swallowed it, the caller waited out its ten-second grace, and then killed the
parent alone. The child went on running, and the only symptom was a Chromium
process and a profile directory left behind after a cancelled export.

So the walk is done here instead, over `CreateToolhelp32Snapshot`, which is a
plain kernel call with no service behind it. Depth first — children before
parents, so a parent cannot spawn a replacement while its children are being
killed — and the snapshot is taken once, because a process that exits during the
walk would otherwise leave its children unreachable.
"""

from __future__ import annotations

import logging
import subprocess
import sys

logger = logging.getLogger(__name__)

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_TERMINATE = 0x0001


def _windows_children() -> "dict[int, list[int]]":
    """Every live process's parent, as {parent_pid: [child_pid, ...]}."""
    import ctypes
    import ctypes.wintypes as wintypes

    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", ctypes.c_char * 260),
        ]

    kernel32 = ctypes.windll.kernel32
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == -1:
        return {}

    children: dict[int, list[int]] = {}
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(ProcessEntry)
        found = kernel32.Process32First(snapshot, ctypes.byref(entry))
        while found:
            children.setdefault(int(entry.th32ParentProcessID), []).append(
                int(entry.th32ProcessID)
            )
            found = kernel32.Process32Next(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    return children


def _terminate(pid: int) -> None:
    import ctypes

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
    if not handle:
        return  # Already gone, or not ours to stop. Both are fine here.
    try:
        kernel32.TerminateProcess(handle, 1)
    finally:
        kernel32.CloseHandle(handle)


def _kill_tree_windows(pid: int) -> int:
    children = _windows_children()
    killed = 0

    def walk(target: int) -> None:
        nonlocal killed
        # Depth first: a parent killed before its children leaves them
        # re-parented and unreachable from this snapshot.
        for child in children.get(target, []):
            if child != target:
                walk(child)
        _terminate(target)
        killed += 1

    walk(pid)
    return killed


def _kill_tree_posix(pid: int) -> None:
    import os
    import signal
    from pathlib import Path
    children: dict[int, list[int]] = {}
    if sys.platform.startswith("linux"):
        for path in Path("/proc").glob("[0-9]*/stat"):
            try:
                fields = path.read_text(encoding="utf-8", errors="replace").rsplit(")", 1)[1].split()
                children.setdefault(int(fields[1]), []).append(int(path.parent.name))
            except (OSError, ValueError, IndexError):
                continue  # A process may exit during the snapshot.
    else:
        result = subprocess.run(["ps", "-A", "-o", "pid=", "-o", "ppid="], capture_output=True, text=True, check=True)
        for line in result.stdout.splitlines():
            child, parent = map(int, line.split())
            children.setdefault(parent, []).append(child)
    def walk(target):
        for child in children.get(target, []):
            walk(child)
        try:
            os.kill(target, signal.SIGKILL)
        except ProcessLookupError:
            pass
    walk(pid)


def terminate_tree(process: "subprocess.Popen", grace: float = 10.0) -> None:
    """Stop `process` and every process it started, then wait for it."""
    if process.poll() is not None:
        return

    try:
        if sys.platform == "win32":
            _kill_tree_windows(process.pid)
        else:
            # Walk descendants explicitly: a Python child's terminate() sends
            # one PID a signal, even when it was started in a process group.
            _kill_tree_posix(process.pid)
    except Exception:  # noqa: BLE001 - a failed kill must not replace the real answer
        logger.exception("Could not stop the process tree cleanly")

    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            logger.error("Process %s did not stop", process.pid)
