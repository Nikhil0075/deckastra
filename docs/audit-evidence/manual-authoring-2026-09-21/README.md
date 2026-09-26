# Review evidence — 21 September 2026

Main deliverable: [manual-authoring gap plan](../../MANUAL_AUTHORING_AND_PRE_RELEASE_GAP_PLAN_2026_09_21.md).

## Current verification

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| Desktop source build | Pass | `build.log`; Vite chunk-size warning, not a build failure |
| All 16 existing TS test workspaces | **1,369 passed, 1 skipped** | `workspace-summary.json` and individual logs. Ran existing Vitest commands directly with one worker; retained their pixel/browser/E2E exclusions. Editor UI was a separate one-worker run: 406 passed. |
| Root `npm test` attempts | Interrupted / incomplete | `npm-test.log`; second invocation `npm-test-serial.log` warned that npm consumed the worker flags. Neither counts as a complete pass. The direct-workspace runner resolved this issue. |
| New text/image witnesses + selected existing UI tests | **42 passed, 3 failed** | `focused.log`; failures demonstrate partial-composition commit, rich paste flattening and portrait image placement. Three new positive controls passed. |
| New live-geometry witnesses + existing gesture tests | **12 passed, 2 failed** | `canvas-live.log`; failures demonstrate group-child drag and rotation preview. Counts overlap the focused run. |
| Typecheck | Pass | `typecheck.log` |
| Schema drift | Pass | `schema-drift.log` |
| Python fixture contracts | Pass | `fixtures.log`; three fixtures, six base negative cases, both element-boundary checks |
| API + agents + integrations, `-m 'not slow'` | **720 passed, 1 failed, 15 skipped, 8 deselected** | `python-fast.log`; object-store upload lifecycle failed with `httpx.ReadTimeout`. No application source was changed in this review. Original quiet run did not enumerate every skip reason. |
| Retry of the failed object-store test after resources changed | **1 skipped** | `object-store-retry.log`: MinIO unavailable; this is not a passing retry. Restore the service and rerun to close the finding. |
| Cold desktop motion, two isolated profiles | Failed before motion | `smoke/motion.json`, `smoke-clean/motion.json`; startup readiness timed out |
| Retry of interrupted first profile | Failed | `motion-retry.err.log`: `_alembic_tmp_export_jobs already exists` during migration. Abnormal startup/termination evidence, not a claim every normal migration corrupts. |
| Warm desktop motion | Harness reports pass, **qualified** | `smoke-warm/motion.json`; `firstRunNotice: false`, `ok: true`. Inspect `smoke-warm/motion-transition.png`: first-run dialog still covers the UI while the harness acts behind it. MA-35. |
| Native desktop interaction after “try now” | Mixed | See journey below; real OS input through computer-use, on our own profile |

The pre-existing renderer preview test is opt-in and was skipped. Browser worker tests, pixel tests, web E2E, physical IME/display/screen-reader checks, real external MCP hosts and the installed release were not completed in this review. Prior green runs are historical, not substituted for these checks.

## Native journey

Executable: `D:\Presentation_app\node_modules\electron\dist\electron.exe`, application `D:\Presentation_app\apps\desktop`, profile `.next/manual-authoring-review/profile-clean`. Freshly rebuilt source, version 0.9.0-beta.1. Initial automation attempts timed out; the user's resource change made the retry usable.

1. Opened the app, observed the first-run dialog, dismissed **Start using Deckastra** at its visible screen position. An earlier accessibility-index click selected text instead; coordinate input corrected that tooling issue. Do not count that misdirected input as a product defect.
2. Double-clicked the slide-1 headline twice. The object became selected but no canvas editable appeared. Enter also did not start editing. This is consistent with the absent Enter handler; double-click's root cause still needs a browser-event regression (pointer-capture retargeting is a concrete hypothesis).
3. Dragged that headline successfully: X/Y changed from 120/200 to 319/360, and the UI subsequently reported Saved. `live-text-drag.jpg` / `.txt`.
4. Used **Add image** and the native file dialog to upload an internally generated 240 × 140 solid cyan PNG. It appeared and saved in a box at X/Y 480/270, W/H 960/540.
5. Dragged from its visible centre toward the lower right. The image remained at X/Y 480/270, with unchanged session history. Captured after waiting for the settled UI: `live-png-drag-failed.jpg` / `.txt`. No mutation/removal of the PNG's native-drag code was performed, so the observed failure is established but its cause remains to be isolated.
6. Opened Motion, selected slide 2, clicked **Fade**. Slide-direction controls disappeared, Fade became selected, and the UI reported Saved. `live-transition-fade.jpg` / `.txt`. This checks selecting/saving a transition, not its presentation playback or every transition kind.
7. Inserted an unanimated **New text** box on slide 2 as a control and double-clicked its visible text. No editable appeared. `live-new-text-doubleclick.jpg` / `.txt`.
8. Closed the isolated app with Alt+F4 after Saved. Its process exited. Kept the test profile/evidence; the user's real profile was not used.

The screenshots show this development build at the tested window size. They are not Figma certification, a final installer run, or pixel baselines.

## Reproduce the five deterministic failures

The two `.test.tsx.txt` files are archived review witnesses. Copy one into `packages/editor-ui/tests/` under its `.test.tsx` name, then run from `packages/editor-ui`:

```powershell
node ../../node_modules/vitest/vitest.mjs run tests/manual-authoring-audit.test.tsx --maxWorkers=1 --no-file-parallelism
node ../../node_modules/vitest/vitest.mjs run tests/canvas-live-audit.test.tsx --maxWorkers=1 --no-file-parallelism
```

The first file expects three failures and three passing controls before fixes. The second expects two failures and twelve passing existing tests. These are evidence tests, not newly fixed features. Temporary discovered copies were removed after testing; no default-suite failure was left behind by the review.

`source-hashes.json`, `built-file-hashes.json` and `working-tree.txt` anchor the reviewed files. Smoke JSON also contains a manifest read by the harness; a development `build` does not regenerate that release manifest, so do not use those historical manifest payload hashes alone as proof of this rebuild's identity. No release manifest, installer, visual baseline or application source was edited here. No API key was stored or used.
