# Phase 4 animation — 2026-10-07

Phase 4 is complete. Themes carry safe custom motion presets, the built-in
animation and transition catalogs cover the Phase 4 set, and agents can inspect
the result as a deterministic motion contact sheet.

## A1 delivered

- `theme.motion.motionPresets` stores named, data-only property tracks. The
  format contains normalized keyframes and no expression or execution surface.
- Every custom preset declares its category, optional description, fixed
  property tracks and a required reduced-motion fallback.
- Validation emits blocking code `E208` when that fallback is missing. An
  incomplete preset can still be preserved by a reader, but cannot pass the
  presentation/export gate.
- The animation compiler resolves built-in and theme-local presets through the
  same path. Reduced motion may point to a built-in or another theme-local
  preset.
- A single entrance clip is clamped to the theme's entrance budget, defaulting
  to 2.5 seconds, so imported theme data cannot reserve an unbounded entrance.
- Compiled clips retain their resolved category. PowerPoint therefore keeps a
  custom exit as an exit and a custom emphasis as emphasis, maps it to the
  nearest supported native effect and records the result as `approximated`.
- PDF behavior remains the established final-frame capture path.

## Verification

- Presentation schema validation: 24 tests passed.
- Animation preset and compiler suites: 91 tests passed.
- PowerPoint export suite: 79 tests passed, including the custom-exit mapping.
- Full workspace TypeScript typecheck passed.

## A2 delivered

- Added `shake`, `wipeOut`, `moveAlongPath`, `lineByLine` and `wordCascade` to
  the existing pulse, highlight sweep, underline draw, colour shift, fade/slide/
  scale exits and text-build catalog.
- `moveAlongPath` resolves an optional path element and derives a portable path
  vector from its bounds; an unresolved reference degrades to the authored
  vector and reports the fallback.
- Added wipe, split, iris, flip and blur-dissolve transitions. Every transition
  is sampled by the same pure timeline path used for seek and playback, and
  reduced motion cuts it rather than merely shortening it.
- Added browser mappings for clip reveals, circular apertures, Y-axis flips and
  blur dissolves without replacing the renderer's base transform.
- PowerPoint receives native emphasis, exit, motion-path, text-build, wipe,
  split, circle and dissolve nodes where available. The remaining nearest-effect
  mappings are recorded as `approximated`.
- The deck-level acceptance suite now exercises every Phase 4 built-in for
  seek/play parity and reduced motion.

### A2 verification

- Animation engine: 148 tests passed across preset, compiler, transition and
  deck-acceptance suites.
- PowerPoint exporter: 92 tests passed.
- Presentation schema, animation engine and PowerPoint exporter typechecks
  passed.

## A4 delivered

- Added `motion_preview` to MCP. Its default result is one time-labelled 3×2
  PNG containing six evenly spaced samples from the slide timeline.
- The animation engine computes each frame and the export worker measures the
  scene once, paints all frames on one browser page, and captures one image.
  There is no second animation implementation and no six-process render loop.
- The endpoint returns the source version, total duration and exact frame times.
  It refuses stale versions, missing slides and unbounded frame counts.
- Text sub-target motion uses the same segmentation path as export, assets are
  inlined through the same authorized loader, and estimated text metrics remain
  visible to the caller.

### A4 verification

- MCP protocol/tool suite: 24 tests passed, including request and image/caption
  coverage for `motion_preview`.
- Preview API suite: 8 tests passed, including a real six-frame Chromium render
  and PNG dimension verification.
- Full workspace TypeScript typecheck passed.

## Next phase

Phase 5 adds word timings, music-bed lowering, voice per cue and the expanded
deterministic sound library. Its acceptance step is a reveal firing on the
correct spoken word.
