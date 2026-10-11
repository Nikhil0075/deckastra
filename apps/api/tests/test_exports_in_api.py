"""The small hosting profile runs background work inside the API (2026-10-11)."""

from __future__ import annotations

import importlib.util
import threading
from pathlib import Path

from deckastra_api import export_worker

ROOT = Path(__file__).resolve().parents[3]


def test_the_in_process_loop_keeps_working_and_stops_when_told(monkeypatch):
    passes: list[str] = []
    ran = threading.Event()

    def fake(worker_id, state):
        passes.append(worker_id)
        if len(passes) == 1:
            raise RuntimeError("one bad pass must not end the loop")
        if len(passes) >= 3:
            ran.set()
        return False

    monkeypatch.setattr(export_worker, "run_once", fake)
    stop = export_worker.start_in_thread("api-test", poll_seconds=0.01)
    assert ran.wait(5), passes
    stop.set()
    seen = len(passes)
    threading.Event().wait(0.1)
    assert len(passes) <= seen + 1
    assert set(passes) == {"api-test"}


def _bootstrap():
    spec = importlib.util.spec_from_file_location("bootstrap", ROOT / "infrastructure" / "deployment" / "bootstrap.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_small_profile_has_nothing_always_on_and_the_scaled_one_keeps_its_shape():
    sizes = _bootstrap().SIZES
    assert sizes["small"] == {"db_tier": "db-f1-micro", "api_memory": "2Gi", "worker_min": "0",
                              "exports_in_api": "1", "daily_usd": "1"}
    # The shape real traffic used before, unchanged, so going back is one flag.
    assert sizes["scaled"]["worker_min"] == "1" and sizes["scaled"]["exports_in_api"] == "0"
    assert sizes["scaled"]["db_tier"] == "db-custom-1-3840"
