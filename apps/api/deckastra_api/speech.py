"""Narration by text-to-speech (integration plan 01 §3.8).

A take is synthesized, stored as an ordinary audio asset, and attached to its
cue **as a proposal** — the same lifecycle as any other change an agent or a
service makes. What makes it safe to automate is what happens around the call:

- **The duration comes from the file.** `audio.duration_ms` reads the encoded
  container. A rate of 1.1 does not make a sentence 1/1.1 as long, and a
  narrated deck advances on this number.
- **An identical request reuses the existing asset.** The cache key is the text,
  the language, the voice, the rate and the provider's version, so re-voicing a
  twenty-slide deck after one edit costs one clip. A cache hit is not charged.
- **The allowance is checked before the request** (`quotas.check_speech`): the
  size of a synthesis is known in advance, so the one that would cross the line
  is refused rather than the one after it.
- **Providers are chosen, never fallen back to**, like generation. `stub` makes
  a recording of the right length from soft tones — unmistakably not a voice —
  so the narrated path runs with no key, in a checkout and in CI. It is not
  offered in an installed product.

Google Cloud Text-to-Speech (Chirp 3 HD) is the cloud provider. It is
configured by environment and has not been exercised against the live service
from this repository; the request and response shapes are Google's documented
`text:synthesize` and `voices` REST resources.
"""

from __future__ import annotations

import base64
import hashlib
import re
import os
import time
import unicodedata
from dataclasses import dataclass
from typing import Any
from xml.sax.saxutils import escape as xml_escape

import httpx
from deckastra_agents.router import ModelUnavailable, distribution

from . import audio, locales
from . import google_credentials
from .translation import google_auth_headers

SPEECH_ENV = "DECKASTRA_SPEECH"
PROVIDERS = ("stub", "google")
#: Bumped when a provider's output for the same request would change, so a
#: cached take is not reused across a voice-model upgrade.
PROVIDER_VERSIONS = {"stub": "stub-1", "google": "google-tts-v1-chirp3"}


class SpeechError(RuntimeError):
    """The speech service answered and the answer could not be used."""


@dataclass
class Synthesis:
    data: bytes
    content_type: str
    extension: str
    duration_ms: int
    voice: str
    peaks: list[float] | None


def selected_speech_provider() -> str:
    choice = os.environ.get(SPEECH_ENV, "").strip().lower()
    if choice and choice not in PROVIDERS:
        raise ModelUnavailable(
            f"{SPEECH_ENV} is set to {choice!r}, which this build does not recognise. Use one of: "
            f"{', '.join(PROVIDERS)}. Nothing was sent anywhere."
        )
    if choice == "google":
        return "google"
    production = distribution() or os.environ.get("DECKASTRA_ENV") == "production"
    if choice == "stub" or not production:
        if production:
            raise ModelUnavailable("The stand-in voice is for development; it is not in an installed product.")
        return "stub"
    raise ModelUnavailable(
        "Narration voices are not set up on this install. Record narration in the app, or configure a speech provider."
    )


def speech_status() -> dict[str, Any]:
    try:
        provider = selected_speech_provider()
    except ModelUnavailable as error:
        return {"provider": "none", "available": False, "reason": str(error)}
    if provider == "google":
        if not google_credentials.configured():
            return {
                "provider": "google",
                "available": False,
                "reason": "Google voices are chosen and not configured (DECKASTRA_GOOGLE_CREDENTIALS, DECKASTRA_GOOGLE_API_KEY or DECKASTRA_GOOGLE_ACCESS_TOKEN).",
            }
        return {"provider": "google", "available": True, "reason": "Voiced by Google Cloud Text-to-Speech. The script is sent to Google."}
    return {
        "provider": "stub",
        "available": True,
        "reason": "Development stand-in: tones the length of the script, not a voice. Nothing is sent.",
    }


# ------------------------------------------------------------ pronunciation


@dataclass(frozen=True)
class Pronunciation:
    """Say ``term`` as ``say``: a brand or name a voice gets wrong (plan 01 §7)."""

    term: str
    say: str


