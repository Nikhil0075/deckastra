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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .db.models import ExportJob
from .ids import new_id
from .db.session import supports_row_locks

logger = logging.getLogger("deckastra.exports")

def export_root() -> Path:
    """Where artifacts land.

    A directory, not object storage and not the database: there is one machine,
    and putting the bytes in a row would make every row read a megabyte.

    Read on every call, not once at import. It used to be a module constant, so
    anything that set `DECKASTRA_EXPORT_DIR` after this module was first imported
    was silently ignored and exports went to the system temp directory — which is
    where every desktop export went: outside the one data directory a backup
    copies, on the system drive, and in a folder Windows' own cleanup may empty,
    so a finished export's "Download" could outlive its file. `local_server` now
    points this at the install's data directory, and reading it at call time is
    what makes that reliable rather than dependent on import order.
    `object_storage.local_root()` follows the same rule for the same reason.
    """
    configured = os.environ.get("DECKASTRA_EXPORT_DIR", "").strip()
    return Path(configured or tempfile.gettempdir()) / "deckastra-exports"

#: A 60-slide PDF renders in about six seconds on a warm machine. This is the
#: point past which something is wrong rather than slow.
EXPORT_TIMEOUT_SECONDS = 300
LEASE_SECONDS = 60

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
    idempotency_key: str | None = None,
) -> ExportJob:
    """Record the intent to export, before any work happens."""
    if kind not in KINDS:
        raise ExportError(f"{kind!r} is not an export format. Choose from: {', '.join(KINDS)}.")

    if idempotency_key:
        existing = session.scalar(
            select(ExportJob).where(
                ExportJob.presentation_id == presentation_id,
                ExportJob.created_by == created_by,
                ExportJob.idempotency_key == idempotency_key,
            )
        )
        if existing is not None:
            if existing.kind != kind or (existing.options_json or {}) != (options or {}):
                raise ExportError("This idempotency key was already used for a different export.")
            return existing

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
        idempotency_key=idempotency_key,
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
    if job.cancel_requested:
        return mark_cancelled(session, job)
    job.status = "running"
    job.stage = "resolving"
    job.progress = 0.0
    job.started_at = job.started_at or _now()
    if job.attempts == 0:
        job.attempts = 1
    session.flush()

    root = export_root()
    root.mkdir(parents=True, exist_ok=True)
    output = root / f"{job.id}.{job.kind}"

    try:
        outcome = _invoke_worker(job.kind, document, output, job.options_json or {})
    except ExportError as error:
        return record_failure(session, job, error)

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


def recover_expired(session: Session) -> int:
    """Requeue work whose owner disappeared, or exhaust its retry budget."""
    now = _now()
    expired = select(ExportJob).where(
        ExportJob.status == "running",
        ExportJob.lease_expires_at.is_not(None),
        ExportJob.lease_expires_at < now,
    )
    # Locked where the engine can; on SQLite there is one worker thread in one
    # process, which is what makes the unlocked read correct rather than lucky.
    if supports_row_locks(session):
        expired = expired.with_for_update(skip_locked=True)
    rows = session.scalars(expired).all()
    for job in rows:
        job.lease_owner = None
        job.lease_expires_at = None
        if job.cancel_requested:
            mark_cancelled(session, job)
        elif job.attempts >= job.max_attempts:
            job.status = "failed"
            job.error = "The export worker stopped repeatedly; retry the export."
            job.finished_at = now
        else:
            job.status = "queued"
            job.stage = "retrying"
            job.message = "The previous worker stopped; the export will resume on another worker."
            job.next_attempt_at = now
    session.flush()
    return len(rows)


