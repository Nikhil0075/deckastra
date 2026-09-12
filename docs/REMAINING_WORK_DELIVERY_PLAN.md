# Deckastra remaining-work delivery plan

**Prepared:** 2026-09-08  
**Scope:** Remaining work after the Phase 0–9 remediation recorded in
`PHASE_0_TO_9_FIX_PROGRESS.md`.  
**Planning unit:** Engineering weeks, not calendar commitments. The ranges assume
two product engineers and one platform/AI engineer can work in parallel, with
design and QA support available at phase exits.

## Current verification snapshot

Docker/PostgreSQL verification was resumed on 2026-09-08 against the current
working tree:

- Compose PostgreSQL (`pgvector/pgvector:pg17`) reached `healthy`.
- The focused migration, JSONB, store-concurrency and theme-concurrency run passed
  **14/14 tests**.
- `python -m pytest apps/api/tests agents integrations -q` with
  `POSTGRES_TEST_URL` passed **394 tests** in 138.81 seconds, with one existing
  LangGraph pending-deprecation warning.

This closes the fresh local PostgreSQL verification gap. It does not substitute
for remote CI, production restore, or credential-dependent acceptance.

## Delivery principles

1. Protect data, access and spend before expanding the feature surface.
2. A phase exits only on user-visible acceptance evidence, not on unit tests alone.
3. Every mutation remains versioned, attributable, reversible and workspace-scoped.
4. Long-running work is durable, idempotent, observable and recoverable after a
   process restart.
5. Credential-dependent acceptance is a release gate, but it must not block local
   implementation or deterministic test coverage.
6. Update the requirement matrix at every phase exit; do not carry a partial item
   forward as implicitly complete.

## Priority definitions

- **P0:** Data loss, authorization, unbounded spend, or unrecoverable job risk.
- **P1:** Required MVP journey or fidelity gap.
- **P2:** Launch evidence, polish, and operational maturity.

## Phase 0 — Rebaseline and make the gates trustworthy

**Target:** 2–3 engineering days  
**Purpose:** Establish one reproducible baseline before feature delivery begins.

### Deliverables

- Run the complete Python suite with `POSTGRES_TEST_URL`, including migration,
  store concurrency, checkpoint and theme-concurrency cases.
- Replace placeholder lint scripts with real lint rules for TypeScript and Python.
- Run schema drift, fixture validation, workspace typecheck/tests, worker-browser
  parity, required Windows/Linux pixel gates and the current editor E2E suite.
- Record failures as owned backlog items with a severity, owner and acceptance
  test; distinguish environmental failures from product failures.
- Refresh the 102-item requirement matrix against the current working tree.

### Exit criteria

- A clean clone can run the documented local gate sequence.
- PostgreSQL-specific tests run rather than skip.
- Remote CI runs the same required gates and has a green, retained build record.
- The delivery backlog and requirement matrix point to the same source of truth.

## Phase 1 — Secure identities, workspaces, spend and durable generation

**Priority:** P0  
**Target:** 2–3 engineering weeks

### Execution status — started 2026-09-08

- [x] Add a production OIDC bearer-token boundary with exact issuer/audience,
  RS256 signature, expiry and verified-email checks.
- [x] Disable signed development tokens categorically in production.
- [x] Persist external identities by immutable issuer/subject and provision one
  personal workspace/project on the first verified sign-in.
- [x] Add explicit account context, workspace creation, project listing and
  role-checked project creation APIs.
- [ ] Connect the selected email/social provider UI and credentialed callback.
- [x] Add workspace/project selection and creation to the home journey, persist
  the selection, target deck creation explicitly and scope repository actions to
  the selected workspace.
- [ ] Add atomic daily-credit and concurrent token/spend reservations.
- [ ] Move generation to durable jobs with story approval, progress and recovery.

### Workstream A — Authentication and tenancy

- Implement real email login and the selected social provider through one
  production session model.
- Add account creation, workspace selection, project creation/selection, invite,
  sign-out and session-expiry journeys.
