"""Run an explicitly selected candidate against the shared approved cost ledger.

This evaluates a candidate; it never changes the production model map. Local
gcloud credentials remain in memory and are never included in reports.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "agents"), str(ROOT / "apps/api")]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--thinking", choices=("LOW", "MEDIUM", "HIGH"), required=True)
    parser.add_argument("--tasks", nargs="+", required=True)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--output-directory", required=True)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--ceiling", type=float, required=True)
    parser.add_argument("--project", default="deckastra")
    parser.add_argument("--gcloud-configuration", default="deckastra")
    parser.add_argument("--ip-family", choices=("auto", "ipv4"), default="auto")
    parser.add_argument("--worker-task", help=argparse.SUPPRESS)
    args = parser.parse_args()
    from deckastra_agents.qualification import TASKS
    if not 1 <= args.limit <= 20 or any(t not in TASKS for t in args.tasks):
        parser.error("Use known tasks and a case limit from 1 through 20.")
    config = json.loads((ROOT / "docs/integrations/benchmarks/cloud-configuration.json").read_text(encoding="utf-8"))
    prices = json.loads(config["DECKASTRA_VERTEX_PRICES"])
    if args.model not in prices:
        parser.error("Configure verified conservative prices before evaluating this model.")
    os.environ.update(DECKASTRA_VERTEX_PROJECT=args.project, DECKASTRA_VERTEX_LOCATION="global",
                      DECKASTRA_VERTEX_IDENTITY="attached", DECKASTRA_ASSISTANT_MAX_COST_USD=str(args.ceiling),
                      DECKASTRA_ASSISTANT_COST_LEDGER=str(Path(args.ledger).resolve()),
                      DECKASTRA_VERTEX_PRICES=json.dumps(prices),
                      DECKASTRA_VERTEX_IP_FAMILY=args.ip_family,
                      DECKASTRA_VERTEX_THINKING=json.dumps({args.model: args.thinking}))
    output = Path(args.output_directory).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.worker_task:
        if (output / "STOP").exists():
            print("Evaluation stopped before starting this queued task.", flush=True)
            return
        from deckastra_agents import vertex_model
        # gcloud manages refresh/re-authentication; do not print or persist tokens.
        import time
        cached = {"token": None, "expires": 0}
        def token():
            command = "gcloud.cmd" if os.name == "nt" else "gcloud"
            if time.monotonic() >= cached["expires"]:
                cached["token"] = subprocess.check_output([command, "auth", "print-access-token", "--configuration=" + args.gcloud_configuration], text=True).strip()
                cached["expires"] = time.monotonic() + 1800
            return cached["token"]
        vertex_model.token_provider = lambda _: token
        spec = importlib.util.spec_from_file_location("assistant_benchmark", ROOT / "scripts/benchmark-assistant.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.argv = ["benchmark", "--model", args.model, "--tasks", args.worker_task, "--limit", str(args.limit),
                    "--output", str(output / (args.worker_task + ".json"))]
        module.main()
        return
    from deckastra_agents.cost_ledger import CostLedger
    ledger = CostLedger(args.ceiling, args.ledger)
    print("Initial shared budget: " + json.dumps(ledger.snapshot()), flush=True)
    if any((output / (task + ".json")).exists() for task in args.tasks):
        parser.error("A report already exists; use a new directory to preserve previous evidence.")
    command = [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]
    def run(task):
        if (output / "STOP").exists():
            print(task + " skipped: stop requested", flush=True)
            return 0
        with (output / (task + ".log")).open("w", encoding="utf-8") as log:
            done = subprocess.run([*command, "--worker-task", task], cwd=ROOT, env=os.environ.copy(), stdout=log, stderr=subprocess.STDOUT)
        print(task + " exit=" + str(done.returncode), flush=True)
        return done.returncode
    with ThreadPoolExecutor(max_workers=2) as workers:
        codes = list(workers.map(run, args.tasks))
    print("Final shared budget: " + json.dumps(ledger.snapshot()), flush=True)
    if any(codes): raise SystemExit(1)


if __name__ == "__main__": main()