def claim_next(session: Session, worker_id: str) -> ExportJob | None:
    recover_expired(session)
    now = _now()
    queued = (
        select(ExportJob)
        .where(
            ExportJob.status == "queued",
            or_(ExportJob.next_attempt_at.is_(None), ExportJob.next_attempt_at <= now),
        )
        .order_by(ExportJob.created_at, ExportJob.id)
    )
    if supports_row_locks(session):
        # Two workers must not claim one job. With no lock this relies on there
        # being exactly one, which a desktop install guarantees and a deployment
        # does not.
        queued = queued.with_for_update(skip_locked=True)
    job = session.scalar(queued.limit(1))
    if job is None:
        return None
    if job.cancel_requested:
        return mark_cancelled(session, job)
    job.status = "running"
    job.stage = "resolving"
    job.progress = 0.02
    job.message = "Resolving the requested presentation version."
    job.attempts += 1
    job.started_at = job.started_at or now
    job.lease_owner = worker_id
    job.lease_expires_at = now + timedelta(seconds=LEASE_SECONDS)
    session.flush()
    return job


def process_one(session: Session, worker_id: str) -> ExportJob | None:
    """Claim and execute one durable job; callers commit after every step."""
    job = claim_next(session, worker_id)
    if job is None or job.status == "cancelled":
        return job
    session.commit()  # make the lease visible before expensive rendering

    from . import store

    try:
        loaded = store.load_presentation(session, job.presentation_id, at_version=job.version_id)
    except Exception as error:  # permanent: the pinned version cannot be resolved
        job.status = "failed"
        job.error = f"The requested presentation version could not be loaded: {error}"[:2000]
        job.finished_at = _now()
        job.lease_owner = None
        job.lease_expires_at = None
        session.flush()
        return job

    job.stage = "rendering"
    job.progress = 0.15
    job.message = "Rendering slides."
    job.lease_expires_at = _now() + timedelta(seconds=LEASE_SECONDS)
    session.commit()
    return run_job(session, job, loaded.document)


def request_cancel(session: Session, job: ExportJob) -> ExportJob:
    if job.status in {"completed", "failed", "cancelled"}:
        return job
    job.cancel_requested = True
    if job.status == "queued":
        return mark_cancelled(session, job)
    job.message = "Cancellation requested; the worker will stop at the next boundary."
    session.flush()
    return job


def retry(session: Session, job: ExportJob) -> ExportJob:
    if job.status not in {"failed", "cancelled"}:
        raise ExportError("Only failed or cancelled exports can be retried.")
    job.status = "queued"
    job.stage = "queued"
    job.progress = 0.0
    job.error = None
    job.finished_at = None
    job.cancel_requested = False
    job.lease_owner = None
    job.lease_expires_at = None
    job.next_attempt_at = _now()
    job.attempts = 0
    session.flush()
    return job


def mark_cancelled(session: Session, job: ExportJob) -> ExportJob:
    job.status = "cancelled"
    job.stage = "cancelled"
    job.message = "Export cancelled."
    job.finished_at = _now()
    job.lease_owner = None
    job.lease_expires_at = None
    session.flush()
    return job


def record_failure(session: Session, job: ExportJob, error: Exception) -> ExportJob:
    job.error = str(error)[:2000]
    job.lease_owner = None
    job.lease_expires_at = None
    if job.cancel_requested:
        return mark_cancelled(session, job)
    if job.attempts < job.max_attempts:
        job.status = "queued"
        job.stage = "retrying"
        job.progress = 0.0
        job.message = f"Export failed; retry {job.attempts + 1} of {job.max_attempts} is scheduled."
        job.next_attempt_at = _now() + timedelta(seconds=min(60, 2 ** job.attempts))
    else:
        job.status = "failed"
        job.stage = "failed"
        job.finished_at = _now()
    session.flush()
    return job


