#!/usr/bin/env python
"""Select passing pinned Vertex candidates by reviewed quality, then latency and cost."""
import argparse
import json
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agents"))
from deckastra_agents.qualification import qualifies


def select(reports):
    candidates = {}
    for report in reports:
        if report.get("provider") != "vertex":
            continue
        for task, record in report.get("tasks", {}).items():
            if not qualifies(record, model_id=record["model_id"], runtime_id=record["runtime_id"], hardware_id=record["hardware_id"]):
                continue
            cases = [c for c in report.get("cases", []) if c["task"] == task]
            scores = [score for c in cases for score in c.get("review", {}).get("scores", {}).values()]
            if not scores:
                continue
            score = sum(scores) / len(scores)
            cost = sum(float(c["usage"].get("used_cost_usd", 0)) for c in cases) / len(cases)
            candidates.setdefault(task, []).append((record["dataset_sha256"], -score, record["metrics"]["p95_seconds"], cost, record["model_id"]))
    result = {}
    for task, choices in candidates.items():
        if len({item[0] for item in choices}) != 1:
            raise ValueError(f"Candidates for {task} used different fixture datasets; compare the same fixtures.")
        selected = min(choices, key=lambda item: item[1:])
        result[task] = selected[-1]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", nargs="+")
    parser.add_argument("--output", required=True)
    parser.add_argument("--qualification-output", help="Write selected functional qualification records for runtime routing")
    args = parser.parse_args()
    reports = [json.loads(Path(path).read_text(encoding="utf-8")) for path in args.reports]
    mapping = select(reports)
    Path(args.output).write_text(json.dumps(mapping, indent=2), encoding="utf-8")
    if args.qualification_output:
        records = {task: next(report["tasks"][task] for report in reports if report.get("tasks", {}).get(task, {}).get("model_id") == model and report["tasks"][task].get("qualified")) for task, model in mapping.items()}
        Path(args.qualification_output).write_text(json.dumps({"tasks": records}, indent=2), encoding="utf-8")
    print(f"Selected passing candidates for {len(mapping)} tasks. Set DECKASTRA_VERTEX_MODELS to the resulting JSON map.")
