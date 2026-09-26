# Deckastra — final desktop package fix register

**Review: 19–20 September 2026. Status: NOT ready for public distribution.**

The UI rewrite has substantial implementation across Phases 0–9. The original export/save defect, deck-list response race, and missing rich-text notes have been addressed and their current tests pass. That does **not** establish that every phase's acceptance criteria or the desktop release gates are complete. This review found four additional defects/boundary gaps and concrete packaging work.

This document contains **36 actionable items**, not 36 reproduced bugs. Each item is explicitly a **defect**, **implementation/configuration gap**, **verification gate**, or **conditional feature gate**. There is no reason to invent another twenty defects to reach a requested example count.

An unsigned internal candidate may be built to perform the installer tests below. “Blocked” means do not distribute it as the final supported product. Conditional items block only the platform/feature being promised; a Windows local/MCP-only beta must explicitly exclude unfinished cloud synchronization and local-generation promises.

## Reviewed state and boundaries

- HEAD: `025fcb2c01b33d81f3ac600c651f9eae9ca2ce54` plus the current, extensive uncommitted Phase 0–9 changes. The commit alone does not identify the tested source.
- Build: current source rebuilt with `npm run build --workspace @deckastra/desktop`; not a newly built installer.
- Runtime under test: Electron 33.4.11 / Chromium 130 on Windows, isolated `.next/final-package-audit/profile` selected explicitly by `DECKASTRA_SMOKE_PROFILE`.
- Existing user data and application source were not changed by the audit. Temporary adversarial tests were removed from normal test discovery after saving their source and output as evidence.
- Generation smoke uses the deterministic stub. No paid call, model download, signing operation, installation, publishing or commit was performed.
- Evidence: [final-package-2026-09-19](audit-evidence/final-package-2026-09-19/). Raw logs/screenshots remain in `.next/final-package-audit`.
- This is a targeted engineering/acceptance review, not a claim of exhaustive security certification or proof that no other defects exist.

## What is closed from the previous audit

| Earlier item | Current evidence | Disposition |
|---|---|---|
| UI-01: exports bypass pending saves | `ExportPanel` receives the editor barrier, flushes focused drafts, passes `expected_version_id`; API checks it before creating the pinned-version job. `export-save-barrier.test.tsx`: 7 pass. | Original reproduction fixed. Keep the regression tests. |
| UI-02: stale project deck-list responses | `DeckList` uses current-project identity and request tickets. `deck-list-race.test.tsx`: 5 pass. | Original deck-card race fixed. Item 02 below concerns a different component: the generation drawer. |
| Rich-text notes missing | `SpeakerNotes`, `notes-rich`, `RichNotes`; 9 component and 10 notes-model tests pass. | Rich-text implementation is present. Item 01 concerns shutdown before its draft commits; item 27 is real editing-engine/IME acceptance. |
| Phase 7 motion authoring absent | `MotionModePanel`, transition editing, role plans, ordinary undo; current motion smoke exercises change/removal of pairs and undo. | Implemented; do not repeat the old “there is no transition engine” finding. |
| Phase 8 dark/code/menus absent | Theme tokens, code panel, host commands/menu and keyboard region tests are present. | Implemented; final visual, OS and accessibility acceptance remains distinct. |

## Priority and owners

- **P1:** resolve before the affected feature/platform is distributed to users; includes data retention, privacy and release-integrity gates.
- **P2:** resolve or explicitly constrain the first release with an observable limitation and a recorded decision.
- Owners name code areas rather than people. “Pass” always means attach evidence from the exact release candidate, not an older package or a development checkout.

## A. Reproduced defects and immediate code changes

### 01 — P1 / Defect: preserve notes drafts through actual window/application exit

**Where:** `packages/editor-ui/src/components/shell/SpeakerNotes.tsx` (`COMMIT_AFTER_MS`, `draft`, `commit`); `packages/editor-ui/src/lib/useEditor.ts` (`onBeforeUnload`); `apps/desktop/src/main/app.ts` (`before-quit`).

**Evidence/impact:** input exists in the notes component for 700 ms before entering the document queue. Dispatching `beforeunload` during that interval leaves `editor.document.slides[0].speakerNotes` undefined. The hook checks only its existing queue; it does not collect this draft. The native quit path also stops the service without an editor draft/save handshake. A notes-only final edit therefore has no demonstrated retention path at exit.

**Fix:** register draft producers with a synchronous durable-journal/close barrier; run that barrier before deciding the window is clean or stopping the sidecar. Wait for acknowledged saves when possible; preserve local recovery and explain blocked exit on failure. Handle active composition without saving partial IME text. A simple timer delay is not a fix.

**Pass:** type and immediately close via X, Alt+F4, File→Exit and OS shutdown; reopen and find the final notes, including on failed save. Include another open editor/presenter and active IME. The current reproducer proves the missing `beforeunload` capture, **not** a completed native OS shutdown experiment.

### 02 — P1 / Defect: scope the AI generation drawer to its project and run

**Where:** `packages/editor-ui/src/components/GenerateDeck.tsx` (`phase`, checkpoint effect, `settle`, `decide`); `DeckList.tsx` (unkeyed `GenerateDeck`).

**Evidence/impact:** load A's paused outline, close the drawer, change `projectId` to B and reopen. A's “Only for A” outline remains visible. The component retains `review` state and will still address A's run. This can let the user approve/revise the wrong project under B's context; it is not evidence of a server permission bypass.

**Fix:** isolate draft/run state per project; bind each request and completion to its originating project/run. Ignore stale completions and never apply a previous project's response to the current drawer. Keying/resetting the component may be part of the fix, but also guard asynchronous completions and `onGenerated` after unmount.

**Pass:** A→B and A→B→A with paused, writing and deciding runs; A's response cannot appear in B or navigate B to A's completed deck. Reopening A restores A's pending run.

### 03 — P1 / Defect: do not forget a paused outline on a temporary error

**Where:** `GenerateDeck.tsx`, checkpoint retrieval `.catch(() => remember(projectId, null))`.

**Evidence/impact:** return HTTP 503 from a remembered run's checkpoint request. The local `deckastra.pending-outline:prj_a` key is deleted. The server run is not deleted, but its UI resume pointer is lost and the user gets no useful recovery action.

**Fix:** distinguish an authoritative missing/terminal run from offline, timeout, 5xx and authentication failures. Keep the pointer for retryable/unknown outcomes, expose Retry, and guard late failures against project/run changes.

