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
    assert {key: sizes["small"][key] for key in ("db_tier", "api_memory", "worker_min", "exports_in_api", "daily_usd")} == {
        "db_tier": "db-f1-micro", "api_memory": "2Gi", "worker_min": "0", "exports_in_api": "1", "daily_usd": "1"}
    # One short video clip (4 s at the held US$0.15/s) fits the demo limits.
    assert float(sizes["small"]["request_max_usd"]) >= 4 * 0.15
    assert float(sizes["small"]["account_daily_usd"]) >= 4 * 0.15
    # The shape real traffic used before, unchanged, so going back is one flag.
    assert sizes["scaled"]["worker_min"] == "1" and sizes["scaled"]["exports_in_api"] == "0"
    assert sizes["scaled"]["db_tier"] == "db-custom-1-3840"


def test_what_the_deploy_sets_actually_turns_voice_pictures_and_video_on(monkeypatch):
    """Each paid medium is configured by the real code, from exactly the deployed values.

    On 2026-10-12 video looked enabled (its model had a default) and could
    never run: the deploy set no per-second price, and a US$0.30 request
    ceiling refused any clip. This reads the same functions the API does.
    """
    from deckastra_agents import video_model, vertex_model
    from deckastra_api import speech

    bootstrap = _bootstrap()
    shape = bootstrap.SIZES["small"]
    env = {**bootstrap.MEDIA, "DECKASTRA_VERTEX_PROJECT": "deckastra-prod", "DECKASTRA_VERTEX_LOCATION": "global",
           "DECKASTRA_VERTEX_IDENTITY": "attached", "DECKASTRA_ASSISTANT_MAX_COST_USD": shape["request_max_usd"],
           "DECKASTRA_ENV": "production"}
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert vertex_model.image_model_id() == "gemini-3.1-flash-lite-image"
    # Price a picture the way /v1/account/capabilities does. Loading the prices
    # was not enough: the image rate is its own field, and its absence passed
    # here and failed the production deploy's smoke check (2026-10-12).
    from deckastra_agents.router import ModelRequest

    client = vertex_model.VertexClient("gemini-3.1-flash-lite-image", vertex_model.configuration(), token=lambda: "unused")
    probe = ModelRequest("media", "", [], stage="image", max_tokens=4096, image_output=True)
    assert 0 < client.estimate_reservation(probe) <= float(shape["request_max_usd"])
    video = video_model.configuration()
    assert video["location"] == "us-central1" and video["rate"] == 0.15
    assert video_model.quote(4, video)["usd"] <= float(shape["request_max_usd"])
    assert speech.selected_speech_provider() == "google"
