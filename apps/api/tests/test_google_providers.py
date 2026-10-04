"""Google translation and voices, against a stand-in for Google (plan 01 §3.7, §3.8).

No test here reaches Google: these run without credentials and must not spend
anyone's money. What they hold is the contract — that the requests this code
sends are the ones Google documents, and that the answers it documents are
read correctly — which is everything that can be checked short of the live
service. The live run is still the operator's, with a real key.

Each request shape is checked against Google's published REST reference:
Cloud Translation v2 ``translate`` and v3 ``translateText``, and Text-to-Speech
v1 ``text:synthesize`` and ``voices``.
"""

from __future__ import annotations

import base64
import json
import struct

import httpx
import pytest

from deckastra_api import google_credentials, speech, translation
from deckastra_api.translation import Item, google_language


@pytest.fixture
def google(monkeypatch):
    """Route every httpx client these modules build to a recorder."""
    seen: list[httpx.Request] = []
    answers: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        for fragment, answer in answers.items():
            if fragment in str(request.url):
                if isinstance(answer, httpx.Response):
                    return answer
                return httpx.Response(200, json=answer)
        return httpx.Response(404, json={"error": {"message": "not stubbed"}})

    real = httpx.Client

    def client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", client)
    for name in (
        "DECKASTRA_GOOGLE_API_KEY",
        "DECKASTRA_GOOGLE_ACCESS_TOKEN",
        "DECKASTRA_GOOGLE_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "DECKASTRA_GOOGLE_GLOSSARY",
    ):
        monkeypatch.delenv(name, raising=False)
    google_credentials.reset()
    speech._VOICE_CACHE.clear()
    return seen, answers


# ------------------------------------------------------------------ languages


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        ("hi-IN", "hi"),
        ("ar-EG", "ar"),
        ("ar", "ar"),
        ("en-US", "en"),
        ("zh-Hant-TW", "zh-TW"),
        ("zh-HK", "zh-TW"),
        ("zh", "zh-CN"),
        ("zh-Hans", "zh-CN"),
        ("pt-PT", "pt-PT"),
        ("pt-BR", "pt"),
        ("fr-CA", "fr-CA"),
        ("mni-Mtei", "mni-Mtei"),
    ],
)
def test_a_deck_tag_becomes_the_code_google_lists(tag, expected):
    assert google_language(tag) == expected


# ---------------------------------------------------------------- translation


def test_v2_with_a_key_sends_listed_codes_and_reads_the_answer(google, monkeypatch):
    seen, answers = google
    monkeypatch.setenv("DECKASTRA_GOOGLE_API_KEY", "test-key")
    answers["/language/translate/v2"] = {"data": {"translations": [{"translatedText": "नमस्ते"}, {"translatedText": "दुनिया"}]}}

    result = translation.GoogleTranslator().translate(
        [Item("a", "Hello"), Item("b", "World")], source="en-US", target="hi-IN"
    )

    assert result == {"a": "नमस्ते", "b": "दुनिया"}
    request = seen[0]
    assert request.method == "POST"
    assert request.url.params["key"] == "test-key"
    assert "Authorization" not in request.headers
    assert json.loads(request.content) == {"q": ["Hello", "World"], "source": "en", "target": "hi", "format": "text"}


def test_v3_with_a_user_token_names_the_quota_project(google, monkeypatch):
    seen, answers = google
    monkeypatch.setenv("DECKASTRA_GOOGLE_ACCESS_TOKEN", "ya29.test")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "deck-project")
    monkeypatch.setenv("DECKASTRA_GOOGLE_GLOSSARY", "brand-terms")
    answers[":translateText"] = {
        "translations": [{"translatedText": "ignored"}],
        "glossaryTranslations": [{"translatedText": "مرحبا"}],
    }

    result = translation.GoogleTranslator().translate([Item("a", "Hello")], source="en", target="ar-EG")

    # With a glossary, the glossary's translation is the one asked for.
    assert result == {"a": "مرحبا"}
    request = seen[0]
    assert str(request.url) == "https://translation.googleapis.com/v3/projects/deck-project/locations/global:translateText"
    assert request.headers["Authorization"] == "Bearer ya29.test"
    assert request.headers["x-goog-user-project"] == "deck-project"
    body = json.loads(request.content)
    assert body == {
        "contents": ["Hello"],
        "mimeType": "text/plain",
        "sourceLanguageCode": "en",
        "targetLanguageCode": "ar",
        "glossaryConfig": {"glossary": "projects/deck-project/locations/global/glossaries/brand-terms"},
    }


