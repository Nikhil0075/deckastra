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
import time
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from . import assets as asset_service
from . import processes
from .db.models import ExportJob
from .ids import new_id
from .db.session import session_scope, supports_row_locks

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


class ExportCancelled(RuntimeError):
    """The user asked for this export to stop, and it did."""


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


def run_job(
    session: Session,
    job: ExportJob,
    document: dict[str, Any],
    should_cancel: "Callable[[], bool] | None" = None,
) -> ExportJob:
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
    # Committed, not flushed, and this is what makes cancellation possible at
    # all. A flush leaves a write transaction open for the whole render, and on
    # SQLite that blocks every other writer: the cancel request could not commit
    # its flag until the render had finished, so the watcher polled a value that
    # could not yet have changed and the job completed with `cancel_requested`
    # written afterwards against a stale snapshot. Nothing in the poll was wrong;
    # it was asking a database that was not allowed to answer.
    session.commit()

    root = export_root()
    root.mkdir(parents=True, exist_ok=True)
    output = root / f"{job.id}.{job.kind}"

    # The deck's pictures, loaded and authorized here rather than fetched by the
    # renderer, which has no session and no network (see `assets.inline_for_render`).
    # Without this an export of a deck with photographs arrives with a dashed
    # placeholder wherever one should be — the failure that looks like success.
    assets = asset_service.inline_for_render(
        session, presentation_id=job.presentation_id, document=document
    )

    try:
        outcome = _invoke_worker(
            job.kind,
            document,
            output,
            job.options_json or {},
            should_cancel=should_cancel,
            assets=assets,
        )
    except ExportCancelled:
        # Nothing to publish: a file from a render the user stopped is a file they
        # did not ask for, and leaving it would let a late artifact appear against
        # a job that says "cancelled".
        output.unlink(missing_ok=True)
        job.bytes = 0
        job.artifact_path = None
        return mark_cancelled(session, job)
    except ExportError as error:
        return record_failure(session, job, error)

    if should_cancel is not None and should_cancel():
        # Asked for while the render was finishing. Publishing anyway would end a
        # job the user stopped with a file they did not want, and a terminal state
        # of "completed" that contradicts what they pressed. Found by cancelling a
        # real export: a one-slide deck renders faster than the poll interval.
        output.unlink(missing_ok=True)
        job.bytes = 0
        job.artifact_path = None
        return mark_cancelled(session, job)

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


def cancellation_watcher(job_id: str) -> "Callable[[], bool]":
    """Ask, on its own connection, whether this job has been cancelled.

    It has to be a separate session. The worker holds an open transaction while it
    renders, and on SQLite — and under any snapshot isolation — it cannot see a
    flag another connection set after that transaction began. Reading it through
    the worker's own session is how "cancel" became a thing noticed only once the
    render had finished anyway.
    """

    def asked() -> bool:
        try:
            with session_scope() as watcher:
                row = watcher.get(ExportJob, job_id)
                return bool(row and row.cancel_requested)
        except Exception:  # noqa: BLE001 - a failed check must not kill the render
            logger.exception("Could not check whether export %s was cancelled", job_id)
            return False

    return asked


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
    return run_job(session, job, loaded.document, should_cancel=cancellation_watcher(job.id))


def request_cancel(session: Session, job: ExportJob) -> ExportJob:
    if job.status in {"completed", "failed", "cancelled"}:
        return job
    job.cancel_requested = True
    if job.status == "queued":
        return mark_cancelled(session, job)
    # The running worker polls this flag on its own connection and stops the
    # renderer — the browser included — rather than letting it finish into a file
    # nobody will read.
    job.message = "Stopping the export."
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


def _terminate_tree(process: "subprocess.Popen[str]") -> None:
    """Stop the renderer and everything it started.

    Killing the exporter alone is not enough: it starts a browser of its own — the
    app's Chromium in render-host mode — and on Windows that child survives its
    parent and keeps a profile directory and a GPU process alive.

    This was `taskkill /F /T`, whose tree walk goes through WMI — and on a machine
    with a damaged WMI repository it answers "Provider not found" to every call,
    silently, leaving the browser running after a cancelled export. `processes`
    walks the tree with a kernel call instead.
    """
    processes.terminate_tree(process)


