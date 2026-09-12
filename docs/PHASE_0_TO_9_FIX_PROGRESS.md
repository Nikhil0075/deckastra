# Phase 0–9 remediation progress

Started 2026-09-06 against HEAD `6f06c46250879b287f9ba73bc41e15a2f7d7cf75`
and the existing uncommitted work. Scope remains **all issues in the Phase 0–9
re-audit and its referenced gap registers**. No phase is declared complete here.
The [re-audit](PHASE_0_TO_9_REAUDIT.md) is the pre-remediation evidence baseline.

## Current batch

| Finding | Implementation and evidence | Remaining boundary |
| --- | --- | --- |
| R01 autosave | Shared acknowledgement promise; adoption refuses queued/in-flight edits; separate journals owned through Web Locks; explicit closed-tab recovery; historical-base/local/server reconciliation, previews, downloads and version-checked save. 23 hook, seven journal and five merge tests pass. Three real browser/API journeys pass against freshly started current-source services, including duplicated tabs and immediate acknowledgement/read version equality. Atomic server version advancement passes 26 persistence tests, including PostgreSQL conflicts and SQLite rollback. | Browser-wide crash/eviction durability is unverified. Unsupported Web Locks/legacy journals deliberately retain copied sources. Full caller regression testing after the atomic store change remains in progress. |
| R02 history assets | Recount every retained version through store replay; place/remove-between-snapshots regression passes. | Actual storage deletion, retries, concurrency and quota accounting remain. |
| R03 persisted issues | Apply/validate final proposal before persistence; resolve slide IDs; HTTP generation+GET regression; editor issue display and 2 component tests pass. | Full interactive browser verification remains. |
| R04 candidate/recursion | Deep snapshot composition inputs, sources and matching review; selected inputs returned to graph state; revision-aware traversal limit. Graph/API suites: 39 passing tests. | Hard token/time exhaustion and complete creative rendering remain broader G14/G17 work. |
| R05 registry | Reject missing or blank untrusted field declarations; 18 registry tests pass. | Broader deadline, schema field-coverage and injection evaluation remain G14/G15. |
| R06 workspace | Stable legacy selection before role check; multi-workspace viewer/admin regression passes in 32 launch tests. | Explicit workspace selection UI remains part of workspace journeys. |
| R07 telemetry | Owned OpenTelemetry SDK providers, OTLP HTTP exporters, lifecycle shutdown/flush, generation-aware reconfiguration, strict content filtering and correlated HTTP/run/model spans. Six telemetry tests include a real local protobuf collector and HTTP stub generation. | Vendor-specific LLM tracing, deployed dashboards and complete failed/paid-path accounting remain unverified or incomplete. |
| R08 pixels | Full-slide 2× captures, all ten slides repeated and reloaded, explicit final animation frame, bottom-right negative control, saved PNG/runtime evidence. All ten Windows and Linux images reviewed; required baseline comparisons pass all four checks on each platform. CI pins the reviewed official Linux image by digest and uses one worker with 512 MB shared memory. | Remote CI execution and cross-platform font parity remain unverified; platform baselines do not establish identical font rendering. |

The full-image review also exposed overlapping diagram edge labels and an
unreadable code filename. The renderer now places labels clear of nodes, group
headings and prior labels, reports when no clear space exists, and uses the
resolved code foreground for filenames. Diagram label text/geometry now appears
in scene digests. The technical scene baseline change adds only that previously
omitted information; node/edge geometry is unchanged. These fixes do not close
all rendering semantics in G08.

## Verification from the first remediation batch

- Whole-workspace `npm run typecheck`: passed.
- `npm test`: 692 tests passed; one opt-in renderer preview test skipped.
- `npm run schema:drift`: all five generated artifacts match.
- `python scripts/validate_fixtures.py`: three fixtures, six base negative cases,
  and both element-boundary checks passed.
- Full Python suite with PostgreSQL enabled: 365 passed in 180.04 seconds;
  one LangChain pending-deprecation warning. PostgreSQL-specific tests ran;
  other fixtures may intentionally use isolated SQLite databases.
- Targeted graph/API, registry and launch checks: 39, 18 and 32 passing tests.
- Targeted editor checks: 13 autosave/recovery and two issue-display tests passed.

Browser journeys and pixels were not rerun in that first batch. The continuation
below adds fresh evidence. These results do not establish all phase exits.
The external-service provider/configuration question is pending; independent local
work remains available and the overall goal remains active.

## Continuation verification — conflict recovery and visual gate

- Whole-workspace `npm run typecheck`: passed again after reconciliation and renderer changes.
- Targeted merge/hook checks: 23 passed. Reconciliation includes independent edits,
  explicit same-field choices, delete-versus-modify, ordering, stale review and a
  second server conflict; unresolved choices cannot be saved.
- `E2E=1` recovery browser suite: two passed against the local API in stub mode.
  Failed autosave + another writer + reload preserves and merges an inserted
  shape and remote title; competing shape coordinates require an explicit choice
  and survive another GET/reload. These use an API second writer, not two browser tabs.
- Renderer visual/layout + scene baseline checks: 39 passed.
- Windows `PIXELS=1 REQUIRE_PIXEL_BASELINE=1`: four passed, including all ten
  fixture slides on repeat/reload and the bottom-right control.
- Worker browser suite: five passed; all three fixtures and wrapping cases have
  equal editor/worker resolved digests with no estimated metrics, and PNG/PDF/PPTX
  reports use measured scenes.
