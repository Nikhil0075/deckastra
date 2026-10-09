import base64
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys

import pytest

spec = importlib.util.spec_from_file_location("budget_policy", Path(__file__).parents[1] / "budget-stop" / "policy.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
EXPECTED = {"billingAccountId": "billing", "budgetId": "budget", "schemaVersion": "1.0", "displayName": "dev", "amount": "5000"}
NOW = datetime(2026, 10, 5, tzinfo=timezone.utc)


def message(**changes):
    data = {"budgetDisplayName": "dev", "currencyCode": "INR", "budgetAmountType": "SPECIFIED_AMOUNT",
            "costIntervalStart": "2026-10-01T07:00:00Z", "budgetAmount": 5000, "costAmount": 5000, **changes}
    return {"message": {"attributes": {k: EXPECTED[k] for k in ("billingAccountId", "budgetId", "schemaVersion")},
                        "data": base64.b64encode(json.dumps(data).encode()).decode()}}


def test_current_actual_breach_and_duplicate_are_stops():
    envelope = message(costAmount=5000.01)
    assert policy.decision(envelope, EXPECTED, NOW) == "stop"
    assert policy.decision(envelope, EXPECTED, NOW) == "stop"


def test_forecast_and_below_budget_do_not_stop():
    assert policy.decision(message(costAmount=4999.99, forecastThresholdExceeded=1.2), EXPECTED, NOW) == "below"


@pytest.mark.parametrize("changes", [
    {"currencyCode": "USD"}, {"budgetDisplayName": "other"}, {"budgetAmountType": "LAST_MONTH_COST"},
    {"budgetAmount": 6000}, {"costAmount": True}, {"costAmount": float("nan")},
    {"costAmount": float("inf")}, {"costAmount": -1}, {"costIntervalStart": "2026-09-01T07:00:00Z"},
    {"costIntervalStart": "2026-11-01T07:00:00Z"}, {"costIntervalStart": "2026-10-03T07:00:00Z"},
    {"costIntervalStart": "2026-10-01T00:00:00"},
    {"costIntervalStart": 123},
])
def test_wrong_or_invalid_billing_evidence_never_stops(changes):
    assert policy.decision(message(**changes), EXPECTED, NOW) != "stop"


@pytest.mark.parametrize("field", ["billingAccountId", "budgetId", "schemaVersion"])
def test_unrelated_budget_attributes(field):
    envelope = message()
    envelope["message"]["attributes"][field] = "other"
    assert policy.decision(envelope, EXPECTED, NOW) == "unrelated"


@pytest.mark.parametrize("envelope", [None, [], {}, {"message": {}}, {"message": None},
                                     {"message": {"attributes": None}}, {"message": {"attributes": {}, "data": "garbage"}}])
def test_bad_wrappers(envelope):
    assert policy.decision(envelope, EXPECTED, NOW) != "stop"


@pytest.fixture
def server(monkeypatch):
    for name, value in {"BILLING_ACCOUNT_ID": "billing", "BUDGET_ID": "budget", "BUDGET_NAME": "dev",
                        "BUDGET_AMOUNT": "5000", "PROJECT_NUMBER": "123"}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setitem(sys.modules, "policy", policy)
    spec = importlib.util.spec_from_file_location("budget_server", Path(__file__).parents[1] / "budget-stop" / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.google.auth, "default", lambda **_: (object(), None))
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    return module


def test_shutdown_is_idempotent_and_never_touches_other_services(server, monkeypatch):
    states = {service: "ENABLED" for service in policy.SERVICES}
    calls = []

    class Response:
        def __init__(self, data): self.data = data
        def json(self): return self.data
        def raise_for_status(self): pass

    class Session:
        def __init__(self, *_): pass
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def get(self, url, **_):
            if "/operations/" in url:
                return Response({"done": True})
            service = url.rsplit("/", 1)[1]
            assert service in policy.SERVICES
            return Response({"state": states[service]})
        def post(self, url, *, json, **_):
            service = url.rsplit("/", 1)[1].removesuffix(":disable")
            assert json == {"disableDependentServices": False, "checkIfServiceHasUsage": "SKIP"}
            calls.append(service)
            states[service] = "DISABLED"
            return Response({"name": "operations/test-operation"})

    monkeypatch.setattr(server, "AuthorizedSession", Session)
    assert server.stop_services() is True
    assert server.stop_services() is True
    assert calls == list(policy.SERVICES)


def test_partial_shutdown_failure_retries_and_attempts_all_services(server, monkeypatch):
    attempted = []

    class Session:
        def __init__(self, *_): pass
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def get(self, url, **_):
            attempted.append(url.rsplit("/", 1)[1])
            raise RuntimeError("permission denied")

    monkeypatch.setattr(server, "AuthorizedSession", Session)
    assert server.stop_services() is False
    assert attempted == list(policy.SERVICES)
