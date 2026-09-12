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
