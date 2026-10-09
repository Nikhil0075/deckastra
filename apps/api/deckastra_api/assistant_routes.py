"""Durable, bounded assistant jobs with short database transactions."""
from __future__ import annotations
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import math
import os
import threading
import time
import uuid
from dataclasses import asdict
import hashlib
from typing import Literal
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update, func
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from deckastra_agents.budgets import RunBudget, RunCancelled
from deckastra_agents.vertex_model import configured_image_client
from deckastra_agents.video_model import configured_video_client
from deckastra_agents.router import ModelUnavailable
from . import assets, author_service, store, proposals, object_storage, assistant_tasks, quotas, locales
from .assistant_assets import fingerprints, describe as describe_asset
from .assistant_models import AssistantRun, AssistantEvent, AssistantReservation
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.models import Asset, Workspace
from .db.session import get_session, session_scope
from .ids import new_id
from .patch import apply_patch

router = APIRouter(prefix="/v1/assistant")
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="deckastra-assistant")
_owner = uuid.uuid4().hex
_writes = threading.Lock()
_dispatch_lock = threading.Lock()
_pending: set[str] = set()


def submit(run_id):
    with _dispatch_lock:
        if run_id in _pending or len(_pending) >= 16:
            return
        _pending.add(run_id)
    def work():
        try:
            execute(run_id)
        finally:
            with _dispatch_lock:
                _pending.discard(run_id)
    future = _executor.submit(work)
    if future is None:  # deterministic test executor
        with _dispatch_lock:
            _pending.discard(run_id)


class Scope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["deck", "slide", "elements"] = "slide"
    slide_ids: list[str] = Field(default_factory=list, max_length=20)
    element_ids: list[str] = Field(default_factory=list, max_length=100)


class AssistantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: Literal["tidy", "motion", "image", "video", "speech", "export"]
    presentation_id: str = Field(min_length=1, max_length=64)
    expected_version_id: str = Field(min_length=1, max_length=64)
    operation_key: str = Field(min_length=8, max_length=64)
    instruction: str = Field(default="", max_length=4000)
    scope: Scope = Field(default_factory=Scope)
    quality: Literal["quality"] = "quality"
    locale: str = Field(default="en", pattern=r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$")
    voice: str = Field(default="default", max_length=100)
    source_asset_ids: list[str] = Field(default_factory=list, max_length=10)
    export_kind: Literal["pdf", "pptx", "mp4"] = "pdf"
    motion_entrance: str = Field(default="fade", max_length=40)
    motion_pacing: Literal["tight", "measured", "deliberate"] = "measured"
    # Unset means "as many click reveals as the slide already has", so re-planning
    # keeps narration cues attached to the clicks they were written for.
    motion_click_reveals: int | None = Field(default=None, ge=0, le=6)
    # Authored animation is never replaced unless the person asks for it.
    motion_replace: bool = False
    video_duration_seconds: Literal[4, 6, 8] = 4
    video_aspect_ratio: Literal["16:9", "9:16"] = "16:9"
    video_generate_audio: Literal[False] = False
    video_quote_token: str | None = Field(default=None, min_length=20, max_length=4096)
    image_quote_token: str | None = Field(default=None, min_length=20, max_length=4096)


def now():
    return datetime.now(timezone.utc)


def event(session, run_id, payload):
    sequence = session.scalar(update(AssistantRun).where(AssistantRun.id == run_id).values(event_seq=AssistantRun.event_seq + 1).returning(AssistantRun.event_seq))
    session.add(AssistantEvent(run_id=run_id, sequence=sequence, payload_json={**payload, "at": now().isoformat()}))


def emit(run_id, payload):
    with session_scope() as session:
        event(session, run_id, payload)


INTERRUPTED = "The worker stopped. Resume the saved checkpoint after checking usage."


def lease_expired(row):
    """A running run whose worker stopped renewing its lease.

    SQLite returns timezone-aware columns without their zone, so a naive value is
    read as the UTC it was written in.
    """
    lease = row.lease_until
    if row.status != "running" or lease is None:
        return False
    return (lease if lease.tzinfo else lease.replace(tzinfo=timezone.utc)) < now()


def result(row, *, summary=False):
    # Status reads compute "interrupted" rather than writing it: a poll that
    # issued an UPDATE contended for SQLite's single write lock with the worker
    # it was polling, and answered 500 "database is locked" instead of the run.
    # The dispatcher and resume persist the state; both are writers anyway.
    status, error = ("interrupted", INTERRUPTED) if lease_expired(row) else (row.status, row.error)
    return {"id": row.id, "presentation_id": row.presentation_id, "task": row.request_json["task"], "status": status, "result": None if summary else row.result_json, "error": error, "budget": row.budget_json, "last_sequence": row.event_seq, "created_at": row.created_at.isoformat(), "cancel_requested": row.cancel_requested}


def owned(session, principal, run_id):
    row = session.get(AssistantRun, run_id)
    if row is None or row.created_by != principal.user_id:
        raise HTTPException(404, "No such assistant run.")
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=row.presentation_id, require=Role.VIEWER)
    return row


SLIDE_SECONDS = 180
JOB_SECONDS = 1800
SLIDE_SECONDS_ENV = "DECKASTRA_ASSISTANT_SLIDE_SECONDS"


