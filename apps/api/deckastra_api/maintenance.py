"""Remove expired assistant payloads; retain only bounded usage metadata."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import delete, select
from .assistant_models import AssistantRun, AssistantEvent
from .account_models import AccountDeletion
from .credit_models import CreditDailyLimit


def expire_payloads(session):
    now = datetime.now(timezone.utc)
    for row in session.scalars(select(AssistantRun).where(AssistantRun.created_at < now - timedelta(days=1),
        AssistantRun.status.in_(["completed", "failed", "cancelled", "expired"]))):
        row.request_json = {"task": row.request_json.get("task", "unknown")}
        row.result_json, row.checkpoint_json, row.error = None, None, None
        session.execute(delete(AssistantEvent).where(AssistantEvent.run_id == row.id))
    for row in session.scalars(select(AssistantRun).where(AssistantRun.created_at < now - timedelta(days=7),
        AssistantRun.status.in_(["interrupted", "awaiting_approval"]))):
        row.status = "expired"
        row.request_json = {"task": row.request_json.get("task", "unknown")}
        row.result_json, row.checkpoint_json, row.error = None, None, None
        session.execute(delete(AssistantEvent).where(AssistantEvent.run_id == row.id))
    session.execute(delete(CreditDailyLimit).where(CreditDailyLimit.day < (now - timedelta(days=32)).date().isoformat()))
    for row in session.scalars(select(AccountDeletion).where(AccountDeletion.completed_at < now - timedelta(hours=2))):
        row.fingerprints_json = []
