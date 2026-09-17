# Independent application verification — 2026-09-17

Source commit: `8c376bf07686e2ae9aaa7c0b475687413fd01b66`. Working tree was clean before verification. This report records checks run independently in this session, not the previously reported results. No production code or visual baseline was changed.

## Verdict

The tested Windows editing, recovery, rendering and PDF export paths work. The run does **not** establish complete release readiness: there is a development sign-in concurrency failure, a desktop smoke shutdown anomaly, a morph acceptance-harness defect, unavailable service checks and remaining platform/product limitations.

## Automated results

| Check | Result |
| --- | --- |
| `npm test`, all configured workspaces | **970 passed, 1 skipped**; exit 0 |
| `npm run typecheck` | Passed |
| `npm run schema:drift` | Passed |
| `python scripts/validate_fixtures.py` | Three fixtures valid; six base negative cases and both element-boundary cases passed |
| `python -m pytest apps/api agents integrations -q --tb=short -ra` | **627 passed, 16 skipped, 1 failed** |
| Worker `test:browser` | **7 passed**, including actual image-pixel/control test, fixture scene parity, measured exports and overlapping renders |
| Renderer `test:pixels`, `PIXELS=1`, `REQUIRE_PIXEL_BASELINE=1` | **4 passed** against the committed Windows baseline |
| Production Next.js build | Passed |
| Correctly configured web E2E, one worker | **4 passed**: drag budget and three recovery journeys |
| Desktop build, including static-external import guard | Passed |
| Fresh PyInstaller sidecar build | Passed |
| Electron packaged directory build | Passed, unsigned |

Web recovery checked an offline edit across reload, independent server edits, explicit choice for a conflicting property and isolation/recovery of duplicate-tab journals. The drag check measured **16.7 ms p95 at approximately 60 Hz across 126 frames, 0.0% dropped**, on a 120-object slide. This is one local measurement, not a latency percentile across machines or workloads.

The Python failure was `test_launch.py::test_an_old_unreferenced_asset_is_swept_and_its_bytes_reclaimed`: it attempted `http://localhost:9000/deckastra-assets/uploads/old.png` and received connection refusal. Docker was not running. The same test passed when rerun with an isolated local `DECKASTRA_ASSET_DIR`. This verifies the local-storage case; it does not turn the unavailable MinIO case into a pass. The 16 skips cover PostgreSQL-dependent checks and opt-in object storage.

## Fresh packaged desktop

Built the desktop and sidecar from the reviewed source, then copied the entire packaged directory to `D:/Deckastra-independent-check-20260917/app`. Ran it with working directory outside the checkout, a separate profile and an empty configured Playwright browser directory. This was a packaged-directory test, **not** a new NSIS installation test.

Runtime: Electron 33.4.11, Chromium 130.0.6723.191, Node 20.18.3.

Build fingerprints:

- `resources/app.asar`: `2C69F5C474C1A0C9188D66222CBBEEEC3D938F1B83ED0BC6E94197A0E2F26311`
- `resources/sidecar/deckastra-service.exe`: `0A9315664FCD9573ED6415D5100EC43F04AA2EEDE34F4A08E464A3783214E32C`

| Desktop exercise | Observed result |
| --- | --- |
| Open seeded deck | Passed; real canvas appeared |
| Add rectangle and save | Passed; save reported, added rectangle observed after restart |
| Restart/verify | Content check passed; shutdown anomaly described below |
| Present / second screen | Passed; second BrowserWindow opened |
| Export PDF | Passed; no console errors/CSP violations in export record |
| Timeline | Passed: gesture/keyframe/conflict-fix assertions and undo/save drain |
| Multi-window | Harness passed |
| Service resilience | Harness passed |
| Agent consent | Passed: no attachment before consent, grant works, self-approval denied, revocation gives 401 |
| Electron scene digests | Passed for technical, repository and animation fixtures after supplying required fixture/baseline paths |
| Morph movement smoke | **Failed / invalid coverage**: navigation stopped on slide 2, never reached the morph pair |

First fresh-profile `msToWindow`: **31,966 ms**. Subsequent initial smoke launches were roughly 2–3 seconds. The export smoke reported **380.3 MB across four Electron processes**. These are harness observations, not whole-system memory or a controlled startup benchmark; they exclude the separate Python sidecar and should not be labelled total application RSS.

The initial digest attempt lacked required environment paths and failed by configuration. The corrected packaged run matched all three baselines (technical 43 lines, repository 14, animation 29). Neither attempt changed them.

### PDF artifact verification

Independently opened the artifact with `pypdf` and compared its storage row:

- Four pages, each **1440 × 810 points**.
- Text extractable from every page.
- **35,011 bytes** on disk, matching the completed export job's `bytes` value.
- Artifact lives inside the isolated profile's workspace export directory.

