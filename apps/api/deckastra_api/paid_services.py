"""Account reservations for deterministic Google services with character pricing."""
import math
import os
import uuid
from contextlib import contextmanager
from deckastra_agents.budgets import RunBudget
from deckastra_agents.router import ModelUnavailable
from deckastra_agents.vertex_router import cost_observer


@contextmanager
def billed(task, characters, price_setting, *, budget=None):
    if os.environ.get("DECKASTRA_CREDITS_ENABLED") != "1" and budget is None:
        yield
        return
    try:
        rate = float(os.environ[price_setting])
        if not math.isfinite(rate) or rate <= 0:
            raise ValueError()
    except (KeyError, ValueError) as error:
        raise ModelUnavailable(f"Configure verified {task} character pricing before enabling it.") from error
    if budget is None:
        observer = cost_observer.get()
        if observer is None:
            raise ModelUnavailable("Paid Google services require an authenticated account.")
        budget = RunBudget(max_cost_usd=float(os.environ.get("DECKASTRA_ASSISTANT_MAX_COST_USD", "0.30")), cost_observer=observer)
    maximum = characters * rate / 1_000_000
    operation = uuid.uuid4().hex
    budget.reserve_cost(operation, maximum, task=task, model=task)
    try:
        yield
    except Exception as error:
        import httpx
        cause = error.__cause__ or error
        if isinstance(cause, httpx.HTTPStatusError) and cause.response.status_code in (400, 401, 403, 404, 429):
            budget.reconcile_cost(operation, maximum, 0)
        raise
    else:
        budget.reconcile_cost(operation, maximum, maximum)
