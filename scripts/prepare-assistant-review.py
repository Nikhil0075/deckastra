"""Prepare reproducible cases and empty independent-review forms without inference."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIMENSIONS = ("factual_grounding", "narrative_quality", "visual_consistency", "translation", "accessibility", "instruction_adherence")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-directory", required=True)
    parser.add_argument("--output-directory", required=True)
    args = parser.parse_args()
    output = Path(args.output_directory)
    output.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("assistant_benchmark", ROOT / "scripts/benchmark-assistant.py")
    benchmark = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(benchmark)
    reviews, summary = {}, []
    for path in sorted(Path(args.report_directory).glob("*.json")):
        report = json.loads(path.read_text(encoding="utf-8"))
        if "tasks" not in report or "cases" not in report:
            continue
        fixture_cases = [(task, index, *benchmark.fixture(task, index)) for task in report["tasks"] for index in range(int(report["tasks"][task]["metrics"]["samples"]))]
        digest = hashlib.sha256(json.dumps(fixture_cases, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if digest != report["dataset_sha256"]:
            raise ValueError("The corpus changed since evaluation; do not reconstruct review inputs from it.")
        inputs = {f"{task}-{index:02}": (request, snapshot) for task, index, request, snapshot in fixture_cases}
        for case in report["cases"]:
            request, snapshot = inputs[case["id"]]
            case["review_input"] = {"request": request, "metadata": snapshot["document"]["metadata"],
                "slide": next(s for s in snapshot["document"]["slides"] if s["id"] == case["slide_id"]),
                "vision": snapshot["vision"], "planning_fact": "A migration records schema changes; source db-guide." if case["task"] == "planning" else None}
            if case["task"] == "critique":
                case["review_input"]["document"] = snapshot["document"]
            reviews[case["id"]] = {"reviewer": "", "independent_of_system_author": False,
                "result_sha256": case["result_sha256"], "scores": {name: None for name in DIMENSIONS},
                "safety_failures": 0, "severe_regressions": 0, "notes": ""}
        (output / path.name).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        for task, record in report["tasks"].items():
            summary.append({"task": task, "model": record["model_id"], "runtime": record["runtime_id"],
                "location": record["location"], "cases": len(report["cases"]),
                "automatic_valid": sum(c["automatic_valid"] for c in report["cases"]),
                "metrics": record["metrics"], "qualified": record["qualified"]})
    (output / "reviews.template.json").write_text(json.dumps(reviews, indent=2), encoding="utf-8")
    (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    models = sorted({item["model"] for item in summary})
    heading = f"These {len(reviews)} synthetic advanced-deck cases were evaluated against {', '.join(models)}. Exact runtime IDs, locations and thinking settings are in the task reports. No task is qualified by this unreviewed report. The source corpus digest was checked while preparing the review pack. Each task report contains the actual result, automatic validation errors, usage and reconstructed scoped input.\n"
    (output / "README.md").write_text("# Independent assistant review\n\n" + heading + """

Copy `reviews.template.json` to a working review file. Someone other than the system author must inspect the input and output of each case, enter their name, confirm independence, assign every rubric score from 0 to 1, and record safety failures/severe regressions and notes. Scores of 0.8 describe publication-ready work with minor edits, and 1 fully meets the brief. Do not change result digests or invent scores for an uninspected result. Failed automatic cases cannot be made successful by a subjective score.

For critique, open `critique-review.html` in a browser. The offline form shows each recorded request, source deck, actual output and empty assessment fields. It saves drafts in that browser and downloads `critique-reviews.completed.json` only after all 20 cases are inspected and scored. Source deck/layout JSON is included; it is not a visual render. Put the completed review in the workspace and supply its path for rescoring. `scripts/prepare-critique-review.py` regenerates the form without inference.

Rescore without another paid request:

```powershell
python scripts/benchmark-assistant.py --rescore docs/evaluations/2026-10-05/critique.json --reviews PATH_TO_COMPLETED_REVIEWS --output .artifacts/reviewed-critique.json
```

Repeat for each task. Qualification also requires the pinned model/runtime/location, 20 cases, corpus coverage, first-attempt validity, task success, latency and zero safety/severe regression findings. Cleanup uses deterministic engines and made no model calls; its result does not qualify a Vertex cleanup model. The remaining unqualified tasks stay disabled. No automatic retry or fallback model is implied by this report.

The approved evaluation budget is US$30 total; the shared model ledger uses a US$25 ceiling, leaving US$5 headroom. Candidate pricing is pinned in docs/integrations/benchmarks/cloud-configuration.json and conservatively uses standard rates. Recorded model usage is an estimate, not a billing invoice; interrupted calls remain reserved until authoritative usage evidence is available. See [official pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) and [model configuration](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro), checked 2026-10-05.
""".replace("docs/evaluations/2026-10-05/critique.json", str(output / "critique.json").replace("\\", "/")), encoding="utf-8")
    print(f"Prepared {len(reviews)} review cases in {output}.")


if __name__ == "__main__":
    main()