- Schema drift: five generated artifacts match. Python fixture validation: all
  three fixtures, six base negative cases and both known/unknown-element checks pass.
- Full `npm test`: **703 passed, one opt-in renderer preview skipped**. The subsequent
  diagram-label search cap passed its targeted visual/baseline run: **40 tests**.
  The 703 count describes the completed full run before that extra regression.
- The follow-up attempt terminated before assertions with Vite `spawn EPERM`
  (two unhandled errors, no tests). Windows reported 96.6% memory usage and about
  434 MB available. This does not establish a code regression or a pass. A
  single-worker retry subsequently passed all 40 targeted tests. The user offered
  to free memory; existing application services were left running.
- Linux's first dependency install failed with `ENOTFOUND`; a host-resolved
  address retry failed with `ECONNREFUSED`. Both stopped before browser assertions.
  Installation from the local npm cache succeeded. Linux repeat/reload/control
  passed; baseline comparison correctly failed because `linux-x64.json` did not
  exist. All ten PNGs were then reviewed and the exact emitted hash file recorded.
  A first verification retry timed out launching Chromium, with all four checks
  skipped. A fresh single-worker run with 512 MB shared memory passed **all four**
  checks in 75.82 seconds against the recorded baseline, without update mode.
  Runtime: Chromium 153.0.8010.12, Node v24.20.0, Linux x64; all images are
  3840×2160 captures of 1920×1080 slides. Temporary review containers were removed.
  See [image review](../packages/renderer/baselines/pixels/REVIEW.md)
  for the intentional migration, platform font differences and runtime pin.
- Full Python API/agent/integration suite was not rerun in this continuation:
  Python implementation did not change here. Its 365-pass result above is earlier
  evidence, not a fresh run. Live models, GitHub credentials, production auth,
  deployment/restore and remote CI remain unverified.

The 47/102 (46.1%) coverage in the re-audit remains a **historical baseline**.
It is not a fresh percentage for the current tree. Broad groups are not promoted
from partial merely because one regression is fixed.

## Continuation verification — telemetry (2026-09-07)

- Full `python -m pytest apps/api agents integrations -q` with PostgreSQL enabled:
  **371 passed**, one LangChain pending-deprecation warning, 192.48 seconds.
- After the final OTLP protocol-precedence adjustment, the six telemetry tests
  passed again in 7.09 seconds. Signal-specific HTTP settings correctly override
  a global gRPC setting; unsupported effective protocols do not report enabled.
- Targeted telemetry/API/launch run: 52 passed. `python -m pip check`: no broken
  requirements after installing the pinned OTLP HTTP exporter.
- Tests exercise actual SDK delivery to a local protobuf collector, replacement
  exporters, disabling, malformed optional configuration, failure counters,
  lifecycle flush/shutdown, sensitive-content exclusion and correlated HTTP,
  agent-run and model-call spans through the stub graph.
- Live models, vendor-specific LangSmith/Langfuse inspection, deployed collectors,
  GitHub installation, production authentication, restore and remote CI were not
  verified. Generation failure accounting and other paid paths remain open.

## Continuation verification — journal ownership (2026-09-07)

- `apps/web/lib/editor-recovery.ts` assigns one writable journal per editor.
  A reload pointer in sessionStorage is advisory: an exclusive Web Lock prevents
  a duplicated tab from reusing an active journal. StrictMode setup/cleanup and
  late acknowledgements after unmount have regressions.
- `ConflictRecovery.tsx` lists other saved copies, prevents taking an active
  journal, and offers downloads. Taking a closed copy writes the destination
  before removing the source. Quota errors and unreadable records preserve the
  original bytes. Legacy shared journals and browsers without Web Locks retain
  sources after copying. The empty-deck view also exposes recovery controls.
- Full web unit suite: **53 passed**. After the final unreadable-owned-record
  listing adjustment, all **30 journal/hook tests passed** (694.58 seconds wall
  time; 4.23 seconds in tests). Web typecheck passed after it.
- Fresh current-source browser verification: **three passed**, 23.33 seconds,
  using a temporary Next server on 3011 with an isolated source/build directory
  and a same-origin proxy to a fresh stub-mode API on 8012, backed by PostgreSQL.
  The normal 3000/8000 services were left running. No live model credentials were
  passed to the temporary API. Copies of source for this run were not a deployment.
- Temporary 3011/8012 processes were stopped after verification. The attempted
  drag follow-up exited with code 1 before emitting test output; it is not a pass
  and does not update earlier performance evidence. Automatic approval review
  rejected a combined process/filesystem cleanup command with only "blocked by
  policy". Separately stopping the two verified temporary listeners succeeded;
  the ignored source/build copy was retained rather than repeating that cleanup.
- Journeys cover offline reload with an independent remote edit; a same-property
  conflict requiring an explicit choice; and a real popup with cloned
  sessionStorage whose save cannot erase the first tab's journal. After the first
  tab closes, its copy is recovered, merged and verified through GET and reload.
  Save response documents and immediately read version IDs are checked explicitly.
- Earlier attempts are not passes: port 3000 timed out before loading any editor;
  its log contained EPIPE. A first temporary-server run exposed a test-context
  lifetime error, fixed by owning BrowserContext explicitly. The older API on
  8000 sometimes returned the prior version immediately after acknowledging a
  save. The inserted element was present on a later read. The stricter check
  reproduced this mismatch there and passed against the fresh 8012 process.
  This establishes current-source behavior in the fresh run; it does not certify
  the existing 8000 process or justify weakening the immediate-read assertion.