def _worker_command() -> tuple[list[str], Path, bool]:
    """How to start the exporter, and from where.

    Two shapes, because the exporter runs in two very different places:

    - **A repository checkout** runs the TypeScript source through `npx tsx`, so a
      developer's change to the renderer is in the next export with no build step.
    - **A packaged desktop app** has no `npx`, no `node_modules` and no TypeScript.
      `DECKASTRA_WORKER_CMD` names a bundled JavaScript entry point and
      `DECKASTRA_WORKER_NODE` the runtime that runs it — Electron's own binary,
      run in Node mode, so nothing extra ships.

    The contract on the other side is identical either way: JSON in on stdin, JSON
    out on stdout, bytes to a file. That is what lets this be a configuration
    choice rather than two code paths through the caller.
    """
    root = Path(__file__).resolve().parents[3]

    configured = os.environ.get("DECKASTRA_WORKER_CMD", "").strip()
    if configured:
        node = os.environ.get("DECKASTRA_WORKER_NODE", "").strip() or sys.executable
        if not Path(configured).is_file():
            # Named but absent is a packaging mistake, and it is worth saying so
            # here: the alternative is a render that times out with the job stuck
            # on "rendering" and nothing anywhere naming the missing file.
            raise ExportError(f"The exporter is not installed at {configured}.")
        # `shell=False`: the path comes from the environment, and a shell would
        # give it a chance to be a command rather than a file.
        return [node, configured], Path(configured).parent, False

    return ["npx", "tsx", "apps/worker/src/cli.ts"], root, sys.platform == "win32"



#: Failures that mean "this build cannot render", not "this deck cannot be
#: exported". They deserve a sentence a user can act on rather than a module
#: loader's stack trace, because retrying will never help.
_MISSING_BROWSER = (
    "Cannot find package 'playwright'",
    "Cannot find module 'playwright'",
    "Executable doesn't exist",
    "browserType.launch",
)


def explain_export_failure(raw: str) -> str:
    """Turn an exporter failure into something a person can act on.

    Applied to both routes a failure can take — the exporter's own JSON answer and
    an exporter that printed nothing at all — because a missing browser produces
    one or the other depending on where the import happens, and a message that
    only covers one of them covers neither reliably.
    """
    if any(marker in raw for marker in _MISSING_BROWSER):
        return (
            "This build cannot render: the export browser is not installed with it. "
            "Exporting works in a development checkout; a packaged build needs the "
            f"browser component shipped alongside it. ({raw[-200:].strip()})"
        )
    return raw


def _no_output_reason(exit_code: int, stderr: str) -> str:
    """Explain an exporter that printed nothing.

    The raw stderr is kept, because it is the only diagnostic there is — but it
    is preceded by what actually went wrong when that is recognisable.
    """
    explained = explain_export_failure(stderr)
    if explained is not stderr:
        return explained
    return f"The exporter produced no output (exit {exit_code}). {stderr[-400:]}"


def _invoke_worker(
    kind: str, document: dict[str, Any], output: Path, options: dict[str, Any]
) -> dict[str, Any]:
    """Run the TypeScript exporter and read its answer."""

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

    command, cwd, needs_shell = _worker_command()

    try:
        finished = subprocess.run(
            command,
            cwd=cwd,
            input=invocation,
            capture_output=True,
            text=True,
            timeout=EXPORT_TIMEOUT_SECONDS,
            # `npx` is a shell script on Windows; without this the call fails
            # with a FileNotFoundError that says nothing about npx. A configured
            # binary needs no shell and must not get one.
            shell=needs_shell,
            # Electron's binary is a browser unless told otherwise. Without this
            # it opens a window and never reads stdin, and the export times out
            # with no explanation.
            env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"},
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
        raise ExportError(_no_output_reason(finished.returncode, finished.stderr or ""))

    try:
        answer = json.loads(payload.splitlines()[-1])
    except json.JSONDecodeError as error:
        raise ExportError(f"The exporter's answer could not be read: {payload[:200]}") from error

    if not answer.get("ok"):
        # The exporter reports its own failures as JSON, so a missing browser
        # arrives here rather than as an empty stdout — which is where the first
        # version of this check was, and why an installed build still showed a
        # module-loader message.
        raise ExportError(explain_export_failure(answer.get("error") or "The export failed."))

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
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "cancel_requested": job.cancel_requested,
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