**Pass:** offline/503/timeout retains the pointer and a later retry recovers the same outline; confirmed terminal/missing state clears it deliberately; a late failure for run A cannot clear a newer run B's pointer.

### 04 — P1 / Defect: reject invalid explicit intelligence modes

**Where:** `agents/deckastra_agents/router.py`, `intelligence`, `selected_provider`, `default_client`.

**Evidence/impact:** with `DECKASTRA_INTELLIGENCE=locla` and a stubbed `api_key_available() == True`, `selected_provider()` returns `cloud`. The implementation treats unrecognized nonempty values like the unset legacy mode. A configuration typo can therefore select a provider the operator did not intend. No network request was made in the probe.

**Fix:** validate against the supported choices at startup and selection; reject every nonempty unknown value before client construction. Reserve legacy auto-selection for a deliberately unset/development configuration only.

**Pass:** invalid modes with and without an available key refuse; valid local mode never constructs or calls the cloud client; valid cloud mode without credentials refuses; whitespace/case normalization is deliberate and tested.

Reproduction sources/output for 01–03: [audit-release-boundaries.test.tsx.txt](audit-evidence/final-package-2026-09-19/audit-release-boundaries.test.tsx.txt), [boundaries.log](audit-evidence/final-package-2026-09-19/boundaries.log). Item 04: [provider-probe.log](audit-evidence/final-package-2026-09-19/provider-probe.log).

## B. Package integrity and reproducibility

### 05 — P1 / Configuration gap: replace the unsupported Electron runtime

**Where:** `apps/desktop/package.json`, `electron-builder.yml` (`electronVersion: 33.4.11`), root lockfile, renderer baselines.