- Require an explicit workspace/project context for scoped reads and writes;
  verify viewer/editor/admin boundaries across multiple memberships.

### Workstream B — Budget enforcement

- Add daily credits and atomic reservation/settlement for generation, contextual
  edits and retries.
- Enforce per-workspace concurrency and per-run token, request and wall-clock
  deadlines before provider work begins.
- Charge successful and failed paid calls consistently; release unused
  reservations; make retry policy and exhaustion fallback deterministic.

### Workstream C — Generation lifecycle

- Persist the story proposal and add approve/reject/revise API and UI states.
- Move generation to durable asynchronous jobs with idempotency keys, checkpoints,
  cancellation and restart-safe recovery.
- Stream progress from persisted events; reconnect from the last event ID after a
  tab, API or worker restart.
- Return the best coherent candidate with explicit unresolved issues when a hard
  deadline or revision budget is exhausted.

### Exit criteria

- A new user can sign in, create/select a workspace and project, start generation,
  approve the story, watch progress, interrupt/restart services and recover the run.
- Concurrent requests cannot exceed available credits or the configured run limit.
- Cross-workspace and lower-role attempts fail before job creation or spend.
- Failure-path, restart and PostgreSQL concurrency tests pass in CI.

## Phase 2 — Complete the authoring foundation and fonts

**Priority:** P1  
**Target:** 3–4 engineering weeks

### Execution status — started 2026-09-08

- [x] Add schema-valid, centered starter objects for text, shapes, lines, icons,
  charts, diagrams, tables and code through the existing transaction path.
- [x] Add undoable common geometry, rotation, opacity and naming controls plus
  first type-specific controls for text, shape, line, icon, chart, code and image.
- [ ] Complete rich content/data/style controls and connect asset-backed image
  insertion to the upload lifecycle.
- [ ] Finish nested transforms, constraints/collision solving, anchored endpoints
  and crop/mask authoring.
- [ ] Complete the versioned font manifest, deterministic loading and fallback UX.

Unfinished checklist items from each phase are retained here and will be rolled
into one consolidated remaining-gaps report after all phases have been executed.

### Editor deliverables

- Complete creation and property controls for every MVP element, including chart
  data/style, table, diagram, icon, code, line, image and text styling.
- Make move/resize/rotate and selection correct through nested transformed parents.
- Finish group-content semantics and connect deterministic constraints/collision
  solving to authoring, composition and validation.
- Implement anchored line endpoints and image crop/mask editing with undo/redo,
  autosave, copy/paste and export parity.
- Verify large-slide pointer performance at 50%, 100% and 200% zoom.

### Font deliverables

- Define a versioned font manifest with allowed sources, weights/styles, checksums
  and license metadata.
- Add editor/worker load barriers, timeout behavior, explicit fallback selection,
  missing-font replacement and actionable UI.
- Persist resolved/fallback information needed for deterministic resume and export.

### Exit criteria

- The manual-authoring journey builds a representative deck without editing JSON.
- Nested transforms, constraints, collisions, anchors and crops round-trip through
  save/reload and isolated undo.
- Editor, preview and worker resolve the same font/measurement manifest; delayed,
  missing and corrupt font cases have browser acceptance tests.

## Phase 3 — Raise AI quality and finish repository grounding

**Priority:** P1  
**Target:** 3–4 engineering weeks

### Execution status — started 2026-09-08

- [x] Emit a versioned deterministic critic report from the exact resolved scene
  used for headless output, including overflow, collisions, bounds, density,
  alignment, contrast/accessibility and font-fallback evidence.
- [x] Return the critic report beside rendered artifacts so preview and model
  review can share one measured source of truth.
- [ ] Feed rendered images and the worker report into the model critic after
  composition, with persisted evidence references on the run.
- [ ] Complete creative-token application, richer chart/data/style proposals and
  rendered before/after approval previews.
- [ ] Complete GitHub installation discovery, incremental indexing, retries and
  commit-level provenance acceptance.

### AI-quality deliverables

