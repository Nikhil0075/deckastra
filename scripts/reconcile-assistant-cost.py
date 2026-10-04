#!/usr/bin/env python
"""List uncertain requests or reconcile one from operator-reviewed usage evidence.

Evidence JSON: operation_id, actual_usd, authority (provider_usage, cloud_billing
or transport_not_sent), reviewed_by, explanation, provider_request_id for billed
requests. Keep provider receipts alongside this evidence. No inference is sent.
"""
import argparse
import json
import os
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "agents"), str(ROOT / "apps/api")]
from deckastra_agents.cost_ledger import CostLedger


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--ceiling", type=float, required=True)
    parser.add_argument("--evidence")
    parser.add_argument("--database-url", help="Application database containing the matching reservation")
    args = parser.parse_args()
    ledger = CostLedger(args.ceiling, args.ledger)
    if not args.evidence:
        print(json.dumps({"spend": ledger.snapshot(), "outstanding": ledger.outstanding()}, indent=2))
        return
    evidence = json.loads(Path(args.evidence).read_text(encoding="utf-8-sig"))
    ledger.reconcile_evidence(evidence)
    if args.database_url:
        os.environ["DATABASE_URL"] = args.database_url
        from deckastra_api.db.session import session_scope
        from deckastra_api.assistant_models import AssistantReservation
        with session_scope() as session:
            reservation = session.get(AssistantReservation, evidence["operation_id"])
            if reservation is not None:
                if reservation.actual_usd is not None and reservation.actual_usd != evidence["actual_usd"]:
                    raise ValueError("Application usage conflicts with the evidence. Resolve this before resuming.")
                reservation.actual_usd = evidence["actual_usd"]
    print(json.dumps({"operation_id": evidence["operation_id"], "spend": ledger.snapshot()}, indent=2))


if __name__ == "__main__":
    main()