### Additional concurrency investigation (P1; G04)

`apps/api/deckastra_api/store.py::commit_transaction` compared
`expected_version_id` with an ORM-loaded head before later assigning the new head.
Two simultaneous requests could both pass that comparison. The sequential two-tab
recovery journey does not prove this invariant. The implementation now uses an
atomic conditional UPDATE against both the composition base and any explicit
expected-version token. A savepoint removes a losing candidate/history, and the
owned ORM head is expired after success. A SQLite physical BEGIN guard prevents
savepoint release from committing outside the enclosing request transaction.
This is an additional finding, separate from the old-process read mismatch.
The persistence verification now passes: exactly one version advance wins and
the losing candidate leaves no orphan history, including when the caller handles
the conflict and commits its other work.
The new `apps/api/tests/test_store_concurrency.py` holds two independent ORM
sessions on the same initial version and checks explicit/omitted version tokens,
the winning document and absence of orphan history. Its first PostgreSQL run,
started before the implementation change, completed with **two failures**:
neither stale save raised `VersionConflict` (537.40 seconds). The fresh final-source
run of concurrency and existing store tests passed **26 tests in 190.20 seconds**.
`test_store.py` also verifies that a successful store call remains subject to the
caller's later outer rollback. The subsequent full API/agent/integration run was
interrupted: its process and session handle disappeared without a final summary.
Docker was also unavailable afterward. This run is neither a pass nor evidence
of a code failure; the earlier 371-pass result predates this transaction change.
The user offered to restart Docker Desktop; PostgreSQL verification must resume
after the daemon and database are available. The temporary derived Docker image
cleanup also lost its handle, so image deletion is not confirmed.

### Final queued canvas movement (G06)

`EditorCanvas.tsx` now reads the synchronously updated draft when pointer-up
flushes a queued animation frame. Previously it read the preceding React render's
draft and could lose the final movement. Marquee selection similarly uses the
last queued pointer position. Two component regressions passed: immediate release
commits the final drag once and undo restores its position; immediate marquee
release selects the intended element. This does not close group resizing or
equal-spacing integration, and provides no new browser performance evidence.
The complete web unit suite then passed **55 tests**, and web typechecking passed.

### Observed generation diagnostics (G02)

The graph records each structured request's stage, contract, schema-attempt count,
first-attempt validity and outcome in its run budget. No prompt, model response or
raw validation input is retained in those observations. Generation diagnostics
aggregate actual requests, including repaired stories and revised candidates;
`attempts` is the maximum schema-attempt count per request, not a count of graph
nodes or provider-internal HTTP retries. Empty observations do not establish a
pass. Input/output tokens are accumulated separately, including charged invalid
responses; the stub response now agrees with its simulated budget charges.
The single-shot path also marks overall first-attempt validity false on repair.

Targeted request-outcome, budget and API regressions: **34 passed**, one LangChain
pending-deprecation warning. Cases cover first-pass success, repair, repeated
invalid output, refusal, provider failure and an HTTP generation with a repaired
story. Actual provider transport
retry counts, real-model validity rates and cross-resume cumulative accounting
remain unverified/incomplete; stub successes are never a real-model sample.

### Latest verification (2026-09-07)

- Full `python -m pytest apps/api agents integrations -q -ra`, with
  `POSTGRES_TEST_URL` explicitly unset because Docker was unavailable: **369
  passed, 11 skipped**, one LangChain pending-deprecation warning, 119.38 seconds.
  Skips: four checkpoint tests, five PostgreSQL persistence/migration tests, and
  both atomic concurrent-save cases. This covers current local API/agent/
  integration changes, including single-shot validity, but cannot replace the
  earlier PostgreSQL evidence or establish a fresh PostgreSQL pass.
- Complete web unit suite: **55 passed**; web typecheck passed. npm consumed the
  attempted worker-limit flags rather than forwarding them; this successful run
  used the normal workspace test command, not a verified single-worker setting.
- `npm run schema:drift`: all five artifacts match. `python
  scripts/validate_fixtures.py`: three fixtures, six base negative cases and both
  element-boundary checks passed.
- Browser/pixel/performance checks were not rerun for the queued-pointer fix;
  its new evidence is component interaction and undo testing. Previous browser
  evidence is dated above. The supplied source specifications remain unchanged.

## Full remaining-work ledger

### Interrupted canvas gestures (2026-09-07)

The canvas previously routed `pointercancel` through pointer-up and committed
the unfinished drag/resize. Cancellation now cancels the queued animation frame,
discards only the local preview, clears guides/spatial exclusions and stops frame
sampling. Unexpected pointer-capture loss uses the same cancellation path.
Ordinary pointer-up retains the existing final-frame flush and transaction.

- Complete web suite: **74 passed**, including four new cancellation cases for
  queued/already-drawn movement and recursive group resizing. Each preserves a
  previous document edit/history entry, ignores a later pointer-up, permits a
  fresh drag and undoes only that subsequent drag.
- Web typecheck passed. No real touch-device, lost-capture browser or performance
  run was performed; the new evidence is component interaction testing.
- Docker remains unavailable. Existing PostgreSQL verification gaps and the
  broader Phase 0–9 ledger remain open.

### Concurrent theme defaults (2026-09-07)

