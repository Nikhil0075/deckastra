"""Running an export (doc 04 §32.4, doc 05 §8).

The renderer, the adapters and the animation engine are TypeScript; the API is
Python. So an export crosses a process boundary, and this module is where.

**A subprocess, not a service.** The alternatives were a long-running Node
service with an HTTP surface or a child process, and while there is one machine
the child process is the honest choice: no port to allocate, no health check, no
second thing to deploy, and a failure arrives as a non-zero exit code with stderr
attached rather than a connection error nobody can act on. The contract — JSON in
on stdin, JSON out on stdout, bytes to a file — is deliberately narrow so it can
become an HTTP call later without this module's callers changing.

**A job, not a request.** A 60-slide PDF takes seconds; a client that lost its
connection midway would have no way to learn whether the work finished. So the
row is created first, the work happens after, and the client asks about the id.

**The report outlives the job.** Doc 04 §32.2 requires the user to see what was
degraded *before* they download, which means the report is stored rather than
streamed past.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .db.models import ExportJob
from .ids import new_id

logger = logging.getLogger("deckastra.exports")

#: Where artifacts land. Object storage is Phase 9; a directory is enough while
#: there is one machine, and putting the bytes in the database would make every
#: row read a megabyte.
EXPORT_ROOT = Path(os.environ.get("DECKASTRA_EXPORT_DIR", tempfile.gettempdir())) / "deckastra-exports"

#: A 60-slide PDF renders in about six seconds on a warm machine. This is the
#: point past which something is wrong rather than slow.
EXPORT_TIMEOUT_SECONDS = 300

KINDS = ("pdf", "pptx")


class ExportError(RuntimeError):
    """An export that failed, with a reason a user can read."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_job(
    session: Session,
    *,
    presentation_id: str,
    version_id: str,
    created_by: str,
    kind: str,
    options: dict[str, Any] | None = None,
) -> ExportJob:
    """Record the intent to export, before any work happens."""
    if kind not in KINDS:
        raise ExportError(f"{kind!r} is not an export format. Choose from: {', '.join(KINDS)}.")

    job = ExportJob(
        id=new_id("exp"),
        presentation_id=presentation_id,
        # The *version*, not the presentation. Doc 04 §32.3 keys artifact
        # stability on it, and a deck edited while the job runs must not silently
        # change what the file contains.
        version_id=version_id,
        created_by=created_by,
        kind=kind,
        status="queued",
        options_json=options or {},
    )
    session.add(job)
    session.flush()
    return job


def run_job(session: Session, job: ExportJob, document: dict[str, Any]) -> ExportJob:
    """Do the work and record the outcome.

    Synchronous. There is no queue yet, and a fake asynchronous endpoint that
    returns 202 and never finishes is worse than a slow one — this is the same
    call the worker loop will make when there is a queue in front of it.
    """
    job.status = "running"
    job.stage = "resolving"
    job.progress = 0.0
    session.flush()

    EXPORT_ROOT.mkdir(parents=True, exist_ok=True)
    output = EXPORT_ROOT / f"{job.id}.{job.kind}"

    try:
        outcome = _invoke_worker(job.kind, document, output, job.options_json or {})
    except ExportError as error:
        job.status = "failed"
        job.error = str(error)[:2000]
        job.finished_at = _now()
        session.flush()
        raise

    job.status = "completed"
    job.stage = "done"
    job.progress = 1.0
    job.artifact_path = str(output)
    job.filename = outcome["filename"]
    job.content_type = outcome["contentType"]
    job.bytes = int(outcome["bytes"])
    job.report_json = outcome["report"]
    job.finished_at = _now()
    session.flush()
    return job


def _invoke_worker(
    kind: str, document: dict[str, Any], output: Path, options: dict[str, Any]
) -> dict[str, Any]:
    """Run the TypeScript exporter and read its answer."""
    root = Path(__file__).resolve().parents[3]

    # The document goes via a file rather than stdin alongside the invocation: a
    # 60-slide deck is megabytes of JSON, and a pipe that large is a place for
    # a deadlock between writing and the child reading.
    with tempfile.NamedTemporaryFile(
        "w", suffix=".mydeck.json", delete=False, encoding="utf-8"
    ) as handle:
        json.dump(document, handle)
        document_path = handle.name

    invocation = json.dumps(
        {
            "kind": kind,
            "output": str(output),
            "documentPath": document_path,
            "options": options,
        }
    )

    try:
        finished = subprocess.run(
            ["npx", "tsx", "apps/worker/src/cli.ts"],
            cwd=root,
            input=invocation,
            capture_output=True,
            text=True,
            timeout=EXPORT_TIMEOUT_SECONDS,
            # `npx` is a shell script on Windows; without this the call fails
            # with a FileNotFoundError that says nothing about npx.
            shell=sys.platform == "win32",
        )
    except subprocess.TimeoutExpired as error:
        raise ExportError(
            f"The export did not finish within {EXPORT_TIMEOUT_SECONDS}s."
        ) from error
    finally:
        Path(document_path).unlink(missing_ok=True)

    for line in (finished.stderr or "").splitlines():
        # Progress arrives on stderr, one object per line, so stdout stays a
        # single parseable value. Logged rather than dropped: a slow export with
        # no trace of where it got to is an export nobody can debug.
        line = line.strip()
        if line.startswith("{"):
            logger.debug("export %s: %s", kind, line)

    payload = (finished.stdout or "").strip()
    if not payload:
        raise ExportError(
            f"The exporter produced no output (exit {finished.returncode}). "
            f"{(finished.stderr or '')[-400:]}"
        )

    try:
        answer = json.loads(payload.splitlines()[-1])
    except json.JSONDecodeError as error:
        raise ExportError(f"The exporter's answer could not be read: {payload[:200]}") from error

    if not answer.get("ok"):
        raise ExportError(answer.get("error") or "The export failed.")

    return answer


def describe(job: ExportJob) -> dict[str, Any]:
    """An export job as the UI shows it."""
    return {
        "id": job.id,
        "presentation_id": job.presentation_id,
        "version_id": job.version_id,
        "kind": job.kind,
        "status": job.status,
        "progress": job.progress,
        "stage": job.stage,
        "message": job.message,
        "filename": job.filename,
        "content_type": job.content_type,
        "bytes": job.bytes,
        # Doc 04 §32.2: the user sees this before the download, not after they
        # have sent the file to a client.
        "report": job.report_json or None,
        "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


def artifact_of(job: ExportJob) -> Path:
    """The file, or a reason it is not there."""
    if job.status != "completed" or not job.artifact_path:
        raise ExportError("This export has not finished.")

    path = Path(job.artifact_path)
    if not path.is_file():
        # An artifact that has been cleaned up. Saying so beats a 500 — the user
        # can re-export, and the job row is still the record that it happened.
        raise ExportError("This export's file is no longer available. Run it again.")

    return path
