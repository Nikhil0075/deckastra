"""Translating and narrating a deck (integration plan 01 §3.7, §3.8).

Both are services acting on someone's document, so both are proposals, and
these tests hold the properties that make that safe to automate: protected
values survive translation, a translation is stamped with the source it
translated, a voice's length is read from the file it produced, an identical
request costs nothing the second time, and nothing writes the deck behind the
person's back.
"""

from __future__ import annotations

import base64
import json
import math
import struct
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import audio, locales, speech, translation  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'languages.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "DECKASTRA_TRANSLATION", "DECKASTRA_SPEECH", "DECKASTRA_DISTRIBUTION"):
        monkeypatch.delenv(name, raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "languages@localhost"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def deck(client, auth):
    response = client.post("/v1/decks/from-template", headers=auth, json={"template_id": "technical-architecture", "title": "Explain the deploy pipeline"})
    assert response.status_code == 200, response.text
    return response.json()


def read(client, auth, presentation_id):
    response = client.get(f"/v1/presentations/{presentation_id}", headers=auth)
    assert response.status_code == 200, response.text
    return response.json()


def commit(client, auth, presentation_id, operations, intent="edit"):
    head = read(client, auth, presentation_id)
    response = client.post(
        f"/v1/presentations/{presentation_id}/transactions",
        headers=auth,
        json={"operations": operations, "intent": intent, "expected_version_id": head["version_id"]},
    )
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------- protection


def test_masking_round_trips_every_protected_kind():
    text = "Revenue grew 42% to $1,200 by 09:30 — see https://example.com/q3 or ask ops@example.com about {{client}} and `npm run build` on Deckastra."
    masked, spans = translation.mask(text, ["Deckastra"])
    for kept in ("42%", "$1,200", "09:30", "https://example.com/q3", "ops@example.com", "{{client}}", "`npm run build`", "Deckastra"):
        assert kept not in masked, kept
        assert kept in spans, kept
    assert translation.unmask(masked, spans) == text


def test_a_translation_that_loses_a_number_is_refused():
    masked, spans = translation.mask("Grew 42% this year", None)
    with pytest.raises(translation.TranslationError):
        translation.unmask(masked.replace("⟦0⟧", "forty"), spans)
    with pytest.raises(translation.TranslationError):
        translation.unmask(masked + " ⟦0⟧", spans)


# ----------------------------------------------------------------- translate


def test_translate_proposes_overlay_entries_stamped_with_the_source(client, auth, deck):
    presentation_id = deck["presentation_id"]
    before = read(client, auth, presentation_id)
    response = client.post(
        f"/v1/presentations/{presentation_id}/locales/hi-IN/translate",
        headers=auth,
        json={"scope": "missing", "expected_version_id": before["version_id"], "glossary": ["Deckastra"]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "stub"
    assert body["translated"], body
    assert body["outcome"] in ("pending", "applied")

    document = body["preview"] or body["document"]
    overlay = document["locales"]["hi-IN"]
    slots = {slot.path: slot for slot in locales.locale_slots(document)}
    for path in body["translated"]:
        entry = overlay["entries"][path]
        assert entry["origin"] == "stub"
        assert entry["sourceHash"] == locales.text_hash(slots[path].value)
        assert locales.text_content(entry["value"]).startswith("[hi-IN] ")
    # The source words are untouched: an overlay replaces nothing in the deck.
    assert document["metadata"]["title"] == before["document"]["metadata"]["title"]


def test_a_whole_deck_translation_waits_for_a_person(client, auth, deck):
    presentation_id = deck["presentation_id"]
    before = read(client, auth, presentation_id)
    body = client.post(
        f"/v1/presentations/{presentation_id}/locales/fr/translate",
        headers=auth,
        json={"scope": "missing", "expected_version_id": before["version_id"]},
    ).json()
    # Many entries is a large change, and a large change is held (risk is the
    # server's to compute, from the operations).
    assert len(body["translated"]) >= 6, body
    assert body["outcome"] == "pending"
    assert body["risk_tier"] in ("medium", "high")
    assert read(client, auth, presentation_id)["version_id"] == before["version_id"]


def test_paid_translation_requires_an_exact_credit_quote(client, auth, deck, monkeypatch):
    monkeypatch.setenv("DECKASTRA_TRANSLATION", "google")
    monkeypatch.setenv("DECKASTRA_TRANSLATION_USD_PER_MILLION", "20")

    class Translator:
        name = "google"
        origin = "machine"
        def translate(self, items, *, source, target):
            return {item.id: f"[{target}] {item.text}" for item in items}

    monkeypatch.setattr(translation, "build_translator", lambda: Translator())
    presentation_id = deck["presentation_id"]
    head = read(client, auth, presentation_id)["version_id"]
    request = {"presentation_id": presentation_id, "expected_version_id": head, "locale": "fr",
               "scope": "missing", "slide_ids": [], "glossary": ["Deckastra"]}
    quote = client.post("/v1/media/quotes/translation", headers=auth, json=request)
    assert quote.status_code == 200, quote.text
    assert quote.json()["task"] == "translation" and quote.json()["units"] > 0
    route = f"/v1/presentations/{presentation_id}/locales/fr/translate"
    without = client.post(route, headers=auth, json={key: value for key, value in request.items() if key not in {"presentation_id", "locale"}})
    assert without.status_code == 422 and "quote" in without.text.lower()
    changed = client.post(route, headers=auth, json={**{key: value for key, value in request.items() if key not in {"presentation_id", "locale"}},
        "glossary": [], "quote_token": quote.json()["quote_token"]})
    assert changed.status_code == 409
    accepted = client.post(route, headers=auth, json={**{key: value for key, value in request.items() if key not in {"presentation_id", "locale"}},
        "quote_token": quote.json()["quote_token"]})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["provider"] == "google"


def test_translate_refuses_a_stale_view_and_the_source_language(client, auth, deck):
    presentation_id = deck["presentation_id"]
    stale = client.post(
        f"/v1/presentations/{presentation_id}/locales/hi-IN/translate",
        headers=auth,
        json={"scope": "missing", "expected_version_id": "ver_NOT_THE_HEAD"},
    )
    assert stale.status_code == 409
    head = read(client, auth, presentation_id)["version_id"]
    own = client.post(
        f"/v1/presentations/{presentation_id}/locales/en/translate",
        headers=auth,
        json={"scope": "missing", "expected_version_id": head},
    )
    assert own.status_code == 422
    bad = client.post(
        f"/v1/presentations/{presentation_id}/locales/not a tag/translate",
        headers=auth,
        json={"scope": "missing", "expected_version_id": head},
    )
    assert bad.status_code in (404, 422)


def test_an_unknown_provider_is_refused_not_guessed(client, auth, deck, monkeypatch):
    monkeypatch.setenv("DECKASTRA_TRANSLATION", "gogle")
    status = client.get("/v1/languages/status", headers=auth).json()
    assert status["translation"]["available"] is False
    head = read(client, auth, deck["presentation_id"])["version_id"]
    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/locales/hi-IN/translate",
        headers=auth,
        json={"scope": "missing", "expected_version_id": head},
    )
    assert response.status_code == 503


def test_the_removed_model_translator_is_refused(monkeypatch):
    monkeypatch.setenv("DECKASTRA_TRANSLATION", "model")
    status = translation.translation_status()
    assert status["available"] is False
    assert "stub, google" in status["reason"]


def test_an_installed_product_has_no_stand_in_translator(monkeypatch):
    monkeypatch.setenv("DECKASTRA_DISTRIBUTION", "1")
    monkeypatch.delenv("DECKASTRA_TRANSLATION", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    status = translation.translation_status()
    assert status["available"] is False


# ---------------------------------------------------------------- narration


def _add_cues(client, auth, presentation_id):
    document = read(client, auth, presentation_id)["document"]
    slide = document["slides"][0]["id"]
    commit(
        client,
        auth,
        presentation_id,
        [{"op": "add", "path": f"/slides/id:{slide}/narration", "value": {"cues": [
            {"id": "nar_01JB8Z9K2QW4RN7F3XAAAAAAA1", "step": 0, "text": "Welcome to the deploy pipeline."},
            {"id": "nar_01JB8Z9K2QW4RN7F3XAAAAAAA2", "step": 0, "text": "It has four stages."},
        ]}}],
        "Add narration",
    )
    return slide


def test_synthesize_proposes_takes_whose_length_is_read_from_the_file(client, auth, deck):
    presentation_id = deck["presentation_id"]
    slide = _add_cues(client, auth, presentation_id)
    head = read(client, auth, presentation_id)["version_id"]
    response = client.post(
        f"/v1/presentations/{presentation_id}/narration/synthesize",
        headers=auth,
        json={"locale": "en", "expected_version_id": head},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "stub"
    assert len(body["voiced"]) == 2
    document = body["preview"] or body["document"]
    cues = next(s for s in document["slides"] if s["id"] == slide)["narration"]["cues"]
    for cue in cues:
        take = cue["takes"]["en"]
        assert take["textHash"] == locales.text_hash(cue["text"])
        assert take["durationMs"] > 0
        assert take["wordTimings"]
        assert take["wordTimings"][0]["startMs"] == 0
        assert take["wordTimings"][-1]["endMs"] == take["durationMs"]
        manifest = next(asset for asset in document["assets"] if asset["id"] == take["assetId"])
        assert manifest["type"] == "audio" and manifest["durationMs"] == take["durationMs"]
    # The stored file says the same length the take does.
    assets = client.get("/v1/workspace/assets", headers=auth).json()["assets"]
    audio_rows = [row for row in assets if row["kind"] == "audio"]
    assert len(audio_rows) == 2 and all(row["waveform_peaks"] and len(row["waveform_peaks"]) == 256 for row in audio_rows)


def test_paid_speech_requires_a_quote_bound_to_the_voice_request(client, auth, deck, monkeypatch):
    presentation_id = deck["presentation_id"]
    _add_cues(client, auth, presentation_id)
    monkeypatch.setenv("DECKASTRA_SPEECH_USD_PER_MILLION", "16")
    monkeypatch.setattr(speech, "selected_speech_provider", lambda: "google")
    monkeypatch.setattr(speech, "voices", lambda _locale: [{"name": "en-US-Chirp3-HD-Orus"}])
    head = read(client, auth, presentation_id)["version_id"]
    request = {"presentation_id": presentation_id, "expected_version_id": head, "locale": "en",
               "cue_ids": [], "voice": "default", "rate": 1.0, "pronunciations": []}
    quote = client.post("/v1/media/quotes/speech", headers=auth, json=request)
    assert quote.status_code == 200, quote.text
    route = f"/v1/presentations/{presentation_id}/narration/synthesize"
    body = {key: value for key, value in request.items() if key != "presentation_id"}
    assert client.post(route, headers=auth, json=body).status_code == 422
    changed = client.post(route, headers=auth, json={**body, "rate": 1.1, "quote_token": quote.json()["quote_token"]})
    assert changed.status_code == 409


def test_timed_ssml_marks_words_without_turning_script_into_markup():
    marked, words = speech.timed_ssml(
        "Deckastra <wins> [pause 800ms] now.",
        [speech.Pronunciation("Deckastra", "Deck astra")],
    )
    assert words == ["Deckastra", "wins", "now"]
    assert [f'name="w{i}"' in marked for i in range(3)] == [True, True, True]
    assert "&lt;" in marked and "<break time=\"800ms\"/>" in marked
    assert '<sub alias="Deck astra">Deckastra</sub>' in marked


def test_google_word_timepoints_are_stored_as_take_alignment(monkeypatch):
    seen = {}

    class Response:
        def json(self):
            return {
                "audioContent": base64.b64encode(b"mp3").decode("ascii"),
                "timepoints": [
                    {"markName": "w0", "timeSeconds": 0.1},
                    {"markName": "w1", "timeSeconds": 0.55},
                ],
            }

    def request(_http, _method, _url, **kwargs):
        seen.update(kwargs["json"])
        return Response()

    monkeypatch.setattr(speech, "_google_request", request)
    monkeypatch.setattr(audio, "duration_ms", lambda *_args: 1000)
    made = speech._google_synthesize("Reveal now", locale="en-US", voice="voice-a", rate=1)
    assert seen["enableTimePointing"] == ["SSML_MARK"]
    assert '<mark name="w0"/>' in seen["input"]["ssml"]
    assert made.word_timings == [
        {"word": "Reveal", "startMs": 100, "endMs": 550},
        {"word": "now", "startMs": 550, "endMs": 1000},
    ]


def test_each_cue_can_choose_a_different_voice_and_keeps_alignment(client, auth, deck):
    presentation_id = deck["presentation_id"]
    slide = _add_cues(client, auth, presentation_id)
    first, second = "nar_01JB8Z9K2QW4RN7F3XAAAAAAA1", "nar_01JB8Z9K2QW4RN7F3XAAAAAAA2"
    commit(
        client,
        auth,
        presentation_id,
        [
            {"op": "add", "path": f"/slides/id:{slide}/narration/cues/id:{first}/voice", "value": "speaker-a"},
            {"op": "add", "path": f"/slides/id:{slide}/narration/cues/id:{second}/voice", "value": "speaker-b"},
            {"op": "add", "path": f"/slides/id:{slide}/narration/cues/id:{first}/advanceOnWord", "value": 2},
        ],
        "Cast two speakers",
    )
    head = read(client, auth, presentation_id)["version_id"]
    response = client.post(
        f"/v1/presentations/{presentation_id}/narration/synthesize",
        headers=auth,
        json={"locale": "en", "voice": "fallback", "expected_version_id": head},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert len({item["asset_id"] for item in body["voiced"]}) == 2
    assert all(item["word_timings"] > 0 for item in body["voiced"])


def test_an_identical_request_reuses_the_recording_and_costs_nothing(client, auth, deck):
    presentation_id = deck["presentation_id"]
    _add_cues(client, auth, presentation_id)
    head = read(client, auth, presentation_id)["version_id"]
    first = client.post(
        f"/v1/presentations/{presentation_id}/narration/synthesize",
        headers=auth,
        json={"locale": "en", "expected_version_id": head},
    ).json()
    assert first["characters"] > 0
    usage = client.get("/v1/workspace/usage", headers=auth).json()
    used = usage["speech_characters"]["used"]
    assert used == first["characters"]
    # Asked again by id, for cues whose takes exist: the same files, no charge.
    head = read(client, auth, presentation_id)["version_id"]
    again = client.post(
        f"/v1/presentations/{presentation_id}/narration/synthesize",
        headers=auth,
        json={"locale": "en", "expected_version_id": head, "cue_ids": [c["cue_id"] for c in first["voiced"]]},
    ).json()
    assert again["characters"] == 0
    assert {c["asset_id"] for c in again["voiced"]} == {c["asset_id"] for c in first["voiced"]}
    assert client.get("/v1/workspace/usage", headers=auth).json()["speech_characters"]["used"] == used


# ------------------------------------------------------------------- audio


def _wav(seconds: float, rate: int = 8000) -> bytes:
    samples = [0.3 * math.sin(2 * math.pi * 440 * i / rate) for i in range(int(seconds * rate))]
    return audio.encode_wav(samples, rate)


def test_durations_are_read_from_each_container():
    assert audio.duration_ms(_wav(1.5)) == 1500
    assert audio.sniff(_wav(0.1)) == "wav"
    # A minimal Ogg Opus stream: an OpusHead page and a last page at granule 96000 + pre-skip.
    def page(granule: int, body: bytes) -> bytes:
        return b"OggS" + struct.pack("<BBqIII", 0, 0, granule, 1, 0, 0) + bytes([1, len(body)]) + body
    head = b"OpusHead" + struct.pack("<BBHIhB", 1, 1, 312, 48000, 0, 0)
    ogg = page(0, head) + page(96_000 + 312, b"\x00" * 10)
    assert audio.duration_ms(ogg) == 2000
    assert audio.duration_ms(b"not audio") is None


def test_an_audio_upload_is_measured_on_arrival(client, auth):
    data = _wav(2.0)
    account = client.get("/v1/account", headers=auth).json()
    workspace_id = account["workspaces"][0]["id"]
    begin = client.post(
        "/v1/workspace/assets/uploads",
        headers=auth,
        json={"workspace_id": workspace_id, "filename": "voice.wav", "content_type": "audio/wav", "size_bytes": len(data), "kind": "audio", "duration_ms": 9999},
    )
    assert begin.status_code == 201, begin.text
    begun = begin.json()
    put = client.put(begun["upload_url"], headers={**auth, "Content-Type": "audio/wav"}, content=data)
    assert put.status_code == 200, put.text
    done = client.post("/v1/workspace/assets/uploads/complete", headers=auth, json={"upload_token": begun["upload_token"]})
    assert done.status_code == 201, done.text
    row = done.json()
    # The file's own length, not the 9999 the client claimed.
    assert row["duration_ms"] == 2000
    assert len(row["waveform_peaks"]) == 256


def test_a_translation_is_as_risky_as_the_slides_it_rewords():
    from deckastra_api.risk import assess_risk

    def entry(slide: str) -> dict:
        return {"op": "add", "path": locales.entry_path("hi-IN", f"/slides/id:{slide}/speakerNotes"), "value": {"value": "x"}}

    assert assess_risk([entry("sld_A")]).tier == "low"
    assert assess_risk([entry(s) for s in ("sld_A", "sld_B", "sld_C", "sld_D")]).tier == "high"
    whole = {s: {"value": "x"} for s in (f"/slides/id:sld_{c}/speakerNotes" for c in "ABCD")}
    assert assess_risk([{"op": "add", "path": "/locales", "value": {"hi-IN": {"entries": whole}}}]).tier == "high"


def test_an_agents_translation_is_stamped_with_the_source_it_translates():
    from deckastra_api.author_service import check, materialise

    document = json.loads((Path(__file__).resolve().parents[3] / "packages/presentation-schema/fixtures/technical-deck.mydeck.json").read_text(encoding="utf-8"))
    slide = document["slides"][0]
    element = slide["elements"][0]
    slot = f"/slides/id:{slide['id']}/elements/id:{element['id']}/content"
    value = {"version": 1, "blocks": [{"id": element["content"]["blocks"][0]["id"], "type": "paragraph", "spans": [{"text": "Bonjour"}]}]}
    written = [
        {"op": "add", "path": "/locales", "value_json": json.dumps({"fr": {"locale": "fr", "status": "draft", "entries": {}}})},
        {"op": "add", "path": locales.entry_path("fr", slot), "value_json": json.dumps({"value": value, "sourceHash": "made up", "origin": "agent:editor"})},
    ]
    operations = materialise(written, document, [])
    assert operations[1]["value"]["sourceHash"] == locales.text_hash(element["content"])
    assert check(document, operations) == []


def test_voicing_with_a_pronunciation_says_the_name_as_written_down(client, auth, deck):
    presentation_id = deck["presentation_id"]
    slide = _add_cues(client, auth, presentation_id)
    head = read(client, auth, presentation_id)["version_id"]
    plain = client.post(
        f"/v1/presentations/{presentation_id}/narration/synthesize",
        headers=auth,
        json={"locale": "en", "expected_version_id": head, "cue_ids": ["nar_01JB8Z9K2QW4RN7F3XAAAAAAA2"]},
    ).json()
    assert plain["outcome"] in ("applied", "pending"), plain
    head = read(client, auth, presentation_id)["version_id"]
    spelled = client.post(
        f"/v1/presentations/{presentation_id}/narration/synthesize",
        headers=auth,
        json={
            "locale": "en",
            "expected_version_id": head,
            "cue_ids": ["nar_01JB8Z9K2QW4RN7F3XAAAAAAA2"],
            # "four" said as six words: the stand-in's tones follow what is said.
            "pronunciations": [{"term": "four", "say": "one two three four five six"}],
        },
    )
    assert spelled.status_code == 200, spelled.text
    before = plain["voiced"][0]
    after = spelled.json()["voiced"][0]
    assert after["asset_id"] != before["asset_id"]
    assert after["duration_ms"] > before["duration_ms"]
    # The take still says the script as written: pronunciation is not the words.
    document = read(client, auth, presentation_id)["document"]
    cue = next(c for s in document["slides"] if s["id"] == slide for c in s["narration"]["cues"] if c["id"].endswith("A2"))
    assert cue["takes"]["en"]["textHash"] == locales.text_hash(cue["text"])


def test_pronunciations_are_a_preference_that_follows_the_person(client, auth):
    value = {"list": [{"term": "Deckastra", "say": "Deck astra"}]}
    assert client.put("/v1/me/preferences/pronunciations", json={"value": value}, headers=auth).status_code == 200
    assert client.get("/v1/me/preferences/pronunciations", headers=auth).json()["value"] == value


def test_a_changed_pronunciation_revoices_only_the_lines_that_say_the_name(client, auth, deck):
    """The recheck's reproducer: Voice with no lines named after "Say names as" changed."""
    presentation_id = deck["presentation_id"]
    slide = _add_cues(client, auth, presentation_id)

    def voice(pronunciations):
        head = read(client, auth, presentation_id)["version_id"]
        response = client.post(
            f"/v1/presentations/{presentation_id}/narration/synthesize",
            headers=auth,
            json={"locale": "en", "expected_version_id": head, "pronunciations": pronunciations},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        if body["outcome"] == "pending":
            approve = client.post(
                f"/v1/presentations/{presentation_id}/proposals/{body['transaction_id']}/approve", headers=auth, json={}
            )
            assert approve.status_code == 200, approve.text
        return body

    first = voice([])
    assert len(first["voiced"]) == 2
    # Nothing changed: nothing is due.
    assert voice([])["outcome"] == "none"
    # "four" is in one line only ("It has four stages."): that line, and only it.
    second = voice([{"term": "four", "say": "one two three four five six"}])
    assert [item["cue_id"] for item in second["voiced"]] == ["nar_01JB8Z9K2QW4RN7F3XAAAAAAA2"]
    document = read(client, auth, presentation_id)["document"]
    cues = {c["id"]: c for s in document["slides"] if s["id"] == slide for c in s["narration"]["cues"]}
    assert cues["nar_01JB8Z9K2QW4RN7F3XAAAAAAA2"]["takes"]["en"]["sayAs"].startswith("fnv1a64:")
    assert "sayAs" not in cues["nar_01JB8Z9K2QW4RN7F3XAAAAAAA1"]["takes"]["en"]
    # And the same list again is not due a second time.
    assert voice([{"term": "four", "say": "one two three four five six"}])["outcome"] == "none"


def test_a_changed_rate_revoices_the_voiced_lines_and_a_pause_lengthens_one(client, auth, deck):
    presentation_id = deck["presentation_id"]
    slide = _add_cues(client, auth, presentation_id)

    def voice(**extra):
        head = read(client, auth, presentation_id)["version_id"]
        response = client.post(
            f"/v1/presentations/{presentation_id}/narration/synthesize",
            headers=auth,
            json={"locale": "en", "expected_version_id": head, **extra},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        if body["outcome"] == "pending":
            client.post(f"/v1/presentations/{presentation_id}/proposals/{body['transaction_id']}/approve", headers=auth, json={})
        return body

    assert len(voice()["voiced"]) == 2
    faster = voice(rate=1.5)
    assert len(faster["voiced"]) == 2  # every voiced line, said faster
    assert voice(rate=1.5)["outcome"] == "none"

    # A pause written into one line: that line is due (its words changed) and
    # its recording is longer by about the pause.
    before = next(c for c in read(client, auth, presentation_id)["document"]["slides"][0]["narration"]["cues"] if c["id"].endswith("A2"))
    commit(
        client,
        auth,
        presentation_id,
        [{"op": "replace", "path": f"/slides/id:{slide}/narration/cues/id:{before['id']}/text", "value": "It has four [pause 2s] stages."}],
        "Add a pause",
    )
    paused = voice(rate=1.5)
    assert [item["cue_id"] for item in paused["voiced"]] == [before["id"]]
    assert paused["voiced"][0]["duration_ms"] - before["takes"]["en"]["durationMs"] >= 1900
