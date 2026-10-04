from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from sqlalchemy import select
import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deckastra_api  # initializes the sibling package paths

from deckastra_agents.budgets import BudgetExceeded
from deckastra_api import credits
from deckastra_api.auth import provision_personal_account
from deckastra_api.credit_models import CreditAccount, CreditEntry, CreditReservation
from deckastra_api.db import session as db


@pytest.fixture(params=["sqlite", "postgres"])
def users(tmp_path, monkeypatch, request):
    url = f"sqlite:///{tmp_path / 'credits.db'}" if request.param == "sqlite" else request.getfixturevalue("postgres_url")
    monkeypatch.setenv("DATABASE_URL", url)
    for setting in ("DECKASTRA_GLOBAL_DAILY_USD", "DECKASTRA_ACCOUNT_DAILY_USD", "DECKASTRA_DEVICE_DAILY_USD"):
        monkeypatch.setenv(setting, "10")
    db.reset_engine()
    db.create_all()
    with db.session_scope() as session:
        users = [provision_personal_account(session, email=f"person{i}@example.com")[0].id for i in range(2)]
    yield users
    db.reset_engine()


def balance(user):
    with db.session_scope() as session:
        return credits.describe(credits.account(session, user))


def test_monthly_reset_preserves_calendar_anchor_after_february(users):
    with db.session_scope() as session:
        row = credits.account(session, users[0], datetime(2026, 1, 31, tzinfo=timezone.utc))
        row.balance_micros = 0
    with db.session_scope() as session:
        row = credits.account(session, users[0], datetime(2026, 2, 28, tzinfo=timezone.utc))
        assert row.balance_micros == 300000
        assert credits.utc(row.period_end).day == 31
        row.balance_micros = 1
    with db.session_scope() as session:
        row = credits.account(session, users[0], datetime(2026, 6, 15, tzinfo=timezone.utc))
        assert row.balance_micros == 300000
        assert credits.utc(row.period_start).day == 31
        assert credits.utc(row.period_end).day == 30


def test_uncertain_usage_is_held_and_reconciliation_is_idempotent(users):
    charge = credits.observer(users[0], task="authoring", model="pinned-model")
    charge("operation", .20, -1)
    assert balance(users[0])["remaining_credits"] == 20
    with pytest.raises(BudgetExceeded):
        charge("second", .11, -1)
    charge("operation", .20, .05)
    charge("operation", .20, .05)
    assert balance(users[0])["remaining_credits"] == 50
    with pytest.raises(ValueError):
        charge("operation", .20, 0)
    with db.session_scope() as session:
        reservation = session.get(CreditReservation, "operation")
        assert reservation.model == "pinned-model"
        assert reservation.actual_micros == 50000
        assert len(list(session.scalars(select(CreditEntry).where(CreditEntry.user_id == users[0])))) == 3


def test_accounts_are_isolated_and_other_account_cannot_refund(users):
    credits.observer(users[0])("a", .30, -1)
    assert balance(users[1])["remaining_credits"] == 60
    with pytest.raises(ValueError):
        credits.observer(users[1])("a", .30, 0)
    assert balance(users[0])["remaining_credits"] == 0


def test_concurrent_reservations_cannot_overspend(users):
    def reserve(index):
        try:
            credits.observer(users[0])(f"concurrent{index}", .20, -1)
            return True
        except BudgetExceeded:
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sum(pool.map(reserve, range(2))) == 1
    assert balance(users[0])["remaining_credits"] == 20


def test_global_and_device_daily_caps_span_accounts(users, monkeypatch):
    monkeypatch.setenv("DECKASTRA_GLOBAL_DAILY_USD", ".25")
    credits.observer(users[0], device_hash="same-device")("first", .20, -1)
    with pytest.raises(BudgetExceeded):
        credits.observer(users[1], device_hash="other")("global-cap", .10, -1)
    monkeypatch.setenv("DECKASTRA_GLOBAL_DAILY_USD", "10")
    monkeypatch.setenv("DECKASTRA_DEVICE_DAILY_USD", ".25")
    with pytest.raises(BudgetExceeded):
        credits.observer(users[1], device_hash="same-device")("device-cap", .10, -1)


def test_reservations_cannot_be_replayed(users):
    observer = credits.observer(users[0])
    observer("once", .01, -1)
    with pytest.raises(ValueError):
        observer("once", .01, -1)
    assert balance(users[0])["remaining_credits"] == 58