- Feed the Critic actual rendered previews and structured render signals for
  overflow, collision, contrast, density, alignment and legibility.
- Make Creative outputs affect the composed design through constrained,
  deterministic tokens rather than coordinates.
- Persist accepted layouts, rejected proposals and dismissed issues, and use them
  in later runs with inspectable provenance.
- Support chart data/style and richer visual edits with a rendered before/after
  approval preview and one-transaction adoption.
- Build a versioned evaluation corpus for structured validity, injection resistance,
  visual quality, grounding and fallback behavior.

### GitHub deliverables

- Complete GitHub App state/callback validation, installation resolution,
  repository discovery and selection.
- Queue incremental indexing from verified webhooks; add retry/backoff, progress,
  cancellation and stale/failed recovery.
- Pin chunks and slide citations to the indexed commit and retain commit-level
  provenance through candidate fallback and re-generation.

### Exit criteria

- A credentialed repository produces a grounded architecture deck whose claims
  link to the exact repository, commit, file and line range.
- A push incrementally refreshes only affected content and the UI moves through
  stale, indexing, current and failed/retry states.
- The agreed real-model corpus meets published validity, grounding, safety and
  quality thresholds; deterministic stub coverage remains green.

## Phase 4 — Finish motion, assets and theme resilience

**Priority:** P1  
**Target:** 2–3 engineering weeks

### Execution status — started 2026-09-08

- [x] Add explicit-workspace presigned uploads with MIME/size validation,
  completion-time object verification and signed downloads.
- [x] Add authenticated list, soft-delete and restore lifecycle endpoints plus
  retry-safe physical cleanup behavior.
- [x] Serialize storage quota completion against a workspace row and verify that
  concurrent PostgreSQL completions cannot overspend the allowance.
- [x] Preserve the resolved portable theme snapshot and theme identity inside
  checkpoint state and rebuild resumed composition from that frozen snapshot.
- [ ] Complete the browser asset library, generated-asset ingestion and
  production bucket lifecycle/versioning policies.
- [ ] Complete keyframe editing, timeline drag/zoom/group/split and ripple shift.

### Motion deliverables

- Add keyframe editing, timeline dragging, track grouping, zoom, split-at-playhead
  and ripple-shift.
- Preserve source clip identity through staggered/grouped timelines and maintain
  seek/play/reduced-motion parity.

### Asset and theme deliverables

- Implement upload, validation, quota reservation, listing, delete, restore and
  retryable physical-object cleanup.
- Protect every retained/undoable version and verify concurrent reference and
  quota changes against PostgreSQL and object storage.
- Retain the resolved theme snapshot through checkpoint resume and verify default
  theme races, rendering and export.

### Exit criteria

- A browser test authors and manipulates a multi-track animation using every
  required timeline operation, then saves/reloads with identical playback.
- A real MinIO/S3 lifecycle test proves upload, use, historical protection,
  restore and eventual byte deletion with accurate quota accounting.
- Interrupted generation resumes with the same portable theme snapshot.

## Phase 5 — Make exports durable and faithful

**Priority:** P1  
**Target:** 3–4 engineering weeks

### Execution status — started 2026-09-08

- [x] Convert export creation to a queued `202` contract with optional scoped
  idempotency keys and immutable presentation-version inputs.
- [x] Add PostgreSQL worker leases with `SKIP LOCKED`, bounded attempts/backoff,
  expired-lease recovery and an independently runnable worker loop.
- [x] Add cancel/retry APIs and editor polling with persisted stage/progress and
  reconnect-safe status reads.
- [x] Verify duplicate-request, cancellation, retry, crash recovery and parallel
  worker claim behavior.
- [ ] Persist fine-grained subprocess progress and interrupt an active renderer
  promptly when cancellation is requested.
- [ ] Move artifacts to object storage, add worker/cache limits and finish the
  remaining PDF/PPTX fidelity gaps.

### Deliverables

- Move exports to a durable queue with persisted stages, progress, retry,
  cancellation, idempotency and restart recovery.
