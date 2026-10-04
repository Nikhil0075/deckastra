"""Durable shared ceiling for benchmark and application paid requests on this host.

Distributed services must configure a shared ledger path in addition to the
workspace's database reservation authority. Uncertain calls stay reserved.
"""
from __future__ import annotations
import math
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from .budgets import BudgetExceeded


class CostLedger:
    def __init__(self, ceiling: float, path: str | Path | None = None):
        if not math.isfinite(ceiling) or ceiling <= 0:
            raise ValueError("A positive finite spend ceiling is required.")
        self.ceiling = ceiling
        self.path = Path(path or os.environ.get("DECKASTRA_ASSISTANT_COST_LEDGER") or
                         (Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local/share"))) / "Deckastra/assistant/cost-ledger.sqlite"))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path, timeout=10) as db:
            db.execute("CREATE TABLE IF NOT EXISTS calls (operation TEXT PRIMARY KEY, reserved REAL NOT NULL, actual REAL)")
            db.execute("CREATE TABLE IF NOT EXISTS reconciliations (operation TEXT PRIMARY KEY, evidence_sha256 TEXT NOT NULL, evidence_json TEXT NOT NULL, reconciled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")

    def snapshot(self):
        with sqlite3.connect(self.path, timeout=10) as db:
            count, used, held = db.execute("SELECT COUNT(*), COALESCE(SUM(actual),0), COALESCE(SUM(CASE WHEN actual IS NULL THEN reserved ELSE 0 END),0) FROM calls").fetchone()
        return {"ceiling_usd": self.ceiling, "used_usd": used, "reserved_usd": held,
                "remaining_usd": max(0, self.ceiling - used - held), "calls": count}

    def observe(self, operation: str, reserved: float, actual: float):
        if not math.isfinite(reserved) or reserved < 0 or not math.isfinite(actual):
            raise ValueError("Usage must have finite nonnegative reserved amounts.")
        with sqlite3.connect(self.path, timeout=10) as db:
            db.execute("BEGIN IMMEDIATE")
            if actual < 0:
                if db.execute("SELECT 1 FROM calls WHERE operation=?", (operation,)).fetchone():
                    raise ValueError("A paid operation identifier cannot be reused.")
                spent = db.execute("SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM calls").fetchone()[0]
                if spent + reserved > self.ceiling:
                    raise BudgetExceeded("total assistant cost", self.ceiling, spent + reserved)
                db.execute("INSERT INTO calls(operation,reserved) VALUES (?,?)", (operation, reserved))
            else:
                updated = db.execute("UPDATE calls SET actual=? WHERE operation=? AND actual IS NULL", (actual, operation))
                if updated.rowcount != 1:
                    raise ValueError("Only an outstanding paid reservation can be reconciled.")

    def outstanding(self):
        with sqlite3.connect(self.path, timeout=10) as db:
            return [{"operation_id": op, "reserved_usd": amount} for op, amount in db.execute("SELECT operation,reserved FROM calls WHERE actual IS NULL ORDER BY operation")]

    def reconcile_evidence(self, evidence):
        """Operator reconciliation with recorded authoritative evidence; never guess."""
        operation, actual = evidence["operation_id"], float(evidence["actual_usd"])
        authority = evidence.get("authority")
        if authority not in {"provider_usage", "cloud_billing", "transport_not_sent"} or not evidence.get("reviewed_by") or not evidence.get("explanation"):
            raise ValueError("Record an authoritative usage source, reviewer and explanation.")
        if not math.isfinite(actual) or actual < 0 or authority == "transport_not_sent" and actual != 0:
            raise ValueError("Confirmed unsent requests cost zero; billed usage must be finite and nonnegative.")
        if authority != "transport_not_sent" and not evidence.get("provider_request_id"):
            raise ValueError("Provider or billing evidence must identify the paid request.")
        encoded = json.dumps(evidence, sort_keys=True, ensure_ascii=False)
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        with sqlite3.connect(self.path, timeout=10) as db:
            db.execute("BEGIN IMMEDIATE")
            prior = db.execute("SELECT evidence_sha256 FROM reconciliations WHERE operation=?", (operation,)).fetchone()
            if prior:
                if prior[0] != digest:
                    raise ValueError("This operation was already reconciled against different evidence.")
                return
            updated = db.execute("UPDATE calls SET actual=? WHERE operation=? AND actual IS NULL", (actual, operation))
            if updated.rowcount != 1:
                raise ValueError("Only an outstanding paid reservation can be reconciled.")
            db.execute("INSERT INTO reconciliations(operation,evidence_sha256,evidence_json) VALUES (?,?,?)", (operation, digest, encoded))
