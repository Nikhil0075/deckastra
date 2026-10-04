"""Accept only this project's current, actual monthly budget breach."""
import base64
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import json

SERVICES = ("aiplatform.googleapis.com", "translate.googleapis.com", "texttospeech.googleapis.com")


def decision(envelope, expected, now=None):
    now = now or datetime.now(timezone.utc)
    try:
        if not isinstance(envelope, dict):
            return "invalid"
        message = envelope["message"]
        if not isinstance(message, dict):
            return "invalid"
        attributes = message["attributes"]
        if not isinstance(attributes, dict):
            return "invalid"
        for key in ("billingAccountId", "budgetId", "schemaVersion"):
            if attributes.get(key) != expected[key]:
                return "unrelated"
        encoded = message["data"]
        if not isinstance(encoded, str) or len(encoded) > 16000:
            return "invalid"
        payload = json.loads(base64.b64decode(encoded, validate=True),
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if not isinstance(payload, dict):
            return "invalid"
        if (payload["budgetDisplayName"] != expected["displayName"]
                or payload["currencyCode"] != "INR"
                or payload["budgetAmountType"] != "SPECIFIED_AMOUNT"):
            return "unrelated"
        if not isinstance(payload["costIntervalStart"], str):
            return "invalid"
        period = datetime.fromisoformat(payload["costIntervalStart"].replace("Z", "+00:00"))
        if period.tzinfo is None:
            return "invalid"
        period = period.astimezone(timezone.utc)
        # Monthly budgets start on day 1 (Google's budget timezone may add hours).
        if (period.year, period.month, period.day) != (now.year, now.month, 1) or period > now:
            return "stale"
        values = [payload["budgetAmount"], payload["costAmount"]]
        if any(isinstance(value, bool) for value in values):
            return "invalid"
        amount, cost = (Decimal(str(value)) for value in values)
        if not amount.is_finite() or not cost.is_finite() or amount != Decimal(expected["amount"]) or cost < 0:
            return "invalid"
        # Forecast-only notifications must never stop service.
        return "stop" if cost >= amount else "below"
    except (KeyError, TypeError, ValueError, InvalidOperation):
        return "invalid"
