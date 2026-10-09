# Phase 5 narration — 2026-10-08

Phase 5 is complete. Narration can drive reveals by spoken word, lines can use
different speakers, a deck can carry a ducked music bed, and the deterministic
sound library has reached 40 recipes.

## Word timing and word-linked reveals

- Google speech requests use safe SSML marks and request `SSML_MARK` time
  points. The returned points are stored on both the cached audio asset and the
  document take, so cache hits preserve alignment without another provider call.
- The development stand-in produces deterministic alignment across its measured
  audio duration, keeping the complete path testable without a paid request.
- `advanceOnWord` names a zero-based word in the selected take. The narrated
  schedule advances at that word only after the current step's animation has
  settled, while the recording continues across the reveal.
- Seek/resume replans the still-speaking recording from its exact offset. The
  presenter script receives and highlights the currently spoken word.
- Invalid/out-of-order timings fail validation; a missing selected word reports
  a warning and safely falls back to end-of-line advancement.

## Multiple speakers

- Every narration cue may select a voice. Synthesis, cache keys and stale-take
  checks resolve the cue voice before the request-wide default.
- The Narration panel exposes a Speaker selector per line. MCP
  `narration_propose` accepts the same voice and word-link intent without
  exposing milliseconds.

## Music bed and ducking

- `soundtrack` accepts a built-in recipe or audio asset, optional slide range,
  looping, fades, level and ducking attack/release.
- The narrated-playback compiler emits a deterministic gain envelope. Present
  mode consumes that envelope for both file and library audio.
- PowerPoint embeds the music as background audio and records an
  `approximated` degradation because loop/fade/duck behavior varies by player.

## Sound library

- Added UI confirm/cancel, swipe, two risers, a warm chime and three ambient
  beds, bringing the library from 31 to 40 deterministic synthesis recipes.
- The existing byte-stability, peak-level and WAV-header tests cover every
  recipe through the shared catalog.

## Verification

- Word/reveal and soundtrack schedule: 13 animation-engine tests passed.
- Language and speech API plus database migration: 25 tests passed.
- PowerPoint exporter: 93 tests passed, including music embedding and the
  approximation report.
- Presentation schema: 139 tests passed; generated JSON Schema drift gate green.
- Presentation core: 81 tests passed.
- Renderer: 212 tests passed, 1 optional pixel test skipped.
- MCP narration/outline suites: 29 tests passed.
- Presenter, audio and sync selection: 35 focused editor tests passed.
- Full workspace TypeScript typecheck passed.

## Next phase

Phase 6 starts with the required encoder spike, comparing Electron WebCodecs
plus a JavaScript MP4 muxer against a bundled ffmpeg route on the 60-slide
performance deck. The exit is a narrated ten-slide MP4 with audio drift no
greater than one frame.
