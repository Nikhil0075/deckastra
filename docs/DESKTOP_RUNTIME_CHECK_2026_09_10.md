# Packaged Windows runtime check — 2026-09-10

## What was run

Executed `apps/desktop/release/win-unpacked/Deckastra.exe`, the existing packaged distribution, through its real Electron smoke harness. This is not a fresh source build or a new NSIS installation test. A separate `--user-data-dir=D:\Presentation_app\.next\desktop-check-profile-20260910` kept sample edits away from the user's ordinary workspace.

Runtime: Electron 33.4.11, Chromium 130.0.6723.191, Node 20.18.3. Records report `packaged: true`. App archive SHA-256: `35A9412F6AA68FD512644D54F9F2F318CCFC061C71ADE17344040A49609EB624`.

Evidence directories (ignored local artifacts):

- `../.next/desktop-check-20260910/`: open/edit/verify/present/export records and screenshots.
- `../.next/desktop-check-20260910-no-browser/`: export with an empty Playwright browser lookup path.

## Results

| Check | Observed result | Limits |
| --- | --- | --- |
| Open packaged app | Canvas appeared; local storage, Web Locks and bridge available | No full offline-network isolation; CSP probe only blocks renderer external fetch |
| First profile startup | 40,870ms to editable deck | One observation; cause not isolated, not a percentile or a proven regression |
| Subsequent startup | 2,380ms / 2,299ms in edit/restart runs | Two observations |
| Edit and restart | Rect toolbar click; Saved observed; rendered element count 15 → 17; relaunch retained 17 and rectangle visible | Counts include thumbnails, not unique document objects; harness's `ok` alone is insufficient |
| Presenter | Two real windows; presenter screenshot shows current/next preview, notes area and controls | No physical second display, slide-navigation or timing fidelity acceptance |
| PDF with existing machine configuration | Completed job; actual artifact 25,452 bytes, pypdf reads three pages; report says metricsEstimated=false | Machine may supply external browser dependencies; save-dialog download not exercised |
| PDF with empty browser lookup path | New job fails, with no artifact | Confirms this packaged distribution is not independent of external browser availability |

The empty lookup path was supplied only to the test launch through `PLAYWRIGHT_BROWSERS_PATH`; no installed browser cache was moved or deleted. The successful export's actual PDF was checked through its recorded artifact path, not inferred from a Download button. The isolated export harness finished with exit 1 and `exportFinished: false`; its UI displayed the generic error and Retry. The roughly three-minute harness duration reflects its polling timeout, not the time until the job failed. All test launches have exited.

## Findings

1. **Packaged export is conditional on the machine environment.** The prior blanket statement that it fails installed needs qualification: it succeeds here using available dependencies, and fails with browser lookup isolated. Shipping a working rendering backend remains necessary.
2. **Failure explanation in this binary is inadequate.** The failed job records `The exporter produced no output (exit 1)` followed by a progress message, rather than the documented missing-browser explanation. Source changes may be newer than this binary; do not conflate them.
3. **Local-only sharing UI is misleading.** The editor screenshot displays a Share panel, Create view link action and a red `Not found.` message. Unsupported local capabilities should be represented explicitly rather than as a failed cloud request.
4. **Visual polish remains unfinished.** The saved-theme inputs/buttons use light native styling against the dark sidebar; the canvas viewport shows horizontal and vertical scrolling. The first animated slide thumbnail is largely empty at the captured initial state. These are observed presentation issues, not a pixel-baseline verdict.
5. **Presenter completeness is unverified.** A window opened, but the sampled current-slide preview shows the added rectangle while animated content is absent. An initial animation state may explain it; a time-controlled navigation/playback check is required before calling it a rendering defect or a pass.
6. **Startup and memory figures need precise labels.** The first launch was much slower than subsequent launches. The reported 385–396MB is Electron process accounting; the Python sidecar and export subprocess are not included, so this is not total application memory.

No baseline was regenerated. macOS, PostgreSQL, MCP clients, strict stale-proposal behavior and Electron pixel parity are not verified by these runs. Application code was not changed during this runtime review.