def _word(char: str) -> bool:
    """A letter, a combining mark, a digit or "_": what a whole word is made of.

    Marks count. A Devanagari vowel sign is a mark, and with Python's ``\\w``
    alone "डेक" was found inside "डेकास्ट्रा", because the sign after it read as
    the end of a word.
    """
    return char == "_" or unicodedata.category(char)[0] in "LMN"


def _find(text: str, pronunciations: list[Pronunciation]) -> list[tuple[int, int, Pronunciation]]:
    """Each whole-word use of a term, left to right, longest term first.

    A scan rather than a regular expression so it can be stated identically in
    TypeScript (`presentation-schema/src/pronunciation.ts`): Python's ``re``
    has no Unicode property classes, and two engines' ideas of a word boundary
    are how two fingerprints of one line come to disagree. Case-insensitive,
    because names are written however a sentence capitalises them; the first
    entry for a term wins.
    """
    first: dict[str, Pronunciation] = {}
    for item in pronunciations:
        if item.term.strip() and item.term.lower() not in first:
            first[item.term.lower()] = item
    terms = sorted(first.values(), key=lambda item: len(item.term), reverse=True)
    if not terms:
        return []
    found: list[tuple[int, int, Pronunciation]] = []
    i = 0
    n = len(text)
    while i < n:
        hit = None
        if i == 0 or not _word(text[i - 1]):
            for item in terms:
                end = i + len(item.term)
                if end <= n and text[i:end].lower() == item.term.lower() and (end == n or not _word(text[end])):
                    hit = (i, end, item)
                    break
        if hit:
            found.append(hit)
            i = hit[1]
        else:
            i += 1
    return found


def applicable(text: str, pronunciations: list[Pronunciation]) -> list[Pronunciation]:
    """The pronunciations this line actually uses, ordered by term."""
    used = {item.term.lower(): item for _start, _end, item in _find(text, pronunciations)}
    return sorted(used.values(), key=lambda item: item.term.lower())


def say_as_fingerprint(text: str, pronunciations: list[Pronunciation], rate: float = 1.0) -> str:
    """How a voiced line was delivered, as its take records it (`sayAs`): the
    pronunciations it used and the speaking rate when that is not 1.

    "" for a line said plainly at the normal rate, so takes voiced before either
    control existed stay current. The twin of `sayAsFingerprint` in
    `presentation-schema/src/pronunciation.ts`: the panel counts what is due
    with that one and this one decides what to voice, and both are held to the
    same fixed vectors in their tests.
    """
    parts = [f"{item.term.lower()}={item.say}" for item in applicable(text, pronunciations)]
    if abs(rate - 1.0) > 1e-9:
        parts.append(f"rate={rate:.2f}")
    if not parts:
        return ""
    return locales.text_hash("\n".join(parts))


# ------------------------------------------------------------------ pauses

#: A pause written into a script: ``[pause]`` (half a second) or ``[pause 1.5s]``
#: / ``[pause 800ms]``. Plain text, so it survives every place a script travels —
#: an overlay, an agent's proposal, Code mode — and a translator is told to keep
#: it (``translation._PROTECTED``) the way it keeps a number.
PAUSE = re.compile(r"\[pause(?:\s+(\d+(?:\.\d+)?)\s*(ms|s))?\]", re.IGNORECASE)
DEFAULT_PAUSE_MS = 500
MAX_PAUSE_MS = 10_000


def pause_ms(match: re.Match[str]) -> int:
    if not match.group(1):
        return DEFAULT_PAUSE_MS
    value = float(match.group(1)) * (1 if match.group(2).lower() == "ms" else 1000)
    return int(max(100, min(MAX_PAUSE_MS, round(value))))


def total_pause_ms(text: str) -> int:
    return sum(pause_ms(match) for match in PAUSE.finditer(text))


def _phonetic(say: str) -> str | None:
    """The IPA in ``/ˈdɛkæstrə/``: how a name sounds, not how to spell it out."""
    say = say.strip()
    if len(say) > 2 and say.startswith("/") and say.endswith("/"):
        return say[1:-1].strip() or None
    return None


