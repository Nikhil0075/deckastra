"""An installed, signed-in desktop offers the services its account pays for (2026-10-12).

The desktop's local service reaches translation, voices, pictures and video
through the main process's private bridge to the hosted API, which prices each
request and holds the account's credits and limits. The local service still
asked for the settings a server needs to run those services itself — a provider
choice, Google credentials, per-character prices, a workspace spend ceiling —
found none, and so reported every paid service as switched off: Voice and
Translate were disabled, and pictures and video said they were not set up,
while the account behind them had them all turned on.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deckastra_api  # noqa: F401  initializes the sibling package paths

from deckastra_agents import gateway_client
from deckastra_api import assistant_routes, local_mode, speech, translation

CLOUD_TASKS = {"provider": "vertex", "tasks": {
    "image": {"available": True, "model": "gemini-3.1-flash-lite-image", "reason": None,
              "minimum_reservation_usd": 0.03},
    "video": {"available": True, "model": "veo-3.1-fast-generate-001", "reason": None,
              "minimum_reservation_usd": 0.6, "usd_per_second": 0.15},
}}

# Everything a server would need to run these services itself, none of which a
# desktop's local service is given (sidecar.ts filters the inherited ones out).
SERVER_SETTINGS = (
    "DECKASTRA_TRANSLATION", "DECKASTRA_SPEECH", "DECKASTRA_SPEECH_USD_PER_MILLION",
    "DECKASTRA_GOOGLE_CREDENTIALS", "DECKASTRA_GOOGLE_API_KEY", "DECKASTRA_GOOGLE_ACCESS_TOKEN",
    "DECKASTRA_VERTEX_IMAGE_MODEL", "DECKASTRA_VERTEX_PRICES", "DECKASTRA_VERTEX_VIDEO_MODEL",
    "DECKASTRA_ASSISTANT_MAX_COST_USD", "DECKASTRA_WORKSPACE_ASSISTANT_CEILINGS", "DECKASTRA_CREDITS_ENABLED",
)


@pytest.fixture
def installed_desktop(monkeypatch):
    for name in SERVER_SETTINGS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DECKASTRA_LOCAL_MODE", "1")
    monkeypatch.delenv("DECKASTRA_ENV", raising=False)
    monkeypatch.setenv("DECKASTRA_DISTRIBUTION", "1")
    monkeypatch.setenv("DECKASTRA_GATEWAY_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("DECKASTRA_GATEWAY_SECRET", "s" * 40)
    monkeypatch.setattr(gateway_client.GatewayClient, "_call",
                        lambda self, path, body=None: CLOUD_TASKS if path == "/capabilities" else {})


def test_voice_and_translate_are_offered_through_the_account(installed_desktop):
    voice, translate = speech.speech_status(), translation.translation_status()
    assert voice["available"] and voice["provider"] == "google"
    assert translate["available"] and translate["provider"] == "google"
    # And the work itself goes through the bridge, not a local Google client.
    assert isinstance(translation.build_translator(), translation.GatewayTranslator)
    assert "credits" in voice["reason"] and "Google" in voice["reason"]


def test_pictures_and_video_stay_offered_for_a_deck(installed_desktop):
    """The per-deck check used to apply a local spend ceiling nobody sets."""
    value = assistant_routes.capabilities()
    document = {"slides": [{"id": "sld_1", "elements": []}]}
    # No session: the cloud holds the limits, so nothing local is consulted.
    scoped = assistant_routes.scoped_capabilities(value, document, {"kind": "deck", "slide_ids": []},
                                                  "wsp_local", None)
    for task in ("image", "video", "speech"):
        assert scoped["tasks"][task]["available"], (task, scoped["tasks"][task]["reason"])


def test_a_checkout_keeps_the_free_stand_ins(installed_desktop, monkeypatch):
    monkeypatch.delenv("DECKASTRA_DISTRIBUTION")
    assert local_mode.account_gateway() is False
    assert speech.speech_status()["provider"] == "stub"
    assert translation.translation_status()["provider"] == "stub"


def test_an_install_without_the_bridge_still_says_it_is_not_set_up(installed_desktop, monkeypatch):
    monkeypatch.delenv("DECKASTRA_GATEWAY_URL")
    assert speech.speech_status()["available"] is False
    assert translation.translation_status()["available"] is False


def test_the_voice_list_comes_from_the_account(installed_desktop, monkeypatch):
    """A desktop holds no Google key, so listing voices went to Google and failed."""
    asked = []

    def answer(self, path, body=None):
        asked.append(path)
        return {"voices": [{"name": "hi-IN-Chirp3-HD-Kore", "label": "hi-IN-Chirp3-HD-Kore", "gender": "female"}]}

    monkeypatch.setattr(gateway_client.GatewayClient, "_call", answer)
    monkeypatch.setattr(speech, "_VOICE_CACHE", {})
    assert speech.resolve_voice("hi-IN", "default") == "hi-IN-Chirp3-HD-Kore"
    assert asked == ["/voices?locale=hi-IN"]