def test_google_refusing_is_a_translation_error_not_a_crash(google, monkeypatch):
    _seen, answers = google
    monkeypatch.setenv("DECKASTRA_GOOGLE_API_KEY", "test-key")
    answers["/language/translate/v2"] = httpx.Response(400, json={"error": {"message": "Bad language pair"}})
    with pytest.raises(translation.TranslationError, match="Google translation failed"):
        translation.GoogleTranslator().translate([Item("a", "Hello")], source="en", target="xx")


def test_nothing_is_sent_without_credentials(google):
    seen, _answers = google
    with pytest.raises(translation.ModelUnavailable, match="Nothing was sent"):
        translation.GoogleTranslator()
    assert seen == []


# --------------------------------------------------------------------- voices


def _ogg_page(granule: int, body: bytes) -> bytes:
    # The parser reads granules and bodies; the CRC is not what is under test.
    return b"OggS" + bytes([0, 0]) + struct.pack("<qII", granule, 1, 0) + b"\0\0\0\0" + bytes([1, len(body)]) + body


def _opus(seconds: float, pre_skip: int = 312) -> bytes:
    head = b"OpusHead" + bytes([1, 1]) + struct.pack("<HIhB", pre_skip, 48_000, 0, 0)
    tags = b"OpusTags" + struct.pack("<I", 0) + struct.pack("<I", 0)
    return _ogg_page(0, head) + _ogg_page(0, tags) + _ogg_page(int(seconds * 48_000) + pre_skip, b"\0" * 8)


def _mp3(frames: int) -> bytes:
    """What Google's MP3 is: MPEG-2 layer III, 24kHz mono, 32kbps, 576 samples a frame."""
    header = bytes([0xFF, 0xF3, 0x44, 0xC4])
    return b"".join(header + b"\0" * 92 for _ in range(frames))  # 96-byte frames


def test_synthesis_asks_for_mp3_so_powerpoint_can_carry_it(google, monkeypatch):
    seen, answers = google
    monkeypatch.setenv("DECKASTRA_SPEECH", "google")
    monkeypatch.setenv("DECKASTRA_GOOGLE_API_KEY", "test-key")
    answers["text:synthesize"] = {"audioContent": base64.b64encode(_mp3(125)).decode()}

    result = speech.synthesize("नमस्ते", locale="hi", voice="hi-IN-Chirp3-HD-Kore", rate=1.2)

    assert (result.content_type, result.extension) == ("audio/mpeg", "mp3")
    assert result.duration_ms == 3000  # 125 frames × 576 samples ÷ 24kHz
    assert result.voice == "hi-IN-Chirp3-HD-Kore"
    request = seen[0]
    assert str(request.url).startswith("https://texttospeech.googleapis.com/v1/text:synthesize")
    assert request.url.params["key"] == "test-key"
    body = json.loads(request.content)
    # A plain "hi" deck speaks as its voice's own tag; a mismatch is refused by Google.
    assert body["voice"] == {"languageCode": "hi-IN", "name": "hi-IN-Chirp3-HD-Kore"}
    assert body["input"] == {"text": "नमस्ते"}
    assert body["audioConfig"]["audioEncoding"] == "MP3"
    assert body["audioConfig"]["speakingRate"] == 1.2


