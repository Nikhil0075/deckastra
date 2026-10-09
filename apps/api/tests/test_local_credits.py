"""The desktop shows the cloud account's credits, not its own ledger's (2026-10-05).

A desktop's local database has a credits table like any other install, and on
the desktop it describes nobody: the balance that pays for AI belongs to the
signed-in cloud account, reached through the main process's private gateway.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deckastra_api  # noqa: F401  initializes the sibling package paths

from deckastra_agents import gateway_client
from deckastra_agents.router import ModelUnavailable
from deckastra_api import gateway_routes, local_mode

CLOUD = {"plan": "free", "monthly_allowance": 60, "remaining_credits": 42.0,
         "period_start": "2026-10-01T00:00:00+00:00", "period_end": "2026-11-01T00:00:00+00:00"}


class Principal:
    user_id = "usr_local"


@pytest.fixture
def desktop(monkeypatch):
    monkeypatch.setattr(local_mode, "enabled", lambda: True)
    monkeypatch.setenv("DECKASTRA_GATEWAY_URL", "http://127.0.0.1:9")


def test_a_signed_in_desktop_reads_the_cloud_balance_through_the_gateway(desktop, monkeypatch):
    monkeypatch.setattr(gateway_client.GatewayClient, "__init__", lambda self, **_: None)
    monkeypatch.setattr(gateway_client.GatewayClient, "credits", lambda self: CLOUD)
    # No session is passed: the local ledger must not be consulted at all.
    assert gateway_routes.balance(principal=Principal(), session=None) == CLOUD


def test_a_signed_out_desktop_is_told_to_sign_in_rather_than_shown_a_local_number(desktop, monkeypatch):
    def refuse(self, **_):
        raise ModelUnavailable("Sign in to use Deckastra AI credits.")

    monkeypatch.setattr(gateway_client.GatewayClient, "__init__", refuse)
    with pytest.raises(HTTPException) as refused:
        gateway_routes.balance(principal=Principal(), session=None)
    assert refused.value.status_code == 503
    assert "Sign in" in refused.value.detail