def spoken_text(text: str, pronunciations: list[Pronunciation]) -> str:
    """The words as the stand-in voice says them: names replaced by how to say
    them, pause markers dropped (their silence is added separately)."""
    out: list[str] = []
    last = 0
    for start, end, item in _find(text, pronunciations):
        out.append(text[last:start])
        # A stand-in cannot read IPA; it says the name as written.
        out.append(text[start:end] if _phonetic(item.say) else item.say)
        last = end
    out.append(text[last:])
    return PAUSE.sub(" ", "".join(out))


def needs_ssml(text: str, pronunciations: list[Pronunciation]) -> bool:
    return bool(applicable(text, pronunciations)) or bool(PAUSE.search(text))


def ssml(text: str, pronunciations: list[Pronunciation]) -> str:
    """SSML for a line: names as written down (``<sub>``, or ``<phoneme>`` for
    IPA), pauses as ``<break>``, everything else as plain words.

    Every piece of the script is escaped, and only those three elements are
    ever produced: a script someone typed is text, and a ``<`` in it must not
    become markup. All three are accepted by Chirp 3 HD and Neural2 voices
    (checked live, 2026-10-03).
    """
    quote = {chr(34): "&quot;"}

    def words(piece: str) -> str:
        out: list[str] = []
        last = 0
        for start, end, item in _find(piece, pronunciations):
            out.append(xml_escape(piece[last:start]))
            written = xml_escape(piece[start:end])
            ipa = _phonetic(item.say)
            if ipa:
                out.append(f'<phoneme alphabet="ipa" ph="{xml_escape(ipa, quote)}">{written}</phoneme>')
            else:
                out.append(f'<sub alias="{xml_escape(item.say, quote)}">{written}</sub>')
            last = end
        out.append(xml_escape(piece[last:]))
        return "".join(out)

    out: list[str] = []
    last = 0
    for match in PAUSE.finditer(text):
        out.append(words(text[last : match.start()]))
        out.append(f'<break time="{pause_ms(match)}ms"/>')
        last = match.end()
    out.append(words(text[last:]))
    return "<speak>" + "".join(out) + "</speak>"


