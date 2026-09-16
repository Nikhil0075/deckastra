"""Drive the **whole graph** on a local model, on briefs it has not seen.

`benchmark-model-pack.py` measures one node. That answered D3's risky question —
can a 4B hold a nested contract with a closed enum and citation ids — but it is
not what a user does. A user asks for a deck, and the graph then runs research,
story, a creative direction, a layout, motion and a critic, each with its own
contract, each paying its own minutes. The 15–20 minute figure in `CLAUDE.md` for
a full deck is an **extrapolation** from one node's median, and a review said so
(2026-09-16). This is the thing that replaces it with a measurement.

Four things it reports that the single-node harness cannot:

* **End-to-end wall clock**, per stage, for a deck someone would actually keep.
* **Where a local model falls over**, if it does. The story contract is the
  largest but the critic's is the most numerous — eight scores and a list of
  issues — and a model that holds one may not hold the other. A failure names
  the stage rather than the run.
* **Whether the result is usable**, not merely valid. The composed document goes
  through the product's own validator, so "it returned a plan" and "it produced a
  deck" are distinguished.
**Grounding is not measured here, and the flag that pretended to has been
removed** (2026-09-17). Injecting context blocks into `state["research"]` does
nothing: the research node *replaces* that key wholesale, and it is
repository-specific — it profiles connected repositories and writes questions a
code search can answer. These briefs are about warehouses and hospitals, so there
is no repository to ground them in and the injected blocks were silently
discarded. The first run of this harness reported `cited: []` and read like the
model ignoring its sources; it had none. Citation behaviour is measured by
`benchmark-model-pack.py`, which calls `story()` directly and so keeps the blocks
it injects. Measuring it through the whole graph needs a repository-grounded brief
against a real index, which is its own piece of work.

Briefs are held out: none of them appears in a prompt, a fixture or a test.

    python scripts/benchmark-full-generation.py --pack qwen3-4b-q4 --out run.json

Nothing here downloads anything. The pack must already be installed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agents"))
sys.path.insert(0, str(ROOT / "apps" / "api"))

from deckastra_agents.budgets import RunBudget  # noqa: E402
from deckastra_agents.runner import AgentRun, run_generation  # noqa: E402
from deckastra_agents.tools import ToolRegistry  # noqa: E402

#: Held out on purpose: none of these appears in a prompt, a fixture or a test,
#: so a good result cannot be the model repeating something it was shown.
BRIEFS = [
    {
        "instruction": (
            "Explain to a warehouse operations team why we are replacing handheld "
            "barcode scanners with wrist-mounted ones, what changes on day one, and "
            "what we will measure after a month."
        ),
        "slide_count": 6,
        "audience": "warehouse operations staff",
        "tone": "plain and practical",
    },
    {
        "instruction": (
            "Make the case to a hospital finance committee for funding a second MRI "
            "scanner, covering current waiting times, the cost of outsourcing scans, "
            "and what the second machine would and would not fix."
        ),
        "slide_count": 7,
        "audience": "hospital finance committee",
        "tone": "measured and evidence-led",
    },
    {
        "instruction": (
            "Introduce a new returns policy to a customer support team: what changed, "
            "the three cases they will get asked about most, and where their "
            "discretion still applies."
        ),
        "slide_count": 5,
        "audience": "customer support agents",
        "tone": "direct and reassuring",
    },
]

def peak_rss_watcher(pid: int, stop: threading.Event) -> dict[str, int]:
    """Peak resident memory of the runtime, sampled while it works.

    The number that decides whether a pack fits a machine, and it cannot be read
    afterwards: a process that was killed for using 7GB reports nothing at all.
    """
    peak = {"peak_rss_mb": 0}

    def watch() -> None:
        try:
            import ctypes
            from ctypes import wintypes

            PROCESS_QUERY_INFORMATION = 0x0400
            PROCESS_VM_READ = 0x0010

            class Counters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            handle = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid
            )
            if not handle:
                return
            counters = Counters()
            counters.cb = ctypes.sizeof(Counters)
            while not stop.wait(1.0):
                if ctypes.windll.psapi.GetProcessMemoryInfo(
                    handle, ctypes.byref(counters), counters.cb
                ):
                    peak["peak_rss_mb"] = max(
                        peak["peak_rss_mb"], counters.PeakWorkingSetSize // (1024 * 1024)
                    )
        except Exception:  # noqa: BLE001 - a missing measurement is not a failed run
            return

    threading.Thread(target=watch, daemon=True).start()
    return peak


def stage_timer(record: dict) -> callable:
    """Record when each stage started, from the events the run emits.

    Per stage rather than per run, because "twenty minutes" is not actionable and
    "sixteen of the twenty were the critic" is.
    """
    seen: dict[str, float] = {}
    order: list[str] = []
    started = time.monotonic()

    def emit(event) -> None:
        stage = getattr(event, "stage", None) or getattr(event, "node", None)
        if not stage:
            return
        now = time.monotonic() - started
        if stage not in seen:
            seen[stage] = now
            order.append(stage)
        record["stage_starts"] = {name: round(seen[name], 1) for name in order}

    return emit


def one_run(brief: dict) -> dict:
    from deckastra_api import model_server
    from deckastra_api.agent_service import _composer
    from deckastra_api.models import GenerateRequest
    from deckastra_api.schema import validate_document

    record: dict = {
        "brief": brief["instruction"][:70],
        "asked_for": brief["slide_count"],
    }

    client = model_server.build_client()
    runtime = model_server._process
    stop = threading.Event()
    peak = peak_rss_watcher(runtime.pid, stop) if runtime is not None else {"peak_rss_mb": 0}

    # Generous, because the point is to find out how long it takes rather than to
    # enforce a ceiling. A run that hits this is reported as exhausted, which is
    # itself a result worth having.
    budget = RunBudget(max_wall_clock_seconds=5400.0, max_total_tokens=4_000_000)

    # The product's own composer, not a second one written here. `propose` hands
    # it the story plan, the creative direction and the motion plan and gets patch
    # operations back; `compose_document` is the layer *underneath* that and takes
    # something else entirely. Building a stand-in would measure a pipeline this
    # product does not have.
    produced: dict = {}
    request = GenerateRequest(
        instruction=brief["instruction"],
        audience=brief.get("audience", ""),
        objective=brief.get("objective", ""),
        slide_count=brief["slide_count"],
        tone=brief.get("tone", ""),
    )

    run = AgentRun(
        client=client,
        registry=ToolRegistry(),
        compose=_composer(request, produced),
        budget=budget,
        # Nobody is here to approve a story mid-benchmark, and the API's own
        # synchronous path turns it off for the same reason.
        human_checkpoint=False,
    )
    run.emit = stage_timer(record)

    state = {
        "run_id": f"bench-{int(time.time())}",
        "request": brief,
    }

    started = time.monotonic()
    try:
        result = run_generation(run, state)  # type: ignore[arg-type]
        record["status"] = result.status
        record["warnings"] = [str(one)[:200] for one in (result.warnings or [])][:6]

        # The orchestrator can end a run by asking a question instead of
        # generating, and that is a *result* rather than a failure — one the
        # single-node harness could never see, because it called `story()`
        # directly and never ran the orchestrator at all. Reported on its own so
        # "it asked what the deadline was" is not filed next to "it crashed".
        if (result.state or {}).get("awaiting") == "clarification":
            record["outcome_class"] = "asked_for_clarification"
            record["clarification"] = (
                (result.warnings or [""])[0] if result.warnings else ""
            )[:300]
        record["errors"] = [
            {"stage": e.get("stage"), "category": e.get("category"), "message": str(e.get("message"))[:200]}
            for e in (result.errors or [])
        ][:6]

        # `_composer` stashes the composed document here on its way past, which
        # is how the API gets hold of it too.
        document = produced.get("document")
        if document is None:
            document = (result.state or {}).get("document")

        if document is not None:
            record["slides"] = len(document.get("slides") or [])
            # The product's own validator, so "it returned a plan" and "it
            # produced a deck someone could open" are different answers.
            errors = validate_document(document)
            record["document_valid"] = errors == []
            record["document_errors"] = [str(one)[:160] for one in errors][:6]
        else:
            record["slides"] = 0
            record["document_valid"] = False

        record["ok"] = record.get("document_valid", False)
        record.setdefault(
            "outcome_class", "produced_a_deck" if record["ok"] else "finished_without_a_deck"
        )
    except Exception as error:  # noqa: BLE001 - the benchmark reports, it does not raise
        record["ok"] = False
        record["outcome_class"] = "crashed"
        record["status"] = "crashed"
        record["failure"] = f"{type(error).__name__}: {error}"[:400]
        record["runtime_said"] = model_server.last_output()[-8:]
    finally:
        stop.set()

    record["seconds"] = round(time.monotonic() - started, 1)
    record["peak_rss_mb"] = peak["peak_rss_mb"]

    observations = budget.structured_requests
    record["structured_requests"] = len(observations)
    record["stages_requested"] = sorted({str(o.get("stage")) for o in observations})
    record["max_attempts"] = max((int(o["attempts"]) for o in observations), default=0)
    record["first_attempt_valid"] = sum(1 for o in observations if o["valid_first_attempt"])
    record["repaired"] = sum(1 for o in observations if not o["valid_first_attempt"])
    record["input_tokens"] = budget.input_tokens
    record["output_tokens"] = budget.output_tokens
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", required=True)
    parser.add_argument("--runs", type=int, default=1, help="Runs per brief")
    parser.add_argument("--out", default=None)
    parser.add_argument(
        "--briefs", type=int, default=len(BRIEFS), help="How many of the held-out briefs to use"
    )
    args = parser.parse_args()

    os.environ["DECKASTRA_MODEL_PACK"] = args.pack
    os.environ.setdefault("DECKASTRA_INTELLIGENCE", "local")

    from deckastra_api import model_server

    records: list[dict] = []
    try:
        records = _run_all(args)
    finally:
        # Stop the runtime this harness started. The supervisor's reaper is a
        # daemon thread, so when a *script* exits the child llama-server simply
        # survives it — and a second run then cannot load, because the first
        # run's weights are still holding the GPU. That is not hypothetical: it
        # is how the 2026-09-17 rerun failed, with three orphaned servers from
        # two earlier attempts still resident. The desktop app has `sidecar.ts`
        # to tear down; a script has this.
        model_server.stop("benchmark finished")

    return _report(args, records)


def _run_all(args) -> list[dict]:
    records: list[dict] = []
    for brief in BRIEFS[: args.briefs]:
        for attempt in range(args.runs):
            record = one_run(brief)
            record["run"] = attempt + 1
            records.append(record)
            print(
                json.dumps(
                    {
                        k: record[k]
                        for k in (
                            "brief",
                            "run",
                            "outcome_class",
                            "status",
                            "slides",
                            "seconds",
                            "peak_rss_mb",
                            "clarification",
                        )
                        if k in record
                    }
                ),
                flush=True,
            )

    return records


def _report(args, records: list[dict]) -> int:
    completed = [one for one in records if one.get("ok")]
    times = sorted(one["seconds"] for one in completed)
    summary = {
        "pack": args.pack,
        "runs": len(records),
        "produced_a_valid_deck": len(completed),
        "median_seconds": times[len(times) // 2] if times else None,
        "fastest_seconds": times[0] if times else None,
        "slowest_seconds": times[-1] if times else None,
        "peak_rss_mb": max((one.get("peak_rss_mb") or 0) for one in records) if records else 0,
        "outcomes": {
            name: sum(1 for one in records if one.get("outcome_class") == name)
            for name in sorted({str(one.get("outcome_class")) for one in records})
        },
        "stages_that_failed": sorted(
            {e["stage"] for one in records for e in (one.get("errors") or []) if e.get("stage")}
        ),
    }
    print(json.dumps({"summary": summary}, indent=2), flush=True)

    if args.out:
        Path(args.out).write_text(
            json.dumps({"summary": summary, "runs": records}, indent=2), encoding="utf-8"
        )
        print(f"wrote {args.out}", flush=True)

    # A benchmark reports; it does not gate. Exit 0 even when runs failed, so a
    # partial result is still a result rather than a lost one.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