def job_seconds(task, slide_count):
    """The run's clock: per-slide allowance times slides, within the job ceiling."""
    try:
        per_slide = float(os.environ.get(SLIDE_SECONDS_ENV, "") or SLIDE_SECONDS)
        if not math.isfinite(per_slide) or per_slide <= 0:
            raise ValueError
    except ValueError:
        per_slide = SLIDE_SECONDS
    return min(JOB_SECONDS, max(per_slide, per_slide * slide_count)), per_slide


def model_client(emit_provider):
    return configured_image_client(emit=emit_provider)


def computed_checkpoint(value):
    if not value:
        return None
    return value.get("computed") if "model_cache" in value else value


class CheckpointClient:
    """Replay completed inference after interruption; never resend an uncertain call."""
    def __init__(self, inner, run_id):
        self.inner, self.run_id = inner, run_id
    def __getattr__(self, name):
        return getattr(self.inner, name)
    def complete(self, request, budget):
        from deckastra_agents.router import ModelResponse
        key = hashlib.sha256(json.dumps(asdict(request), sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with session_scope() as session:
            row = session.get(AssistantRun, self.run_id)
            cache = (row.checkpoint_json or {}).get("model_cache", {})
            cached = cache.get(key)
            old_operations = set(session.scalars(select(AssistantReservation.operation_id).where(AssistantReservation.run_id == self.run_id)))
        budget.check_clock()
        if cached:
            emit(self.run_id, {"status": "resumed", "message": "Reused a completed model response; no inference repeated"})
            payload = dict(cached["response"])
            return ModelResponse(**payload)
        answer = self.inner.complete(request, budget)
        with session_scope() as session:
            row = session.get(AssistantRun, self.run_id)
            if row.owner_id != _owner or row.status != "running":
                raise RunCancelled("The worker no longer owns this run.")
            state = dict(row.checkpoint_json or {})
            cache = dict(state.get("model_cache", {}))
            operations = set(session.scalars(select(AssistantReservation.operation_id).where(AssistantReservation.run_id == self.run_id))) - old_operations
            cache[key] = {"response": asdict(answer), "operation_ids": sorted(operations)}
            state["model_cache"] = cache
            row.checkpoint_json, row.budget_json = state, budget.report()
        return answer


def capabilities():
    from deckastra_agents.router import ModelRequest
    from . import speech
    tasks = {}
    spend = None
    try:
        if os.environ.get("DECKASTRA_CREDITS_ENABLED") != "1":
            ceiling = float(os.environ["DECKASTRA_ASSISTANT_MAX_COST_USD"])
            from deckastra_agents.cost_ledger import CostLedger
            spend = CostLedger(ceiling).snapshot()
    except (KeyError, ValueError, OSError):
        pass
    for task in AssistantRequest.model_fields["task"].annotation.__args__:
        provider, model, task_reason = "none", None, None
        reservation_estimate = None
        inputs = ["text", "document"]
        if task in {"export", "tidy", "motion"}:
            provider, task_reason = "export" if task == "export" else "engine", None
        elif task == "speech":
            status = speech.speech_status()
            provider = status["provider"]
            task_reason = None if status["available"] else status["reason"]
            if provider == "google":
                try:
                    from deckastra_agents.vertex_model import configuration
                    configuration()
                    rate = float(os.environ["DECKASTRA_SPEECH_USD_PER_MILLION"])
                    if not math.isfinite(rate) or rate < 0:
                        raise ValueError()
                except (ModelUnavailable, ValueError, KeyError) as exc:
                    task_reason = str(exc) or "Configure speech pricing and an assistant spend ceiling."
        elif task == "image":
            provider = "vertex"
            try:
                paid_client = configured_image_client()
                model = paid_client.model
                probe = ModelRequest("media", "", [], stage="image", max_tokens=4096, image_output=True)
                reservation_estimate = paid_client.estimate_reservation(probe)
                if spend is not None and reservation_estimate > spend["remaining_usd"]:
                    raise ModelUnavailable(f"This task needs at least US${reservation_estimate:.4f} reserved; US${spend['remaining_usd']:.4f} remains. Existing uncertain usage still counts against the ceiling.")
                task_reason = None
            except (ModelUnavailable, ImportError, ValueError) as exc:
                task_reason = str(exc)
        elif task == "video":
            provider = "vertex"
            try:
                paid_client = configured_video_client()
                if hasattr(paid_client, "video_capability"):
                    capability = paid_client.video_capability()
                    model = capability.get("model")
                    reservation_estimate = float(capability.get("usd_per_second") or 0) * 4
                else:
                    model = paid_client.model
                    reservation_estimate = paid_client.estimate_reservation(4)
                task_reason = None
            except (ModelUnavailable, ImportError, ValueError) as exc:
                task_reason = str(exc)
        tasks[task] = {"available": task_reason is None, "provider": provider, "model": model, "inputs": inputs, "reason": task_reason, "minimum_reservation_usd": reservation_estimate}
    return {"provider": "media", "available": any(t["available"] for t in tasks.values()), "reason": None, "tasks": tasks, "spend": spend}


def scoped_capabilities(value, document, scope, workspace_id, session, locale=None):
    """Read-only affordability for the selected document and speech scripts."""
    speech_task = value["tasks"]["speech"]
    if speech_task["available"] and speech_task["provider"] == "google":
        rate = float(os.environ["DECKASTRA_SPEECH_USD_PER_MILLION"])
        characters = 0
        for slide in document["slides"]:
            if scope["kind"] != "deck" and slide["id"] not in scope["slide_ids"]: continue
            for cue in slide.get("narration", {}).get("cues", []):
                script = locales.script_entry(document, slide["id"], cue, locale or locales.source_locale(document))
                if isinstance(script, dict): script = script.get(locale or locales.source_locale(document), script.get("source", ""))
                characters += len(script or "")
        speech_task["minimum_reservation_usd"] = characters * rate / 1_000_000
    for task in value["tasks"].values():
        if not task["available"] or task["provider"] not in {"vertex", "google"}: continue
        try:
            ceiling = workspace_ceiling(workspace_id)
            spent = sum(r.actual_usd if r.actual_usd is not None else r.reserved_usd for r in session.scalars(select(AssistantReservation).join(AssistantRun).where(AssistantRun.workspace_id == workspace_id)))
            remaining = min(max(0, ceiling - spent), (value.get("spend") or {}).get("remaining_usd", 0))
            needed = task.get("minimum_reservation_usd") or 0
            if needed > remaining:
                task["available"], task["reason"] = False, f"Selected scope requires US${needed:.4f} reserved; US${remaining:.4f} remains. Select fewer scripts or reconcile confirmed usage."
        except ModelUnavailable as exc:
            task["available"], task["reason"] = False, str(exc)
    return value


def workspace_ceiling(workspace_id):
    try:
        configured = json.loads(os.environ.get("DECKASTRA_WORKSPACE_ASSISTANT_CEILINGS", "{}"))
        ceiling = configured.get(workspace_id)
        if ceiling is None and os.environ.get("DECKASTRA_ENV", "development").lower() != "production":
            ceiling = os.environ.get("DECKASTRA_ASSISTANT_MAX_COST_USD")
        amount = float(ceiling)
        if not math.isfinite(amount) or amount <= 0:
            raise ValueError()
        return amount
    except (TypeError, ValueError, AttributeError):
        raise ModelUnavailable("Configure an explicit positive assistant spend ceiling for this workspace. The operator's total ceiling also applies.")


@router.get("/capabilities")
def assistant_capabilities(presentation_id: str | None = None, slide_id: str | None = None, locale: str | None = None, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    value = capabilities()
    if presentation_id:
        access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id)
        loaded = store.load_presentation(session, presentation_id)
        if slide_id and not any(s["id"] == slide_id for s in loaded.document["slides"]):
            raise HTTPException(404, "No such slide.")
        scope = {"kind": "slide" if slide_id else "deck", "slide_ids": [slide_id] if slide_id else []}
        value = scoped_capabilities(value, loaded.document, scope, access.workspace_id, session, locale)
    return value


@router.post("/runs", status_code=202)
def create_run(request: AssistantRequest, background: BackgroundTasks, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    required = "export" if request.task == "export" else "write"
    if required not in principal.scopes:
        raise HTTPException(403, f"This task requires {required} scope.")
    access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=request.presentation_id, require=Role.VIEWER if request.task == "export" else Role.EDITOR)
    payload = request.model_dump(mode="json")
    existing = session.scalar(select(AssistantRun).where(AssistantRun.created_by == principal.user_id, AssistantRun.operation_key == request.operation_key))
    if existing:
        if existing.request_json != payload:
            raise HTTPException(409, "This operation key was already used for a different request.")
        return result(existing)
    loaded = store.load_presentation(session, request.presentation_id)
    if loaded.version_id != request.expected_version_id:
        raise HTTPException(409, "The deck changed. Save and read the current version before starting.")
    if request.task == "video":
        if not request.video_quote_token:
            raise HTTPException(422, "Request and accept a video credit quote before generation.")
        from .media_quotes import verify_video_quote
        verify_video_quote(request.video_quote_token, user_id=principal.user_id,
                           presentation_id=request.presentation_id, prompt=request.instruction,
                           duration_seconds=request.video_duration_seconds,
                           aspect_ratio=request.video_aspect_ratio)
    if request.task == "image":
        if request.scope.kind != "slide" or len(request.scope.slide_ids) != 1:
            raise HTTPException(422, "Generated images require exactly one slide scope.")
        if not request.image_quote_token:
            raise HTTPException(422, "Request and accept an image credit quote before generation.")
        from .media_quotes import verify_service_quote
        slide_id = request.scope.slide_ids[0]
        quote_payload = {"presentation_id": request.presentation_id,
                         "expected_version_id": request.expected_version_id,
                         "slide_id": slide_id, "prompt": request.instruction}
        verify_service_quote(request.image_quote_token, kind="image", user_id=principal.user_id,
                             presentation_id=request.presentation_id, payload=quote_payload,
                             prompt=request.instruction)
    ids = {slide["id"] for slide in loaded.document["slides"]}
    if request.scope.kind != "deck" and (not request.scope.slide_ids or not set(request.scope.slide_ids) <= ids):
        raise HTTPException(422, "Choose existing slides for this scope.")
    if request.task == "motion":
        from .motion import KNOWN_PRESETS
        if request.motion_entrance not in KNOWN_PRESETS:
            raise HTTPException(422, "Choose a supported entrance preset.")
    if request.task == "export":
        own = locales.same_language(request.locale, locales.source_locale(loaded.document))
        if not own and request.locale not in (loaded.document.get("locales") or {}):
            raise HTTPException(422, f"This deck has no {request.locale} translation to export.")
    if request.scope.kind == "elements" and request.task in ("speech", "export", "image", "video", "motion"):
        raise HTTPException(422, "This task supports slide or deck scope.")
    if request.scope.kind == "elements" and not request.scope.element_ids:
        raise HTTPException(422, "Select elements for an elements scope.")
    if request.scope.kind == "elements":
        def element_ids(items):
            for item in items:
                yield item["id"]
                yield from element_ids(item.get("children", []))
        allowed = {eid for slide in loaded.document["slides"] if slide["id"] in request.scope.slide_ids for eid in element_ids(slide["elements"])}
        if not set(request.scope.element_ids) <= allowed:
            raise HTTPException(422, "Choose existing elements on the selected slides.")
    if session.scalar(select(func.count()).select_from(AssistantRun).where(AssistantRun.status.in_(["queued", "running"]))) >= 16:
        raise HTTPException(429, "The assistant queue is full. Wait for a running job to finish.")
    availability = scoped_capabilities(capabilities(), loaded.document, request.scope.model_dump(), access.workspace_id, session, request.locale)["tasks"][request.task]
    if not availability["available"]:
        raise HTTPException(503, availability["reason"])
    if availability["provider"] in {"vertex", "google"}:
        try:
            workspace_ceiling(access.workspace_id)
        except ModelUnavailable as exc:
            raise HTTPException(503, str(exc))
    row = AssistantRun(id=new_id("asr"), workspace_id=access.workspace_id, presentation_id=request.presentation_id, created_by=principal.user_id, operation_key=request.operation_key, request_json=payload, scopes_json=sorted(principal.scopes), status="queued", cancel_requested=False, event_seq=0)
    try:
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        existing = session.scalar(select(AssistantRun).where(AssistantRun.created_by == principal.user_id, AssistantRun.operation_key == request.operation_key))
        if existing and existing.request_json == payload:
            return result(existing)
        raise HTTPException(409, "This operation key was concurrently used for another request.")
    event(session, row.id, {"status": "queued", "message": "Assistant job queued"})
    session.flush()
    session.refresh(row)
    # Background dispatch runs after the middleware committed the request.
    background.add_task(submit, row.id)
    return result(row)


@router.get("/runs")
def list_runs(presentation_id: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id)
    rows = session.scalars(select(AssistantRun).where(AssistantRun.presentation_id == presentation_id, AssistantRun.created_by == principal.user_id).order_by(AssistantRun.created_at.desc()).limit(30)).all()
    return {"runs": [result(row, summary=True) for row in rows]}


def recover(session):
    """Persist interruption. Writers only: the dispatcher and resume, never a status read."""
    session.execute(update(AssistantRun).where(AssistantRun.status == "running", AssistantRun.lease_until < now()).values(status="interrupted", error=INTERRUPTED).execution_options(synchronize_session=False))


@router.get("/runs/{run_id}")
def get_run(run_id: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    return result(owned(session, principal, run_id))


@router.get("/runs/{run_id}/events")
def events(run_id: str, after: int = Query(0, ge=0), principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    owned(session, principal, run_id)
    rows = session.scalars(select(AssistantEvent).where(AssistantEvent.run_id == run_id, AssistantEvent.sequence > after).order_by(AssistantEvent.sequence).limit(100)).all()
    return {"events": [{"sequence": row.sequence, **row.payload_json} for row in rows]}


@router.get("/runs/{run_id}/stream")
def stream(run_id: str, after: int = Query(0, ge=0), principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    owned(session, principal, run_id)
    def updates():
        cursor = after
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            with session_scope() as current:
                owned(current, principal, run_id)
                run = current.get(AssistantRun, run_id)
                rows = current.scalars(select(AssistantEvent).where(AssistantEvent.run_id == run_id, AssistantEvent.sequence > cursor).order_by(AssistantEvent.sequence).limit(100)).all()
                pending = [(e.sequence, e.payload_json) for e in rows]
                terminal = run.status not in ("queued", "running") or lease_expired(run)
            for sequence, payload in pending:
                cursor = sequence
                yield f"id: {sequence}\nevent: progress\ndata: {json.dumps(payload)}\n\n"
            if terminal and len(pending) < 100:
                return
            if not pending:
                yield ": heartbeat\n\n"
                time.sleep(.5)
    return StreamingResponse(updates(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    row = owned(session, principal, run_id)
    if row.status in ("queued", "running", "interrupted"):
        row.cancel_requested = True
        if row.status != "running":
            row.status = "cancelled"
        event(session, row.id, {"status": "cancelling", "message": "Cancellation requested; completed changes and usage remain."})
    return result(row)


@router.post("/runs/{run_id}/resume", status_code=202)
def resume_run(run_id: str, background: BackgroundTasks, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    row = owned(session, principal, run_id)
    recover(session)
    session.refresh(row)
    if row.status != "interrupted":
        raise HTTPException(409, "Only interrupted runs can resume.")
    required = "export" if row.request_json["task"] == "export" else "write"
    if required not in principal.scopes:
        raise HTTPException(403, "The current credential cannot resume this task.")
    reservations = session.scalars(select(AssistantReservation).where(AssistantReservation.run_id == run_id)).all()
    cached_operations = {op for item in (row.checkpoint_json or {}).get("model_cache", {}).values() for op in item["operation_ids"]}
    cached_operations.update(item["operation_id"] for item in (row.checkpoint_json or {}).get("audio_cache", {}).values() if item.get("operation_id"))
    unreplayable = any(r.actual_usd and r.operation_id not in cached_operations for r in reservations)
    if any(r.actual_usd is None for r in reservations) or (unreplayable and not computed_checkpoint(row.checkpoint_json)):
        raise HTTPException(409, "Paid execution already occurred or has uncertain usage. This run cannot safely repeat it.")
    row.status, row.cancel_requested, row.error = "queued", False, None
    row.scopes_json = sorted(principal.scopes)
    event(session, row.id, {"status": "queued", "message": "Resuming saved work"})
    background.add_task(submit, row.id)
    return result(row)


def execute(run_id):
    try:
        _execute(run_id)
    except Exception as exc:
        with session_scope() as session:
            row = session.get(AssistantRun, run_id)
            if row is not None and row.status in ("queued", "running"):
                row.status, row.error = "failed", public_error(exc)
                event(session, run_id, {"status": "failed", "message": row.error})


UNCHANGED = "The deck was not changed."


def _cause(exc, kind):
    """The first exception of `kind` in the cause chain, so a timeout wrapped as a
    model error and then as a stage failure is still recognised as a timeout."""
    seen = set()
    while exc is not None and id(exc) not in seen:
        if isinstance(exc, kind):
            return exc
        seen.add(id(exc))
        exc = exc.__cause__ or exc.__context__
    return None


def public_error(exc):
    """One sentence on what happened, that nothing changed, and what to try.

    Classified by exception type, never by message text. Model output and the
    repair prompts sent back to a model are not addressed to the person and can
    carry deck or source content, so they are never shown; the full diagnostic
    is kept in the run's checkpoint.
    """
    import httpx
    from deckastra_agents.budgets import BudgetExceeded
    from deckastra_agents.router import ModelError
    from .assistant_tasks import UserFacingError
    if isinstance(exc, HTTPException):
        return str(exc.detail)[:1000]
    if isinstance(exc, RunCancelled):
        return f"The job was cancelled. {UNCHANGED} Any usage so far is recorded in the run."
    if isinstance(exc, BudgetExceeded):
        if exc.budget == "time":
            return f"The job reached its {exc.limit:.0f}-second time limit before it finished. {UNCHANGED} Choose fewer slides, or try again."
        if exc.budget == "token":
            return f"The job used its whole token allowance before it finished. {UNCHANGED} Choose fewer slides or objects."
        return f"This job needs more cloud budget than remains (US${exc.used:.4f} against a US${exc.limit:.4f} ceiling, including held usage). {UNCHANGED} An operator can raise the ceiling or reconcile held usage."
    if isinstance(exc, UserFacingError):
        return str(exc)[:1000]
    unavailable = _cause(exc, ModelUnavailable)
    if unavailable:
        return f"{str(unavailable)[:600]} {UNCHANGED}"
    if _cause(exc, httpx.TimeoutException):
        return f"The image service did not answer before the job's time limit. {UNCHANGED} Try again."
    if isinstance(exc, ModelError):
        return f"The image service returned an error. {UNCHANGED} Try again; if it keeps happening, check the media configuration."
    return f"Something unexpected stopped the assistant. {UNCHANGED} The details are saved with the run for a bug report."


def start_dispatcher():
    stop = threading.Event()
    def dispatch():
        while not stop.is_set():
            try:
                with session_scope() as session:
                    recover(session)
                    ids = list(session.scalars(select(AssistantRun.id).where(AssistantRun.status == "queued").order_by(AssistantRun.created_at).limit(16)))
                for run_id in ids:
                    submit(run_id)
            except Exception:
                pass  # startup may still be migrating; retry without inventing progress
            stop.wait(5)
    threading.Thread(target=dispatch, daemon=True, name="assistant-dispatch").start()
    return stop


def asset_errors(session, before, after, workspace_id):
    """Model-written manifests cannot substitute paths or another workspace's assets."""
    old = {a["id"]: a for a in before.get("assets", [])}
    manifest = {a["id"]: a for a in after.get("assets", [])}
    errors = []
    for asset_id, entry in manifest.items():
        if old.get(asset_id) == entry:
            continue
        row = session.get(Asset, asset_id)
        if row is None or row.deleted_at or row.workspace_id != workspace_id:
            errors.append("The candidate references an unavailable workspace asset.")
        elif entry.get("storageKey") != row.storage_key or entry.get("type") != row.kind or entry.get("mimeType") != row.content_type or entry.get("byteSize") != row.bytes:
            errors.append("Asset storage paths and types must match the workspace registry.")
    old_ids = set(author_service._asset_ids(before))
    for asset_id in set(author_service._asset_ids(after)) - old_ids:
        row = session.get(Asset, asset_id)
        if asset_id not in manifest or row is None or row.deleted_at or row.workspace_id != workspace_id:
            errors.append("New asset references must be registered in this workspace.")
    return errors


def _execute(run_id):
    with session_scope() as session:
        claimed = session.execute(update(AssistantRun).where(AssistantRun.id == run_id, AssistantRun.status == "queued", AssistantRun.cancel_requested.is_(False)).values(status="running", owner_id=_owner, lease_until=now() + timedelta(seconds=30)))
        if claimed.rowcount != 1:
            return
        row = session.get(AssistantRun, run_id)
        request, checkpoint = dict(row.request_json), computed_checkpoint(row.checkpoint_json)
        principal = Principal(row.created_by, "", frozenset(row.scopes_json))
        access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=row.presentation_id, require=Role.VIEWER if request["task"] == "export" else Role.EDITOR)
        loaded = store.load_presentation(session, row.presentation_id)
        snapshot = {"run_id": run_id, "user_id": row.created_by, "project_id": access.project.id, "workspace_id": access.workspace_id, "document": loaded.document, "images": author_service.workspace_images(session, row.presentation_id)}
        snapshot["assets"] = [describe_asset(a) for a in session.scalars(select(Asset).where(Asset.workspace_id == access.workspace_id, Asset.deleted_at.is_(None)).limit(40)).all()]
        snapshot["sources"] = []
        snapshot["vision"] = []
        for asset_id in request.get("source_asset_ids", []):
            asset = session.get(Asset, asset_id)
            if asset is None or asset.workspace_id != access.workspace_id or asset.deleted_at:
                raise HTTPException(404, "No such source file.")
            data, mime = object_storage.read(asset.storage_key)
            if mime == "application/pdf":
                import io
                from pypdf import PdfReader
                text = "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages[:20])
            elif mime in ("text/plain", "text/csv"):
                text = data.decode("utf-8", errors="replace")
            else:
                raise HTTPException(422, "Generation sources support PDF, text and CSV files.")
            snapshot["sources"].append({"id": asset.id, "title": asset.filename, "mime_type": mime, "text": text[:12000]})
        event(session, run_id, {"status": "running", "message": "Preparing the requested task"})
    stop = threading.Event()
    def heartbeat():
        while not stop.wait(5):
            try:
                with session_scope() as session:
                    session.execute(update(AssistantRun).where(AssistantRun.id == run_id, AssistantRun.owner_id == _owner, AssistantRun.status == "running").values(lease_until=now() + timedelta(seconds=30)))
            except Exception:
                return
    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    def cancelled():
        with session_scope() as session:
            row = session.get(AssistantRun, run_id)
            return row is None or row.cancel_requested or row.status != "running" or row.owner_id != _owner
    ledger = None
    configured_ceiling = os.environ.get("DECKASTRA_ASSISTANT_MAX_COST_USD")
    if os.environ.get("DECKASTRA_CREDITS_ENABLED") != "1" and configured_ceiling and math.isfinite(float(configured_ceiling)) and float(configured_ceiling) > 0:
        from deckastra_agents.cost_ledger import CostLedger
        ledger = CostLedger(float(configured_ceiling))
    def observe(operation, reserved, actual, *, task=None, model=""):
        if os.environ.get("DECKASTRA_CREDITS_ENABLED") == "1":
            from .credits import observer
            observer(principal.user_id, task=task or request["task"], model=model)(operation, reserved, actual)
            with session_scope() as session:
                if actual < 0:
                    session.add(AssistantReservation(operation_id=operation, run_id=run_id, reserved_usd=reserved))
                else:
                    reservation = session.get(AssistantReservation, operation)
                    if reservation:
                        reservation.actual_usd = actual
            return
        if ledger:
            ledger.observe(operation, reserved, actual)
        try:
            observe_workspace(operation, reserved, actual)
        except Exception:
            if ledger and actual < 0:
                ledger.observe(operation, reserved, 0)  # no provider request was sent
            raise
    observe.for_call = lambda task, model: lambda *args: observe(*args, task=task, model=model)
    def observe_workspace(operation, reserved, actual):
        with session_scope() as session:
            if actual < 0:
                # Serialize workspace reservations across workers and processes.
                session.execute(update(Workspace).where(Workspace.id == snapshot["workspace_id"]).values(id=Workspace.id))
                spent = sum(r.actual_usd if r.actual_usd is not None else r.reserved_usd for r in session.scalars(select(AssistantReservation).join(AssistantRun).where(AssistantRun.workspace_id == snapshot["workspace_id"])))
                ceiling = workspace_ceiling(snapshot["workspace_id"])
                if spent + reserved > ceiling:
                    from deckastra_agents.budgets import BudgetExceeded
                    raise BudgetExceeded("workspace cost", ceiling, spent + reserved)
                session.add(AssistantReservation(operation_id=operation, run_id=run_id, reserved_usd=reserved))
            else:
                reservation = session.get(AssistantReservation, operation)
                if reservation:
                    reservation.actual_usd = actual
    ceiling = os.environ.get("DECKASTRA_ASSISTANT_MAX_COST_USD")
    slide_count = len(loaded.document["slides"]) if request["scope"]["kind"] == "deck" else len(request["scope"]["slide_ids"])
    wall_clock, snapshot["slide_seconds"] = job_seconds(request["task"], slide_count)
    budget = RunBudget(max_wall_clock_seconds=wall_clock, max_total_tokens=min(250000, max(60000, 18000 * slide_count)), cancelled=cancelled, max_cost_usd=float(ceiling) if ceiling else None, cost_observer=observe)
    if not budget.max_cost_usd or not math.isfinite(budget.max_cost_usd) or budget.max_cost_usd < 0:
        budget.max_cost_usd = None
    with session_scope() as session:
        for reservation in session.scalars(select(AssistantReservation).where(AssistantReservation.run_id == run_id)):
            if reservation.actual_usd is None:
                budget.reserved_cost_usd += reservation.reserved_usd
            else:
                budget.used_cost_usd += reservation.actual_usd
        row = session.get(AssistantRun, run_id)
        if row.budget_json:
            for field in ("used_tokens", "input_tokens", "output_tokens"):
                setattr(budget, field, int(row.budget_json.get(field, 0)))
    def speech_charge(characters):
        with session_scope() as session:
            session.execute(update(Workspace).where(Workspace.id == snapshot["workspace_id"]).values(id=Workspace.id))
            quotas.check_speech(session, snapshot["workspace_id"], characters)
            # Reservation is conservative if a provider's outcome is uncertain.
            quotas.record_speech(session, snapshot["workspace_id"], characters=characters)
    snapshot["speech_charge"] = speech_charge
    def speech_cached(key):
        with session_scope() as session:
            row = session.get(AssistantRun, run_id)
            cached = (row.checkpoint_json or {}).get("audio_cache", {}).get(key)
            return cached["media"] if cached else None
    def speech_save(key, media, operation):
        with session_scope() as session:
            row = session.get(AssistantRun, run_id)
            if row.owner_id != _owner or row.status != "running":
                raise RunCancelled("The worker no longer owns this run.")
            state = dict(row.checkpoint_json or {})
            state.setdefault("model_cache", {})
            cache = dict(state.get("audio_cache", {}))
            cache[key] = {"media": media, "operation_id": operation}
            state["audio_cache"] = cache
            row.checkpoint_json, row.budget_json = state, budget.report()
    snapshot.update(speech_cached=speech_cached, speech_save=speech_save)
    try:
        if loaded.version_id != request["expected_version_id"]:
            raise HTTPException(409, "The deck changed while the job was queued. Re-author against the current version.")
        if request["task"] == "export":
            checkpoint = {"export": True}
        elif not checkpoint:
            if request["task"] == "image":
                client = CheckpointClient(model_client(lambda payload: emit(run_id, {"status": "provider", **payload})), run_id)
            elif request["task"] == "video":
                client = configured_video_client()
            else:
                client = None
            checkpoint = assistant_tasks.compute(request, snapshot, client, budget, lambda e: emit(run_id, e if isinstance(e, dict) else e.to_dict()))
            budget.check_clock()
            with session_scope() as session:
                row = session.get(AssistantRun, run_id)
                state = dict(row.checkpoint_json or {})
                state["model_cache"] = state.get("model_cache", {})
                state["computed"] = checkpoint
                row.checkpoint_json, row.budget_json = state, budget.report()
                event(session, run_id, {"status": "validated", "message": "Validated output saved"})
        budget.check_clock()
        if checkpoint.get("media") and any("base64" in media for media in checkpoint["media"]):
            # Upload bounded media before acquiring the document write transaction.
            prepared = []
            for index, media in enumerate(checkpoint["media"]):
                budget.check_clock()
                if "base64" not in media:
                    prepared.append(media)
                    continue
                raw = base64.b64decode(media["base64"], validate=True)
                key = f"workspaces/{snapshot['workspace_id']}/assets/assistant/{run_id}/{index}.{media['extension']}"
                object_storage.put(key, raw, media["content_type"])
                digest, dhash = fingerprints(raw, media["content_type"])
                prepared.append({**{k: v for k, v in media.items() if k != "base64"}, "storage_key": key, "size_bytes": len(raw), "sha256": digest, "dhash64": dhash})
            checkpoint = {**checkpoint, "media": prepared}
            with session_scope() as session:
                row = session.get(AssistantRun, run_id)
                state = dict(row.checkpoint_json or {})
                state["model_cache"] = state.get("model_cache", {})
                state["computed"] = checkpoint
                row.checkpoint_json = state
        budget.check_clock()
        with _writes, session_scope() as session:
            # Acquire a write lock before reading cancellation/version state; SQLite ignores FOR UPDATE.
            session.execute(update(AssistantRun).where(AssistantRun.id == run_id, AssistantRun.owner_id == _owner).values(lease_until=now() + timedelta(seconds=30)))
            row = session.get(AssistantRun, run_id)
            if row.cancel_requested or row.status != "running" or row.owner_id != _owner:
                raise RunCancelled("Cancelled before applying the validated result.")
            access = resolve_presentation_access(session, user_id=principal.user_id, presentation_id=row.presentation_id, require=Role.VIEWER if request["task"] == "export" else Role.EDITOR)
            current = store.load_presentation(session, row.presentation_id)
            if current.version_id != request["expected_version_id"]:
                raise HTTPException(409, "The deck changed before the result could be proposed.")
            final = {k: v for k, v in checkpoint.items() if k not in {"operations", "metadata", "metadata_versions", "media"}}
            if checkpoint.get("operations"):
                candidate, _ = apply_patch(current.document, checkpoint["operations"])
                errors = author_service.check(current.document, checkpoint["operations"])
                errors += assistant_tasks.scope_errors(current.document, candidate, request["scope"], request["task"], request.get("locale"))
                errors += asset_errors(session, current.document, candidate, row.workspace_id)
                if errors:
                    raise HTTPException(422, "; ".join(errors[:5]))
                final.update(proposals.create_proposal(session, presentation_id=row.presentation_id, operations=checkpoint["operations"], intent=request["instruction"] or request["task"], created_by=row.created_by, run_id=run_id, agent_id=f"assistant:{request['task']}", expected_version_id=request["expected_version_id"], model_authored=request["task"] not in {"tidy", "motion"}, review_reason=checkpoint.get("requires_review")))
            if checkpoint.get("media"):
                final["assets"] = []
                media_operations = []
                manifest_exists = "assets" in current.document
                if request["task"] == "speech" and not manifest_exists:
                    media_operations.append({"op": "add", "path": "/assets", "value": []})
                working = current.document
                for index, media in enumerate(checkpoint["media"]):
                    key = media["storage_key"]
                    asset = assets.register(session, workspace_id=row.workspace_id, created_by=row.created_by, storage_key=key, kind=media["kind"], filename=f"assistant-{request['task']}-{index}.{media['extension']}", content_type=media["content_type"], size_bytes=media["size_bytes"], width=media.get("width"), height=media.get("height"), duration_ms=media.get("duration_ms"))
                    asset.sha256, asset.dhash64 = media["sha256"], media.get("dhash64")
                    asset.description = f"Generated by {media['provider']}"
                    final["assets"].append(describe_asset(asset))
                    if request["task"] == "speech":
                        media_operations.append({"op": "add", "path": "/assets/-", "value": {"id": asset.id, "type": "audio", "storageKey": key, "fileName": asset.filename, "mimeType": asset.content_type, "byteSize": asset.bytes, "durationMs": asset.duration_ms, "createdBy": "generated"}})
                        slide = next(s for s in working["slides"] if s["id"] == media["slide_id"])
                        cue = next(c for c in slide["narration"]["cues"] if c["id"] == media["cue_id"])
                        path = f"/slides/id:{slide['id']}/narration/cues/id:{cue['id']}/takes"
                        take = {"assetId": asset.id, "durationMs": asset.duration_ms, "voice": media["voice"], "textHash": media["text_hash"]}
                        media_operations.append({"op": "add", "path": path if not cue.get("takes") else f"{path}/{request['locale']}", "value": {request["locale"]: take} if not cue.get("takes") else take})
                    elif request["task"] in {"image", "video"}:
                        if not manifest_exists:
                            media_operations.append({"op": "add", "path": "/assets", "value": []})
                            manifest_exists = True
                        asset_type = "video" if media["kind"] == "video" else "image"
                        media_operations.append({"op": "add", "path": "/assets/-", "value": {"id": asset.id, "type": asset_type, "storageKey": key, "fileName": asset.filename, "mimeType": asset.content_type, "byteSize": asset.bytes, "width": asset.width, "height": asset.height, **({"durationMs": asset.duration_ms} if asset.duration_ms else {}), "createdBy": "generated"}})
                if request["task"] in {"image", "video"} and final["assets"]:
                    chosen = [slide for slide in current.document["slides"] if request["scope"]["kind"] == "deck" or slide["id"] in request["scope"]["slide_ids"]]
                    view = current.document["viewport"]
                    if request["task"] == "image":
                        placed = next(item for item in final["assets"] if item["kind"] == "image")
                        factor = min(view["width"] * .7 / placed["width"], view["height"] * .65 / placed["height"])
                        width, height = placed["width"] * factor, placed["height"] * factor
                        element = {"id": new_id("el"), "type": "image", "assetId": placed["id"], "fit": "contain", "transform": {"x": (view["width"] - width) / 2, "y": (view["height"] - height) / 2, "width": width, "height": height}, "altText": "Generated illustration requested as: " + request["instruction"][:400]}
                    else:
                        clip = next(item for item in final["assets"] if item["kind"] == "video")
                        poster = next(item for item in final["assets"] if item["kind"] == "image")
                        factor = min(view["width"] * .82 / clip["width"], view["height"] * .78 / clip["height"])
                        width, height = clip["width"] * factor, clip["height"] * factor
                        element = {"id": new_id("el"), "type": "video", "assetId": clip["id"], "posterAssetId": poster["id"], "fit": "cover", "autoplay": True, "loop": True, "muted": True, "controls": False, "startTimeMs": 0, "endTimeMs": clip["duration_ms"], "transform": {"x": (view["width"] - width) / 2, "y": (view["height"] - height) / 2, "width": width, "height": height}, "name": "Generated video: " + request["instruction"][:180]}
                    media_operations.append({"op": "add", "path": f"/slides/id:{chosen[0]['id']}/elements/-", "value": element})
                    final["warnings"] = [*final.get("warnings", []), f"Review the generated {request['task']} and placement before applying."]
                if media_operations:
                    errors = author_service.check(current.document, media_operations)
                    if errors:
                        raise HTTPException(422, "; ".join(errors[:3]))
                    candidate, _ = apply_patch(current.document, media_operations)
                    errors += assistant_tasks.scope_errors(current.document, candidate, request["scope"], request["task"], request.get("locale"))
                    errors += asset_errors(session, current.document, candidate, row.workspace_id)
                    if errors:
                        raise HTTPException(422, "; ".join(errors[:3]))
                    intent = "Create spoken narration" if request["task"] == "speech" else f"Place generated {request['task']}"
                    final.update(proposals.create_proposal(session, presentation_id=row.presentation_id, operations=media_operations, intent=intent, created_by=row.created_by, run_id=run_id, agent_id=f"assistant:{request['task']}", expected_version_id=current.version_id, model_authored=True))
            if checkpoint.get("export"):
                from . import export_service
                options = {"locale": request["locale"], "slideIds": request["scope"]["slide_ids"] if request["scope"]["kind"] != "deck" else None}
                job = export_service.create_job(session, presentation_id=row.presentation_id, version_id=current.version_id, created_by=row.created_by, kind=request["export_kind"], options=options, idempotency_key=run_id)
                final["export"] = export_service.describe(job)
            row.result_json, row.budget_json, row.status = final, budget.report(), "completed"
            event(session, run_id, {"status": "completed", "message": "Assistant task completed"})
    except Exception as exc:
        with session_scope() as session:
            row = session.get(AssistantRun, run_id)
            if row is not None and row.owner_id == _owner:
                row.status = "cancelled" if isinstance(exc, RunCancelled) else "failed"
                row.error = public_error(exc)
                state = dict(row.checkpoint_json or {})
                state["failure_diagnostic"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
                row.checkpoint_json = state
                row.budget_json = budget.report()
                event(session, run_id, {"status": row.status, "message": row.error})
    finally:
        stop.set()
