"""Measured E2B-first routing. Escalation is explicit and only for quality failures."""
from __future__ import annotations
import json
import os
import threading
import hashlib
from pathlib import Path
from typing import Any, Callable
from .budgets import RunBudget
from .qualification import load_report, qualifies
from .router import ModelClient, ModelError, ModelRequest, ModelUnavailable
from .vertex_model import VertexClient, configuration, runtime_id as vertex_runtime_id

_local_slot = threading.BoundedSemaphore(1)
STAGES = {"story": "planning", "orchestrator": "planning", "author": "authoring", "creative": "planning", "layout": "planning", "motion": "planning", "critic": "critique"}


def deployment_signature() -> str:
    """Bind measurements to the installed pack, context and serving configuration."""
    from .model_packs import selected_pack
    pack = selected_pack()
    manifest = (pack.directory / "pack.json").read_bytes() if pack else b""
    settings = {key: os.environ.get(key, "") for key in ("DECKASTRA_MODEL_SERVER_CMD", "DECKASTRA_ASSISTANT_RUNTIME", "DECKASTRA_ASSISTANT_HARDWARE")}
    # Supervised ports change on restart; backend service addresses bind web measurements.
    settings["backend_url"] = "" if settings["DECKASTRA_MODEL_SERVER_CMD"] else os.environ.get("DECKASTRA_MODEL_SERVER", "")
    return hashlib.sha256(manifest + json.dumps(settings, sort_keys=True).encode() + b"assistant-adapter-v4-functional-scope-chunking").hexdigest()


def task_of(request: ModelRequest) -> str:
    return STAGES.get(request.stage, request.stage or request.task_type)


class HybridClient:
    supports_escalation = True
    def __init__(self, local: Callable[[], ModelClient], vertex: Callable[[str], ModelClient], report: dict[str, Any], model_id: str, runtime_id: str, hardware_id: str, *, local_only: bool = False, emit: Callable[[dict], None] | None = None):
        self.local_factory, self.vertex_factory = local, vertex
        self.report, self.model_id, self.runtime_id, self.hardware_id = report, model_id, runtime_id, hardware_id
        self.local_only, self.emit = local_only, emit or (lambda event: None)
        self.escalated: set[str] = set()
        self._local = None

    def route(self, request: ModelRequest) -> str:
        task = task_of(request)
        record = self.report.get("tasks", {}).get(task, {})
        qualified = qualifies(record, model_id=self.model_id, runtime_id=self.runtime_id, hardware_id=self.hardware_id)
        return "local" if self.local_only or (qualified and task not in self.escalated) else "vertex"

    def escalate(self, request: ModelRequest, budget: RunBudget, reason: str) -> None:
        budget.check_clock()
        task = task_of(request)
        if self.local_only or self.route(request) == "vertex":
            raise ModelError("Quality validation failed; no further provider escalation is permitted.")
        self.escalated.add(task)
        self.emit({"provider": "vertex", "task": task, "reason": reason})

    def complete(self, request: ModelRequest, budget: RunBudget):
        budget.check_clock()
        provider = self.route(request)
        self.emit({"provider": provider, "task": task_of(request), "reason": ("Explicit local-only mode" if self.local_only else "Measured local qualification") if provider == "local" else "Local task unqualified or quality check failed"})
        if provider == "vertex":
            return self.vertex_factory(task_of(request)).complete(request, budget)
        while not _local_slot.acquire(timeout=.1):
            budget.check_clock()
        try:
            if self._local is None:
                self._local = self.local_factory()
            return self._local.complete(request, budget)
        finally:
            _local_slot.release()

    def stream(self, request, budget):
        budget.check_clock()
        provider = self.route(request)
        self.emit({"provider": provider, "task": task_of(request), "reason": ("Explicit local-only mode" if self.local_only else "Measured local qualification") if provider == "local" else "Local task unqualified or quality check failed"})
        if provider == "vertex":
            yield from self.vertex_factory(task_of(request)).stream(request, budget)
            return
        while not _local_slot.acquire(timeout=.1):
            budget.check_clock()
        try:
            if self._local is None:
                self._local = self.local_factory()
            stream = getattr(self._local, "stream", None)
            if stream:
                yield from stream(request, budget)
            else:
                yield self._local.complete(request, budget)
        finally:
            _local_slot.release()


def configured_client(*, local_factory=None, emit=None, mode: str | None = None) -> HybridClient:
    from .local_model import local_client
    mode = mode or os.environ.get("DECKASTRA_INTELLIGENCE", "hybrid")
    if mode not in ("local", "hybrid", "vertex"):
        raise ModelUnavailable("Assistant mode must be local, hybrid or vertex.")
    vertex_clients = {}
    vertex_lock = threading.Lock()
    def vertex(task):
        if mode == "local":
            raise ModelUnavailable("Local-only mode cannot use Vertex.")
        config = configuration()
        try:
            models = json.loads(os.environ["DECKASTRA_VERTEX_MODELS"])
            if not isinstance(models, dict) or not models:
                raise ValueError()
        except (KeyError, ValueError):
            raise ModelUnavailable("Configure DECKASTRA_VERTEX_MODELS as a pinned per-task model map.")
        model = models.get(task, models.get("default"))
        if not model:
            raise ModelUnavailable(f"No qualified Vertex model configured for {task}.")
        if task != "image":
            evidence = load_report(os.environ.get("DECKASTRA_VERTEX_QUALIFICATION"))
            record = evidence.get("tasks", {}).get(task, {})
            if not qualifies(record, model_id=model, runtime_id=vertex_runtime_id(model, config), hardware_id=config["location"]):
                raise ModelUnavailable(f"Vertex {task} requires representative functional benchmarks and a review independent of the system author.")
        with vertex_lock:
            if model not in vertex_clients:
                vertex_clients[model] = VertexClient(model, config)
            return vertex_clients[model]
    report = load_report(os.environ.get("DECKASTRA_ASSISTANT_QUALIFICATION")) if mode != "vertex" else {}
    if report and report.get("deployment_signature") != deployment_signature():
        report = {}  # stale hardware, runtime, context or pack; never reuse its qualification
    return HybridClient(local_factory or local_client, vertex, report,
        os.environ.get("DECKASTRA_ASSISTANT_PACK", "gemma4-e2b-q4"),
        os.environ.get("DECKASTRA_ASSISTANT_RUNTIME", ""), os.environ.get("DECKASTRA_ASSISTANT_HARDWARE", ""),
        local_only=mode == "local", emit=emit)


def status() -> dict[str, object]:
    mode = os.environ.get("DECKASTRA_INTELLIGENCE", "hybrid")
    try:
        client = configured_client(mode=mode)
        request = ModelRequest("planning", "", [], stage="planning")
        if client.route(request) == "vertex":
            client.vertex_factory("planning")
        else:
            from .local_model import local_client
            local_client()
        return {"provider": mode, "available": True, "reason": None}
    except (ModelUnavailable, ImportError) as exc:
        return {"provider": mode, "available": False, "reason": str(exc)}
