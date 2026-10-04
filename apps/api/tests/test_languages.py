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

from deckastra_api import audio, locales, translation  # noqa: E402
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
    response = client.post("/v1/generate", headers=auth, json={"instruction": "Explain the deploy pipeline", "slide_count": 3})
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
        manifest = next(asset for asset in document["assets"] if asset["id"] == take["assetId"])
        assert manifest["type"] == "audio" and manifest["durationMs"] == take["durationMs"]
    # The stored file says the same length the take does.
    assets = client.get("/v1/workspace/assets", headers=auth).json()["assets"]
    audio_rows = [row for row in assets if row["kind"] == "audio"]
    assert len(audio_rows) == 2 and all(row["waveform_peaks"] and len(row["waveform_peaks"]) == 256 for row in audio_rows)


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
