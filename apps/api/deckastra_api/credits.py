"""Transactional account ledger, monthly renewal and conservative uncertain usage."""
from __future__ import annotations

import calendar
import math
import os
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from deckastra_agents.budgets import BudgetExceeded
from .credit_models import CreditAccount, CreditDailyLimit, CreditEntry, CreditReservation
from .db.session import ensure_physical_transaction, session_scope
from .ids import new_id

MICROS_PER_CREDIT = 5000


def utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def next_month(value, anchor):
    year, month = (value.year + 1, 1) if value.month == 12 else (value.year, value.month + 1)
    return value.replace(year=year, month=month, day=min(anchor, calendar.monthrange(year, month)[1]))


def amount(usd):
    if not math.isfinite(usd) or usd < 0:
        raise ValueError("Usage must be finite and nonnegative.")
    return math.ceil(usd * 1_000_000)


def _insert_once(session, row):
    ensure_physical_transaction(session)
    try:
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        pass


def account(session, user_id, at=None):
    at = utc(at or datetime.now(timezone.utc))
    allowance = 60
    _insert_once(session, CreditAccount(user_id=user_id, plan="free", monthly_allowance=allowance,
        balance_micros=allowance * MICROS_PER_CREDIT, period_start=at,
        period_end=next_month(at, at.day), anchor_day=at.day))
    # A write locks the account on both PostgreSQL and SQLite, before reading it.
    session.execute(update(CreditAccount).where(CreditAccount.user_id == user_id).values(user_id=user_id))
    row = session.scalar(select(CreditAccount).where(CreditAccount.user_id == user_id).execution_options(populate_existing=True))
    if at >= utc(row.period_end):
        start = utc(row.period_end)
        end = next_month(start, row.anchor_day)
        while end <= at:
            start, end = end, next_month(end, row.anchor_day)
        row.period_start, row.period_end = start, end
        row.balance_micros = row.monthly_allowance * MICROS_PER_CREDIT
    grant_key = f"{user_id}:{utc(row.period_start).date().isoformat()}"
    # Each renewal is recorded once even when requests race.
    exists = session.scalar(select(CreditEntry.id).where(CreditEntry.operation_id == grant_key, CreditEntry.kind == "grant"))
    if exists is None:
        session.add(CreditEntry(id=new_id("cre"), user_id=user_id, operation_id=grant_key, kind="grant",
            amount_micros=row.monthly_allowance * MICROS_PER_CREDIT, created_at=at))
    session.flush()
    return row


def describe(row):
    return {"plan": row.plan, "monthly_allowance": row.monthly_allowance,
        "remaining_credits": max(0, row.balance_micros) / MICROS_PER_CREDIT,
        "period_start": utc(row.period_start).isoformat(), "period_end": utc(row.period_end).isoformat()}


def observer(user_id, *, task="model", model="", device_hash=""):
    def observe(operation_id, reserved, actual):
        maximum = amount(reserved)
        at = datetime.now(timezone.utc)
        day = at.date().isoformat()
        scopes = [("global", "DECKASTRA_GLOBAL_DAILY_USD", "10"),
                  (f"account:{user_id}", "DECKASTRA_ACCOUNT_DAILY_USD", "0.30"),
                  (f"device:{device_hash or user_id}", "DECKASTRA_DEVICE_DAILY_USD", "0.30")]
        with session_scope() as session:
            # Every reservation locks the global daily row first, then account.
            # This also makes concurrent first-use inserts and limits deterministic.
            for scope, _, _ in scopes:
                _insert_once(session, CreditDailyLimit(scope=scope, day=day, spent_micros=0, requests=0))
                session.execute(update(CreditDailyLimit).where(CreditDailyLimit.scope == scope, CreditDailyLimit.day == day).values(scope=scope))
            row = account(session, user_id, at)
            reservation = session.get(CreditReservation, operation_id)
            if actual < 0:
                if reservation is not None:
                    raise ValueError("This provider operation was already reserved; do not replay it.")
                if maximum > row.balance_micros:
                    raise BudgetExceeded("account cost", row.balance_micros / 1e6, maximum / 1e6)
                for scope, setting, default in scopes:
                    limit = session.get(CreditDailyLimit, (scope, day))
                    ceiling = amount(float(os.environ.get(setting, default)))
                    if limit.spent_micros + maximum > ceiling or limit.requests >= int(os.environ.get("DECKASTRA_DAILY_REQUEST_CAP", "200")):
                        raise BudgetExceeded("daily cost", ceiling / 1e6, (limit.spent_micros + maximum) / 1e6)
                    limit.spent_micros += maximum
                    limit.requests += 1
                row.balance_micros -= maximum
                session.add(CreditReservation(operation_id=operation_id, user_id=user_id, reserved_micros=maximum,
                    actual_micros=None, period_start=row.period_start, created_at=at, task=task, model=model, device_hash=device_hash))
                session.add(CreditEntry(id=new_id("cre"), user_id=user_id, operation_id=operation_id, kind="charge", amount_micros=-maximum, created_at=at))
            else:
                if reservation is None or reservation.user_id != user_id:
                    raise ValueError("No account reservation exists for this operation.")
                actual_micros = amount(actual)
                if reservation.actual_micros is not None:
                    if reservation.actual_micros != actual_micros:
                        raise ValueError("Usage was already reconciled to a different amount.")
                    return
                refund = reservation.reserved_micros - actual_micros
                reservation.actual_micros = actual_micros
                if utc(reservation.period_start) == utc(row.period_start):
                    row.balance_micros += refund
                original_day = utc(reservation.created_at).date().isoformat()
                for scope in ("global", f"account:{user_id}", f"device:{reservation.device_hash or user_id}"):
                    limit = session.get(CreditDailyLimit, (scope, original_day))
                    if limit is not None:
                        limit.spent_micros -= refund
                session.add(CreditEntry(id=new_id("cre"), user_id=user_id, operation_id=operation_id,
                    kind="refund" if refund >= 0 else "charge_adjustment", amount_micros=refund, created_at=at))
    observe.for_call = lambda call_task, call_model: observer(user_id, task=call_task, model=call_model, device_hash=device_hash)
    return observe
