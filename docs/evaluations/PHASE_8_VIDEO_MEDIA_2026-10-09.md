# Phase 8 video media evidence — 2026-10-09

## Result

Phase 8 is complete at the application boundary. Video is an explicit paid
media task, never a text-model route. The default is a pinned Veo 3.1 Fast
model, muted 720p output, one clip, and one of the provider-supported 4, 6 or 8
second durations. No paid provider call was made during this phase because the
plan requires a separately approved media budget.

## Cost and authority boundary

- `POST /v1/media/quotes/video` calculates account credits and returns a signed
  15-minute quote bound to user, presentation, prompt hash, model, duration,
  aspect ratio and `generate_audio=false`.
- Assistant video runs reject missing, expired or mismatched quotes before they
  enter the queue. Hosted generation also reserves and reconciles credits.
- MCP exposes separate `media_quote` and `media_generate` tools. Generation can
  create only a pending proposal; no agent tool can approve it.
- The gateway transport uses the pinned Vertex long-running prediction and poll
  contract, with no automatic retry after a request may have been accepted.

## Asset and export handling

- MP4 files are capped at 32 MiB each and render payloads at 96 MiB total.
  Workspace quota is checked before either the clip or poster asset is recorded.
- A poster PNG is extracted by the configured audited ffmpeg executable and is
  a first-class reference for validation, scoped proposals and reference counts.
- PDF receives poster bytes only and records that motion was approximated.
- PPTX writes the MP4 media part, video relationship and poster blip.
- MP4 export seeks embedded video to the resolved local slide time before each
  frame capture, so it composes with narration and the deterministic timeline.

## Verification

- Provider quote, bounded request and long-running poll: `agents/tests/test_video_media.py`.
- Signed quote, mismatch refusal, storage registration and pending proposal:
  `apps/api/tests/test_assistant.py`.
- Agent quote/generate split and absence of self-approval:
  `apps/mcp-server/tests/tools.test.ts`.
- Renderer payload/DOM behavior: `packages/renderer/tests/scene.test.ts`.
- Native PowerPoint media relationship: `packages/export-pptx/tests/pptx.test.ts`.
- Poster-only PDF and composed MP4 checks:
  `apps/worker/tests/video-media.browser.test.ts`.

The Python suites, TypeScript typechecks, renderer, worker, MCP and PowerPoint
unit suites are green. The encoder-backed browser case is present and gated by
`DECKASTRA_FFMPEG`; this workstation has no ffmpeg executable, so that case is
skipped here. Phase 6 already records a decoded real narrated MP4 within the
one-frame drift target on an encoder-equipped environment.
