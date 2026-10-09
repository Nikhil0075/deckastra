# Plan 09 gap closure — 2026-10-09

## Audit disposition

The external gap analysis was checked against the working tree rather than
accepted as instructions. Its central finding was correct: the Phase 0–8 status
described implemented slices more strongly than the remaining launch evidence
allowed. Plan 09 now distinguishes implementation from launch closure and keeps
the remaining gaps in §10.1.

No commit, account-plan claim or human-review record was created. Those require
maintainer or product-owner authority and real evidence. The separately
authorized live-provider smoke is recorded below.

## Closure unit 1

- MCP `document_export` now accepts narrated `mp4`, matching the existing API
  and worker capability.
- The transition vocabulary is consistent across schema, animation engine,
  editor controls, API validation/planning, workspace contracts and MCP:
  cut, fade, slide, cover, push, zoom, wipe, split, iris, flip, blur dissolve
  and morph. PowerPoint maps cover to its native push approximation.
- Template `voiceStyle` is persisted into the composed deck's metadata rather
  than disappearing after gallery selection.
- Dead critic signals/tests and the obsolete story prompt were removed. The
  frozen sidecar no longer bundles an unused prompts directory.
- `CLAUDE.md` now labels removed local intelligence as history, describes the
  deterministic motion planner rather than a deleted Motion Agent, and replaces
  the deleted Critic with the current Design Check boundary.
- Plans 07 and 08 now point to plan 09 as the current authority.

## Verification

- Editor transition authoring: 21 tests passed.
- MCP surface and requests: 26 tests passed.
- Animation transition compile/acceptance: 48 tests passed.
- Presentation schema: 139 tests passed; generated schemas regenerated.
- PowerPoint export: 94 tests passed.
- Desktop sidecar data packaging: 9 tests passed.
- Focused API preset/capability/transition checks: 9 tests passed.
- Relevant TypeScript typechecks and `git diff --check` passed.

## Closure unit 2

- Added the three coarse MCP actions from §7: `slide_insert_pattern`,
  `motion_style_apply`, and `voice_lines`. Pattern and motion requests use
  deterministic server planning; agent calls create ordinary reviewable
  proposals and expose no approval action. Voicing uses the existing speech
  service and narration proposal path, including word timings.
- Added matching shared contracts and HTTP client methods rather than a second
  MCP-only write path.
- Added a Patterns tab and rail entry in the editor. Insertion uses reviewed
  named-slot definitions and applies the server's dry-run patch as one undoable
  editor action.
- Added a deck-wide Motion style control. It loads the reviewed catalog and
  applies the deterministic dry-run patch as one undoable editor action.
- The existing Narration panel remains the matching human control for voicing.

Closure-unit verification: 21 focused API tests, 27 MCP protocol tests and 13
editor tests passed. Workspace contracts, client, MCP and editor typechecks
passed.

## Closure unit 3

- Added short-lived signed quotes for generated images, machine translation and
  cloud speech. Each token is bound to the user, deck version and exact request;
  changed prompts, scopes, glossary, cues, voice, rate or pronunciations require
  a fresh quote.
- Paid translation and speech now reserve and reconcile against the existing
  account-credit ledger. Desktop calls travel through the private authenticated
  account bridge, so provider credentials never move into the local sidecar.
- The Languages and Narration panels now show the exact credit amount and require
  a second explicit confirmation before sending text or scripts to a paid cloud
  provider.
- Added MCP `image_quote` / `image_generate` and `voice_quote`. Generated images
  use the existing durable assistant run, workspace asset limits and proposal
  review boundary.

Closure-unit verification: 122 focused API tests, 28 MCP protocol tests, 20
workspace-client tests, 11 focused editor tests and 8 desktop host/account tests
passed. Workspace contracts, client, MCP, editor and desktop typechecks passed.
The paid-provider paths were exercised with deterministic stand-ins; no live
provider request or credits were consumed.

## Live paid-provider smoke — 2026-10-09

The operator authorized one minimal live check per quoted service. Google Cloud
Translation returned a real Hindi translation, Cloud Text-to-Speech returned
valid MP3 audio for both Standard and Chirp 3 HD voices, and Vertex Gemini 3.1
Flash Image returned a 1,249,825-byte PNG. Vertex usage reconciled to
US$0.067311; translation and speech requests were only a few dozen characters.

The first voice request exposed that SSML mark timepoints were being sent to
the v1 endpoint, where Google rejects that field. Speech synthesis now uses the
documented v1beta1 endpoint, and voices that omit mark timepoints receive a
deterministic duration-based word-timing fallback. The generated image is kept
at `artifacts/live-provider-smoke/deckastra-live-image.png`.

## Closure unit 4

- Added the seventh reviewed motion style, `playful`. It uses `wordCascade` for
  text and a spring entrance for non-text elements, and is selectable through
  the existing editor, API, workspace-contract and MCP style surfaces.
- `metadata.voiceStyle` now selects the default live voice persona. An explicit
  deck or cue voice still wins, so the new behavior does not override authored
  choices.
- Expanded `presets:check` to compose all 24 reviewed templates with their own
  motion style, verify that every slide is animated, export a real PDF and PPTX,
  and reopen every output with `pypdf` and `python-pptx`. This adds 48 readable
  export checks to the catalog and contact-sheet drift gate.
- Removed the empty legacy prompt, evaluation, node and integration remnants,
  and corrected the remaining path documentation. The complete repository gate
  also found and fixed three stale editor token-discipline violations.

Closure-unit verification: `presets:check` passed all 24 template cases and 48
real exports; all TypeScript workspace typechecks passed; all JavaScript and
TypeScript suites passed 1,999 tests with one renderer-preview skip. The full
Python gate passed 776 tests with 26 environment-dependent skips and one
expected hostile-ZIP duplicate-entry warning.

## Still open

An audited bundled ffmpeg, a signed rebuild and full installed-desktop smoke,
human contact-sheet review, complete client approve/undo evidence, Copilot tier
evidence and an approved live Veo run remain open. Launch also still needs the
operator-owned privacy, terms, OAuth-publishing, production-alert, Arabic-PDF,
signing, distribution, billing, GST and Business-tier decisions tracked by the
release plan. The dirty working tree remains uncommitted; this audit does not
assume authority to package hundreds of existing changes into commits.