A new stale-session test reproduced two simultaneous defaults: the first writer
selected A, then a second session holding old `is_default=False` objects selected
B without clearing A. The original implementation failed this test; its parallel
SQLite smoke case happened to pass and did not disprove the stale-session defect.

Theme saving now acquires a workspace write lock before looking up or creating
the theme, then selects the default through one database UPDATE with ORM state
synchronization. The lock is held until the caller's transaction ends. This
serializes same-workspace writers and avoids deciding database changes from
stale in-memory booleans. No schema migration or new commit boundary was added.

- After the fix, theme concurrency plus launch suites: **35 passed, two skipped**,
  one LangChain pending-deprecation warning, 18.24 seconds. SQLite verifies the
  reproduced stale-session case and two real parallel writers.
- The matching two PostgreSQL cases were skipped because Docker remains
  unavailable. They add two pending database checks to the eleven from the
  preceding full suite; there is no fresh all-PostgreSQL pass.
- Protection against writes outside this service, historical duplicate-default
  repair, durable resume theme retention and live browser/export acceptance
  remain unverified/open.

### Default-theme adoption continuation (2026-09-07)

The editor can save its current theme as the workspace default. Blank creation,
graph generation and single-shot generation now resolve the default from the
authorized target workspace. The graph freezes the definition once before model
work and supplies that same snapshot to every candidate composition, including
best-draft recomposition. Each document embeds the full definition and its
`metadata.themeId`; later edits to the saved theme do not mutate old decks. Without
a default, the existing built-in theme remains the fallback.

- Four new API cases passed: blank/graph/single-shot adoption with portable
  snapshots, plus workspace isolation. The preceding API/agent suite passed 40
  tests after the implementation change and before those four cases were added.
- Complete web unit suite: **70 passed**. The new control test verifies that
  saving as default sends the current portable definition and updates the default
  badge. Web typecheck passed.
- The fresh full local Python suite completed: **379 passed, 11 skipped**, one
  LangChain pending-deprecation warning, 122.10 seconds. PostgreSQL was explicitly
  disabled because Docker remains unavailable. Skips were four checkpoint, five
  PostgreSQL persistence/migration and two concurrent-store tests. This run
  predates the theme-write serialization change described above.
- F08 remains partial: concurrent default selection, durable checkpoint-resume
  theme retention, live browser/render/export acceptance and broader brand-aware
  composition are not established by these tests. The Critic's existing lack of
  complete rendered evidence remains a separate F01/G17 gap.

### Saved-theme editor workflow (2026-09-07)

The editor side panel now lists saved workspace themes, applies a selected theme,
and saves/replaces the current theme under a user-entered name. Default themes
are labelled in the list. Refresh provides recovery from a failed listing or
changes made elsewhere; errors and in-flight state are visible.

New presentation-scoped list/save/proposal endpoints use the deck's actual
workspace, avoiding the legacy first-membership ambiguity. List requires read
access; save/proposal requires editor access. Cross-workspace and archived themes
are refused. The proposal endpoint is read-only and returns the existing theme
patch; the editor applies it against its latest local document through normal
history/autosave, preserving pending work and one-step undo. A late response after
unmount or a different document cannot apply to that document.

- API launch suite: **33 passed**, one LangChain pending-deprecation warning,
  23.92 seconds. The new workflow verifies scoped listing/saving, read-only
  proposal retrieval, application through versioned transactions and foreign
  theme/deck rejection.
- Web suite: **69 passed**. A component regression changes local metadata while
  the theme request is pending, applies the returned patch, and undoes only the
  theme while retaining the local change. Final web typecheck passed.
- The last small addition is a refresh button using the tested request/error
  path; no additional browser run was performed. F08 remains partial: default
  theme adoption in new-deck generation/creation and its selection controls, live
  theme rendering/export checks and concurrent default selection remain open.

### Generation authorization continuation (2026-09-07; P1)

Inspection found that `/v1/generate` accepted workspace membership without an
editor-role check and restricted explicit projects to whichever membership its
unordered query returned first. A viewer could therefore create decks and incur
generation spend, while an authorized editor's explicit second-workspace target
could be rejected.

Both blank and generated creation now use `resolve_creation_project`. Explicit
targets resolve their own project/workspace chain and require editor access.
Default selection uses the existing stable workspace rule and first project by
ID, refusing insufficient authority rather than selecting a different workspace.
Generation quota checks/accounting, repository resolution and telemetry receive
the authorized project's workspace ID. Authorization precedes quota/model/run
work for both the graph and single-shot paths.

- API/launch/agent surface suites: **72 passed**, one LangChain pending-deprecation
  warning, 48.73 seconds. Tests assert viewer refusal before any paid-work entry
  point or persisted run/document, refusal to elevate default selection, and
  successful explicit generation in a second workspace with usage charged there.
- An initial new-test run had **24 passes and one failure** because its manually
  constructed membership omitted its required ID. Added the fixture ID and fixed
  the quota assertion to use `used_generations`; the production schema was not
  changed or loosened. The 72-pass run is after those corrections.
- This repairs an authorization defect; production email/social sign-in,
  concurrent spending reservations and complete workspace-selection UI remain
  separate open requirements. Docker is still unavailable, so there is no fresh
  PostgreSQL verification in this continuation.

### Blank-deck creation continuation (2026-09-07)