def test_synthesis_with_a_user_token_names_the_quota_project(google, monkeypatch):
    seen, answers = google
    monkeypatch.setenv("DECKASTRA_SPEECH", "google")
    monkeypatch.setenv("DECKASTRA_GOOGLE_ACCESS_TOKEN", "ya29.test")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "deck-project")
    answers["text:synthesize"] = {"audioContent": base64.b64encode(_mp3(42)).decode()}

    speech.synthesize("Hello", locale="en-US", voice="default", rate=1.0)

    request = seen[0]
    assert request.headers["Authorization"] == "Bearer ya29.test"
    assert request.headers["x-goog-user-project"] == "deck-project"
    assert "key" not in request.url.params
    assert json.loads(request.content)["voice"] == {"languageCode": "en-US"}


def test_audio_google_cannot_measure_is_refused(google, monkeypatch):
    _seen, answers = google
    monkeypatch.setenv("DECKASTRA_SPEECH", "google")
    monkeypatch.setenv("DECKASTRA_GOOGLE_API_KEY", "test-key")
    answers["text:synthesize"] = {"audioContent": base64.b64encode(b"not audio").decode()}
    with pytest.raises(speech.SpeechError, match="length could not be read"):
        speech.synthesize("Hello", locale="en", voice="default")


def test_voices_match_by_language_with_the_decks_region_first(google, monkeypatch):
    seen, answers = google
    monkeypatch.setenv("DECKASTRA_SPEECH", "google")
    monkeypatch.setenv("DECKASTRA_GOOGLE_API_KEY", "test-key")
    answers["/v1/voices"] = {
        "voices": [
            {"name": "en-GB-Standard-A", "languageCodes": ["en-GB"], "ssmlGender": "FEMALE"},
            {"name": "en-US-Chirp3-HD-Kore", "languageCodes": ["en-US"], "ssmlGender": "FEMALE"},
            {"name": "en-US-Standard-B", "languageCodes": ["en-US"], "ssmlGender": "MALE"},
            {"name": "hi-IN-Standard-A", "languageCodes": ["hi-IN"], "ssmlGender": "FEMALE"},
        ]
    }

    names = [voice["name"] for voice in speech.voices("en-US")]

    assert names == ["en-US-Chirp3-HD-Kore", "en-US-Standard-B", "en-GB-Standard-A"]
    assert seen[0].url.params["languageCode"] == "en-US"


def test_a_deck_tagged_without_a_region_still_finds_voices(google, monkeypatch):
    _seen, answers = google
    monkeypatch.setenv("DECKASTRA_SPEECH", "google")
    monkeypatch.setenv("DECKASTRA_GOOGLE_API_KEY", "test-key")
    answers["/v1/voices"] = {"voices": [{"name": "hi-IN-Chirp3-HD-Kore", "languageCodes": ["hi-IN"], "ssmlGender": "FEMALE"}]}
    assert [voice["name"] for voice in speech.voices("hi")] == ["hi-IN-Chirp3-HD-Kore"]


def test_an_uploaded_opus_file_is_still_measured_with_its_pre_skip():
    from deckastra_api import audio

    assert audio.duration_ms(_opus(2.5), "audio/ogg") == 2500


# -------------------------------------------------------------- pronunciation


def test_a_line_using_a_pronunciation_is_sent_as_escaped_ssml(google, monkeypatch):
    seen, answers = google
    monkeypatch.setenv("DECKASTRA_SPEECH", "google")
    monkeypatch.setenv("DECKASTRA_GOOGLE_API_KEY", "test-key")
    answers["text:synthesize"] = {"audioContent": base64.b64encode(_mp3(42)).decode()}
    names = [speech.Pronunciation("Deckastra", 'Deck "astra"'), speech.Pronunciation("AI", "A I")]

    speech.synthesize("Deckastra <3 AI, said deckastra.", locale="en-US", voice="default", pronunciations=names)

    assert json.loads(seen[-1].content)["input"] == {
        "ssml": '<speak><sub alias="Deck &quot;astra&quot;">Deckastra</sub> &lt;3 <sub alias="A I">AI</sub>, '
        'said <sub alias="Deck &quot;astra&quot;">deckastra</sub>.</speak>'
    }

    # A line that uses none of them stays plain text: SSML only where it is needed.
    speech.synthesize("Nothing to rename here.", locale="en-US", voice="default", pronunciations=names)
    assert json.loads(seen[-1].content)["input"] == {"text": "Nothing to rename here."}