- Add bounded worker leases, total render deadlines, tenant-authorized asset/font
  materialization and cache keys based on version plus export options.
- Finish PDF assets, notes/options and metadata behavior.
- Replace PPTX placeholder boxes with native editable content where practical and
  embedded visual fallbacks otherwise; report every degradation accurately.
- Define the export SLO, then measure 60-slide latency percentiles, throughput,
  memory and failure recovery under representative concurrency.

### Exit criteria

- API/worker restarts do not lose or duplicate an export; progress reconnects and
  cancel/retry are observable from the UI.
- Representative PDF and PPTX files pass independent readers and visual review in
  Acrobat/PowerPoint, with pre-download degradation reports matching the artifact.
- Load evidence satisfies the agreed worker concurrency, p95/p99 latency and RSS
  limits without cross-tenant asset access.

## Phase 6 — Complete the product experience

**Priority:** P1/P2  
**Target:** 2–3 engineering weeks

### Execution checklist

- [x] Add an in-editor accessibility review for missing visual descriptions,
  declared WCAG contrast pairs and the current slide's document reading order.
- [x] Make image, chart and diagram alternative text editable and navigable from
  the accessibility review.
- [x] Add a consistent keyboard focus indicator and reduced-motion CSS fallback.
- [x] Verify share token hashing, anonymous open, expiry, revocation, access
  isolation and view counting at the API boundary.
- [ ] Complete automated axe/browser checks plus manual keyboard, screen-reader
  and 200% zoom verification across every editor dialog and journey.
- [ ] Verify public sharing and revocation from an externally reachable browser.
- [ ] Finish onboarding/recovery empty states and production-shaped, privacy-safe
  product funnel metrics and dashboards.

### Deliverables

- Integrate accessibility checks into authoring: alt-text editing, composite
  contrast, reading order, keyboard-only operation, focus/dialog behavior,
  reduced motion and 200% zoom.
- Verify share creation, anonymous open/present, expiry and revocation in a public
  browser journey.
- Complete onboarding, empty states, repository/font recovery, interrupted-run
  recovery and crash/eviction journal recovery.
- Instrument the first-deck funnel, proposal acceptance/undo, export success,
  provenance inspection and retained-slide cohorts.

### Exit criteria

- The agreed WCAG 2.1 AA scope passes automated checks and a manual keyboard/screen-
  reader review.
- Public sharing and revocation work from an externally reachable environment.
- Product metrics are computed from production-shaped events and displayed in a
  deployed dashboard without prompt or customer-content leakage.

## Phase 7 — Production proof and MVP release gate

**Priority:** P0/P2  
**Target:** 2–3 engineering weeks plus observation time

### Execution checklist

- [x] Enable versioning for the asset bucket and enforce 35-day noncurrent
  version retention through idempotent storage initialization.
- [x] Add and run a timed scratch-restore rehearsal that verifies the Alembic
  head, complete database counts, presentation history replay and referenced
  object bytes while cleaning up its isolated sentinel.
- [x] Add the restore rehearsal to remote CI and retain its JSON evidence as a
  build artifact.
- [x] Bring the live local PostgreSQL database to the current migration head and
  verify the production web build plus PostgreSQL/MinIO health.
- [ ] Provision continuous WAL archiving/PITR in the release environment and
  demonstrate the five-minute RPO; a local full-dump rehearsal proves restore
  mechanics and RTO timing, not production PITR.
- [ ] Deploy collectors/dashboards/alerts, exercise representative load, run the
  real credentialed integrations and record the complete twelve-step journey.
- [ ] Publish the final requirement matrix and release decision after the remote
  CI and credential/environment gates have produced evidence.

### Deliverables

- Deploy API, web, workers, PostgreSQL/pgvector, Redis and object storage with
  capacity limits, alerts and runbooks.
- Deploy OpenTelemetry dashboards and an approved LLM tracer using correlated IDs
  and the existing allowlisted/redacted attribute policy.