`POST /v1/presentations` creates a schema-valid blank document with one empty
slide, a persisted initial version and user attribution. It reuses the composer’s
canonical document shell/theme, removes generated metadata/provenance, and never
starts an agent run. Explicit projects require editor access through the existing
project authorization chain. The default uses the stable workspace selection and
its first project by ID; insufficient role is refused before creating anything.

The home page exposes “Start blank” and connects the generation-failure screen’s
existing blank action to the same request. Success opens `/edit/<saved-id>`;
failure is displayed with a retry path while retaining the brief. A synchronous
in-flight guard prevents repeated clicks from submitting competing creations.

- **22 API tests passed**, including blank POST/GET equality, initial version,
  empty slide, subsequent versioned editing, no agent run, token requirement,
  viewer rejection and foreign-project non-disclosure.
- **68 web tests passed**, including home/failure-screen creation and navigation,
  failed storage response, retry and brief retention. Web typecheck passed.
- Live browser creation/edit/reload and interrupted-response idempotency were
  not verified. This closes the no-op blank action, not all G05/F10 authoring or
  onboarding requirements. Current development-session authentication is unchanged.

### Font-driven scene rebuild continuation (2026-09-07)

`useBrowserMeasurer` now subscribes to browser font readiness, successful loads
and load failures. It changes the measurer wrapper identity so memoized scenes
rebuild, while retaining the shared underlying measurer/cache/DOM host. All six
scene-building application surfaces consume the hook: editor canvas and shell,
conflict previews, home preview, shared deck and presenter route. An unavailable
initial measurer lookup no longer permanently prevents later initialization.

`DomMeasurer` invalidates on both load success and failure. Its named listeners
are removed by `dispose`; React's shared subscription detaches when its last
consumer unmounts and ignores a subsequently settled readiness promise.

- **65 web tests passed**, including changed metrics reaching rebuilt scenes,
  two subscribers sharing one measurer, stable memoization between font changes,
  failed initialization retry and subscription cleanup. The cache regression
  verifies stale-to-refreshed values, one measurement host and disposal cleanup.
- **46 layout-engine tests passed**. Web and layout-engine typechecks passed.
- No live delayed-font browser, worker/pixel or hydration check was run here.
  G09 remains partial: this fixes scene invalidation, but a complete font manifest,
  explicit load barrier/fallback workflow and corresponding live acceptance are
  still required. This is not evidence of cross-platform font parity.
- Docker remains unavailable; the eleven PostgreSQL-dependent skips recorded
  above have not become passes.

### Equal-spacing continuation (2026-09-07)

Canvas movement now calls `snapRectWithSpacing`, comparing alignment, equal-gap
and grid candidates once per axis. The smaller correction wins; established
alignment priorities win exact ties, while spacing wins a grid tie. The helper
rejects negative gaps and chooses the closest valid spacing candidate. Canvas
neighbors are ranked by rectangle distance, deterministically tied by ID, and
capped at 40 after the prescribed zoom-scaled spatial search.

The chrome draws two double-arrow indicators with logical-pixel gap labels at
the final snapped box. Indicators have screen-space line/font sizes, disappear
on release, and never coexist with another winning guide on the same axis.
Ctrl/Cmd disables all snapping. Shift suppresses corrections on the fixed axis;
one movement still commits as one undoable transaction.

- Editor suite: **108 passed**, including four spacing candidate regressions.
- Final web suite: **63 passed**, including 50%/200% zoom, guide numbers/removal,
  undo, Ctrl disabling and Shift preserving the fixed axis.
- Editor and web typechecks passed. No browser/pixel/performance check was run
  for these changes; current evidence is model and component interaction testing.
- G06's prior missing equal-gap wiring is implemented. Full browser acceptance,
  transformed-parent handling, additional distribution cases outside the two
  bracketing neighbors and other group-content semantics remain open; this does
  not declare the complete phase or requirement group finished.

### Group resizing continuation (2026-09-07)

`apps/web/lib/resize-operations.ts` connects the editor's `resizeGroup` helper to
canvas transactions. Free groups default to scaling descendants recursively;
container groups default to preserving their children while their box changes.
An ancestor's scale-children operation also scales nested groups, including nested
groups whose own direct-resize preference is container-only. Child text uses the
minimum axis scale; letter spacing and explicit font-size limits follow that
factor. Each resize is one patch and one undo entry. The object inspector exposes
both modes with a labelled select, disabled on locked groups.

The canvas now builds resize previews from the same patch used on pointer-up,
rebuilding only the active slide. This reflows text and updates descendant
geometry instead of stretching only the scene's outer box. Normal moves retain
their existing fast preview path.

- Full web unit suite: **59 passed**. Two interaction cases verify both modes,
  nested rotated groups/text, preview-to-commit DOM equality and full undo.
  Two patch cases verify non-uniform text scaling, rotated transforms, complete
  inverse restoration and the default container behavior.
- The first typecheck found an invalid container type in the new test fixture
  (`horizontalStack`). Corrected to the schema's `horizontal`, added schema
  validation for that result, and reran: **web typecheck passed; both patch tests
  passed**. No production schema was relaxed.
- G06 is still partial: equal-spacing snapping/guides remain unwired. Full browser
  resize performance, all container layout/child-content semantics and nested
  transformed-parent pointer handling are not established by these tests.
- Docker still has no available Linux-engine pipe; no new PostgreSQL checks ran
  in this continuation. Earlier skips remain explicit above.