def test_only_the_pronunciations_a_line_uses_change_its_recording():
    names = [speech.Pronunciation("Deckastra", "Deck astra")]
    plain = speech.cache_key("Four stages.", "en", "default", 1.0, "google")
    # Adding a name the line never says does not make it a new recording to pay for...
    assert speech.cache_key("Four stages.", "en", "default", 1.0, "google", names) == plain
    # ...and one it does say does.
    said = "Deckastra has four stages."
    assert speech.cache_key(said, "en", "default", 1.0, "google", names) != speech.cache_key(said, "en", "default", 1.0, "google")


# ----------------------------------------------------------- credentials file


class _FakeCredentials:
    """Stands in for google-auth's credentials: the refresh is what is under test."""

    def __init__(self, quota: str | None = "file-project") -> None:
        self.token: str | None = None
        self.valid = False
        self.quota_project_id = quota
        self.refreshes = 0

    def refresh(self, _request) -> None:
        self.refreshes += 1
        self.token = f"minted-{self.refreshes}"
        self.valid = True


def test_a_credentials_file_mints_tokens_and_bills_its_own_project(google, monkeypatch, tmp_path):
    seen, answers = google
    path = tmp_path / "deckastra-google.json"
    path.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("DECKASTRA_SPEECH", "google")
    monkeypatch.setenv("DECKASTRA_GOOGLE_CREDENTIALS", str(path))
    fake = _FakeCredentials()
    monkeypatch.setattr(google_credentials, "_load", lambda _path: fake)
    monkeypatch.setattr(google_credentials, "_refresh", lambda credentials: credentials.refresh(None))
    answers["text:synthesize"] = {"audioContent": base64.b64encode(_mp3(42)).decode()}

    speech.synthesize("Hello", locale="en-US", voice="default")
    speech.synthesize("Hello again", locale="en-US", voice="default")

    assert seen[0].headers["Authorization"] == "Bearer minted-1"
    assert seen[0].headers["x-goog-user-project"] == "file-project"
    # Minted once and reused while it is valid, renewed once it is not.
    assert fake.refreshes == 1
    fake.valid = False
    speech.synthesize("Third", locale="en-US", voice="default")
    assert seen[-1].headers["Authorization"] == "Bearer minted-2"
    assert speech.speech_status()["available"] is True


def test_a_named_project_wins_over_the_files_own(google, monkeypatch, tmp_path):
    _seen, _answers = google
    monkeypatch.setenv("DECKASTRA_GOOGLE_CREDENTIALS", str(tmp_path / "x.json"))
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "deckastra")
    monkeypatch.setattr(google_credentials, "_load", lambda _path: _FakeCredentials())
    monkeypatch.setattr(google_credentials, "_refresh", lambda credentials: credentials.refresh(None))
    assert translation.GoogleTranslator().project == "deckastra"


def test_a_missing_credentials_file_is_refused_by_name(google, monkeypatch, tmp_path):
    seen, _answers = google
    monkeypatch.setenv("DECKASTRA_GOOGLE_CREDENTIALS", str(tmp_path / "absent.json"))
    with pytest.raises(translation.ModelUnavailable, match="not a file"):
        translation.GoogleTranslator()
    assert seen == []


def test_the_machines_default_google_login_is_not_used(google, monkeypatch, tmp_path):
    """A developer's default login is for some other project; using it is a decision nobody made."""
    seen, _answers = google
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(tmp_path / "someone-elses.json"))
    assert google_credentials.configured() is None
    with pytest.raises(translation.ModelUnavailable, match="not configured"):
        translation.GoogleTranslator()
    assert seen == []



@pytest.mark.parametrize(
    ("text", "kept"),
    [
        ("Revenue grew 42% in Q3", ["42%", "Q3"]),
        ("COVID-19 and H2O in 2026", ["COVID-19", "H2O", "2026"]),
        ("The iPhone15 costs $999", ["iPhone15", "$999"]),
        ("Three steps", []),
    ],
)
def test_a_word_with_a_digit_in_it_is_kept_whole(text, kept):
    """Found by the first live Google run: "Q⟦1⟧" came back as "first quarter"."""
    masked, spans = translation.mask(text)
    assert spans == kept
    assert translation.unmask(masked, spans) == text


