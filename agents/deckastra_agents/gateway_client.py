"""Desktop inference through its private main-process account proxy."""
import os
from dataclasses import asdict
from types import SimpleNamespace
from urllib.parse import urlparse
import httpx
from .router import ModelError, ModelRequest, ModelResponse, ModelUnavailable, ToolInvocation


class GatewayClient:
    supports_escalation = False

    def __init__(self, *, emit=None):
        self.url = os.environ["DECKASTRA_GATEWAY_URL"].rstrip("/")
        self.secret = os.environ.get("DECKASTRA_GATEWAY_SECRET", "")
        parsed = urlparse(self.url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or len(self.secret) < 32:
            raise ModelUnavailable("The private desktop account bridge is not configured.")
        self.emit = emit or (lambda _: None)

    def _call(self, path, body=None):
        with httpx.Client(timeout=210, trust_env=False) as client:
            reply = client.request("POST" if body is not None else "GET", self.url + path,
                headers={"Authorization": f"Bearer {self.secret}"}, json=body)
        if reply.status_code in (401, 403):
            raise ModelUnavailable("Sign in to use Deckastra AI credits.")
        if reply.status_code != 200:
            detail = reply.json().get("detail", "The hosted AI task is unavailable.")
            raise ModelUnavailable(str(detail)[:500])
        return reply.json()

    def credits(self):
        """The signed-in account's balance, from the hosted ledger.

        The desktop's own database has a credits table too, and it describes
        nothing: the account whose credits pay for AI lives in the cloud.
        """
        return self._call("/credits")

    def route(self, request):
        return "vertex"

    def vertex_factory(self, task):
        capability = self._call("/capabilities").get("tasks", {}).get(task, {})
        if not capability.get("available"):
            raise ModelUnavailable(capability.get("reason") or f"The {task} task has not passed evaluation.")
        return SimpleNamespace(model=capability.get("model"), estimate_reservation=lambda _: capability.get("minimum_reservation_usd") or 0)

    def complete(self, request, budget):
        from .vertex_router import task_of
        budget.check_clock()
        task = task_of(request)
        body = {"task": task, "system": "\n\n".join([request.system, *request.context]),
            "messages": request.messages, "response_schema": request.response_schema,
            "images": [asdict(i) for i in request.images], "tools": [asdict(t) for t in request.tools],
            "max_tokens": request.max_tokens, "web_search": request.web_search, "image_output": request.image_output}
        value = self._call("/infer", body)
        answer = dict(value["response"])
        answer["tool_calls"] = [ToolInvocation(**c) for c in answer.get("tool_calls", [])]
        response = ModelResponse(**answer)
        budget.spend_tokens(response.input_tokens, response.output_tokens)
        budget.used_cost_usd += value.get("usage", {}).get("used_cost_usd", 0)
        self.emit({"provider": "vertex", "task": task, "model": response.model})
        return response

    def stream(self, request, budget):
        yield self.complete(request, budget)