Every historical finding remains represented below. Completed sub-fixes are in
the current-batch table; broad items stay open until their complete acceptance
criteria are verified. This preserves the requested scope across work sessions.

| Original finding | Baseline remaining work |
| --- | --- |
| G01 — Validation/evaluation gates | Open: real lint, rule-by-rule fixtures and real-model evaluation corpus/rates. |
| G02 — Generation measurements | Structured-request attempts/validity and input/output accounting now observed and regression-tested. Provider transport retries, cumulative resumed runs and the real-model evaluation corpus/rates remain open. |
| G03 — Actual authentication | Open: development tokens remain; email/social authentication and a complete account journey are absent. |
| G04 — Autosave | Improved; not closed. Failed batches survive, but R01 remains. |
| G05 — Manual authoring | Blank creation now persists and opens an editable one-slide deck, with HTTP/UI regressions. Full element/content/style controls and the live manual-authoring journey remain open. |
| G06 — Group resize/distribution | Group resize modes and equal-gap snapping/guides are wired and component-tested, including zoom/modifiers and undo. Complete transformed-parent, distribution, group-content and browser-performance acceptance remains open. |
| G07 — Constraints/collision | Open: deterministic solver/validation are not integrated into authoring/render composition. |
| G08 — Rendering semantics | Open: anchored lines, image crop/mask and other documented semantic gaps. The schema guard/fallback fix remains valid. |
| G09 — Font loading | All application scene consumers now subscribe to font readiness/load/failure and rebuild through a shared measurer; cache invalidation and cleanup are tested. Worker already waits on browser fonts. Full font manifest, load barrier/fallback workflow and live delayed-font/hydration acceptance remain open. |
| G10 — Visual gates | Required ten-slide 2× capture/reload comparisons now pass on reviewed Windows and pinned Linux runtimes. Remote CI execution remains unverified. |
| G11 — Performance/dashboard | Open: current drag E2E passes its dropped-frame allowance at 16.7ms p95/60Hz, not the literal <16ms criterion or all resize/p99/RSS/dashboard budgets. |
| G12 — Human checkpoint | Test harness fixed and PostgreSQL resume tests pass; product story-approval HTTP/UI path remains absent. |
| G13 — Live generation progress | Open: synchronous generation/home-page subscription gap. |
| G14 — Budgets/timeouts | Open: daily workspace credits, hard tool deadlines, full spend accounting and usable fallback on exhaustion; R04 adds default recursion evidence. Monthly quotas are partial adjacent coverage, not the planned daily ceiling. |
| G15 — Untrusted boundary | Missing/blank declarations now fail registration (R05); full field-coverage and injection evaluation remain. |
| G16 — Memory feedback | Open: accepted-layout and dismissed-issue feedback are not a complete persisted user loop. |
| G17 — Critic/creative | Story selection improved; issue persistence, coherent candidates, source alignment and creative application remain R03/R04. |
| G18 — Contextual editing | Open: chart/data/style intents and rendered approval preview; R01 pending-edit protection. |
| G19 — Documentation | CLAUDE now records many decisions. Reconcile remaining claims about saved issues, best complete candidates, reconfiguration and whole-suite/phase completion with this review. Original supplied specifications remain historical inputs. |
| G20 — Real GitHub connection | Open: browser callback authentication/state, discovery/selection and external installation-ID resolution; no credentialed installation demo. |
| G21 — Incremental refresh | Open: push does not queue the incremental indexing path; live freshness/retry evidence absent. |
| G22 — Provenance | Wrong-repository/same-filename defect fixed. Indexed-commit identity and correct selected-story provenance remain open, especially after fallback (R04). |
| G23 — Motion authoring | Start offsets, delays, track ordering and clip duplication are implemented and component-tested. Keyframe editing, timeline drag/group/zoom/split/ripple tools and complete browser motion acceptance remain open. |
| G24 — External acceptance | Unverified: real model, real GitHub, embedding quality and externally reachable deployment demonstration. |
| F01 — Critic evidence/retention | Partial: eight scores/routing exist; plan counts are not render metadata; R03/R04 prevent closing fallback. |
| F02 — Headless reliability/cache | Open: bounded concurrent pool leases, total deadlines, authorized asset materialization/font manifest and version/options cache. |
| F03 — PDF fidelity | Open: assets, notes/options and metadata; tagged PDF remains an explicit deferral. |
| F04 — PPTX fidelity/report | False `rasterized` action fixed. Real native/media content or embedded visual fallbacks still needed. |
| F05 — Asynchronous exports | Open: POST remains synchronous; queued/failed job durability, live progress, retries/cancellation are unfinished. |
| F06 — Export performance | Unverified against an agreed SLO: prior 60-slide 6.299s/5.315s figures are historical observations, not fresh load/percentile/RSS results. |
| F07 — Sharing/roles | New viewer links and role checks fixed; R06 and public-share browser verification remain. |
| F08 — Theme workflow | Saved themes can be listed, applied with undo, saved/replaced and marked as default. Blank and both generation paths adopt portable default snapshots from the target workspace. Concurrent defaults, checkpoint-resume retention and live rendering/export acceptance remain open. |
| F09 — Asset lifecycle | Current heads and replayed retained versions now protected; storage deletion, upload/restore wiring, concurrency and quotas remain (R02). |
| F10 — Onboarding/recovery | Blank action now persists a deck and navigates to its editor; failures retain the brief and allow retry. Broader stale/font feedback, mid-run recovery and live onboarding acceptance remain incomplete. |
| F11 — Spend enforcement | Open: contextual edits/continuations and failed work/concurrent reservations not fully accounted for. |
| F12 — Observability | SDK/exporter delivery, filtering, lifecycle and correlated HTTP/run/model traces verified locally (R07). Vendor LLM tracing, deployed dashboards and complete metric/paid-path coverage remain. |
| F13 — Recovery | Policy exists; actual WAL/PITR/object retention and restore rehearsal unverified. |
| F14 — Accessibility | Helper tests pass; application integration, composite contrast, alt editing and focus/keyboard/zoom checks remain. |
| F15 — Product metric pipeline | Missing: retained-slide session/cohort calculation and dashboard. Targets alone are complete. |
| F16 — MVP exit | PostgreSQL tests and current editor navigation/drag check now pass. Twelve-step signup/project/GitHub/authoring/export launch demonstration remains incomplete. |