def _invoke_worker(
    kind: str,
    document: dict[str, Any],
    output: Path,
    options: dict[str, Any],
    timeout: int | None = None,
    should_cancel: "Callable[[], bool] | None" = None,
    assets: list[dict[str, Any]] | None = None,
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

    # Base64 images, by the same argument and more so — a deck of photographs is
    # tens of megabytes, and that is exactly the pipe write a child reading its
    # invocation cannot drain.
    assets_path: str | None = None
    if assets:
        with tempfile.NamedTemporaryFile(
            "w", suffix=".assets.json", delete=False, encoding="utf-8"
        ) as handle:
            json.dump(assets, handle)
            assets_path = handle.name

    invocation = json.dumps(
        {
            "kind": kind,
            "output": str(output),
            "documentPath": document_path,
            **({"assetsPath": assets_path} if assets_path else {}),
            "options": options,
        }
    )

    command, cwd, needs_shell = _worker_command()
    limit = timeout or EXPORT_TIMEOUT_SECONDS

    process = subprocess.Popen(  # noqa: S603 - `shell` is decided above, per runtime
        command,
        cwd=cwd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        # UTF-8 both ways, stated. `text=True` alone means the locale's code page —
        # cp1252 on Windows — while the exporter speaks UTF-8, so every em dash
        # in a degradation message reached the export panel as "â€”" (found by the
        # `handoff` acceptance step), and a non-ASCII path would reach the
        # exporter garbled.
        encoding="utf-8",
        errors="replace",
        # `npx` is a shell script on Windows; without this the call fails with a
        # FileNotFoundError that says nothing about npx. A configured binary needs
        # no shell and must not get one.
        shell=needs_shell,
        # Electron's binary is a browser unless told otherwise. Without this it
        # opens a window and never reads stdin, and the export times out with no
        # explanation.
        env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"},
    )

    # Polled rather than waited on. `subprocess.run` blocks until the renderer is
    # finished, so "cancel" could only ever be a flag someone noticed afterwards:
    # the job was marked cancelled while a browser went on rendering a file
    # nobody would read. This checks between short waits and stops the work.
    deadline = time.monotonic() + limit
    stdout = stderr = ""
    to_send: str | None = invocation
    try:
        while True:
            try:
                stdout, stderr = process.communicate(to_send, timeout=CANCEL_POLL_SECONDS)
                break
            except subprocess.TimeoutExpired:
                # stdin is written once; `communicate` is resumed with nothing.
                to_send = None
                if should_cancel is not None and should_cancel():
                    _terminate_tree(process)
                    raise ExportCancelled("The export was cancelled.")
                if time.monotonic() > deadline:
                    _terminate_tree(process)
                    raise ExportError(f"The export did not finish within {limit}s.")
    finally:
        Path(document_path).unlink(missing_ok=True)
        # The asset payload is the larger of the two and holds real image bytes;
        # leaving it behind would put a copy of every exported picture in the
        # temp directory.
        if assets_path:
            Path(assets_path).unlink(missing_ok=True)

    class _Finished:
        pass

    finished = _Finished()
    finished.returncode = process.returncode  # type: ignore[attr-defined]
    finished.stdout = stdout  # type: ignore[attr-defined]
    finished.stderr = stderr  # type: ignore[attr-defined]

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


#: Doc 04 §41.4's MCP preview size. A slide at 1024 wide is legible to a person
#: and cheap to hand a model; the deck's own viewport decides the scale.
PREVIEW_WIDTH = 1024

#: How often a running render is asked whether it has been cancelled. Short
#: because the answer is a person waiting, and the check is one cheap read.
CANCEL_POLL_SECONDS = 0.25

#: A preview is something a caller waits on, unlike an export, which is a job.
PREVIEW_TIMEOUT_SECONDS = 90


#: The eight bytes every PNG starts with, written as numbers so no escape
#: sequence can be mangled on its way into this file.
_PNG_MAGIC = bytes([137, 80, 78, 71, 13, 10, 26, 10])


def _png_size(image: bytes) -> tuple[int, int]:
    """Width and height from the PNG's own IHDR chunk.

    Read from the bytes rather than derived from the requested scale: rounding
    decides the last pixel, and a caller that trusts a computed number gets a
    figure the file disagrees with.
    """
    if len(image) < 24 or image[:8] != _PNG_MAGIC:
        raise ExportError("The renderer did not return a PNG.")
    return int.from_bytes(image[16:20], "big"), int.from_bytes(image[20:24], "big")


def render_slide_png(
    document: dict[str, Any],
    slide_id: str,
    *,
    at_time: str = "final",
    assets: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """One slide as a PNG, through the same worker an export uses.

    Deliberately not a second rendering path. The same bundle, the same browser,
    the same no-network-at-render-time rules — a preview that rendered through
    anything else would be a picture of a deck this product would not export.

    The scale is derived from the document's own viewport rather than fixed, so a
    deck authored at a size other than 1920 wide still previews at `PREVIEW_WIDTH`
    instead of whatever its own dimensions imply.
    """
    viewport = document.get("viewport") or {}
    width = float(viewport.get("width") or 1920)
    scale = max(0.1, min(3.0, PREVIEW_WIDTH / width)) if width else 1.0

    root = export_root()
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False, dir=root) as handle:
        output = Path(handle.name)

    try:
        answer = _invoke_worker(
            "png",
            document,
            output,
            {"slideIds": [slide_id], "scale": scale, "atTime": at_time},
            timeout=PREVIEW_TIMEOUT_SECONDS,
            assets=assets,
        )
        image = output.read_bytes()
        pixels = _png_size(image)
        return {
            "bytes": image,
            # The image's own pixels, not the slide's logical size. The worker
            # reports the latter — 1920x1080 whatever the scale — and a caller
            # told that about a 1024-wide image has been told the wrong thing.
            "width": pixels[0],
            "height": pixels[1],
            "slide_width": int(answer.get("width") or 0),
            "slide_height": int(answer.get("height") or 0),
            "metrics_estimated": bool(answer.get("metricsEstimated")),
            # An agent looking at its own change has to be able to tell a picture
            # it could not load from a picture that is not there.
            "warnings": answer.get("warnings") or [],
        }
    finally:
        # A preview is not an artifact anyone downloads later; the bytes go back
        # in the response and the file has no reason to outlive the request.
        output.unlink(missing_ok=True)


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