- Configure WAL archiving, point-in-time recovery, object versioning and retention;
  rehearse a scratch restore including document history and referenced assets.
- Run remote CI, load/performance suites, the real-model/GitHub/embedding corpus and
  the complete twelve-step MVP demonstration.
- Update all requirement-by-requirement evidence and publish a release decision
  with accepted deferrals and owners.

### Exit criteria

- Restore evidence meets RPO ≤5 minutes and RTO ≤1 hour.
- Deployed dashboards show generation/export reliability, spend, saturation and
  product metrics with actionable alerts.
- The twelve-step MVP journey passes end to end in the release environment.
- No open P0 item; every accepted P1 deferral has an explicit user impact, owner
  and target release.

## Phase 8 — Critic, export and headless-render hardening

**Priority:** P1/P2  
**Target:** continuation of the original Phase 0–9 roadmap

### Execution checklist

- [x] Preserve render-derived critic signals and surface unresolved review issues
  before export.
- [x] Move export execution to durable, idempotent jobs with leases, recovery,
  retries, cancellation and observable UI progress.
- [x] Serialize access to each warm Chromium page with FIFO leases so concurrent
  jobs cannot close or rewrite another job's page.
- [x] Enforce one total deadline across queue wait, browser acquisition, text
  measurement, font/image settling and capture, destroying timed-out pages.
- [x] Verify lease ordering, queue-time exhaustion, timeout cleanup and existing
  real-browser scene/export behavior.
- [ ] Add tenant-authorized asset materialization and a verified font manifest at
  the worker boundary, then cache by version plus export options.
- [ ] Finish PDF notes/assets/metadata and PPTX native media/chart/table fidelity,
  followed by representative 60-slide p95/p99/RSS evidence.

## Dependency and parallelization map

| Lane | Can start after | Blocks |
| --- | --- | --- |
| Authentication/workspace journeys | Phase 0 | Production generation, GitHub, sharing and assets |
| Budget reservations and durable generation | Phase 0 schema baseline | AI acceptance and interrupted-run recovery |
| Editor and fonts | Phase 0 | Render critic, motion acceptance and export fidelity |
| GitHub connection/indexing | Auth workspace context | Credentialed grounding acceptance |
| AI critic/evaluation | Durable generation + renderer signals | Real-model quality gate |
| Motion authoring | Editor transaction foundation | Motion browser exit |
| Asset/theme lifecycle | Workspace context + durable storage jobs | PDF/PPTX fidelity and restore rehearsal |
| Durable exports | Job framework + fonts/assets | Export SLO and MVP demonstration |
| Accessibility/onboarding/metrics | Stable journeys | Production release gate |
| Operations/restore/deployment | Phase 0; evolves continuously | Final release |

The critical path is: **trusted gates → auth/workspace + durable job/spend
foundation → fonts/assets → exports → deployed restore/load/MVP proof**. Editor,
GitHub, AI quality and motion should run as parallel lanes once their stated
dependencies are available.

## Phase governance

For each phase, create a short execution issue per deliverable containing:

- requirement IDs and user journey;
- API/schema changes and migration/rollback plan;
- security, privacy, cost and failure-mode notes;
- automated and manual acceptance evidence;
- observability and support/runbook changes;
- explicit non-goals.

A phase review produces four artifacts: a green CI link, a demonstration record,
an updated requirement matrix, and a list of residual risks. A feature is not
marked complete when only its happy-path unit test passes.

## Credential and environment gates

The following can be implemented and tested locally but cannot receive final
acceptance without external configuration:

- email/social identity provider credentials and callback URLs;
- GitHub App credentials, webhook secret and an installation with test repos;
- real model and embedding provider credentials with spending caps;
- deployed OTLP collector, LLM tracer and dashboards;
- staging/production object storage, backup/WAL archive and public DNS/TLS;
- PowerPoint/Acrobat visual-review environment.

Provision these during Phase 1, not at the end of the project, so Phases 3, 5, 6
and 7 are not blocked waiting for credentials.
