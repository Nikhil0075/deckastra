"""Cancelling an export stops the render (D2 closure audit, 2026-09-12).

`request_cancel` used to set a flag and say the worker would "stop at the next
boundary". There was no boundary: `_invoke_worker` blocked in `subprocess.run`
until the renderer finished or the five-minute timeout expired, so a cancelled
job went on rendering — with a browser open — and was marked cancelled once the
work nobody wanted was already done.

The renderer is now polled while it runs, and cancelling kills it and everything
it started. These tests use a stand-in worker that sleeps and answers nothing,
because the property under test is *when the process dies*, not what a real
export produces.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import export_service  # noqa: E402


@pytest.fixture()
def sleeping_worker(tmp_path, monkeypatch):
    """A worker that starts, ignores its request, and would run for a minute."""
    script = tmp_path / "sleeper.py"
    script.write_text(
        textwrap.dedent(
            """
            import sys, time
            sys.stdin.read()
            time.sleep(60)
            print('{"ok": true}')
            """
        ).strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("DECKASTRA_WORKER_CMD", str(script))
    monkeypatch.setenv("DECKASTRA_WORKER_NODE", sys.executable)
    monkeypatch.setenv("DECKASTRA_EXPORT_DIR", str(tmp_path))
    return script


def alive(pid: int) -> bool:
    if sys.platform == "win32":
        finished = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True, check=False
        )
        return str(pid) in finished.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def test_a_cancelled_render_is_stopped_rather_than_left_running(sleeping_worker, tmp_path):
    started = time.monotonic()
    asked = {"cancel": False}
    children: list[int] = []

    real_popen = subprocess.Popen

    def watched(*args, **kwargs):
        process = real_popen(*args, **kwargs)
        children.append(process.pid)
        return process

    subprocess.Popen = watched  # noqa: S001 - restored below
    try:
        # Cancelled a moment after it starts, the way a person does.
        def should_cancel() -> bool:
            asked["cancel"] = time.monotonic() - started > 1.5
            return asked["cancel"]

        with pytest.raises(export_service.ExportCancelled):
            export_service._invoke_worker(
                "pdf",
                {"slides": []},
                tmp_path / "never.pdf",
                {},
                should_cancel=should_cancel,
            )
    finally:
        subprocess.Popen = real_popen

    # Seconds, not the 300-second export timeout: the work was stopped, not waited
    # out. That difference is the whole feature.
    assert time.monotonic() - started < 20
    assert children, "the exporter should have been started"
    time.sleep(0.5)
    assert not alive(children[0]), "the renderer is still running after cancellation"


def test_a_render_that_finishes_normally_is_not_disturbed(tmp_path, monkeypatch):
    """The poll must not break the ordinary path."""
    script = tmp_path / "answers.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, sys
            request = json.loads(sys.stdin.read())
            open(request["output"], "wb").write(b"bytes")
            print(json.dumps({"ok": True, "bytes": 5, "filename": "a.pdf",
                              "contentType": "application/pdf", "report": {}}))
            """
        ).strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("DECKASTRA_WORKER_CMD", str(script))
    monkeypatch.setenv("DECKASTRA_WORKER_NODE", sys.executable)

    answer = export_service._invoke_worker(
        "pdf", {"slides": []}, tmp_path / "out.pdf", {}, should_cancel=lambda: False
    )
    assert answer["ok"] is True
    assert (tmp_path / "out.pdf").read_bytes() == b"bytes"


def test_the_watcher_reads_the_flag_on_its_own_connection(tmp_path, monkeypatch):
    """Why a plain attribute read was not enough.

    The worker holds an open transaction while it renders and cannot see a flag
    another connection set after that transaction began — which is exactly how
    "cancel" ended up being noticed only once the render had finished.
    """
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'cancel.db'}")
    from deckastra_api.db import session as db_session

    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.db.models import (
        ExportJob,
        Presentation,
        PresentationVersion,
        Project,
        User,
        Workspace,
    )
    from deckastra_api.ids import new_id

    with db_session.session_scope() as setup:
        user = User(id=new_id("usr"), email="cancel@localhost", name="C")
        workspace = Workspace(id=new_id("wsp"), name="W", owner_id=user.id)
        project = Project(id=new_id("prj"), workspace_id=workspace.id, name="P", created_by=user.id)
        deck = Presentation(
            id=new_id("doc"), project_id=project.id, title="T", schema_version="1.1"
        )
        # A real version row: the job's `version_id` is a foreign key, because an
        # export is of a version (doc 04 §32.3) rather than of a deck.
        version = PresentationVersion(
            id=new_id("ver"), presentation_id=deck.id, created_by=user.id, source="user"
        )
        job = ExportJob(
            id=new_id("exp"),
            presentation_id=deck.id,
            version_id=version.id,
            created_by=user.id,
            kind="pdf",
            status="running",
            options_json={},
        )
        # Flushed in two stages: nothing relates the job to the version row, so
        # SQLAlchemy has no dependency to sort them by and the job's foreign key
        # would be checked before its version existed.
        setup.add_all([user, workspace, project, deck, version])
        setup.flush()
        setup.add(job)
        job_id = job.id

    watcher = export_service.cancellation_watcher(job_id)
    assert watcher() is False

    # A different connection asks for the stop, exactly as the HTTP request does.
    with db_session.session_scope() as requester:
        export_service.request_cancel(requester, requester.get(ExportJob, job_id))

    assert watcher() is True


