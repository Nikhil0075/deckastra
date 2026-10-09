# Phase 6 MP4 export — 2026-10-08

Phase 6 is complete. Deckastra exports a narrated deck as a deterministic
H.264/AAC MP4 and exposes the format through the editor, workspace client, API,
durable export job and worker CLI.

## Encoder spike and decision

The spike compared Electron/Chromium WebCodecs plus a JavaScript muxer with an
ffmpeg process boundary.

- The export worker's pinned headless Chromium reported both `VideoEncoder` and
  `AudioEncoder` as unavailable. Electron may expose them on some hosts, but an
  exporter whose codec path changes with the machine is not a reliable release
  boundary.
- WebCodecs also leaves container muxing to another library. AAC encoding has
  platform gaps, and uploaded MP3/Ogg/WAV narration still needs a decoding and
  mixing path. See the [MDN codec selection guidance](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection).
- ffmpeg accepts the existing audio formats, mixes the explicit schedule and
  writes the widely playable H.264/AAC MP4 pair. FFmpeg is LGPL by default but
  can become GPL depending on build options, so Deckastra does not silently
  download an arbitrary static binary. The cloud image installs its distribution
  package; desktop releases use a separately audited executable. See
  [FFmpeg's legal guidance](https://www.ffmpeg.org/legal.html).

Decision: use a configured ffmpeg executable. `DECKASTRA_FFMPEG` is the explicit
override; packaged desktop builds also look in `Resources/ffmpeg`.

## Deterministic pipeline

- `compileVideoPlan` resolves the selected slides, compiles each motion timeline
  and narration schedule, and assigns a global start time to every slide and
  audio event.
- Frame `n` is always sampled at `n × 1000 / fps`; narrated time is mapped back
  to the active animation segment before the shared export renderer paints it.
- The active narration line is burned into the video and the word selected by
  the take's timing points is highlighted on the corresponding frames.
- Narration takes, built-in or uploaded sound cues, and looped soundtrack beds
  become ffmpeg inputs with explicit delay, trim and volume filters. The music
  volume expression comes from Phase 5's compiled duck/fade gain points.
- The final duration is rounded up to a frame boundary. Both video and mixed
  audio are trimmed to that same boundary, which structurally bounds drift to
  one container packet and is tested against one video frame.
- Temporary frames, audio inputs and filter scripts are removed after success or
  failure. Cancelling the durable job terminates the worker/encoder process tree.

## Product surface

- The Export panel offers **Narrated video** and pins 30 fps into the job.
- The API accepts 24, 30 or 60 fps and stores it with the version-pinned job so
  retries cannot change cadence.
- The report records unavailable audio and the current exact-cut approximation
  for authored slide transitions before download.
- Cloud export images install ffmpeg. Missing local encoders produce an
  actionable message naming `DECKASTRA_FFMPEG`.

## Acceptance evidence

- A real browser-rendered, ten-slide narrated deck exported at 30 fps.
- The resulting file had an MP4 `ftyp` box and decoded as H.264 video plus AAC
  audio through an independent ffmpeg readback.
- Video and audio were decoded separately; their reported end times differed by
  no more than 33.3 ms, the one-frame limit at 30 fps.
- The final acceptance run, including burned-in word highlighting, completed in
  13.4 seconds on the development Windows host.
- Worker browser suite: 14 tests passed, including the MP4 acceptance test.
- MP4 planner/encoder arguments: 3 tests passed.
- Export UI save barrier: 8 tests passed, including MP4 cadence.
- API MP4 job and migration checks passed.

## Next phase

Phase 7 scales the reviewed preset catalog to the launch counts in section 6.3,
with every preset passing the existing gate and human review state.
