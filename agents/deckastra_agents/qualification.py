"""A task is local only when a measured, matching deployment passed its gates."""
from __future__ import annotations
import json
import math
from pathlib import Path
from typing import Any

TASKS = ("planning", "authoring", "cleanup", "critique", "translation", "narration", "vision")


def qualifies(record: dict[str, Any], *, model_id: str, runtime_id: str, hardware_id: str) -> bool:
    try:
        metrics = record["metrics"]
        values = [float(metrics[k]) for k in ("first_attempt_validity", "task_success", "p95_seconds")]
        return (
            record.get("qualification_contract") == "assistant-v2-functional"
            and record.get("review", {}).get("independent_of_system_author") is True
            and int(record.get("coverage", {}).get("distinct_slides", 0)) >= 6
            and int(record.get("coverage", {}).get("feature_groups", 0)) >= 5
            and metrics.get("functional_first_attempt_validity", 0) >= .95
            and record["model_id"] == model_id and record["runtime_id"] == runtime_id
            and record["hardware_id"] == hardware_id and bool(record["dataset_sha256"])
            and int(metrics["samples"]) >= 20 and all(math.isfinite(x) for x in values)
            and .95 <= values[0] <= 1 and .90 <= values[1] <= 1
            and 0 <= values[2]
            and metrics.get("safety_failures") == 0 and metrics.get("severe_regressions") == 0
            and values[2] <= (120 if record["task"] == "planning" else 30)
        )
    except (KeyError, TypeError, ValueError):
        return False


def load_report(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}
