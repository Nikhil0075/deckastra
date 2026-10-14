# Design-system V3 export and accessibility gate

`npm run presets:check` is the release gate for the eight design languages. It
does not stop at a contact sheet: the same documents are reopened through
independent PDF and PowerPoint readers, and the capabilities used by the V3
languages are exercised through their screen, PNG, PDF and PPTX paths.

## Coverage

| Requirement | Automated evidence |
| --- | --- |
| Canvas versus PNG | `packages/renderer/tests/pixels.test.ts` renders the production `SlideView` in Chromium at 2× DPR, checks deterministic PNG output and compares the platform baseline when `PIXELS=1`. The language and pattern preview gates render through the worker's PNG path. |
| PDF render and text extraction | `apps/api/tests/test_preset_exports.py` exports every reviewed template and extracts every page with `pypdf`. `test_language_exports.py` independently extracts Hindi and Arabic. |
| PowerPoint reopen | `test_preset_exports.py`, `test_pptx_masks.py`, `test_pptx_treatments.py` and `test_pptx_charts.py` reopen exported files with `python-pptx`. |
| Transparent PNG preservation | `apps/api/tests/test_preset_cutouts.py`, `apps/worker/tests/cutouts.browser.test.ts` and the PPTX media tests verify alpha, MIME and byte preservation. |
| Mask geometry | Renderer mask tests compare resolved cubic bounds; browser tests inspect pixels and PDF soft masks; `python-pptx` tests reopen native ellipse and custom-geometry masks. |
| Editable picture-filled text | `packages/export-pptx/tests/pptx.test.ts` asserts that the run contains DrawingML `blipFill`, remains text, and falls back without flattening when the asset is absent. |
| Narrative reading order | `packages/renderer/tests/accessibility.test.ts` checks semantic order independently of visual depth. Cutout/layer tests verify that depth roles do not rewrite it. |
| Alt text after masks/cutouts | Preset cutout, renderer accessibility and PowerPoint reopen tests keep the description on the image element. |
| Hindi and Arabic | `apps/api/tests/test_language_exports.py` validates embedded Devanagari fonts, logical text extraction and Arabic dotted-letter identity. |
| Windows scaling 100–150% | `packages/editor-ui/tests/layout-sizes.test.ts` checks the same logical layout at 100%, 125% and 150%; the pixel gate also renders at 2× DPR. |
| Narrow and wide editor widths | `layout-sizes.test.ts` and `workspace-layout.test.tsx` cover 1024–2560px windows, panel collapse, restoration and persisted widths. |

## Deliberately broken cases

The gate must fail safely and explain each of these:

- Empty or unresolved mask path: renderer mask tests require an explicit warning and an unmasked picture, never an invisible one.
- Missing cutout asset: the preset-media check reports the manifest entry as absent.
- Transparent PNG with a JPEG name/MIME: the media check rejects it before export.
- Picture-fill asset removed from the manifest: PPTX keeps editable text, uses the authored fallback colour and records an approximation warning.
- Unsupported PowerPoint blend mode: PPTX records a dropped-feature warning naming the element.
- Foreground subject accidentally below its background decoration: Design Check emits `W219` and supplies one undoable move.

## Human evidence

Automation proves integrity, not taste. Before an installer is rebuilt, review:

1. `.artifacts/design-language-gate/index.html` for language separation.
2. `.artifacts/design-system-v2-families/index.html` for layout-family variety.
3. The eight flagship template decks in the desktop app at 100%, 125% and 150% Windows scaling.
4. One PDF and one PowerPoint export per language, with the PowerPoint text, charts and diagrams selected and edited.

