# Manual authoring: pending work after the September 25 delivery

Reviewed on 2026-09-25 against commit `025fcb2c01b33d81f3ac600c651f9eae9ca2ce54` plus the existing working tree (240 changed/untracked entries at the start of this recheck). Nothing was committed. This review changes documentation only and preserves the existing application changes.

## Decision and counting

The [35-item gap plan](MANUAL_AUTHORING_AND_PRE_RELEASE_GAP_PLAN_2026_09_21.md) records **30/35 implemented and tested: 85.7%**. Five rows are not fully closed: **MA-22, MA-28, MA-31, MA-33, MA-34**. MA-22 is labelled “Done, narrowed” in the delivery table; this review keeps it conditional until that narrower release scope is explicitly accepted or rectangular crop is implemented.

That percentage is an implementation-ledger measure, **not a measured release-readiness percentage**. Two additional checks remain on rows currently marked done: offline close with unsaved canvas text (MA-11), and Motion panel display scaling (MA-24). These do not create two new items in the 35-item denominator. MA-29 also has an unresolved target-time agreement: an automated 24.9-second journey establishes functional feasibility, not how quickly a new user can build a deck.

The current changes have substantial regression coverage. This recheck independently passed **158 tests across 10 test files**, including the new manual authoring controls. It did not rerun the full product suite, Electron smoke sweep, installer or physical-device acceptance. The delivery's other passing counts remain reported evidence, not independently repeated results here.

## Prioritized remaining register

| Priority / item | What is still needed | Concrete closure evidence |
| --- | --- | --- |
| P1 — MA-11 follow-up | Rerun unsaved **canvas** text close and quit with the service healthy and offline. Unit recovery tests do not exercise native shutdown ordering. | Use an isolated profile; type without blurring; close/quit; relaunch; confirm exact text, recovered save and no duplicate application. Include journal/save failure blocking and composition behavior required by the original row. Record all variants. |
| P1 — MA-28 | Complete the real MCP-to-human handoff. Generated-style fixtures are useful but do not demonstrate attachment, proposal application or handoff. | Real Claude Code and Codex sessions against the desktop: create → revise → animate → human text/image/data edits → undo → save/reopen → export. Include nested groups and stale-proposal refusal. Caller-authored operations must not invoke a paid model. Record connection/configuration failures separately from application failures. Repeat relevant acceptance on the final installed candidate. |
| P1 — MA-34 / old 11 | Implement the final release command and mandatory strict signature gate. This is **code work**, not just waiting for a certificate. | A real documented command builds the candidate and invokes strict verification on that exact output; unsigned, missing and stale outputs cannot produce release success. `release:win` currently exists in the checklist's instructions but not in either package manifest. Keep unsigned development packaging distinct. |
| P1 — MA-34 / old 12 | Verify the installed nested payload, not only the installer. | Inventory the actual native executables, verify expected publisher/signatures for the main executable and sidecar/dependencies under the release policy, and prove a tampered/unsigned sidecar fails. Hash/integrity-check JS worker/MCP bundles appropriately; do not pretend JS bundles are independently Authenticode-signable executables. |
| P1 — MA-34 / old 33 | Generate and ship required dependency/font/model notices matching the final payload. An SBOM is not the notices themselves. | Inventory bundled JS, Python/native dependencies, fonts and optional packs; ship required notices accessible from the installed product and obtain release-owner redistribution review. Reconcile the SBOM with actual packaged contents. |
| P1 — MA-31 | Build and install the **current** final candidate; run authoring acceptance outside the checkout. | Installer SHA-256, manifest/source identity, installed path, isolated profile, logs and screenshots. Trusted click/double-click, PNG drag, grouped edits, transitions, recovery, reopen, PDF and PPTX work without development dependencies. Exercise installer/upgrade/uninstall behavior; copying an unpacked build is not installer verification. |
| P1 — MA-33 | Physical IME, accessibility, high-DPI and projector checks. | Real Japanese/Chinese/Korean composition in canvas and notes, including close/export; NVDA/keyboard/high contrast; 125/150/200% scaling; two physical displays with disconnect, reconnect and sleep/wake. Record device/OS and failures. Simulated composition events and axe do not close these checks. |
| P1 — MA-34 final gates | Sign and verify the final payload; run candidate CI after the authoring changes. | Nested and outer signatures, current notices/SBOM/manifest, Windows installed acceptance, applicable Linux CI/pixel results and retained artifacts. macOS requires its own build, notarization/stapling, installed-app checks and real supported hardware if it is in the release scope. |
| P2 — MA-24 follow-up | Rerun Motion panel at actual 125–200% display scaling. | Transition selection, controls, scrub preview and pair repair remain visible/reachable; no clipping or keyboard traps. This overlaps MA-33's display session and can be closed there. |
| P2 — MA-22 scope | Rectangular `crop` is still not drawn. Focal-point positioning and reset are implemented; the inspector discloses the limitation. | Either implement crop consistently in editor, presentation and exports with reopen/Undo/parity tests, or explicitly accept focal-point-only scope for this release and document the imported-crop limitation. Do not advertise unrestricted cropping. |
| P2 — MA-29 acceptance detail | Agree the usability target and test with people appropriate to the intended skill level. | Record the task, user experience level, completion/errors and target. Keep the automated five-slide journey as the functional no-AI acceptance test, not a human productivity result. |