## Continuation: motion timing controls (2026-09-07)

MotionPanel now exposes source start offsets and optional clip delays in
milliseconds through undoable, ID-addressed transactions. It uses stored offsets,
not compiled absolute positions that include preceding tracks and trigger timing.
Empty, negative and non-finite inputs do not change the document.

The new motion-panel component regression verifies after-previous timing (850ms
resolved start), schema validity, negative input rejection and separate undo steps,
including removal of a previously absent delay. Initial test setup needed the
editor recovery-ready barrier and a registered preset. Typecheck also caught an
unknown[] test adapter; parsing the patch schema corrected that adapter.

Verification: 75 web tests passed; after the test adapter correction, web
typecheck and the motion regression passed again. Diff whitespace check passed.
Docker's Linux engine remains unavailable: PostgreSQL checks remain pending.
G23 remains partial: reorder/keyframe authoring and live browser motion acceptance
are still open. No visual baselines were regenerated.


## Continuation: animation track ordering (2026-09-07)

MotionPanel now provides Move track earlier/later controls for the selected clip's
whole source track. A single move transaction preserves all its clips, IDs,
triggers, offsets and future fields; the existing compiler recalculates relative
timing. Boundary controls are disabled and selection remains on the moved clip.

The motion regression covers both directions, a multi-clip track with extensions,
relative timing before/after, schema validity, boundaries and three separate undo
steps. Full web suite: **76 passed**; web typecheck passed. No new PostgreSQL or
live browser verification is claimed.

G23 remains partial. These keyboard-operable ordering buttons cover track order,
not the full doc 04 section 25.2 interaction list: timeline drag, duplicate clip,
group tracks, timeline zoom, split at playhead and ripple-shift still need product
implementation/acceptance, alongside keyframe authoring and browser verification.


## Continuation: duplicate clips and stagger-source editing (2026-09-07)

MotionPanel now duplicates the selected source clip with a fresh ID in one undoable
transaction, preserving timing, keyframes, preset parameters and future fields.
It selects the copy so subsequent timing changes affect the copy independently.
Duplication intentionally retains the original interval; existing overlap warnings
remain applicable until the author adjusts its timing.

Inspection also found that staggerReveal produces child bars with generated IDs.
Panel edits now resolve those bars to the authored source clip, and duplication
selects the corresponding child of the copy. Previously these edits addressed a
nonexistent document clip. Regressions cover custom keyframes/future fields,
separate edits and undo, plus delay/duplicate/duration edits from a stagger child.

Verification: **78 web tests passed**, web typecheck passed. No new database,
browser or visual-baseline result is claimed. G23 remains partial; timeline drag,
keyframe editing, grouping, zoom, splitting and ripple-shift still remain open.


## Latest verification and status (2026-09-08)

The duration inspector now uses authored duration rather than reduced playback
duration and ignores empty/negative/non-finite input. A regression exposed that
the compiler read a nonexistent raw motion field on resolved scenes. It now reads
resolved motion tokens, honoring document defaults/preferences and inheritance.
Test scene doubles now provide resolved token maps; full-motion sequencing tests
explicitly request full motion. No supplied fixture or visual baseline changed.

- Full workspace typecheck completed without TypeScript errors.
- Full npm test: **746 passed, one opt-in renderer preview skipped**.
- Windows PIXELS=1 REQUIRE_PIXEL_BASELINE=1: **four passed**, 14.34 seconds.
  The first invocation without PIXELS skipped all four; the enabled run above is
  the actual verification. No update-baseline flag was used.
- PostgreSQL, Linux pixels, worker browser parity and external services were not
  rerun in this batch. Historical results must not be represented as fresh.
- Current HEAD remains 6f06c46250879b287f9ba73bc41e15a2f7d7cf75 with uncommitted work.

### Current remaining-work summary

The historical G/F rows above retain earlier audit wording; completed issue
persistence/candidate-selection fixes are described in the R03/R04 evidence and
must not be counted again as missing. No new 102-requirement coverage percentage
has been certified.

1. Production email/social authentication, account/project/workspace selection.
2. Complete manual content/style authoring, transformed-parent gestures, group
   content semantics, constraints/collision integration, anchored lines and crops.
3. Complete font manifest/load/fallback experience and live font acceptance.
4. Story approval UI/API; durable asynchronous generation and live progress.
5. Daily credits, concurrent spend reservations, all paid/failed paths, hard
   deadlines, provider retries and usable budget-exhaustion fallback.
