#!/usr/bin/env python
"""Measure a model pack against the contracts this product actually asks for (D3).

The D3 exit gate is not "does a small model produce text". It is whether one can
hold **these** contracts — a `StoryPlan` is a nested schema with a closed layout
enum, per-slide copy and citation ids — often enough, fast enough, on hardware
someone owns. A benchmark that asked its own easier question would answer the
wrong one.

So this drives the real node. `story()` is called with the real prompt, the real
schema and the real repair loop out of `ask_model`, and the numbers come from the
product's own accounting (`RunBudget.structured_requests`) rather than from a
reimplementation that could disagree with it.

    python scripts/benchmark-model-pack.py --pack qwen3-4b-q4 --runs 3

What it reports, and why each one is a decision rather than a statistic:

- **First-pass validity.** How often the grammar-constrained output validated
  without a repair round trip. A model that needs a repair every time costs two
  calls for every stage, which is the difference between a minute and three.
- **Latency**, per stage and total. The number a user feels.
- **Peak RSS of the runtime.** Whether it fits beside the app on this machine.
- **Source alignment.** When material is supplied, whether the cited ids are ones
  it was actually given. A model that invents citations is worse than one that
  omits them, because the product renders them as provenance.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))
sys.path.insert(0, str(ROOT / "agents"))

from deckastra_agents.budgets import RunBudget  # noqa: E402
from deckastra_agents.envelope import Source, envelope  # noqa: E402
from deckastra_agents.nodes._common import NodeContext, NodeFailure  # noqa: E402
from deckastra_agents.nodes.story import story  # noqa: E402
from deckastra_agents.tools.registry import ToolRegistry  # noqa: E402

BRIEFS = [
    {
        "instruction": "Explain our move to event-driven architecture to the engineering team.",
        "audience": "Senior engineers who know our current monolith",
        "objective": "Get agreement to start with the billing domain",
        "tone": "direct, concrete, no hype",
        "slide_count": 5,
    },
    {
        "instruction": "A quarterly business review for a SaaS company that grew 40% and lost two enterprise customers.",
        "audience": "The board",
        "objective": "Be honest about churn while making the growth case",
        "tone": "measured",
        "slide_count": 6,
    },
]

#: Material with ids, so a citation can be checked against what was supplied
#: rather than merely being present.
SOURCES = [
    ("src_billing", "Billing retries currently run in a cron every 15 minutes; 4% of invoices settle late."),
    ("src_latency", "p95 checkout latency is 840ms, of which 300ms is synchronous inventory calls."),
    ("src_churn", "Two enterprise accounts (combined $410k ARR) did not renew, both citing onboarding time."),
]


def peak_rss_watcher(pid: int, stop: threading.Event) -> dict[str, int]:
    """Poll the runtime's resident set while a run is in flight.

    Sampled rather than read once at the end: a model's peak is during
    generation, and by the time a run returns the allocator may have given some
    of it back.
    """
    found = {"peak_mb": 0}

    def watch() -> None:
        import ctypes
        import ctypes.wintypes as wintypes

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

        handle = ctypes.windll.kernel32.OpenProcess(0x0400 | 0x0010, False, pid)
        if not handle:
            return
        try:
            while not stop.wait(0.25):
                counters = Counters()
                counters.cb = ctypes.sizeof(Counters)
                if ctypes.windll.psapi.GetProcessMemoryInfo(
                    handle, ctypes.byref(counters), counters.cb
                ):
                    found["peak_mb"] = max(
                        found["peak_mb"], int(counters.PeakWorkingSetSize / 1024 / 1024)
                    )
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)

    if sys.platform == "win32":
        threading.Thread(target=watch, daemon=True).start()
    return found


def one_run(client, brief: dict, with_sources: bool) -> dict:
    budget = RunBudget(max_wall_clock_seconds=900.0, max_total_tokens=1_000_000)
    context_blocks = (
        [envelope(text, Source(id=source_id, kind="repository")) for source_id, text in SOURCES]
        if with_sources
        else []
    )
    state = {
        "run_id": "benchmark",
        "request": brief,
        "research": {"context_blocks": context_blocks},
    }
    ctx = NodeContext(
        client=client,
        budget=budget,
        emit=lambda event: None,
        registry=ToolRegistry(),
    )

    started = time.monotonic()
    record: dict = {"brief": brief["instruction"][:60], "with_sources": with_sources}
    try:
        produced = story(state, ctx)  # type: ignore[arg-type]
        plan = produced.get("story_plan") or {}
        slides = plan.get("slides") or []
        record["slides"] = len(slides)
        record["asked_for"] = brief["slide_count"]

        if with_sources:
            supplied = {source_id for source_id, _ in SOURCES}
            cited = {
                str(one)
                for slide in slides
                for one in (slide.get("source_ids") or [])
            }
            record["cited"] = sorted(cited)
            # Inventing an id is worse than citing nothing: the product renders
            # these as provenance a reader is invited to trust.
            record["invented_citations"] = sorted(cited - supplied)
        record["ok"] = True
    except NodeFailure as failure:
        record["ok"] = False
        record["failure"] = str(failure)[:300]
    except Exception as error:  # noqa: BLE001 - the benchmark reports, it does not raise
        record["ok"] = False
        record["failure"] = f"{type(error).__name__}: {error}"[:300]

    record["seconds"] = round(time.monotonic() - started, 1)
    if not record["ok"]:
        # What the runtime itself said. Without this a crash is a connection
        # error in the harness and a diagnosis nobody has.
        from deckastra_api import model_server

        record["runtime_said"] = model_server.last_output()[-6:]
    observations = budget.structured_requests
    record["attempts"] = max((int(o["attempts"]) for o in observations), default=0)
    record["valid_first_attempt"] = bool(observations) and all(
        o["valid_first_attempt"] for o in observations
    )
    record["outcome"] = observations[-1]["outcome"] if observations else "none"
    record["input_tokens"] = budget.input_tokens
    record["output_tokens"] = budget.output_tokens
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", required=True)
    parser.add_argument("--runs", type=int, default=3, help="Runs per brief")
    parser.add_argument("--out", default=None, help="Write the full record here as JSON")
    arguments = parser.parse_args()

    import os

    os.environ["DECKASTRA_INTELLIGENCE"] = "local"
    os.environ["DECKASTRA_MODEL_PACK"] = arguments.pack

    from deckastra_api import model_server

    print(f"starting {arguments.pack}…", flush=True)
    loading = time.monotonic()
    base_url = model_server.ensure_ready()
    load_seconds = round(time.monotonic() - loading, 1)
    print(f"  ready at {base_url} in {load_seconds}s", flush=True)

    stop = threading.Event()
    rss = peak_rss_watcher(model_server._process.pid, stop)  # type: ignore[union-attr]

    # Through `build_client`, not `local_client`: the product's own entry point,
    # which wraps the client so that using it keeps the model loaded. Reaching
    # past it meant the harness measured a path no caller takes — and spent five
    # runs rediscovering the idle reaper at 600 seconds.
    client = model_server.build_client()

    records = []
    try:
        for brief in BRIEFS:
            for index in range(arguments.runs):
                with_sources = index == 0
                print(f"  {brief['instruction'][:44]}… run {index + 1}", end="", flush=True)
                record = one_run(client, brief, with_sources)
                records.append(record)
                print(
                    f" {record['seconds']}s"
                    f" {'ok' if record['ok'] else 'FAILED'}"
                    f" attempts={record['attempts']}",
                    flush=True,
                )
    finally:
        stop.set()
        time.sleep(0.5)

    succeeded = [r for r in records if r["ok"]]
    summary = {
        "pack": arguments.pack,
        "runs": len(records),
        "succeeded": len(succeeded),
        "first_pass_valid": sum(1 for r in records if r["valid_first_attempt"]),
        "load_seconds": load_seconds,
        "peak_rss_mb": rss["peak_mb"],
        "seconds_median": round(statistics.median([r["seconds"] for r in succeeded]), 1)
        if succeeded
        else None,
        "seconds_worst": max([r["seconds"] for r in succeeded], default=None),
        "invented_citations": sorted(
            {one for r in records for one in (r.get("invented_citations") or [])}
        ),
        "wrong_slide_count": [
            (r["slides"], r["asked_for"]) for r in succeeded if r.get("slides") != r.get("asked_for")
        ],
    }

    print("\n" + json.dumps(summary, indent=2))
    if arguments.out:
        Path(arguments.out).write_text(
            json.dumps({"summary": summary, "runs": records}, indent=2), encoding="utf-8"
        )
        print(f"\nwritten to {arguments.out}")

    model_server.stop("benchmark finished")
    return 0 if succeeded else 1


if __name__ == "__main__":
    sys.exit(main())
