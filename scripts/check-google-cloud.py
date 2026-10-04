"""A live check of Google translation and voices, through Deckastra's own code.

Run after scripts/setup-google-cloud.ps1. It sends a few words to Google — a
fraction of a cent, inside the free allowance — and reads back what came:

  1. Cloud Translation: "One deck, every language" into Hindi, with a protected
     number, through `translation.GoogleTranslator` and the same masking an
     export uses.
  2. Text-to-Speech: the voices listed for hi-IN.
  3. Text-to-Speech: one short line voiced, with a pronunciation, and the MP3
     measured by `audio.duration_ms` — the length a take would record.

Exit code 0 only when all three answered. Nothing is written to any deck.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

import deckastra_api  # noqa: E402,F401  (path bootstrap for deckastra_agents)
from deckastra_api import google_credentials, speech, translation  # noqa: E402


def main() -> int:
    how = google_credentials.configured()
    print(f"credentials: {how or 'none'}; project: {google_credentials.project() or os.environ.get('GOOGLE_CLOUD_PROJECT') or '(unset)'}")
    if not how:
        print("Not configured. Run scripts/setup-google-cloud.ps1 first.")
        return 2
    os.environ.setdefault("DECKASTRA_SPEECH", "google")

    failures = 0
    try:
        translator = translation.GoogleTranslator()
        masked, spans = translation.mask("One deck, every language, in 3 steps")
        result = translator.translate([translation.Item("t", masked)], source="en", target="hi-IN")
        text = translation.unmask(result["t"], spans)
        print(f"translate  ok  {text!r}  (project {translator.project or 'key'})")
        if "3" not in text:
            print("translate  WARN  the protected number did not survive")
    except Exception as error:  # report every kind; this is a diagnostic
        failures += 1
        print(f"translate  FAIL  {type(error).__name__}: {error}")

    try:
        voices = speech.voices("hi-IN")
        print(f"voices     ok  {len(voices)} for hi-IN, first: {voices[0]['name'] if voices else '-'}")
        voice = voices[0]["name"] if voices else "default"
    except Exception as error:
        failures += 1
        voice = "default"
        print(f"voices     FAIL  {type(error).__name__}: {error}")

    try:
        made = speech.synthesize(
            "Deckastra में आपका स्वागत है।",
            locale="hi-IN",
            voice=voice,
            pronunciations=[speech.Pronunciation("Deckastra", "डेकास्ट्रा")],
        )
        print(f"synthesize ok  {made.content_type}, {len(made.data)} bytes, {made.duration_ms} ms, voice {made.voice}")
        if not made.duration_ms:
            failures += 1
            print("synthesize FAIL  the audio's length could not be read")
        # The speech controls together: a phonetic name, a pause and a rate.
        controlled = speech.synthesize(
            "Deckastra में आपका स्वागत है। [pause 1s] धन्यवाद।",
            locale="hi-IN",
            voice=voice,
            rate=1.2,
            pronunciations=[speech.Pronunciation("Deckastra", "/ˈdɛkæstrə/")],
        )
        print(f"controls   ok  {controlled.duration_ms} ms with a 1s pause, IPA name and rate 1.2")
    except Exception as error:
        failures += 1
        print(f"synthesize FAIL  {type(error).__name__}: {error}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