def cache_key(
    text: str, locale: str, voice: str, rate: float, provider: str, pronunciations: list[Pronunciation] | None = None
) -> str:
    # Only the pronunciations this line uses: adding a name to the list must
    # not make every other line in the deck a new recording to pay for.
    used = applicable(text, pronunciations or [])
    material = "\x1f".join(
        [text, locale, voice, f"{rate:.3f}", PROVIDER_VERSIONS.get(provider, provider)]
        + [f"{item.term.lower()}={item.say}" for item in used]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def synthesize(
    text: str, *, locale: str, voice: str, rate: float = 1.0, pronunciations: list[Pronunciation] | None = None, budget=None, accounted=False
) -> Synthesis:
    provider = selected_speech_provider()
    pronunciations = applicable(text, pronunciations or [])
    if provider == "stub":
        data = audio.stub_voice(spoken_text(text, pronunciations), words_per_second=2.6 * rate, pause_ms=total_pause_ms(text))
        duration = audio.duration_ms(data, "audio/wav")
        if duration is None:
            raise SpeechError("The stand-in recording could not be measured.")
        return Synthesis(data, "audio/wav", "wav", duration, "stub", audio.peaks(audio.wav_samples(data)))
    from .paid_services import billed
    if accounted:
        return _google_synthesize(text, locale=locale, voice=voice, rate=rate, pronunciations=pronunciations)
    with billed("speech", len(text), "DECKASTRA_SPEECH_USD_PER_MILLION", budget=budget):
        return _google_synthesize(text, locale=locale, voice=voice, rate=rate, pronunciations=pronunciations)


# --------------------------------------------------------------------- Google


def _google_credentials() -> dict[str, Any] | None:
    """How to authorise a request, minting a token from a credentials file if one is named."""
    token = google_credentials.bearer_token()
    if token:
        return {"headers": google_auth_headers(token)}
    key = os.environ.get("DECKASTRA_GOOGLE_API_KEY", "").strip()
    if key:
        return {"key": key}
    return None


def _google_request(http: httpx.Client, method: str, url: str, **kwargs: Any) -> httpx.Response:
    credentials = _google_credentials()
    if not credentials:
        raise ModelUnavailable("Google voices are chosen and no key is set. Nothing was sent.")
    if "headers" in credentials:
        kwargs.setdefault("headers", {}).update(credentials["headers"])
    else:
        kwargs.setdefault("params", {})["key"] = credentials["key"]
    response = http.request(method, url, **kwargs)
    response.raise_for_status()
    return response


def voice_language(locale: str, voice: str) -> str:
    """The languageCode to send with a voice.

    A Google voice's name starts with its own tag ("hi-IN-Chirp3-HD-Kore"), and
    a request whose languageCode disagrees with the voice is refused. A deck
    tagged plain "hi" therefore speaks as its chosen voice's "hi-IN".
    """
    parts = (voice or "").split("-")
    if len(parts) >= 3 and parts[0].lower() == locale.split("-")[0].lower():
        return f"{parts[0]}-{parts[1]}"
    return locale


def _google_synthesize(
    text: str, *, locale: str, voice: str, rate: float, pronunciations: list[Pronunciation] | None = None
) -> Synthesis:
    body = {
        # SSML only when the line uses a pronunciation or a pause: plain text
        # is the documented default.
        "input": {"ssml": ssml(text, pronunciations or [])} if needs_ssml(text, pronunciations or []) else {"text": text},
        "voice": {"languageCode": voice_language(locale, voice), **({"name": voice} if voice and voice != "default" else {})},
        # MP3, not Ogg Opus: PowerPoint plays MP3 and WAV, and an Opus take
        # could not go into an exported deck at all. Google's MP3 is 32kbps
        # mono (a minute is ~240KB) and every browser decodes it.
        "audioConfig": {"audioEncoding": "MP3", "speakingRate": max(0.25, min(4.0, rate))},
    }
    try:
        with httpx.Client(timeout=60) as http:
            response = _google_request(http, "POST", "https://texttospeech.googleapis.com/v1/text:synthesize", json=body)
        data = base64.b64decode(response.json()["audioContent"])
    except (httpx.HTTPError, KeyError, ValueError) as error:
        raise SpeechError(f"Google Text-to-Speech failed: {error}") from error
    duration = audio.duration_ms(data, "audio/mpeg")
    if duration is None:
        raise SpeechError("Google returned audio whose length could not be read.")
    # MP3 is not decoded here; the editor draws the waveform from the file.
    return Synthesis(data, "audio/mpeg", "mp3", duration, voice or "default", None)


_VOICE_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}
VOICE_CACHE_SECONDS = 24 * 3600

#: What the stand-in offers, so the voice picker has something to show in a checkout.
STUB_VOICES = [{"name": "stub", "label": "Stand-in tones (development)", "gender": "neutral"}]


def voices(locale: str) -> list[dict[str, Any]]:
    """The voices for a language, cached for a day (plan 01 §3.8)."""
    provider = selected_speech_provider()
    if provider == "stub":
        return STUB_VOICES
    cached = _VOICE_CACHE.get(locale)
    if cached and time.monotonic() - cached[0] < VOICE_CACHE_SECONDS:
        return cached[1]
    try:
        with httpx.Client(timeout=30) as http:
            response = _google_request(
                http, "GET", "https://texttospeech.googleapis.com/v1/voices", params={"languageCode": locale}
            )
        # By language, not by exact tag: a deck tagged plain "hi" has every
        # voice Google lists under "hi-IN", and an exact match found none.
        primary = locale.split("-")[0].lower()
        listed = [
            {"name": item["name"], "label": item["name"], "gender": str(item.get("ssmlGender", "")).lower()}
            for item in response.json().get("voices", [])
            if any(code.split("-")[0].lower() == primary for code in item.get("languageCodes", []))
        ]
    except (httpx.HTTPError, KeyError, ValueError) as error:
        raise SpeechError(f"Could not list Google voices: {error}") from error
    # The deck's own region first ("hi-IN" voices for a "hi-IN" deck), then
    # Google's newest voices, then by name.
    listed.sort(
        key=lambda voice: (
            0 if voice["name"].lower().startswith(locale.lower() + "-") else 1,
            0 if "Chirp3-HD" in voice["name"] else 1,
            voice["name"],
        )
    )
    _VOICE_CACHE[locale] = (time.monotonic(), listed)
    return listed