def test_a_running_job_is_cancelled_by_a_request_on_another_connection(tmp_path, monkeypatch):
    """The case the unit tests above could not see, and the live run found.

    `run_job` used to *flush* the "running" update and keep the write transaction
    open across the whole render. On SQLite that blocks every other writer: the
    cancel request could not commit its flag until the render had finished, so the
    watcher polled a value that could not change, the job completed, and the flag
    was written afterwards against a stale snapshot. The row ended up saying
    `cancel_requested = 1, status = completed` — which reads like a poll that did
    not work, when in fact nothing was allowed to answer it.

    This drives the real path: the worker claims a job, renders through a
    stand-in that sleeps, and a *separate connection* asks for the stop.
    """
    import threading

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'running.db'}")
    monkeypatch.setenv("DECKASTRA_EXPORT_DIR", str(tmp_path))

    slow = tmp_path / "slow.py"
    slow.write_text(
        textwrap.dedent(
            """
            import json, sys, time
            request = json.loads(sys.stdin.read())
            time.sleep(6)
            open(request["output"], "wb").write(b"late bytes")
            print(json.dumps({"ok": True, "bytes": 10, "filename": "late.pdf",
                              "contentType": "application/pdf", "report": {}}))
            """
        ).strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("DECKASTRA_WORKER_CMD", str(slow))
    monkeypatch.setenv("DECKASTRA_WORKER_NODE", sys.executable)

    from deckastra_api.db import session as db_session

    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.db.models import (
        ExportJob,
        Presentation,
        PresentationVersion,
        Project,
        User,
        Workspace,
    )
    from deckastra_api.ids import new_id

    with db_session.session_scope() as setup:
        user = User(id=new_id("usr"), email="running@localhost", name="R")
        workspace = Workspace(id=new_id("wsp"), name="W", owner_id=user.id)
        project = Project(id=new_id("prj"), workspace_id=workspace.id, name="P", created_by=user.id)
        deck = Presentation(
            id=new_id("doc"), project_id=project.id, title="T", schema_version="1.1"
        )
        version = PresentationVersion(
            id=new_id("ver"),
            presentation_id=deck.id,
            created_by=user.id,
            source="user",
            snapshot_json={"slides": []},
        )
        setup.add_all([user, workspace, project, deck, version])
        setup.flush()
        job = ExportJob(
            id=new_id("exp"),
            presentation_id=deck.id,
            version_id=version.id,
            created_by=user.id,
            kind="pdf",
            status="queued",
            options_json={},
        )
        setup.add(job)
        job_id, document_version = job.id, version.id

    worker_done = threading.Event()

    def work() -> None:
        try:
            with db_session.session_scope() as session:
                export_service.run_job(
                    session,
                    session.get(ExportJob, job_id),
                    {"slides": [], "metadata": {"title": "T"}},
                    should_cancel=export_service.cancellation_watcher(job_id),
                )
        finally:
            worker_done.set()

    thread = threading.Thread(target=work, daemon=True)
    thread.start()

    # Wait until it is really rendering, then ask — from another connection, as
    # the HTTP request does. This is the write that used to block.
    for _ in range(40):
        time.sleep(0.25)
        with db_session.session_scope() as watcher:
            if watcher.get(ExportJob, job_id).status == "running":
                break

    asked_at = time.monotonic()
    with db_session.session_scope() as requester:
        export_service.request_cancel(requester, requester.get(ExportJob, job_id))
    # The request itself must not wait for the render to finish.
    assert time.monotonic() - asked_at < 3, "the cancel request blocked behind the render"

    worker_done.wait(timeout=30)
    with db_session.session_scope() as after:
        finished = after.get(ExportJob, job_id)
        assert finished.status == "cancelled", f"ended {finished.status}"
        # And nothing published: a file from a render the user stopped is a file
        # they did not ask for.
        assert not finished.artifact_path
        assert finished.bytes == 0
    assert document_version


def test_the_exporter_is_spoken_to_in_utf8_both_ways(tmp_path, monkeypatch):
    """The exporter reads and writes UTF-8, whatever the machine's code page.

    Read with the locale's encoding (cp1252 on Windows), every em dash in a
    degradation message reached the export panel as "â€”" — found by the desktop
    `handoff` acceptance step — and a non-ASCII output path reached the exporter
    garbled. The fake exporter here reads and writes raw UTF-8 bytes, as the real
    one does, so it fails under the old decoding on Windows.
    """
    script = tmp_path / "utf8.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, sys
            request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
            open(request["output"], "wb").write(b"bytes")
            answer = {"ok": True, "bytes": 5, "filename": "a.pdf", "contentType": "application/pdf",
                      "report": {"message": "replaced in this build — the content is not in the file"},
                      "echo": request["output"]}
            sys.stdout.buffer.write(json.dumps(answer, ensure_ascii=False).encode("utf-8"))
            """
        ).strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("DECKASTRA_WORKER_CMD", str(script))
    monkeypatch.setenv("DECKASTRA_WORKER_NODE", sys.executable)
    folder = tmp_path / "Übersicht – décks"
    folder.mkdir()

    answer = export_service._invoke_worker("pdf", {"slides": []}, folder / "out.pdf", {}, should_cancel=lambda: False)
    assert answer["report"]["message"] == "replaced in this build — the content is not in the file"
    assert answer["echo"] == str(folder / "out.pdf")
    assert (folder / "out.pdf").read_bytes() == b"bytes"
