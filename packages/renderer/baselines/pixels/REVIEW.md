# Full-slide pixel baseline review — 2026-09-06

Reviewed against HEAD `6f06c46250879b287f9ba73bc41e15a2f7d7cf75`
plus the Phase 0–9 remediation working tree. The supplied fixture documents were
not modified for this migration.

The previous capture divided CSS clip dimensions by DPR. It therefore protected
only the top-left quarter of each slide. The new capture uses the complete
1920×1080 CSS slide at DPR 2, asserting a 3840×2160 PNG. All ten slides are
checked on repeated renders and reloads. A bottom-right control must change the
hash. Animation tracks are sampled at their explicit final frame; an entrance
fixture is no longer accepted as a blank initial frame.

All ten new Windows and Linux PNGs were visually inspected before recording the
expected hashes. This intentionally replaces the incompatible cropped Windows
baseline and establishes the previously absent Linux baseline. It does not
claim pixel equality between platforms or production font loading/fidelity.

| Slides (zero-based) | Image review |
| --- | --- |
| technical/0 | Full hero title and supporting text visible. |
| technical/1 | All four metric cards, including rightmost 600MB, visible. |
| technical/2 | All nodes/labels visible; reciprocal labels separated from each other, node bounds and group heading. |
| technical/3 | Full three-column table and all four rows visible. Fixture prose is historical example content, not an assertion of current export capabilities. |
| technical/4 | Code filename now uses the resolved foreground; all code lines and footer visible. |
| repository/0 | Title, summary and right-side 34k metric visible. |
| repository/1 | All four language bars, labels and axis ticks visible. |
| animation/0 | Title visible at final frame. |
| animation/1 | Click-reveal title, all three statements and blue line visible at final frame. |
| animation/2 | Zoom entrance title visible at final frame. |

Two actual rendering defects were fixed before recording: diagram edge labels
overlapped each other/nodes, and the filename inherited a dark browser default
color. Label placement is resolved in the scene and included in its digest;
the technical scene baseline adds label text/coordinates without changing node
positions or edge paths. Dense diagrams without a clear label position report
a warning. This is not the general collision solver required by G07.

Both browsers reported Chromium `153.0.8010.12`. Linux uses the official image
`mcr.microsoft.com/playwright:v1.63.0-noble` at immutable digest
`sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`.
CI pins that same image; Playwright/OS/font updates require another image review.
Platform fallback fonts visibly differ (including apparent weight); these
baselines protect each platform's rendering, not cross-platform font parity.
The G09 font manifest/loading work remains open.

The run emits review evidence under ignored `artifacts/<platform>/` and
`<platform>.json.computed`; CI uploads both PNGs and runtime metadata on failure.
After reviewing images, record through `UPDATE_PIXELS=1`, or copy the exact
reviewed `.computed` output, then run again with `REQUIRE_PIXEL_BASELINE=1` and
without update mode. Never record new hashes simply to remove an unexplained
failure. Test results and limitations are tracked in
[the remediation report](../../../../docs/PHASE_0_TO_9_FIX_PROGRESS.md).