**Fix:** select and pin a supported stable Electron release; update the dependency and builder pin together. The [official schedule](https://releases.electronjs.org/schedule) lists Electron 33 end-of-life as **29 April 2025**; the [support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) supports the latest three stable majors. This is a verified lifecycle issue, not a claimed exploit in Deckastra.

**Pass:** installed runtime matches the chosen supported patch; full smoke, text measurement, exports, sandbox/preload, menus and real contenteditable tests pass. Review changed pixels before accepting new platform baselines.

### 06 — P1 / Configuration gap: assign a real release version

**Where:** `apps/desktop/package.json` remains `0.0.0`; `electron-builder.yml` names artifacts from version; `agent-access.ts` binds consent to app version.

**Fix:** assign the actual release/pre-release version and keep installer metadata, runtime info and release notes consistent. Never reuse `0.0.0` for successive delivered builds.

**Pass:** About/runtime info, installer, artifact name and upgrade path identify the same version; an update invalidates previously enabled agent access as designed.

### 07 — P1 / Implementation gap: identify the exact source and bundled payload

**Where:** desktop build scripts, `IPC.info`, release output. Current HEAD does not identify the many uncommitted changes.

**Fix:** freeze a reviewable release snapshot before final packaging and emit a build manifest containing commit/source-tree identity, build time, runtime versions, migration head and hashes of renderer, sidecar, worker and MCP payloads. Do not expose secrets. This audit does not commit on your behalf.

**Pass:** an installed candidate can be traced back to its source and all its payloads. A stale sidecar paired with a new renderer is detected rather than certified by the renderer's version alone.

### 08 — P1 / Implementation gap: fail the sidecar build when mandatory resources are missing

**Where:** `apps/desktop/scripts/build-sidecar.mjs`, `data.flatMap(... existsSync(from) ? ... : [])`.

**Fix:** require migrations/config, generated schema and agent prompts; fail with the missing path instead of silently omitting it. Enumerate and validate the expected contents before packaging.

**Pass:** remove each required input in a scratch build and observe a pre-package failure. A clean build contains every required resource, including the latest migration and prompts.

### 09 — P1 / Build gap: make the frozen Python sidecar reproducible

**Where:** `apps/api/requirements.txt`, `requirements-dev.txt`, `build-sidecar.mjs` uses whichever configured Python/PyInstaller environment exists.

**Fix:** create a desktop packaging dependency lock with hashes and pinned Python/PyInstaller/tool versions; build from a clean isolated environment. Preserve the broader development requirements if needed, but do not use an arbitrary developer environment as the release dependency definition.

**Pass:** two clean builders resolve the same dependency inventory; provenance and an SBOM are attached. Fresh packaging does not depend on undeclared locally installed modules.

### 10 — P1 / CI gap: add desktop candidate jobs

**Where:** `.github/workflows/ci.yml` currently exercises Linux/web/API/rendering, not Windows/macOS installer creation and installed desktop acceptance.

**Fix:** add platform jobs for building sidecar/main/worker/MCP and running the applicable isolated smoke/release checks; separate unsigned PR candidates from signed release jobs. Upload JSON, screenshots and logs on failure.

**Pass:** a broken preload, missing PyInstaller import, stale packaged worker or failed installed smoke blocks the release job. No green release badge is derived solely from web/Node tests.

### 11 — P1 / Release-control gap: require signature verification in the final release command

**Where:** `apps/desktop/package.json` runs `electron-builder --publish never`; `verify:signing` is separate and strict failure requires `DECKASTRA_RELEASE=1`.

**Fix:** introduce one documented final-release path that sets strict verification and cannot succeed without checking the exact freshly produced artifacts. Keep unsigned internal packaging possible under a distinct command/label.

**Pass:** an unsigned candidate fails the release gate even though electron-builder succeeded; stale artifacts cannot satisfy the gate for a failed current build.

### 12 — P1 / Verification/implementation gap: verify nested Windows executable signatures

**Where:** `scripts/check-signing.mjs` enumerates top-level release files; `electron-builder.yml` ships a PyInstaller sidecar via `extraResources`.

**Fix:** inspect the installed main executable and sidecar, and inventory executable dependencies covered by the chosen signing policy, in addition to the installer. Do not infer nested signing from `signAndEditExecutable: true` or a signed NSIS wrapper.

**Pass:** signatures and publisher identity verify on the installed payload. A deliberately unsigned/tampered sidecar causes the strict gate to fail.

### 13 — P1 / Conditional macOS gate: notarize and verify the installed app, not just its DMG

**Where:** `electron-builder.yml` has `notarize: false`, arm64 target and entitlements; `check-signing.mjs` assesses top-level artifacts.

**Fix:** configure release credentials securely, explicitly enable notarization, staple and verify the disk image **and** installed `.app` with its nested sidecar. Exercise the hardened runtime. Decide explicitly whether Intel Macs are supported; the present target is arm64 only.

**Pass:** a downloaded/quarantined candidate installs, launches, generates and exports on real supported Macs without bypassing Gatekeeper. Attach notarization and installed-bundle evidence. Windows cannot close this item.

## C. Data retention and operational recovery

### 14 — P1 / Implementation/verification gap: provide a consistent local backup and restore procedure

**Where:** `workspace-state.ts`, SQLite database/checkpoints/assets under the profile; editor recovery journals live in browser storage outside the `workspace` directory.

**Fix:** define a supported backup command/flow that quiesces writers or uses SQLite's backup mechanism; include referenced assets, checkpoints and unacknowledged recovery data under a documented manifest. A casual copy of an active SQLite file or only `workspace/` is insufficient evidence.

**Pass:** restore into a fresh profile and recover a saved deck, historical version, pending outline, image asset and unsaved journal. Corrupt/incomplete backups fail before replacing live data.

### 15 — P1 / Verification gate: rehearse migrations and incompatible rollback

**Where:** Alembic migrations, `local_server.py` startup, sidecar startup timeout.

**Fix/check:** build an old-version profile with actual decks/assets/checkpoints, upgrade it with the candidate, interrupt a migration in a disposable copy, and attempt an older app against a newer schema. Add a safe refusal/restore path where missing.

**Pass:** no partial upgrade silently opens as an empty workspace; old binaries do not write an unsupported newer schema; the backup/restore path recovers data. Fresh empty-database migration tests alone do not close this gate.

### 16 — P1 / Implementation/verification gap: define how installed users receive safe updates

**Where:** no updater integration is present in `apps/desktop`; packaging is manual NSIS/DMG.

**Fix:** implement a signed update channel **or** explicitly ship a tested manual-upgrade workflow for the first release. Define running-job/unsaved-draft handling, version compatibility and rollback/recovery. An automatic updater is not mandatory if the manual policy is explicit and works.

**Pass:** N→N+1 retains data/settings and resets agent consent; interrupted download/install leaves one runnable version; users know how to obtain security updates.

### 17 — P2 / UX gap: make a failed sidecar startup actionable

**Where:** `apps/desktop/src/renderer/App.tsx`, `ServiceNotice` shows a reason but no retry/recovery action; `sidecar.ts` exposes terminal `failed` after unsuccessful startup/restart.

**Fix:** offer a bounded restart/retry and safe diagnostic/recovery instructions, distinguish migration failure from missing executable/permissions, and never reset/delete the workspace as a generic repair.

**Pass:** after removing the underlying transient failure, the user can retry without task-manager work; fatal schema failure remains safely refused and provides a backup-preserving route.

### 18 — P2 / Operational gap: persist useful, redacted desktop diagnostics

**Where:** `sidecar.ts` forwards logs to process stderr; installed launches do not give ordinary users a terminal or evidence bundle.

**Fix:** add bounded rotating logs and a user-triggered diagnostics export containing build ID, migration/runtime/provider status and errors. Redact bearer grants, keys, document content and prompts by default.

**Pass:** a support report from a normal installed launch explains a startup/export failure without requiring a developer console, and a seeded secret does not appear in the bundle.

## D. Intelligence and MCP product readiness

### 19 — P1 / Product gap: make the selected intelligence provider visible and configurable

**Where:** router/model-server configuration uses environment variables; desktop `App`, menu and `GenerateDeck` have no complete provider/model setup flow.

**Fix:** provide a persistent, explicit local/cloud/external-agent/manual setup state. Show the effective provider and availability before generation; never require ordinary installed users to set shell environment variables to understand what runs.

**Pass:** a clean installed profile can select a supported route, sees where content will be processed, and receives an actionable unavailable state. Merely having a server health field is not the user-facing setup flow.

### 20 — P1 / Release configuration gap: do not present stub generation as real generation

**Where:** unset `DECKASTRA_INTELLIGENCE` plus no key selects the stub; `GenerateDeck` presents the ordinary generation workflow and does not display provider provenance before starting.

**Fix:** in a distributed build, explicitly label demo generation or disable it until configured; keep the stub available for tests. Make demo mode opt-in and visibly persistent while used.

**Pass:** a keyless/model-less fresh install never makes a user believe a template/stub answer was produced by a configured model. Demo fixtures remain usable without paid calls.

### 21 — P1 / Conditional local-model gate: distribute verified optional model packs and runtime

**Where:** `model_packs.py` discovers a user-supplied directory; `local_model.py` / API model supervisor require a usable llama runtime. Pack discovery has no content-hash verification in the inspected code.

**Fix:** define an install/select/remove flow with pinned runtime/model manifests, hashes, disk/RAM checks, interrupted-install recovery and license notices. Keep packs optional and separate from user backups. Do not call external-directory discovery a completed consumer installation experience.

**Pass:** a clean machine installs one supported pack, rejects corruption, resumes/restarts an interrupted installation safely, and can remove the pack without deleting decks. If this does not ship, local generation must be explicitly excluded from the release claim.

### 22 — P1 / Conditional local-model verification gate: measure quality, resource use and cancellation

**Where:** `local_model.py`, `model_server.py`, `RunBudget`, `GenerateDeck` waiting state.

**Fix/check:** benchmark the selected quantized model on the release hardware matrix; attach first-pass schema validity, retries, source alignment, latency, peak RAM, cancellation and idle-unload results. Give long generation a meaningful cancel/status path where absent.

**Pass:** agreed thresholds hold for representative decks and invalid outputs; cancellation ends resource use; missing/OOM/crashed models refuse without cloud calls. Stub and protocol tests do not close this item.

### 23 — P1 / Conditional cloud-provider gate: manage credentials and consent in the installed app

**Where:** provider selection currently depends on inherited process environment and API credentials.

**Fix:** if cloud generation ships, use an explicit setup/consent flow and OS-protected credential storage; support change/revoke, distinguish authentication from network errors, and state what is sent. Do not expose keys in the renderer, logs or model-pack manifests.

**Pass:** configure, use and revoke credentials through the installed experience; local/manual mode works with no credentials; source documents are not sent before the cloud choice is explicit.

### 24 — P1 / MCP usability/verification gate: complete installed Claude Code and Codex setup

**Where:** `apps/mcp-server/scripts/acceptance.mjs`, packaged `resources/mcp`, desktop agent-access control.

**Fix/check:** provide copyable OS-correct installed command/configuration and visible consent/expiry instructions. Run one real Claude Code session and one real Codex session against the packaged server, not the checkout's `tsx` entry.

**Pass:** each host creates → revises → animates → previews → exports a test deck; stale/destructive changes are correctly refused or held. Runtime paths survive spaces, upgrade and nondefault installation location. Prior SDK acceptance is useful but is not either host session.

### 25 — P1 / MCP authority verification gate: retest grants on the installed candidate

**Where:** `agent-access.ts`, `attachment.ts`, API grants and packaged MCP attachment discovery.

**Fix/check:** verify off-by-default, explicit enable, expiry, stop/revoke, restart, app update and second-instance behaviour using the shipped payload. Verify attachment permissions and make permission-setting failure actionable for the chosen OS policy.

**Pass:** old grants fail after revoke/restart/update, an external agent cannot approve itself/share, and no checkout or launching a second writer is required. This is an installed gate; current development consent tests already pass.

## E. Installed interaction and rendering acceptance

### 26 — P1 / Verification gate: test the exact installer without development dependencies

**Where:** NSIS/DMG output, frozen sidecar, worker/MCP `extraResources`.

**Fix/check:** install outside the checkout on a clean account/VM; remove repository/Python/Node/Playwright availability from the test environment. Exercise cold/warm launch, migrations, create/edit/reopen, image upload/preview, PDF/PPTX download, history, AI review and all applicable smokes.

**Pass:** actual saved artifacts open in independent readers and contain the expected version, notes, text and images; current installed payloads supply every dependency. Test download cancellation, denied destination and disk-full failure without damaging an existing target file. No current installer was built in this audit.

### 27 — P1 / Verification gate: exercise real rich-text editing and IME

**Where:** `SpeakerNotes`, `TextEditor`, shared `text-editing.ts`; paste uses DOM range insertion and formatting uses browser editing commands.

**Fix/check:** test Japanese/Chinese/Korean IME on supported OSes; paste formatted Word/web content into the middle of a paragraph; verify blank lines, numbering, cursor retention, native Undo/Redo, toolbar use by keyboard and switch/close/export during composition.

**Pass:** no partial characters, duplicated lines, list conversion, caret reset or lost draft. One Undo reverses the intended typing/paste action rather than a deck operation. Synthetic composition events and a Bold/Numbered-list smoke do not cover all of this.

### 28 — P2 / Visual gate: compare every delivered screen against the approved Figma

**Where:** tokens/styles and shell, AI/motion/code panels, deck list, history, notes, export/share and recovery screens.

**Fix/check:** attach a frame-by-frame comparison with the approved Page 2 frame IDs at agreed window sizes; resolve actual spacing/type/icon/overflow deviations. Include empty/loading/error states and long titles. Avoid cosmetic guessing from the implementation itself.

**Pass:** every material deviation is fixed or explicitly accepted with screenshots. This audit does not assert exact Figma fidelity; no approved-frame comparison was performed.

### 29 — P2 / Accessibility gate: finish assistive-technology and OS scaling acceptance

**Where:** chrome primitives, drawers/menus, notes, code pane, presenter; current `a11y` smoke runs axe and keyboard paths in light/dark.

**Fix/check:** supplement the already passing automated checks with NVDA/VoiceOver, high contrast, 125/150/200% scaling, focus restoration and disabled/error announcements. Include notes toolbar and modal/nonmodal drawer transitions.

**Pass:** all essential operations are reachable and announced, no clipped controls trap users, and changing theme does not hide status/error distinctions. Do not report automated WCAG checks as full accessibility certification.

### 30 — P2 / Performance gate: test large decks and long sessions

**Where:** scene building, `DeckThumbnail` cache, timeline gestures, renderer/performance budgets.

**Fix/check:** use representative large decks/projects with images, groups and motion; measure cold/warm start, input latency, drag dropped-frame budget, deck-switch memory, model/export contention and a sustained session. Attach hardware and workloads.

**Pass:** the agreed budgets hold; caches/resources stabilize after repeated navigation/export; the app remains usable at the advertised minimum RAM. A small fixture's working-set sample is not a memory/leak qualification.

### 31 — P1 / Presenter verification gate: test real displays and navigation over time

**Where:** `PresentMode`, `PresenterView`, `presentSync`, transition engine and native presenter windows.

**Fix/check:** exercise two physical displays with different scaling, move/fullscreen windows, sleep/wake and disconnect/reconnect; navigate forward/back during transitions and click segments, blackout, pause, target-time countdown and reduced motion.

**Pass:** audience and presenter retain the same pinned content/step; no stale frame or unintended arrival animation on backward navigation; notes/timer remain readable and blackout works. Existing sampled morph and two-window checks close only their specific cases.

### 32 — P1 / Platform verification gate: run release-candidate CI on each advertised platform

**Where:** platform renderer baselines and `.github/workflows/ci.yml`.

**Fix/check:** record Linux CI/pixels against the candidate; build and run on actual supported Windows/macOS architectures. Keep platform baselines independent. macOS is conditional on advertising a Mac package; Linux CI remains a code-quality gate even without a Linux desktop release.

**Pass:** results reference the same release snapshot/runtime pins; no baseline is regenerated merely to hide a rendering change. A Windows pass is not Linux or macOS evidence.

## F. Trust boundaries and release scope

### 33 — P1 / Distribution gap: generate and ship dependency/font/model notices

**Where:** packaging files/resources and dependency inventory; no consolidated distribution NOTICE/LICENSE inventory was found by this review.

**Fix:** inventory what actually ships, including bundled JS, Python wheels/native libraries, Electron notices, fonts and any optional model/runtime; include the corresponding required notices and model terms. Have the release owner approve redistribution, without inferring rights from a manifest's free-text license name.

**Pass:** the installed notices match the SBOM/payload and are accessible to users. This item requests a compliance review, not a legal conclusion about any particular dependency.

### 34 — P1 / Hardening gap: validate privileged IPC senders and inputs explicitly

**Where:** `apps/desktop/src/main/app.ts` IPC handlers and `protocol.ts`; handlers currently rely heavily on the hardened window factory and typed renderer contract.

**Fix:** check that privileged requests originate from an expected live app window/main frame/origin, validate payloads at runtime and bound byte/path-bearing requests. Add negative tests for foreign/destroyed frames and malformed data. Keep sandbox/context isolation and navigation restrictions.

**Pass:** invalid callers cannot toggle grants, open privileged windows or invoke file dialogs/writes; valid editor/presenter flows still work. This is a structural hardening gap, **not** a reproduced remote exploit or proof that existing sandboxing is broken.

### 35 — P1 / Conditional product gate: make desktop cloud collaboration real or exclude it clearly

**Where:** desktop `App`/menu versus API sync/workspace functionality; local sharing correctly reports unsupported capability.

**Fix:** if shared cloud workspaces are part of this release, wire desktop sign-in, explicit opt-in movement, sync status/outbox, conflict review and role refresh to the existing authority. Otherwise state local-only/MCP scope in onboarding and release notes; do not advertise backend endpoints as a delivered desktop workflow.

**Pass:** two installed devices edit offline and reconcile without silent loss, revoked members are refused and local decks are never silently uploaded. A cloud workspace's presenter receives the pinned deck and assets. This is not required to ship an explicitly local-only beta.

### 36 — P2 / Conditional portability gate: define `.mydeck` open/save and file association behaviour

**Where:** desktop File menu currently offers New/Generate/All decks/Exit; builder has no `.mydeck` file association. The desktop architecture plan includes file open/save.

**Fix:** if portable document files are promised, add validated import/export through the same transaction/schema boundary and define asset packaging, versioning and unknown-field preservation; support open-file/second-instance dispatch safely. Otherwise document that this release is workspace/database based, not a general `.mydeck` file editor.

**Pass:** a deck and its images round-trip on a fresh machine, malformed files fail usefully, future values survive, and opening a file cannot execute code or overwrite unrelated workspace data.

## Execution order

1. Fix **01–04** and add their regressions to the normal suites. Preserve the already passing Phase 9 tests.
2. Resolve release scope: **19–23, 35–36**, plus macOS/architecture commitments. Do not hide unfinished features behind an “all phases complete” claim.
3. Upgrade the runtime and establish reproducible candidate identity: **05–10**.
4. Build an internal candidate and close recovery/upgrade and installed-functionality gates: **14–18, 24–32, 34**.
5. Close notices and final signature/notarization gates: **11–13, 33**. Produce immutable hashes and a release evidence manifest; then approve distribution.

Do not sign off the final package until every applicable P1 is closed with evidence. An accepted P2 limitation must name what users cannot do and where that limitation is communicated.

## Verification from this review

These are independent results from the current working tree, not the earlier reported 600-test run.

| Check | Result and limit |
|---|---|
| `npm test` | **1,222 passed, 1 skipped**. The skip is the optional renderer HTML contact-sheet writer, not a failed pixel gate. |
| `npm run typecheck` | Pass across workspaces. |
| `npm run schema:drift` | Pass. No generated schema was rewritten. |
| Current desktop build | Pass; main/preload/renderer/worker/MCP built. A bundle-size warning remains informational; this is not an installer build. |
| `python -m pytest apps/api agents integrations -q --tb=short -ra` | **686 passed, zero skips**, 522.85 seconds. Existing local PostgreSQL and MinIO were running; `POSTGRES_TEST_URL` was supplied. |
| Fixture validation | 3 fixtures pass; 6 base negatives, malformed-known-line rejection and genuine-unknown preservation pass. |
| Worker browser tests | **7 passed**, including browser text metrics/editor digest parity and image pixels. |
| Windows pixel suite | **4 passed** with `PIXELS=1 REQUIRE_PIXEL_BASELINE=1`; no baseline changes. |
| Fresh-profile desktop smoke | **19/19 passed**: open, edit, verify, slides, history, export, a11y, ai, motion, presenter, decks, present, timeline, morph, consent, menu, windows, resilience, digest. Every record says `packaged: false`; console/CSP error arrays were empty. |
| New adversarial component tests | **3 failed as expected**, demonstrating items 01–03. These failures are not included in the green existing-suite count. |
| Invalid-mode provider probe | Returned `cloud` for `locla` with mocked key availability; item 04 remains open. No model request. |

The export smoke confirmed that the exported version ID equals the persisted head containing the just-typed note. It did **not** independently extract the note from a PDF artifact; use item 26 for end-format verification. The motion smoke changed transitions/pairs, applied a role plan and undid it to the original content. The accessibility smoke passed its light/dark axe and keyboard checks; it excludes slide content/canvas from its axe chrome scan and is not a screen-reader certification.

Not performed in this review: fresh installer creation/install, strict signing/notarization, real local inference benchmarks, real Claude Code/Codex sessions, exact Figma comparison, real OS IME, physical multi-monitor acceptance, or Linux/macOS execution. Existing source tests and earlier evidence are not relabelled as new installed passes. No paid calls, baseline regeneration, production fixes or commits were made.

## Re-running the new defect tests

Copy `audit-evidence/final-package-2026-09-19/audit-release-boundaries.test.tsx.txt` to `packages/editor-ui/tests/audit-release-boundaries.test.tsx`, then run from `packages/editor-ui`:

```powershell
node ../../node_modules/vitest/vitest.mjs run tests/audit-release-boundaries.test.tsx
```

All three assertions intentionally specify the desired behaviour and failed on the audited code. They use real components/hooks with controlled transport events; they are not native OS/IME tests. Keep them outside normal discovery until implementing the fixes, or deliberately land them as failing regressions in the fix branch.

Provider probe: set an invalid explicit mode, replace `api_key_available` with a test function returning true, and inspect `selected_provider`. It selected `cloud`; no client request or real credential was used.


## Delivery status

**Independent recheck, 20 September:** the implementation entries below record the implementer's results. A subsequent review verified 03/04 and the normal/offline close paths, but found remaining P1 cases in 01 (failed journal plus failed save still approves closing) and 02 (older completion overwrites a newer run pointer). **Both were then fixed; see the "(recheck)" rows below, which carry the reviewer's own reproducers as permanent tests.** The original closure labels below record the first implementation pass. See [the recheck and delivery-plan corrections](ITEMS_01_TO_04_RECHECK_2026_09_20.md) and its deterministic regressions. This note supersedes the closure labels below for release sign-off; their historical implementation evidence is preserved.

Added by the implementation work, item by item; the register above is unchanged. Release scope agreed on
2026-09-20: **Windows x64, local-only; generation through MCP agents or a cloud API key; 0.9.0-beta.1;
manual upgrades.** Items 13, 21, 22, 35 and 36 are therefore exclusions to state, not work to build.

| Item | Status | Evidence |
|---|---|---|
| 04 | **Fixed** | `router.intelligence()` refuses any value outside `""`/`local`/`cloud` with `IntelligenceMisconfigured` (a `ModelUnavailable`); `/health` reports `misconfigured`; an app-wide handler makes every `ModelUnavailable` a 503. Tests: 10 unit cases (5 typos × key/no key), normalisation, and API cases for health, graph and single-shot generation and Ask. Removing the validation fails 12 tests; removing the handler leaves Ask raising uncaught. |
| 03 | **Fixed** | Only a 404 forgets a paused run, and only the run asked about (compare-and-delete). 401/5xx/offline keep it and show **Try again**. `generate-deck-scope.test.tsx`: 503+retry, 401, 500, late-404-vs-newer-run. Forgetting on any error fails 3 of them. |
| 02 | **Fixed** | The phase carries its project; every async path captures its origin and only updates that project's stored pointer once the person has moved on; `onGenerated` never fires for another project or after unmount; `DeckList` keys the drawer by project. Tests: A→B paused, A→B while writing then back to A, deciding then switch, unmount. The first run found a real bug — a phase left at "writing" hung on return — fixed by resetting per project. |
| 01 (recheck) | **Closed, development build** | The recheck's double failure — storage full *and* the save failing — used to report "journalled" and approve the close. Readiness is three-valued now: `clean`, `journalled` only when the journal took the work, otherwise `blocked`. A participant that throws or does not answer is blocked, never journalled; a draft a field could not hand over blocks too. The main process no longer closes or quits a blocked window: it says what is at risk and offers Try again / Close and lose the changes / Keep the window open, and a quit stops when someone keeps their work. Tests: the recheck's reproducer verbatim, plus thrown participant, never-answering participant and one unsafe window among several; each fails with the fix removed. In the app, a new `close` variant breaks the page's storage with the service down: neither the window nor the app closes. The four ordinary variants still keep the note. |
| 02 (recheck) | **Closed** | The pointer write is bound to a per-project request sequence held outside the component, so it survives the drawer being closed and reopened; only the newest request may replace a project's remembered run, in either completion order, and a late decision on an abandoned run cannot retire a newer one. Tests: the recheck's reproducer verbatim plus both orders and the decision case; they fail with the guard removed. |
| 01 | **Fixed (development build)** | `useEditor.registerDraft` + `saveNow` and `beforeunload` run drafts; `close-barrier.ts` + `main/close-guard.ts` hold every window's close (and quit) until the page has saved or journalled; the service stops after. On the desktop the journal pointer survives a restart and same-base recovered work autosaves. New smoke steps `close` / `close-verify`: reproduced the loss on window close and quit before the fix; after it, all four variants — window, quit, each with the service killed first — find the note after relaunch. Unit: 8 cases incl. IME (pre-composition text only) and a bounded wait. **Open for item 27's checklist:** OS shutdown/sign-out (best-effort `session-end` only) and a real IME. |
| 23 | **Fixed (development build)** | `main/cloud-key.ts`: `safeStorage`-encrypted, owner-only, never returned to the renderer, refused outright where it cannot be encrypted; key checked before it becomes an environment variable; saving or removing restarts the service; consent text beside the field. A rejected key is now its own message (`ModelUnavailable`), not the one a network failure gets. 10 desktop unit tests, 4 client-error tests, and a new `intelligence` smoke step: saving a test key moves the app to the cloud route, the page cannot read it back, removing it returns to where it started. **Not tested:** a real key against Anthropic. |
| Scope exclusions (13, 21, 22, 35, 36) | **Stated** | `FirstRunNotice` on first launch and `docs/RELEASE_NOTES_0.9.0-beta.1.md`: local-only, no cloud workspace, sharing, sync, `.mydeck` files or local models; Windows only. The UI offers none of them, and the service refuses local models by name on an installed build. |
| 20 | **Fixed** | `DECKASTRA_DISTRIBUTION=1` (set from `app.isPackaged`) refuses the stub and refuses to read an inherited API key as a choice; local models are named as not in this release. 6 unit cases + API cases for health, both generation paths and Ask. Simulated install in the app: the Generate drawer says "Generation is not set up on this install…". A checkout still generates with the stub (`ai` step green). |
| 19 | **Fixed** | `generation_status()` answers `/health` and `capabilities.generation`; `generation-route.ts` turns it into what a person reads; the Generate drawer names the route, disables Generate when it cannot work and offers set-up; the desktop's Intelligence drawer (bar + View menu) shows the route, agent access and the release's exclusions. 7 UI/unit tests, 2 API tests, and the `menu` smoke step reads the drawer in both modes: "Demo planner — not a model" in a checkout, "Generation is not set up" as an install. |
| 05 | **Fixed** | Electron **33.4.11 → 44.4.3** (Chromium 152, Node 24), pinned in both `apps/desktop/package.json` and `electron-builder.yml`; `electron-builder` 25.1.8 → 26.15.3. Two API changes fixed: `printToPDF` lost `marginType` (explicit zero margins now — a type error caught it) and `console-message` passes an event object (the harness's CSP check would have kept passing on deprecated arguments). Gates on the new runtime: the `digest` step's scene digests match the committed Node baselines byte for byte inside Electron's own Chromium; exports through the render host, present, morph, timeline, a11y (axe, both themes) and every other step pass. `npm audit --omit=dev`: 0 vulnerabilities. **Not yet:** an installer built on the new runtime (item 26). |
| 06 | **Fixed** | Version `0.9.0-beta.1` (was `0.0.0`), which names the installer, `IPC.info` and every smoke record. Agent consent now records the build it was granted in and reads as off in any other — the twelve-hour life alone would have carried a permission across an update installed the same afternoon, which is what the claim "off after every update" is about. 5 desktop tests; the update case fails with the rule removed. |
| 08 | **Fixed** | `scripts/sidecar-data.mjs` holds the list of files the frozen service reads by path and the check that they exist and are not empty; `build-sidecar.mjs` stops the build naming each missing one instead of filtering it out. 8 tests, including removing each of the four inputs in turn from a scratch copy. |
| 10 | **Written; never run on a runner** | A `Desktop (Windows)` job in `.github/workflows/ci.yml`: typecheck, desktop unit tests, all five bundles, the frozen service from the hashed lock, the SBOM and the build manifest, then the acceptance steps that need no second display (open, edit, verify, digest, close, close-verify), with artifacts uploaded on any outcome. An unsigned installer is built only on `workflow_dispatch` with `package: true`, because packaging takes minutes and produces 250MB. Every command in the job was run locally on Windows and passes, and the YAML parses — **but it has not run on a GitHub runner**, and nothing here can make it. Writing the gate found one thing: the `close` step records `ok: "pending"` by design, so a naive check would have failed a passing run. |
| 17 | **Fixed** | `classifyFailure` in `sidecar.ts` + `ServiceFailure.tsx`: five named kinds, advice per kind, a bounded retry offered only where it could help, and the same control in the outage banner. Nothing suggests clearing the workspace, asserted for every kind. 14 desktop tests. In the app, the `resilience` step now kills the service, presses **Try again** in the banner, and the service comes back with the queued edit saved. |
| 18 | **Fixed** | `main/logs.ts`: rotating app and service logs in the profile (2MB, two older files kept), never failing the thing they log. `main/diagnostics.ts` + Help > Export diagnostics: one JSON report with the build manifest, runtime, data directory, service failure and kind, generation route, whether a key is set, agent-access state and both log tails. **Scoped redaction, per the review's correction:** user content is not logged at source, and `redact` removes only the credential shapes it knows (API keys, bearer tokens, the launch secret, grants). 13 tests, all redaction cases failing when it is disabled. In the app, the `menu` step writes a real report (5.6 KB) and asserts the live launch secret, bearer tokens and API keys are absent. |
| 34 | **Fixed** | `main/ipc-guard.ts`: every `ipcMain` handler goes through `handleFromWindow` / `onFromWindow`, which answer only the main frame of an app-created window on the app's own origin — refusing a foreign origin, a prefix-alike origin, a sub-frame, an unknown window, a destroyed sender and a frameless sender. Payloads are validated at the boundary: minted ids, plain file names (no paths, no null bytes), bounded bytes (512MB), booleans for permissions. 14 negative and positive tests. **Structural hardening, not a reproduced exploit** — and not proof the existing sandboxing was broken. |
| 14 | **Fixed** | A backup is one moment, not a directory copy. `apps/api/deckastra_api/backup.py`: the **running service** takes it with SQLite's online backup API (no quiescing the app), checkpoints copied *after* the application database so a parked run can never lose its checkpoint, the asset list read **from the snapshot** rather than the live database, and asset-byte deletion held for the duration (`deletions_held`, taken by the sweeper). A manifest records counts and a SHA-256 per file, and names assets whose bytes were already missing rather than omitting them. `verify` refuses a damaged, incomplete, wrong-format or non-database backup **before** a restore touches anything, and what a restore replaces is moved aside, never deleted. Restore is offline (`local_server --restore-from`) because it replaces the database the service holds open. File > Back up… / Restore from a backup… are main's, with main's dialogs; **the renderer still names no path**, and the route needs `administer`, which no grant carries. Recovery journals are collected from the windows and carried verbatim, then put back. 15 + 5 Python tests, 9 desktop, 7 editor-ui. Controls: the deletion gate and the snapshot-sourced asset list each fail when removed. In the app, the `backup` step backs up with a note still in its field, changes the deck, restores, and finds the earlier deck and the journal; the note must be in the backup's database **or** its journal, and the run records which (`journal`, 2026-09-20). Asserting the database alone passed standalone and failed in the full sweep — the note was in the backup throughout, and the assertion was in the wrong place. **Writing `UPGRADING.md` found a gap and closed it:** a backup from a *newer* build verified cleanly, was restored, and was only refused by the migration afterwards — data safe in `replaced-…`, but an install that would not open. `restore` now checks the backup's schema first; the control fails with it removed. |
| 15 | **Fixed** | `local_server.check_schema_supported` refuses a database whose recorded revision this build does not know — an older binary meeting a newer schema, which manual upgrades make real — **by name**, saying which of the two things to do, and leaving the file byte-identical. It classifies as a `migration` failure, so item 17's "nothing will offer to clear your workspace" advice applies. `test_migration_rehearsal.py` builds a profile at an **older revision with rows in it** (columns introspected, so the rehearsal cannot quietly stop rehearsing), upgrades it with the candidate and asserts the deck *and its version chain* survive; drives an interrupted upgrade and asserts the launch sequence cannot reach `seed()`; and restores an item-14 backup taken before the upgrade, then migrates it forward again. 6 tests. **In the real app:** a genuine profile was built by the app, rewound three revisions with Alembic, and relaunched — `open`, `edit` and `verify` all green, ending at head with the deck intact. Marked as written by a later build, the same profile is refused with the written message and the deck is still there. |
| 16 | **Fixed (the automatable half)** | `docs/UPGRADING.md`: close, back up, install over the top, let the first launch migrate, allow agents again. It states what survives (decks, history, images, paused outlines, cloud key, open deck), what does not (agent consent, every time, including downgrades), what a backup is and is not (no exports, and why), the three failure messages and what to do about each, and that **security updates only arrive by checking for a new build** — there is no updater, because an unsigned update channel is worse than none. `tests/upgrade.test.ts` drives one profile across a version change: key kept, open deck kept, consent off, the same version not treated as an upgrade, a downgrade treated as one. 5 tests. **Open:** running the two real installers end to end is item 26 and is the user's run; this is not claimed on development-build evidence. |
| 25 | **Fixed (verified on the packaged payload; the installed *location* is the user's run)** | New `grants` acceptance step, run against `release/win-unpacked` with `packaged: true` and no checkout on the path. Published credential: attachment v2, scopes `read, write, export`, expiring in 12h. The **service** refuses everything else regardless of which tools an adapter registers — approve **403**, share **403**, delete a deck **403**, back up **403**, revoke grants **403** — while reading the account is 200. The attachment's ACL on the packaged run is a single entry, the user's own account with full control, and no `Everyone` or built-in `Users`. A real **second instance** exits 0 in 3.6s and the first instance's grant still works. After a **service restart** the old grant answers 401 and the republished one 200, because the launch secret it was signed with did not survive the process. Expiry is checked as the published window rather than by sleeping twelve hours. **Found and fixed on the way:** `DECKASTRA_SMOKE_PROFILE` was honoured only when `DECKASTRA_SMOKE_DIR` was set too, so the second-instance probe — harness off, profile kept — started a whole app against the user's real profile directory. It wrote nothing (no step ran; the real database's newest version was still the previous day's), but the failure was silent. `main/profile.ts` plus 4 tests. The shipped MCP server drove the journey **16/16** on a credential obtained the product's own way: consent given through the packaged window in one run, honoured by an ordinary launch of the same build, then `resources/mcp/cli.mjs` inside the package run by the app's own binary under `ELECTRON_RUN_AS_NODE` — attach, no approval or sharing tool at all, its own deck, a low-risk change, a refused stale one, motion in roles, elements paired across slides, a push refused the pairing, a rendered preview, a destructive change left pending as `mcp:acceptance`, an export cancelled and another finished. Closing the app withdrew the attachment and left no process behind. **Open, and the user's:** the installer asks for elevation (exit 1223 twice, unattended), so the candidate has not been run from its installed location. |
| 26 | **Largely verified on the packaged payload; the installed *location*, a clean account, a real disk-full and a denied destination are the user's** | The candidate copied **outside the checkout** and driven with `python`, `node`, `npm`, `npx` and `tsx` off `PATH` and `PLAYWRIGHT_BROWSERS_PATH` emptied, the scrub proven before the run is trusted: **20 steps green**, `packaged: true`, zero CSP violations — open, edit, verify, slides, history, export, motion, presenter, decks, present, timeline, morph, consent, menu, intelligence, windows, resilience, backup, grants, with `a11y` skipped by name because axe-core is not shipped. Artifacts read by independent readers: **pypdf** — 4 pages at 1440×810pt, extractable text, byte count matching the export row, stored inside the profile; **python-pptx** — 4 slides at 13.33×7.5in, real text boxes and shapes, and speaker notes reading back as the exact sentence typed into the editor before exporting. **Two bugs found and fixed.** (1) The notes part's root element was `<p:notesSlide>`; ECMA-376 says `<p:notes>`, and python-pptx *raised* rather than disagreeing — so every speaker note ever exported to PowerPoint sat in an element no conforming reader looks for. The existing test asserted the fixture had **no** notes, which a broken exporter satisfies just as well; it now injects a note and reads it back, and the control fails with the old element. (2) `saveFile` used `writeFile`, which truncates the target first, so a failed save destroyed the file it was replacing — exactly what this item says must not happen. `main/save-file.ts` stages beside the target and renames over it; 7 tests, and the control fails on the discriminating one. Two method notes: the first save-file suite **passed against the broken code** (it failed before the target was touched), and **mocking `node:fs/promises` does not work in this runner**, established by diagnostic rather than assumed. **Open, and the user's:** the installer wants elevation (`/S` exits 1223, unattended); a clean account or Windows Sandbox; a real disk-full and a denied destination; images, since the deck an install opens carries none (the picture path is covered by `test_pptx_opens.py`). |
| 30 | **Measured; budgets hold and memory settles. A packaged build, a multi-hour session and the minimum-RAM machine are not covered** | New `performance` acceptance step on a **60-slide** deck built by repeating both seed fixtures with fresh ids (renumbered a block at a time, so cross-slide morph pairs survive) with a real uploaded photograph on every slide: 323 elements, 41 groups, 67 images, 13 animated slides, 60 transitions. Budgets judged by the product's own `checkBudget` / `checkFrameBudget`, not by thresholds copied into the harness. Measured on an i5-9300H, 12,140MB RAM with 1,376MB free: cold open **487ms**; thumbnail strip **523ms** against 1000ms; warm slide switch **15ms** against 120ms; drag **0% dropped** at 16.8ms p95 on a ~60Hz display against a 5% allowance; export 30.8s cold then 12.7s warm for a 1.87MB PDF. **Memory settles:** six rounds of twenty slide switches give +38.0, +14.4, +16.6, +11.7, +5.8, +2.4MB — a flattening curve, not a leak — and two exports bring it to 412MB, below where it started. Three rounds could not have shown this; the first three increments alone are a straight line. **A real bug found and fixed:** `withPage` bounded the *whole* export at a flat 20s, which sixty slides with pictures exceed — the export only succeeded because the job retried into a warm browser, leaving a row marked `completed` carrying a deadline error. `renderDeadlineFor` is 20s + 1.5s a slide; afterwards both exports ran with `attempts: 1`. 5 tests. **Three harness bugs, each reporting something false:** importing the renderer into the *main* process pulled in `ulid`, whose PRNG detection throws there and took the app down before it opened a window (symptom: "the step is slow"); the export poll read `export_id` where the route returns `id`, so it called five minutes of asking a nonsense URL a timeout while both exports had finished in under one; and the thumbnail strip measured 13ms, which was sixty thumbnails already being there rather than rendering. The step now records the **machine** it ran on, because the first attempt ran with 701MB free and took 65s to open a four-slide deck. **Open:** packaged-build numbers, a multi-hour session, and the advertised minimum RAM. |
| 09 | **Fixed (for this platform)** | `sidecar-requirements.lock`: 97 packages pinned with hashes, compiled from a new `.in` that names the API's requirements plus PyInstaller. The build creates a clean venv, installs with `--require-hashes`, and freezes from it; a stamp keeps it in step with the lock. The service was rebuilt this way and the app ran against the frozen binary (`open` step, `DECKASTRA_SIDECAR` pointing at it). `scripts/sbom.mjs` writes CycloneDX from the lock (97 python components with their hashes) plus 21 npm components; both the lock and the SBOM are hashed into the build manifest and ship in resources. 7 tests. **Limits:** the lock resolves for Windows x64 / CPython 3.13 — the release platform — and "two clean builders resolve the same inventory" has been made deterministic but not demonstrated on a second machine. |
| 07 | **Fixed** | `scripts/manifest.mjs` writes `dist/build-manifest.json` **after** the bundles and the frozen sidecar (the review's correction), hashing each payload, the migrations, and the source — commit plus a digest over every changed and untracked source file, because this tree is never clean. It ships in `extraResources`, reaches `IPC.info` and every smoke record. Pairing: `/health` reports the digest of the migrations the service is running and the app refuses a service that does not match its manifest, while treating silence on either side as unknown. 9 desktop tests, plus `test_build_identity.py`, which runs the Node and Python implementations against each other; all three of its cases fail when they diverge. |
