"""One evaluated Vertex model per task. No local or cross-provider fallback."""
from __future__ import annotations

import json
import os
import threading
from contextvars import ContextVar

from .qualification import load_report, qualifies
from .router import ModelRequest, ModelUnavailable
from .vertex_model import VertexClient, configuration, runtime_id

cost_observer = ContextVar("deckastra_account_cost_observer", default=None)
STAGES = {"story": "planning", "orchestrator": "planning", "author": "authoring",
          "creative": "planning", "layout": "planning", "motion": "planning", "critic": "critique"}


def task_of(request: ModelRequest) -> str:
    return STAGES.get(request.stage, request.stage or request.task_type)


class TaskVertexClient:
    supports_escalation = False

    def __init__(self, *, emit=None):
        self.emit = emit or (lambda event: None)
        self.clients = {}
        self.lock = threading.Lock()

    def route(self, request):
        return "vertex"

    def vertex_factory(self, task):
        config = configuration()
        try:
            models = json.loads(os.environ.get("DECKASTRA_VERTEX_MODELS", "{}"))
            model = models.get(task)
            if not isinstance(model, str) or not model:
                raise ValueError()
        except (ValueError, TypeError, AttributeError) as exc:
            raise ModelUnavailable(f"No evaluated Vertex model is pinned for {task}.") from exc
        evidence = load_report(os.environ.get("DECKASTRA_VERTEX_QUALIFICATION"))
        record = evidence.get("tasks", {}).get(task, {})
        if not qualifies(record, model_id=model, runtime_id=runtime_id(model, config), location=config["location"]):
            raise ModelUnavailable(f"Vertex {task} requires 20 representative cases and independent review for the exact model and thinking setting.")
        with self.lock:
            if model not in self.clients:
                self.clients[model] = VertexClient(model, config)
            return self.clients[model]

    def _prepare(self, request, budget):
        task = task_of(request)
        client = self.vertex_factory(task)
        observer = cost_observer.get()
        if observer is not None and budget.cost_observer is None:
            budget.cost_observer = observer
        if os.environ.get("DECKASTRA_ENV") == "production" and budget.cost_observer is None:
            raise ModelUnavailable("Hosted AI requires an authenticated account credit reservation.")
        self.emit({"provider": "vertex", "task": task, "model": client.model, "reason": "Evaluated task model"})
        return client

    def complete(self, request, budget):
        return self._prepare(request, budget).complete(request, budget)

    def stream(self, request, budget):
        yield from self._prepare(request, budget).stream(request, budget)


def configured_client(*, emit=None, **_legacy):
    if os.environ.get("DECKASTRA_LOCAL_MODE") == "1" and os.environ.get("DECKASTRA_GATEWAY_URL"):
        from .gateway_client import GatewayClient
        return GatewayClient(emit=emit)
    return TaskVertexClient(emit=emit)


def status():
    try:
        configured_client().vertex_factory("planning")
        return {"provider": "vertex", "available": True, "reason": None}
    except (ModelUnavailable, ImportError) as exc:
        return {"provider": "vertex", "available": False, "reason": str(exc)}