These are actionable subchecks of the existing register, **not eleven newly discovered product defects**. No new authoring regression was observed in the tests run here.

## Source findings supporting the release corrections

- `apps/desktop/package.json`: `package` runs build, sidecar, SBOM, manifest and electron-builder; `verify:signing` is a separate command. Neither this manifest nor root `package.json` declares `release:win`.
- `docs/RELEASE_CHECKLIST_0.9.0-beta.1.md`, section 10: instructs `npm run release:win`. Correct this together with the release command, not merely by substituting an unsigned packaging command.
- `apps/desktop/scripts/check-signing.mjs`, `artifacts()`: reads only immediate files in `release` filtered by extension. It does not inspect an installed tree or recursively verify the sidecar. Builder signing configuration is not evidence that this verification requirement is satisfied.
- `apps/desktop/scripts/sbom.mjs`: emits component inventory; `electron-builder.yml` ships that SBOM. This does not implement the old register's separate dependency/font/model notices requirement. Existing Electron license files do not cover every bundled dependency.
- `packages/editor-ui/src/components/inspector/ImageSection.tsx`: implements focal position/reset and explicitly warns when an element carries unsupported rectangular crop. `packages/renderer/src/scene.ts` resolves focal point to CSS object position; `packages/export-pptx/src/media.ts` implements focal cover cropping.
- `apps/desktop/src/main/smoke.ts`, `authoring` step: contains trusted input, stored-document assertions, reopen/presentation/export and a model-route request check. Its `modelRequests` result measures observed matching page request URLs; it is not independent provider billing telemetry. The raw reported 24.9-second run was not reproduced in this recheck.

## Independent test results

All commands used the repository's installed Vitest with one worker and no file parallelism.

| Workspace / files | Result |
| --- | --- |
| editor-ui: `manual-authoring-shell`, `authoring-models`, `inspector-authoring`, `motion-authoring`, `text-editor` | 65 passed, 5 files |
| editor-ui: `canvas-gesture`, `insert-image`, `editor-recovery` | 30 passed, 3 files |
| presentation-core: `ungroup` | 9 passed, 1 file |
| export-pptx: full current suite | 54 passed, 1 file |
| **Total** | **158 passed, 10 files; no test failures or skips in these successful runs** |

Commands, from the named workspace directory:

```powershell
# packages/editor-ui
node ../../node_modules/vitest/vitest.mjs run tests/manual-authoring-shell.test.tsx tests/authoring-models.test.ts tests/inspector-authoring.test.tsx tests/motion-authoring.test.tsx tests/text-editor.test.tsx --maxWorkers=1 --no-file-parallelism
node ../../node_modules/vitest/vitest.mjs run tests/canvas-gesture.test.tsx tests/insert-image.test.tsx tests/editor-recovery.test.ts --maxWorkers=1 --no-file-parallelism
# packages/presentation-core
node ../../node_modules/vitest/vitest.mjs run tests/ungroup.test.ts --maxWorkers=1 --no-file-parallelism
# packages/export-pptx
node ../../node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism
```

One initial command used the wrong filename `canvas-gestures.test.tsx`; it exited with “No test files found.” The corrected singular filename ran successfully and is counted above. The failed invocation is not an application defect.

Not rerun here: repository-wide tests/typecheck, Python suites, schema drift/fixtures, native Electron acceptance, browser/pixel suites, actual MCP clients, installed candidate, physical IME/accessibility/displays, macOS or CI. Do not transfer older passes to an unidentified new installer.

## Carry-over release scope

The 35-item authoring plan does not replace the [full release checklist](RELEASE_CHECKLIST_0.9.0-beta.1.md) or [final package register](DESKTOP_FINAL_PACKAGE_FIX_REGISTER.md). Retain their outstanding clean-machine install/upgrade, failure-to-save destination, real MCP hosts, Figma comparison, platform and candidate-CI gates unless superseded by recorded evidence. Local-model consumer packaging/benchmark/license claims and minimum-hardware/performance claims also need their own evidence or explicit release exclusions; this authoring recheck does not certify them.

Recommended order: close the canvas-offline regression check and MCP handoff; finish the release command, nested verification and notices; freeze/build the candidate; run installed and physical-device acceptance; then sign/verify and retain final CI evidence. A certificate is necessary for distribution, but it is not the only remaining work.