Artifact: `D:/Deckastra-independent-check-20260917/profile/workspace/deckastra-exports/exp_01M2QBCFHV0Z6W1MDCVBQ4X9WM.pdf`.

This packaged export used the animation deck. The separate Chromium image-pixel test verified the supplied-image path against a missing-bytes control. It does not constitute a packaged PDF pixel comparison with photographs, nor proof of PPTX image support.

## Manual desktop observations

Used native Windows application controls on the isolated test profile:

- Selected slide 3, entered presentation mode and advanced to slide 4. Correct destination content appeared and forward navigation was disabled at the end.
- Opened the dedicated presenter window at slide 4. It showed the current slide, end-of-deck next state, notes area and elapsed timer.
- The timer advanced from approximately 00:15 to 00:27 between observations.
- Clicked Previous in the presenter: both presenter and audience moved to slide 3, with the correct slide 4 next preview in the presenter.
- Confirmed the local Share explanation was shown rather than a failed link request.
- Inspected screenshots: saved-theme inputs/buttons and native scrollbars remain visually inconsistent with the dark application styling.

These checks establish navigation and live synchronization, not a frame-by-frame morph or a controlled timing-accuracy/physical-projector acceptance test. The fixture slides tested had no speaker notes, so no populated-notes fidelity claim is made.

Several recovery copies were visible after repeated forced harness exits. This deserves a clean normal-close reproduction before being classified as a production journal-cleanup defect; the test harness uses `app.exit()` and the session also required process cleanup.

## Findings and remaining work

### P2 — Concurrent development sign-in returns HTTP 500

The first parallel web E2E attempt issued concurrent `/v1/dev/session` requests for `dev@localhost`. API logs show `sqlite3.IntegrityError: UNIQUE constraint failed: users.email`, and the drag test received HTTP 500. The serial rerun succeeded once the account existed.

The initial web build also pointed at the existing configured API port 8001 while the first isolated API used 8000; those recovery attempts were stopped and are not counted. The sign-in race is independently visible in the API log and occurred before browser navigation.

Acceptance for a fix: concurrent first-time sign-ins for the same identity both return the same persisted account without duplicate workspaces or a 500. Add a concurrent regression rather than relying on serial tests.

### P2 — Morph smoke does not reach the morph

`apps/desktop/src/main/smoke.ts::runMorph` assumes its two ArrowRight events reach the target transition. On the current four-slide fixture, the captured result is **“Revealed on click” (slide 2)**. It reports zero translated frames, but never exercised the transition it claims to test.

Acceptance: navigate to the explicit source slide, assert source/destination IDs, then sample the transition across time. Keep this gate open until the corrected harness records movement and a settled final state. Manual endpoint navigation is not a substitute.

### P2 — Smoke process did not exit after a successful verify result

The verify step wrote its success record and closed its visible window, but its owned main/sidecar processes remained and blocked the sequence. The test process was stopped after confirming its executable belonged to the isolated package. Subsequent smoke steps completed.

This is an observed shutdown anomaly, not a confirmed normal-user quit defect. Reproduce separately with both `app.exit()` and ordinary window close; verify child cleanup and subsequent launch. Native UI cleanup also encountered an unavailable coordinate-geometry error, so normal-close acceptance was not established in this session.

### Existing limitations retained

- PPTX still reports dropped images; PNG/PDF image delivery does not implement that adapter.
- Linux pixel baseline remains unverified here; do not derive it from Windows hashes.
- Unstyled theme controls, recovery controls and scrollbars remain visual work.
- Full two-device synchronization, real external Claude Code/Codex journeys, cloud identity/invitations, live provider/repository integrations and current full local-model benchmarks were not exercised.
- macOS, signing/notarization, updater/recovery rehearsal and physical projector/display scaling need their actual target environments.
- PostgreSQL row-lock/concurrency and MinIO/S3 lifecycle gates remain unavailable without their services.

## Evidence and cleanup

- Command logs: `D:/Presentation_app/.next/independent-check/`.
- Packaged smoke JSON/screenshots: `D:/Deckastra-independent-check-20260917/results/`.
- Corrected digest result: `D:/Deckastra-independent-check-20260917/digest-corrected/digest.json`.
- Test package, isolated data and PDF were retained for reproduction. Existing user decks and the installed `D:/deckastra` application were not modified.
- Started test servers were stopped at the end; isolated desktop processes were targeted for cleanup by their exact executable paths.

An initial npm packaging invocation misparsed CLI flags; the successful build used the electron-builder CLI directly with `--dir --publish never`. Automatic review rejected a command to rebuild the web app with an API URL override, without a specific reason. Instead, verification used the existing port-8001 configuration with an isolated API and reran the four web journeys successfully.

No claim of “the whole application passes” is made: the table above distinguishes observed passes, setup corrections, failures and unavailable acceptance gates.