6. Persisted layout/issue feedback, creative application, rendered critic evidence,
   richer contextual edits and rendered approval previews.
7. Real GitHub callback/discovery/installation flow, queued incremental indexing,
   retry/freshness and indexed-commit provenance verification.
8. Remaining motion tools: keyframe editing, dragging, grouping, zoom, splitting,
   ripple-shift and complete browser motion acceptance.
9. Bounded export worker leases/deadlines/cache, authorized assets/fonts, durable
   asynchronous export jobs with progress/retry/cancel, PDF/PPTX fidelity gaps.
10. Asset upload/deletion/restore/concurrency/quotas; theme snapshot retention on
    checkpoint resume and PostgreSQL concurrency/live theme acceptance.
11. Accessibility integration, public sharing, onboarding, crash/eviction and
    interrupted-run recovery acceptance.
12. Real lint/evaluation fixtures, injection coverage, real-model/embedding/GitHub
    evaluation, updated requirement-by-requirement audit and documentation.
13. Performance SLO/load/p95/p99/RSS evidence, deployed telemetry/LLM dashboards,
    full metric coverage and retained-slide cohort pipeline.
14. Production backup/WAL/PITR/object retention and restore rehearsal; remote CI
    and end-to-end deployment plus the complete twelve-step MVP demonstration.
15. Fresh PostgreSQL verification remains pending Docker availability (including
    the two new theme-concurrency cases); external acceptance requires configured
    services and credentials. These are verification gaps, not passes.

## Desktop milestones D0–D2 (added 2026-09-12)

New rows, per the desktop plan's ledger discipline. The original phases are not
renumbered and nothing here is discharged by execution becoming local: the
authentication, security, performance, accessibility, export and backup
requirements still apply to the desktop, and several are listed below as open.

| Milestone | Implementation and evidence | Remaining boundary |
| --- | --- | --- |
| D0 shell and seam | `WorkspaceClient` is the single transport (`packages/workspace-client`), the editor is a package (`packages/editor-ui`), and `apps/desktop` runs it from a custom scheme with `contextIsolation`, `sandbox` and a CSP. Installed-app acceptance on Windows 11 (2026-09-08): runs from the installer with no dev server, network absent from the CSP, all three scene digests byte-identical to the Node baselines, edit survives restart, present opens a second window. | Pixel parity *inside Electron's Chromium* is unrecorded; the digest gate covers the scene, not the paint. macOS is unmeasured and cannot be measured from this machine. |
| D1 local authority | `apps/api` runs as a supervised sidecar on SQLite in local mode; the renderer reaches it only through a same-origin proxy that injects the bearer. Packaged export renders with the app's own Chromium (`main/render-host.ts`, `apps/worker/src/electron-backend.ts`); verified from the packaged pieces and then from the installed app, artifact read back by `pypdf`. Exports live in the data directory. | A *freshly built* installed binary has not been re-verified since the render-host change landed in source; the September 12 installed run used the build made that day, and any later source change needs its own run. PostgreSQL row-lock coverage still needs `POSTGRES_TEST_URL`. The MinIO sweeper test fails locally without the compose service. |
| D2 agent access | `apps/mcp-server` over stdio, 13 tools, attaching to the running app through a published grant. Version identity is carried from proposal through preview to approval; the authority enforces capabilities (`grants.py`); cancellation stops a running render; an adopted outside change can be undone through the server. Suites: MCP 19, desktop 15, editor-ui 94, worker 19, and the API's authored-proposal, version, grant, preview, motion and cancellation files. | One client has not yet driven create → revise → animate → preview → approve → undo → export end to end on a scratch workspace, including a stale refusal and a cancellation. The MCP server still runs from this checkout through `tsx`; an installed app on a machine without the repository has no server. D2.3's scoped *session* grant (user-visible consent, revocation UI) is not built — the credential is scoped, the consent flow is not. |

### Requirement dispositions

- **Retained.** Optimistic concurrency, proposal-before-apply, server-computed
  risk, inverses and ordinary undo, the authorization ladder, "a missing resource
  and a forbidden one both answer 404", no expression language, no path from
  document content to the filesystem. All of these hold for an agent because an
  agent's request is the same request.
- **Moved.** The editor's rules moved from `apps/web` into `packages/editor-ui`
  unchanged; the export contract moved from `npx tsx` to a bundled entry point
  with the same JSON-in/JSON-out shape; rendering moved from Playwright's
  Chromium to the app's own *in a packaged build only* — a checkout and CI still
  use Playwright, and byte-identical output across the two browsers is not
  claimed.
- **Replaced by an approved decision.** The generic `proposal.commit` surface in
  the D2 plan became `document_propose` plus approval in the app: an agent cannot
  approve, and the low-risk apply-immediately rule stands (making someone approve
  a typo fix trains them to approve without reading). Recorded here because it is
  a narrower surface than the plan described, not an oversight.
- **Still open.** Packaging the MCP server; the full real-client journey on a
  scratch workspace; a user-visible grant/consent flow with revocation; pixel
  parity inside Electron; macOS; PostgreSQL row-lock verification; and a freshly
  built installed binary re-verified after the current source.

### Evidence discipline

Two claims in this repository were previously stronger than their evidence, and
both were corrected rather than re-argued: "refusing to run headless prevents a
stale editor" (it does not — the editor now watches the head) and "the tool
surface's omissions keep an agent from approving or sharing" (they did not — the
authority now refuses by capability). A tool count is not a closure criterion.
