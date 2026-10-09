# ffmpeg audit for the desktop installer — 2026-10-09

The desktop installer distributes ffmpeg for MP4 export and video poster
frames, so it may ship only a build whose licence allows that. This records the
build that was audited and what it was checked against.

## The build

| | |
| --- | --- |
| Source | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), release `latest` dated 2026-10-09 |
| Archive | `ffmpeg-n9.0-latest-win64-lgpl-9.0.zip`, 171,474,130 bytes |
| Archive SHA-256 | `b4c78a248da441aeb80fcb59a4edd643c034703fe0cf1c61933b80ecb6e58aaa` (matches BtbN's published `checksums.sha256`) |
| Version | `ffmpeg version n9.0.2-24-gfd5d616c29-20261009`, built with gcc 16.2.0 |
| `bin/ffmpeg.exe` | 134,499,328 bytes, static |
| `ffmpeg.exe` SHA-256 | `9e93e998e4f540b2eca34409daa015fbeddf090dfaa9f9c762d380e2b235e105` |
| Licence | **LGPL version 3** (built with `--enable-version3`; `LICENSE.txt` in the archive is LGPL-3.0) |

The files are kept in `vendor/ffmpeg/`, which is ignored by git. BtbN rebuilds
`latest` every day and keeps old builds only briefly, so this exact binary
cannot be downloaded again by name. It must be stored somewhere we control
before it is bundled.

## Audit (`node apps/desktop/scripts/check-ffmpeg.mjs vendor/ffmpeg/n9.0/ffmpeg.exe`)

- No `--enable-gpl` and no `--enable-nonfree`; `libx264` and `libx265` absent. **Pass.**
- `h264_mf` (Windows Media Foundation) and the built-in `aac` encoder present. **Pass.**
- Note: `--enable-libopenh264` is compiled in. Export never selects it. Cisco's
  patent coverage applies only to its own binary downloaded separately to the
  user's device, so this copy is unused weight, not a licence problem.
- Also present but not selected by export: `h264_nvenc`, `h264_amf`, `h264_qsv`.

## Live encoding

With `DECKASTRA_FFMPEG` pointing at this binary, the worker's browser suite
passed 15 of 15, none skipped:

- Narrated MP4 acceptance: ten narrated slides, H.264 through `h264_mf`, AAC
  audio, no more than one frame of audio/video drift.
- Generated video export: the embedded clip's frames appear in the MP4, and
  the PDF uses the poster.

Running them for the first time found two bugs, both fixed in the same change:

1. `-filter_complex_script` no longer exists in ffmpeg 9. FFmpeg 7.0 replaced
   it with `-/filter_complex`, and Debian bookworm's 5.1 (the cloud image) knows
   only the old spelling. The worker now reads `ffmpeg -version` and uses the
   spelling that ffmpeg understands.
2. Every exported clip began with its **poster** rather than its first frame.
   The seek was skipped when the clip was already at the target time, and a
   paused video that has never sought keeps showing its poster. The worker now
   always seeks.

CI's Export job now installs the runner's ffmpeg (6.1, with `libx264`) and
runs these tests, so the libx264 and old-spelling path is covered on every
push, and this audit covers the LGPL and `h264_mf` path.

## Before it ships

1. Store this `ffmpeg.exe` (SHA-256 above) where the release build can fetch
   it by hash.
2. Bundle it at `resources/ffmpeg/ffmpeg.exe` through `extraResources`.
   `ffprobe` and `ffplay` are not shipped.
3. Add it to `THIRD_PARTY_NOTICES` with the LGPL-3.0 text, the exact version,
   and a link to its source (FFmpeg `n9.0.2-24-gfd5d616c29` and BtbN's build
   scripts).
4. Sign it with the release certificate. `verify-release.mjs` refuses it
   otherwise.
5. Rebuild the installer and smoke-test a narrated MP4 export and a video
   poster frame on the installed app.

Size: at 134 MB uncompressed, this is the largest single file the installer
would carry. A minimal LGPL build with only the needed codecs, filters and
formats is likely an order of magnitude smaller, and is worth doing before a
public release.

This is a technical licence check, not legal advice.