SAY_AS_LIST = [
    speech.Pronunciation("Deckastra", "Deck astra"),
    speech.Pronunciation("AI", "A I"),
    speech.Pronunciation("gcp", "G C P"),
    speech.Pronunciation("डेक", "डेक़"),
    speech.Pronunciation("AI", "eye"),
]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Deckastra has four stages.", "fnv1a64:99a537db4aeea714"),
        ("The AI said hello to GCP and deckastra.", "fnv1a64:81de9de5d79a72c8"),
        ("Nothing to rename here.", ""),
        ("डेकास्ट्रा Deckastra में", "fnv1a64:99a537db4aeea714"),
        ("एक डेक, हर भाषा", "fnv1a64:720a01830a2343da"),
        ("AIs and AI_x and xAI", ""),
    ],
)
def test_say_as_fingerprints_match_the_editors(text, expected):
    """The same vectors as `presentation-schema/tests/pronunciation.test.ts`."""
    assert speech.say_as_fingerprint(text, SAY_AS_LIST) == expected


def test_a_vowel_sign_belongs_to_its_word():
    """"डेक" is not inside "डेकास्ट्रा": the sign after it is part of the word."""
    assert speech.spoken_text("डेकास्ट्रा", SAY_AS_LIST) == "डेकास्ट्रा"
    assert speech.spoken_text("एक डेक", SAY_AS_LIST) == "एक डेक़"


def test_rate_enters_the_fingerprint():
    """The same value as `presentation-schema/tests/pronunciation.test.ts`."""
    assert speech.say_as_fingerprint("Plain line.", [], 1.15) == "fnv1a64:17fb203370813577"
    assert speech.say_as_fingerprint("Plain line.", [], 1.0) == ""


def test_pauses_and_phonetic_names_become_ssml_google_accepts(google, monkeypatch):
    """Both checked live against Chirp 3 HD and Neural2 voices on 2026-10-03."""
    seen, answers = google
    monkeypatch.setenv("DECKASTRA_SPEECH", "google")
    monkeypatch.setenv("DECKASTRA_GOOGLE_API_KEY", "test-key")
    answers["text:synthesize"] = {"audioContent": base64.b64encode(_mp3(42)).decode()}
    names = [speech.Pronunciation("Deckastra", "/ˈdɛkæstrə/"), speech.Pronunciation("GCP", "G C P")]
    speech.synthesize("Deckastra on GCP. [pause 1.5s] Done [pause].", locale="en-US", voice="default", pronunciations=names)
    assert json.loads(seen[-1].content)["input"]["ssml"] == (
        '<speak><phoneme alphabet="ipa" ph="ˈdɛkæstrə">Deckastra</phoneme> on <sub alias="G C P">GCP</sub>. '
        '<break time="1500ms"/> Done <break time="500ms"/>.</speak>'
    )
    # A pause alone is reason enough for SSML; a plain line stays plain text.
    speech.synthesize("Wait [pause] here.", locale="en-US", voice="default")
    assert "ssml" in json.loads(seen[-1].content)["input"]
    speech.synthesize("Plain line.", locale="en-US", voice="default")
    assert json.loads(seen[-1].content)["input"] == {"text": "Plain line."}


def test_the_stand_in_voice_is_as_long_as_its_pauses():
    from deckastra_api import audio

    plain = speech.synthesize("One two three four five six.", locale="en", voice="stub")
    paused = speech.synthesize("One two three [pause 2s] four five six.", locale="en", voice="stub")
    assert abs((paused.duration_ms - plain.duration_ms) - 2000) < 50


def test_a_translator_keeps_pause_markers():
    masked, spans = translation.mask("Wait [pause 0.5s] then 42% more.")
    assert spans == ["[pause 0.5s]", "42%"]
