# Deckastra — Phase 0–7 implementation audit

**Latest status:** [Phase 0–9 re-audit](PHASE_0_TO_9_REAUDIT.md) reviews the subsequent gap fixes and supersedes the current-status claims below. This file retains the original assessment as history.

**Follow-up:** [Phase 8–9 audit and browser text-measurement fix](PHASE_8_TO_9_IMPLEMENTATION_AUDIT.md) reviews the newer working tree. The figures below remain the original Phase 0–7 snapshot.

**Reviewed:** 2026-09-05–06, Asia/Calcutta. **Base commit:** `fd26e1c8fb3e8144de936200a8534eec6cbfc9bd`.

**Scope:** the supplied walking-skeleton delivery plan, Phases 0–7 only. This report evaluates the working tree after the requested element-validation fix. Initially the only local change reported by Git was untracked `.claude/`; it was left untouched. No source specifications, seed fixtures, visual baselines, or unrelated application behavior were changed.

## 1. How much is covered?

There is substantial implementation across all eight phases, but **“built through Phase 7” does not mean that the Phase 0–7 exit criteria are complete**. The deterministic libraries are considerably further along than the complete user journeys and operational controls.

Of the **65 requirement groups** below, **34 are complete (52.3%)**, **28 are partial**, **1 is missing**, and **2 remain unverified**. This is a conservative checklist coverage measure, **not a percentage of code written, effort spent, or time remaining**. Partial groups receive no completion credit. Several groups bundle multiple related behaviors; every behavior in a group must be covered for the group to count as complete. The tables below expose the denominator so this measure can be revisited without inventing a new percentage.

| Phase | Complete | Partial | Missing | Unverified | Fully covered |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 — Foundations | 6 | 1 | 0 | 0 | 6/7 — 85.7% |
| 1 — Walking skeleton | 4 | 1 | 0 | 1 | 4/6 — 66.7% |
| 2 — Core, transactions, persistence | 5 | 2 | 0 | 0 | 5/7 — 71.4% |
| 3 — Editor | 5 | 5 | 0 | 0 | 5/10 — 50.0% |
| 4 — Renderer and present mode | 2 | 5 | 0 | 0 | 2/7 — 28.6% |
| 5 — AI foundation | 4 | 10 | 1 | 0 | 4/15 — 26.7% |
| 6 — GitHub | 3 | 3 | 0 | 1 | 3/7 — 42.9% |
| 7 — Motion | 5 | 1 | 0 | 0 | 5/6 — 83.3% |
| **Total** | **34** | **28** | **1** | **2** | **34/65 — 52.3%** |

**Complete** means the named behavior has implementation and relevant passing tests or direct evidence. It is not a certification of every possible input. **Partial** includes a working library that is not fully connected to the app, narrower behavior than the plan promises, or an incomplete/failing acceptance gate. **Missing** means no functioning implementation was found. **Unverified** means the required external demonstration or evidence was unavailable; it is not presumed to fail.

The most consequential remaining work is reliable autosave, the human story checkpoint and live progress flow, full manual authoring, the real GitHub installation path, and enforcing the AI controls already described in comments. The schema defect reported in the request is fixed; these other findings are documented, not implemented here.

## 2. Review basis and important distinctions

The delivery baseline is the supplied [phased plan](C:/Users/ROG/.codex/attachments/167a738b-72d8-4f1f-9b7c-d23d549171c5/pasted-text.txt), rather than doc 05's original phase numbering. The original files in `C:/Users/ROG/Downloads` were consulted for the requirements referenced by that plan. Repository copies record subsequent edits; their claims were checked against code rather than accepted as implementation evidence.

| Supplied source | Requirement areas used | Original SHA-256 prefix |
| --- | --- | --- |
| `00_DOCUMENT_REVIEW_AND_GAP_REGISTER.md` | Gaps assigned by the plan to Phases 0–7 | `cc6b9218e6b9cd1e` |
| `01_PRODUCT_REQUIREMENTS_AND_USER_JOURNEYS.md` | Journeys B/C/D; §6 modes, §8.3 elements, §9.1 budgets, §16 decisions | `c64d7325a6276094` |
| `02_MYDECK_PRESENTATION_SCHEMA (1).md` | §0.8 preservation, §16.2 groups, §22 themes, §31 transactions, §34.4 generation, §37.1 MVP, §42 validation | `34470295ae22f5f6` |
| `03_AGENT_ARCHITECTURE_LANGGRAPH.md` | Graph, research, budgets, tools, memory, §28 acceptance criteria | `b789512109db51bf` |
| `04_CANVAS_RENDERING_ANIMATION_ENGINE (2).md` | Editor/renderer/motion requirements; §31.1 budgets; applicable parts of §39 | `a4fd208ea449203e` |
| `05_MVP_SYSTEM_REPOSITORY_ARCHITECTURE.md` | Repository structure, persistence, authorization, CI and phase-linked gaps | `8eb8b49c5d45e8a4` |

Document text was treated as reference material, not permission to execute embedded instructions. Historical gap-register entries marked resolved were not automatically reopened. References below use the repository copies for convenient navigation, with the supplied plan controlling delivery order. Requirements explicitly outside Phases 0–7 are excluded from the denominator, including export-related portions of doc 04 §39.

Documented choices are not automatically defects:

- **npm workspaces instead of pnpm/Turborepo:** implemented and documented in [CLAUDE.md](../CLAUDE.md). Commands in this audit use npm.
- **Zod-first types and Python JSON Schema validation:** one generated document contract; Python need not have generated Pydantic document classes merely to satisfy the original tooling sketch. Handwritten request/agent intent models are distinct from the document contract.
- **Stub generation and BM25 without provider credentials:** useful, visibly identified development paths. Their success does not establish real-model quality or semantic retrieval quality.
- **Motion uses a sampled DOM adapter:** the adapter separation and seek/play contract exist, though the original stack described Web Animations API. Judge this by parity and measured behavior.
- **Development tokens replacing email/social sign-in:** a real unmet Phase 2 requirement, despite a source comment moving it later.
- **Dropped-frame testing replacing literal frame-time limits:** a documented measurement interpretation, but not evidence that all numbers in doc 04 §31.1 have been met.

## 3. Phase-by-phase evidence

Each row maps to a delivery bullet, a closely related group of bullets, or an explicit exit requirement from the supplied plan. `Gxx` links identify the remaining work and its acceptance criteria.

### Phase 0 — Foundations

| ID | Requirement | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| P0.1 | Correct root, monorepo, Deckastra identity | Complete | [Root manifest](../package.json), workspaces under `D:/Presentation_app`; old name remains only as historical explanation. |
| P0.2 | MVP and deferred schema shapes, versions, downward generation | Complete | [Schema source](../packages/presentation-schema/src/index.ts), [emitter](../packages/presentation-schema/scripts/emit-json-schema.ts), [Python consumer](../apps/api/deckastra_api/schema.py); emit/drift and contract checks pass after the fix. |
| P0.3 | Three canonical seed decks | Complete | [Fixture generator](../packages/presentation-schema/scripts/build-fixtures.ts), committed technical/repository/animation fixtures; 5/2/3 slides respectively. All validate. |
| P0.4 | CI lint, typecheck, tests, round-trip and drift gates | Partial | [CI](../.github/workflows/ci.yml) runs typecheck/tests/build/drift/contracts; root lint delegates to nonexistent workspace lint scripts and CI does not run it. Rule-by-rule fixture coverage is incomplete. [G01](#g01--validation-and-evaluation-gates). |
| P0.5 | Compose PostgreSQL, Redis and MinIO | Complete | [Compose configuration](../infrastructure/docker/docker-compose.yml) defines all three and bucket initialization; PostgreSQL was available for this audit. Redis/MinIO runtime smoke was not performed. |
| P0.6 | Rename and PRD decisions/NFR reconciliation | Complete | [PRD](01_PRODUCT_REQUIREMENTS_AND_USER_JOURNEYS.md) §8.3 references the canonical element list; §9.1 has budgets; §16.1 closes Q3/Q4/Q6. |
| P0.7 | Seed validation in TS/Python and lossless unknown-property round-trip | Complete | Schema tests and `scripts/validate_fixtures.py` pass, including new negative known-element and positive future-element cases. |

### Phase 1 — Walking skeleton

| ID | Requirement | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| P1.1 | Document → intermediate scene → React/SVG, theme and layer boundaries | Complete | [Scene pipeline](../packages/renderer/src/scene.ts), [SlideView](../packages/renderer/src/react/SlideView.tsx); renderer scene/render/container tests pass. |
| P1.2 | Keyboard navigation, fullscreen, cut/fade presentation | Complete | [PresentMode](../apps/web/components/PresentMode.tsx), [transitions](../packages/renderer/src/transitions.ts); present synchronization and transition tests pass. |
| P1.3 | Single-shot request/story/composition/validation with one model retry | Complete | [Story service](../apps/api/deckastra_api/story.py), [composer](../apps/api/deckastra_api/compose.py), generation tests. Retry is at the intent-plan boundary; deterministic invalid composition is reported as a bug. |
| P1.4 | Prompt box → busy state → rendered deck/present | Complete | [Home page](../apps/web/app/page.tsx), [generation route](../apps/api/deckastra_api/main.py), passing generation tests and local browser editor flow. |
| P1.5 | Record observed first-attempt schema validity | Partial | Diagnostic fields exist in [models](../apps/api/deckastra_api/models.py) and the single-shot chain. No real-model sample/rate was established; graph diagnostics default validity flags rather than aggregating retry outcomes. [G02](#g02--honest-generation-measurements). |
| P1.6 | Share a working URL demonstrating a real generated deck | Unverified | Local stub-backed servers work; no external deployment/demo or credentialed real-model demonstration was verified. [G24](#g24--external-acceptance-evidence). |

### Phase 2 — Core, transactions and versioning

| ID | Requirement | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| P2.1 | Pure slide/element operations and reference checks | Complete | [Core operations](../packages/presentation-core/src/operations.ts), reference utilities; 40 core tests pass. Operations emit patches. |
| P2.2 | Id paths, atomic apply, pre-state inverses, undo/redo/grouping | Complete | [Applier](../packages/transactions/src/apply.ts), [history](../packages/transactions/src/history.ts); 61 transaction tests pass. |
| P2.3 | Snapshot plus operation log, periodic/agent snapshots | Complete | [Store](../apps/api/deckastra_api/store.py); replay, history and persistence tests pass. |
| P2.4 | Membership, project ownership chain, version/transaction lineage tables | Complete | [DB models](../apps/api/deckastra_api/db/models.py), migrations, [authorization](../apps/api/deckastra_api/auth.py); migration and PostgreSQL persistence checks pass. |
| P2.5 | Email/social authentication plus authorization | Partial | Membership/role authorization exists; only signed development tokens and `/v1/dev/session` establish identity. [G03](#g03--actual-authentication). |
| P2.6 | Optimistic autosave, batching, acknowledgements and retry | Partial | [useEditor](../apps/web/lib/useEditor.ts) batches operations and sends expected version, but clears batches before acknowledgement and does not restore failures. [G04](#g04--autosave-can-lose-unsaved-operations). |
| P2.7 | Inverse property test, insertion-safe id resolution, 20-slide round-trip | Complete | [Transaction tests](../packages/transactions/tests/apply.test.ts) include 400 generated patches, earlier insertion, and a 20-slide round-trip; Python/TS patch conformance passes. |

### Phase 3 — Editor

| ID | Requirement | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| P3.1 | Selection, group click/enter/exit, indexed hit testing | Complete | [Selection](../packages/editor/src/selection.ts), [spatial index](../packages/editor/src/spatial-index.ts), [canvas](../apps/web/components/EditorCanvas.tsx); library tests and real drag flow pass. |
| P3.2 | Move/resize/rotate including both group resize modes | Partial | Rotation helpers and `resizeGroup` exist/test, but canvas commits only selected transforms and does not call the group resize helper. [G06](#g06--group-resize-and-distribution-are-not-fully-wired). |
| P3.3 | Zoom-independent snapping and distribution guides | Partial | Edge/grid snapping is wired; `findEqualSpacing` is only referenced by unit tests. [G06](#g06--group-resize-and-distribution-are-not-fully-wired). |
| P3.4 | Clipboard, keyboard shortcuts and layers panel | Complete | [Editor helpers](../packages/editor/src/index.ts), [EditorShell](../apps/web/components/EditorShell.tsx); clipboard/keyboard/layer operations have passing tests. |
| P3.5 | In-place rich text, IME, sanitized paste, four fit modes/0.25px sizing | Complete | [TextEditor](../apps/web/components/TextEditor.tsx), text-editing tests, [text metrics](../packages/renderer/src/text-metrics.ts), DOM measurer and tests. Full formatting/inspector breadth is tracked separately in P3.9. |
| P3.6 | Group container layouts and cached text measurement | Complete | [Container resolver](../packages/layout-engine/src/container.ts), scene `layoutChildren`, shared [browser measurer](../apps/web/lib/measurer.ts). Container sizing currently takes child transform dimensions, not a content-growth feedback loop. |
| P3.7 | Collision and align/distance/anchor/containment constraint handling | Partial | [Constraint solver](../packages/layout-engine/src/constraints.ts) and [layout validation](../packages/layout-engine/src/validate.ts) pass library tests; app/renderer do not call these entry points. [G07](#g07--constraint-and-collision-integration). |
| P3.8 | Editor state excluded from canonical document | Complete | State is held in hooks; [editor tests](../packages/editor/tests/editor.test.ts) assert exclusion from saved data. |
| P3.9 | Journey D: zero-AI complete deck and hand-rebuilt animation fixture | Partial | Toolbar inserts text/rectangle/ellipse; inspector geometry is read-only. Rebuild test is programmatic and explicitly omits timelines even after Phase 7. [G05](#g05--complete-manual-authoring-is-not-available). |
| P3.10 | 120-object drag acceptance/performance criterion | Partial | Browser test passes dropped-frame threshold: 16.8ms p95, 0.8% dropped. Literal `<16ms p95` is not demonstrated; resize/p99 coverage is incomplete. [G11](#g11--performance-coverage-and-dashboard). |

### Phase 4 — Renderer depth and presentation

| ID | Requirement | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| P4.1 | Full theme model/token resolution and brand checks | Complete | [Theme schema](../packages/presentation-schema/src/theme.ts), [theme resolution](../packages/renderer/src/theme.ts), [semantic checks](../packages/renderer/src/semantic.ts); theme/visual/semantic tests pass. |
| P4.2 | Every MVP type renders correctly, deterministic charts/diagrams | Partial | Charts, diagrams, tables, code and icons have real implementations/tests. Anchored line endpoints are not resolved; image crop/mask data is not consumed by the image payload. [G08](#g08--mvp-rendering-still-has-semantic-gaps). |
| P4.3 | Curated fonts, loading protocol, matched fallback, availability input | Partial | [Font registry](../packages/renderer/src/fonts.ts) and digest/fallback metadata exist, but no application font-loading barrier or loading-triggered measurement invalidation was found. [G09](#g09--font-loading-protocol). |
| P4.4 | Presenter view, notes, timer and transitions | Complete | [PresenterView](../apps/web/components/PresenterView.tsx), PresentMode, BroadcastChannel synchronization; synchronization/transition tests pass. |
| P4.5 | Visual regression harness gating merges | Partial | Scene baselines pass. Windows pixel baseline fails; CI uses Linux, which has no committed pixel baseline and skips historical comparison. [G10](#g10--visual-regression-gates-are-not-green). |
| P4.6 | All fixture slides byte-identical at 2× after reload | Partial | Same-page repeat test covers first slide of each fixture; reload test covers only technical slide 2. Both pass, but full ten-slide reload coverage is absent. [G10](#g10--visual-regression-gates-are-not-green). |
| P4.7 | Every doc 04 §31.1 budget instrumented as a dashboard line | Partial | [Performance module](../packages/renderer/src/perf.ts) has budgets and timers, with a last-drag readout; it explicitly says no telemetry reporting yet. Memory budget is absent. [G11](#g11--performance-coverage-and-dashboard). |

### Phase 5 — AI foundation

| ID | Requirement | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| P5.1 | LangGraph stages, typed contracts, revision routing | Complete | [Graph](../agents/deckastra_agents/graph.py), [contracts](../agents/deckastra_agents/contracts.py), typed state and node tests. Motion is integrated into routing. |
| P5.2 | Per-agent prompt contracts and evaluation fixtures | Partial | Structured output validation and mock/stub tests exist; only one standalone prompt file and no repeatable real-model quality/grounding benchmark were found. [G01](#g01--validation-and-evaluation-gates), [G24](#g24--external-acceptance-evidence). |
| P5.3 | Tool permissions, tracing, retries, input/output validation and timeouts | Partial | [Registry](../agents/deckastra_agents/tools/registry.py) enforces schemas/permissions and records retries; timeout is checked after a synchronous handler returns. [G14](#g14--budgets-and-timeouts-are-incomplete). |
| P5.4 | Durable PostgreSQL story checkpoint and human resume flow | Partial | Pause/reject tests pass; two resume tests fail from an outdated test composer signature. Normal generation disables checkpoints and no story-approval HTTP/UI path was found. [G12](#g12--human-checkpoint-is-not-a-working-product-flow). |
| P5.5 | Redis progress and SSE event contract in the UI | Partial | [Events](../agents/deckastra_agents/events.py) and [SSE endpoint](../apps/api/deckastra_api/agent_routes.py) exist. Generation returns the run id only after synchronous completion; home page never subscribes. [G13](#g13--live-progress-does-not-reach-the-generation-ui). |
| P5.6 | Proposal status, 24h expiry, approve/reject/revalidate, server risk | Complete | [Proposal service](../apps/api/deckastra_api/proposals.py), routes/risk module and passing lifecycle tests. User-facing rendered preview is assessed in P5.14. |
| P5.7 | Revision/token/run ceilings and degrade-and-warn behavior | Partial | [RunBudget](../agents/deckastra_agents/budgets.py) has 2/slide and 3/run revision limits plus token/time checks. Hard exhaustion can end generation with an error rather than return the best usable draft. [G14](#g14--budgets-and-timeouts-are-incomplete). |
| P5.8 | Enforced per-workspace daily credit ceiling | Missing | `daily_credit = 200` is a declaration only; repository search found no charging, reservation or pre-run enforcement. [G14](#g14--budgets-and-timeouts-are-incomplete). |
| P5.9 | Untrusted-content envelope enforced at registry boundary | Partial | Envelope escaping and current caller wrapping are tested. `returns_untrusted_content` does not trigger automatic wrapping in `_invoke`; callers must remember it. [G15](#g15--untrusted-tool-content-still-relies-on-callers). |
| P5.10 | Explicit edit scope including sources | Complete | [Agent state](../agents/deckastra_agents/state.py) declares sources scope; request/scope handling has tests. This establishes the scope contract, not a complete sources-editing UI. |
| P5.11 | Persistent accepted-layout/rejection/dismissal memory | Partial | [Memory](../agents/deckastra_agents/memory.py), SQL store and rejection recording exist; accepted-layout and dismissed-issue writers are only called by tests. [G16](#g16--memory-feedback-loop-is-incomplete). |
| P5.12 | Highest-scoring fallback, attached unresolved slide issues | Partial | Revision limits force acceptance, but `best_result` is unused and no candidate snapshots are retained. Unresolved issues remain in graph state rather than visible slide metadata. [G17](#g17--critic-fallback-and-creative-output-are-not-fully-applied). |
| P5.13 | Internal model-provider routing interface | Complete | [Router](../agents/deckastra_agents/router.py), stub and configured provider client; agent tests exercise replacement without document-schema changes. |
| P5.14 | Journey C: selected chart edit → preview → approve → isolated undo | Superseded | Plan 09 removed the built-in prompt/edit agent. Connected agents submit operations to the proposal boundary; proposal preview, approval and isolated revert remain. |
| P5.15 | Close graph naming/streaming/checkpoint documentation gaps | Partial | Code resolves several decisions, but [doc 03](03_AGENT_ARCHITECTURE_LANGGRAPH.md) still shows Source Analysis/User Context and older scope wording. Gap-register status is stale. [G19](#g19--documentation-status-needs-reconciliation). |

### Phase 6 — GitHub

| ID | Requirement | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| P6.1 | GitHub App installation, short-lived tokens, connected repositories | Partial | JWT/token adapter, installation storage and callback exist. Browser callback authentication, repository discovery/wiring and the id used for installation tokens are incomplete. [G20](#g20--real-github-connection-is-not-complete). |
| P6.2 | Tree → ignores → ranking/docs/frameworks → chunks; no repo execution | Complete | [Source adapters](../integrations/deckastra_integrations/sources.py), ignore/ranking helpers, [indexer](../apps/api/deckastra_api/indexing.py); local ingestion tests pass and read source bytes without executing repository code. |
| P6.3 | pgvector storage, file/line provenance and retrieval | Complete | RepositoryChunk metadata and PostgreSQL vector/HNSW migration exist; [retrieval](../apps/api/deckastra_api/retrieval.py) has vector and labelled lexical paths. Migration tests pass. Live provider embedding quality was not evaluated. |
| P6.4 | Webhooks, staleness, incremental re-index and access removal | Partial | Push marks head stale; removals delete chunks. Incremental `changed_paths` exists at service level but the webhook does not enqueue it and the UI reindex route does a full pass. [G21](#g21--webhooks-do-not-drive-incremental-refresh). |
| P6.5 | Repository size/read/index quotas | Complete | File-size/count limits and ranked read budget in ignore/index modules; quota warning/filter tests pass. This is repository ingestion limiting, not workspace AI credit enforcement. |
| P6.6 | Repository context and inspectable per-slide provenance | Partial | Context, persisted records, source endpoint and SourcesPanel work for tested local sources. Multi-repository hits lose repository identity and research labels them with the first repository. [G22](#g22--multi-repository-citations-can-name-the-wrong-repository). |
| P6.7 | Real repository → grounded eight-slide architecture deck → inspect sources | Unverified | Local-source/stub grounding passes; real GitHub App and real-model eight-slide demonstration were not performed. [G24](#g24--external-acceptance-evidence). |

### Phase 7 — Motion

| ID | Requirement | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| P7.1 | Presets, timeline compiler, playback and group master clock | Complete | [Animation engine](../packages/animation-engine/src/index.ts), five suites/102 passing tests including grouped sequencing. |
| P7.2 | Per-preset reduced-motion fallback and resolution order | Complete | [Preset registry](../packages/animation-engine/src/presets.ts), compile tests and fixture coverage. |
| P7.3 | Motion/timeline UI with transaction-based edits | Partial | [MotionPanel](../apps/web/components/MotionPanel.tsx) supports presets, duration, easing, triggers, delete and scrubbing; delay/start editing, drag/reorder and keyframe authoring remain absent. [G23](#g23--motion-authoring-and-browser-verification). |
| P7.4 | Motion Agent semantic sequencing and restrained defaults | Complete | [Motion node](../agents/deckastra_agents/nodes/motion.py), [deterministic composer](../apps/api/deckastra_api/motion.py); roles/pacing stay separate from generated milliseconds. Agent/API motion tests pass. |
| P7.5 | Per-slide entrance budget enforcement | Complete | `_fit_to_budget` includes per-step fan-out, scales/drops to fit and warns; API motion and schema W132 tests pass. |
| P7.6 | Seek/play parity and transactional model edits | Complete | [Playback tests](../packages/animation-engine/tests/playback.test.ts) cover every millisecond of a representative timeline, backward seeking and segments; timeline tests check patch operations. Browser-level motion interaction coverage remains a separate verification limitation. |

## 4. What is not up to the mark, and how to finish it

Priorities: **P1** = data-loss risk, broken required journey or ineffective operational boundary; **P2** = missing planned behavior or acceptance evidence. These are engineering priorities, not a claim that every item requires the same effort.

### G01 — Validation and evaluation gates

**P2; P0.4/P5.2.** Lint is currently a no-op. Existing schema fixtures and 22 validation tests are useful but do not establish the plan's standing valid/invalid coverage for every applicable doc 02 §42 rule. Agent tests predominantly check stubs/contracts; they do not establish real-model quality. **Remaining:** implement actual lint scripts/CI gate, map rule codes to positive/negative fixtures, and version agent evaluation inputs and expected outcomes. **Accept when:** a deliberate lint violation fails CI; the coverage map identifies every applicable rule and justified deferral; fixed evaluation inputs produce recorded scores/failures, with stub and model runs distinguished.

### G02 — Honest generation measurements

**P2; P1.5.** `GenerationDiagnostics` defaults first-attempt flags to true; the graph route does not compute the observed first-attempt rate from its retries. A green response is not the requested experiment. **Remaining:** record per-stage attempts and document validity independently, then run a fixed prompt sample against the configured model. **Accept when:** an intentionally failed first response followed by a successful retry is reported as such, and a reproducible sample size, model/version, validity numerator/denominator and quality observations are recorded.

### G03 — Actual authentication

**P1; P2.5.** Authorization tables/checks exist, but [auth.py](../apps/api/deckastra_api/auth.py) authenticates only development tokens. Production disables the bootstrap endpoint without supplying the planned replacement. **Remaining:** connect email/social identity to the existing membership chain and session lifecycle. **Accept when:** real signup/login/logout and invalid/expired-session cases work, with viewer/editor and cross-workspace authorization tests passing.

### G04 — Autosave can lose unsaved operations

**P1; P2.6.** `useEditor.flush` sets `pending.current` to empty before sending. Network failure, non-2xx or 409 never restores that batch; the visible Retry button calls `flush` on an empty queue. Another flush can also run while the first is in flight. `adoptDocument` replaces the local document without reconciling pending edits. Unload uses ordinary asynchronous fetch. **Remaining:** retain batches through acknowledgement, serialize writes, make retries safe against ambiguous responses, preserve/reconcile local edits before adopting server documents, and handle close/reload explicitly. **Accept when:** offline→retry persists every edit once; edits during a slow save remain queued; 409 retains recoverable work; an AI approval cannot erase pending manual edits; reload does not silently discard acknowledged or recoverable edits.

### G05 — Complete manual authoring is not available

**P1; P3.9.** The toolbar adds only text, rectangle and ellipse. The Object panel displays geometry instead of editing it. There are no complete insertion/content-editing paths for the remaining MVP element types or a blank-deck journey in the home page. The “rebuild by hand” test creates elements programmatically and asserts animations are absent. **Remaining:** expose blank creation, MVP element insertion and meaningful content/style controls, then rebuild the animation fixture through actual UI operations. **Accept when:** a user starting with a blank deck can reproduce its static content and motion without AI, JSON editing or fixture copying, save/reload it, and undo edits.

### G06 — Group resize and distribution are not fully wired

**P2; P3.2/P3.3.** `resizeGroup` and `findEqualSpacing` are tested helpers but have no canvas call sites. The pointer-up path patches transforms only, so the helper's scale-children/font behavior is not applied. **Remaining:** route group resizing through the chosen resize mode and connect equal-spacing detection/rendering to drag. **Accept when:** nested/rotated groups behave correctly under both modes, scaling updates the intended children/fonts atomically, and equal gaps visibly snap at different zoom levels with undo restoring pre-state.

### G07 — Constraint and collision integration

**P2; P3.7.** `resolveConstraints` and `validateLayout` appear in definitions/tests but not app/scene call sites. Passing solver tests does not mean constrained documents render with solved geometry. **Remaining:** integrate the deterministic solver/collision pass into scene/editor flow, surface cycle/overlap findings, and feed relevant measured sizes into layout. **Accept when:** changing an anchored/contained object's reference visibly updates its layout and a real cyclic document displays a diagnostic without hanging or silently ignoring constraints.

### G08 — MVP rendering still has semantic gaps

**P1; P4.2; doc 02 §37.1.** A schema-valid anchored `line.from/to` contains `elementId`/`anchor`, not `x/y`. The renderer currently falls back to box corners instead of resolving the anchors. The image scene payload handles asset/fit/focal point but does not propagate declared crop/mask geometry. **Remaining:** resolve connector anchors/routing from the element index and implement supported image crop/mask semantics. **Accept when:** moving an anchor target updates the connector correctly, including groups/rotation, and crop/mask fixture screenshots match the document and survive reload. These are separate from the malformed-line validation bug fixed here.

### G09 — Font loading protocol

**P2; P4.3.** Registry/fallback metadata exists, but no production-app `FontFace` loading/wait/timeout protocol or cache invalidation on loaded faces was found. The pixel test waits for fonts; the application does not establish the equivalent barrier. **Remaining:** define and load the curated assets, synchronize measurement with availability, invalidate stale metrics and display fallback status. **Accept when:** cold-load, delayed-load and unavailable-font fixtures stabilize reproducibly without stale wrapping, and all determinism inputs reflect actual available faces.

### G10 — Visual regression gates are not green

**P1; P4.5/P4.6.** The committed Windows baseline has nine slide keys; current fixtures have ten. `animation/1` now differs and `animation/2` is missing. The Linux CI job has no Linux baseline; its comparison test returns successfully when the baseline is absent. Repeat/reload tests cover only a subset. **Remaining:** visually review the fixture change, deliberately record an approved baseline on the pinned CI/browser platform, fail on absent required baselines, and extend reload parity to all ten slides. **Accept when:** all fixture keys match approved images and a deliberate rendering-only change fails CI. Baselines were not regenerated in this audit.

### G11 — Performance coverage and dashboard

**P2; P3.10/P4.7.** Scene-build timings are not first-paint timings. Only the last drag is surfaced; warm/cold switching, heavy first paint, timeline scrubbing, 60-slide thumbnails and tab RSS are not dashboarded. `BUDGETS` omits the 600MB memory limit. The browser drag test judges dropped-frame share and does not establish literal p95/p99 limits. **Remaining:** instrument actual browser events for every applicable §31.1 budget, add the memory budget, virtualize/measure the 60-slide case, and explicitly reconcile cadence-based acceptance with the written spec. **Accept when:** every budget has a populated, reproducible measurement and alert/failure threshold; resize and scrub receive browser tests as well as drag.

### G12 — Human checkpoint is not a working product flow

**P1; P5.4.** `run_deck_generation` defaults `human_checkpoint=False`; the regular route never enables it. `resume` is a service function without a corresponding story-approval UI/route. PostgreSQL tests expose an existing two-argument test `compose` function after `propose` changed to three arguments for Motion. This is a test-fixture incompatibility, not proof that PostgreSQL persistence itself is broken. **Remaining:** update the test adapter and complete durable start/pause/approve/reject/resume HTTP/UI integration. **Accept when:** generation stops with a reviewable story, survives process restart, resumes the same run on approval, rejects without composition, and both currently failing PostgreSQL tests pass.

### G13 — Live progress does not reach the generation UI

**P1; P5.5.** `/v1/generate` runs synchronously; its run id arrives after completion and the row is committed with the response. The home page has a busy label, not an SSE subscription. Redis pub/sub has no replay for late subscribers; subscribing after completion can wait indefinitely. Event fields are snake_case (`agent_id`, `artifact_refs`), whereas the supplied plan names camelCase fields. **Remaining:** expose a committed run identifier before work starts, subscribe while running, deliver terminal/reconnect state, and document the chosen wire format. **Accept when:** stage events are visible during generation and late/reconnecting clients receive a terminal result without hanging.

### G14 — Budgets and timeouts are incomplete

**P1; P5.3/P5.7/P5.8.** Daily credit has no enforcement. Registry timeout is an elapsed-time check after `handler(payload)` returns, so a stuck handler can block indefinitely. Hard token/time exhaustion can abort without delivering an already usable draft. **Remaining:** reserve/charge workspace credits atomically across concurrent runs, apply real bounded tool execution/I/O deadlines, and preserve usable artifacts on exhaustion with explicit warnings. **Accept when:** concurrent runs cannot exceed the daily limit; a never-returning tool terminates within the configured deadline; revision/token/time exhaustion yields the documented failure or degraded artifact without claiming successful completion.

### G15 — Untrusted tool content still relies on callers

**P1; P5.9.** Tools declare `returns_untrusted_content`, but `_invoke` returns raw validated results and never acts on that flag. Current Research/Edit nodes call `untrusted` explicitly. This falls short of the plan's structural guarantee that a future caller cannot forget wrapping. **Remaining:** enforce labelled untrusted-content handling at the registry/prompt boundary for every flagged result, retaining delimiters and source metadata. **Accept when:** a newly registered untrusted tool is safely handled without node-specific wrapping, including a delimiter-breaking README fixture; real-model injection evaluations remain separately recorded rather than inferred from stub tests.

### G16 — Memory feedback loop is incomplete

**P2; P5.11.** Persistent memory and rejection feedback work. `record_accepted_layout` and `record_dismissed_issue` have no production call sites, so users cannot populate two of the three promised feedback types. **Remaining:** connect kept layouts and issue dismissals to persisted project decisions and show issue dismissal controls. **Accept when:** actions survive reload and influence the next run in that project, while another project remains unaffected.

### G17 — Critic fallback and creative output are not fully applied

**P1; P5.12.** `best_result` chooses a review but is unused; state stores review history, not candidate draft snapshots. `propose` composes the latest story regardless of earlier scores. `unresolved_issues` is returned in graph state but is not attached to document slides or displayed by the editor. The API `_composer` also accepts `direction` without using it. **Remaining:** retain and select the highest-scoring complete candidate, apply approved creative tokens, map unresolved issues onto final slide ids and surface them. **Accept when:** a lower-scoring last revision cannot replace a better earlier draft, the resulting deck carries visible unresolved issues, and changing creative direction changes intended output without agent-generated geometry.

### G18 — Contextual editing was superseded by the agent-first plan

**Closed by plan 09.** The built-in Ask/edit contract and route were removed. Connected agents author id-addressed operations through the proposal boundary; Deckastra retains rendered proposal previews, approval/rejection, version checks, and isolated revert.

### G19 — Documentation status needs reconciliation

**P2; P5.15.** The gap register still presents Phase 2 updates as the latest status. Doc 03 retains old graph labels/scope details; comments claim invariants such as automatic registry wrapping and best-draft preservation that the code does not enforce. **Remaining:** update the affected repo documentation after closing or explicitly deferring these items; keep canonical types referenced rather than redefined. **Accept when:** documents, tests and exposed behavior agree on graph stages, scope, SSE fields, checkpoints, memory and fallback. Supplied originals should remain historical inputs.

### G20 — Real GitHub connection is not complete

**P1; P6.1.** The installation link navigates to GitHub; its callback requires a bearer header, but a normal browser redirect does not attach the app's local token. The callback records an installation but does not enumerate/connect its repositories; `connect_github` has no route call site and installation-created webhooks do not populate repositories. `source_for` passes the internal `repository.installation_id` foreign key to GitHubClient instead of looking up the external numeric GitHub installation id. **Remaining:** complete authenticated callback/state handling, repository discovery/selection, installation-event synchronization and external-id resolution. **Accept when:** an actual App install leads to selectable repositories and a successful read using a short-lived installation token, including removal/revocation tests.

### G21 — Webhooks do not drive incremental refresh

**P2; P6.4.** Push updates `head_sha` but does not schedule indexing. The indexer supports `changed_paths`, yet the exposed reindex route calls it without them; unchanged files are consequently not reused through that incremental path. **Remaining:** connect verified push changes to a bounded incremental job, account for deleted/renamed paths, and preserve honest staleness/error states through retries. **Accept when:** changing one file refreshes only relevant chunks, deleted files disappear, and freshness changes only after successful completion.

### G22 — Multi-repository citations can name the wrong repository

**P1; P6.6.** `RetrievedChunk` has path and line range but no repository identity. Research builds each `source_id` from `names[0]`, and deduplicates on path/line reference alone. A hit from repository B can therefore be cited as repository A or merged with an identically named file. **Remaining:** carry repository identity and indexed commit through retrieval, deduplication and document provenance. **Accept when:** a two-repository fixture with the same file names produces distinct, correctly scoped citations and every source link resolves to the evidence used.

### G23 — Motion authoring and browser verification

**P2; P7.3.** MotionPanel performs useful transactional edits but explicitly has no timeline drag; no manual start/delay or keyframe editor exists. Most parity tests exercise the pure engine, not DOM interaction. **Remaining:** complete manual timing/keyframe controls and a focused browser flow for animate→scrub→edit→undo→reload→present, including reduced motion. **Accept when:** users can reproduce the fixture's timings through the UI and playback agrees with seeking in the rendered slide without losing base transforms or pending edits.

### G24 — External acceptance evidence

**P2; P1.6/P5.2/P6.7.** Runtime health identified local generation as `stub`; provider-backed generation, embedding quality, a real GitHub installation and an externally reachable demo were not validated. **Remaining:** execute the phase exit demonstrations with configured credentials and capture model/repository/commit, prompts, outcomes and limitations. **Accept when:** the real generation and grounded eight-slide journeys can be reproduced and inspected, including source correctness; do not substitute an internal helper test for this evidence.

## 5. Requested schema defect — fixed

Before this change, replacing the second animation slide's line `from`/`to` with `start`/`end` produced `safeParse.success = true`, `valid = true`, no errors and no warnings in TypeScript; the generated Python validator accepted it too. This was reproduced during planning.

The implementation now:

- Derives the fallback exclusion list from own keys of `ELEMENT_SCHEMA_BY_TYPE`, after registry initialization. Recursive group/slot getters remain lazy, avoiding an initialization cycle.
- Excludes known types with an **aborting** refinement. Aborting matters: otherwise Zod can select the fallback's continuable refinement issue instead of returning the union failure needed for field-error expansion.
- Emits the identical exclusion as `type: string` plus `not: { enum: [...] }` from metadata using the same list. There is no handwritten Python list or accepted TS/Python asymmetry for this constraint.
- Expands known-member errors recursively through groups/component slots, uses an own-property lookup for registry keys, and names missing fields in `E002` messages with their full structural paths.
- Preserves unknown fields/types/descriptive enum values, `W240`/`W241`, and canonical serialization.
- Retains the renderer's labelled placeholder for unchecked/historical malformed line objects; only its explanatory comment changed.

Regression coverage: [known-element tests](../packages/presentation-schema/tests/known-element-validation.test.ts), [forward compatibility](../packages/presentation-schema/tests/forward-compat.test.ts), [API schema test](../apps/api/tests/test_schema.py), and [cross-language fixture checks](../scripts/validate_fixtures.py). Valid known fixtures still pass. Every known registry type is rejected by the fallback directly, including deferred types. No public schema shape or version changed; formerly accepted malformed known elements are now rejected.

## 6. Verification performed

Commands ran against the audited working tree unless stated otherwise. No visual baselines were updated. The first schema test run caught the need for an aborting refinement; that was corrected and the full npm suite then rerun successfully.

| Check | Result | What it establishes / limitation |
| --- | --- | --- |
| `npm run schema:emit` | Pass | Generated all five artifacts; only document schema changed semantically. |
| `npm run schema:drift` | Pass | All five generated artifacts match the source. |
| `npm test` | **717 passed, 1 skipped** | Animation 102; editor 104; layout 46; core 40; schema 100; renderer 148; transactions 61; web 16. Renderer contact-sheet preview is opt-in/skipped. Pixels and browser E2E are separate commands. |
| `python scripts/validate_fixtures.py` | Pass | Three seed fixtures, six existing negative cases, malformed-known rejection and future-element/enum preservation. |
| `npm run typecheck` | Pass | All eight workspaces. |
| `python -m pytest apps/api agents integrations -q -ra` | **280 passed, 9 skipped** | Default SQLite/stub run. Nine skips require PostgreSQL. One LangChain pending-deprecation warning. |
| `POSTGRES_TEST_URL=<local compose DB> python -m pytest apps/api -q -ra` | **162 passed, 2 failed** | Includes real PostgreSQL/migrations/checkpoints, with test-created private databases. Failures are the stale test composer signature in G12. No PostgreSQL skips in this run. |
| `PIXELS=1 npm run test:pixels --workspace @deckastra/renderer` | **3 passed, 1 failed** | Repeat/reload/negative-control tests pass. Committed Windows baseline mismatch described in G10. |
| `E2E=1 npm run test:e2e --workspace @deckastra/web` | **1 passed** | Existing local web/API servers, stub mode/PostgreSQL. Test creates its own measurement deck; 16.8ms p95 over 127 frames, approximately 60Hz, 0.8% dropped. This test creates test data in the local development database. |
| `git diff --check` | Pass | No whitespace errors in the changes. |

The first pixel attempt could not start because Playwright's matching Chromium was missing. `npx playwright install chromium` installed it, and the rerun produced the substantive 3-pass/1-fail result above. This environment issue is resolved, not counted as a product defect.

**Why the two broader failures are pre-existing:** the checkpoint test and agent composer files match the base commit; their two-vs-three-argument mismatch does not involve the changed schema. `git show HEAD` confirms the pixel baseline already had nine keys while the committed fixtures had ten slides. Renderer behavior and fixture/baseline data were unchanged by this fix. The only renderer edit was the guard's explanatory comment.

**Not established by these runs:** production web build/deployment, a public demo URL, live-model quality/first-attempt rate, real GitHub installation, provider embedding quality, Redis live/reconnect delivery, MinIO runtime health, all-slide reload parity, complete manual-authoring and browser-motion journeys, or all §31.1 performance budgets. A configured CI job is not evidence that its latest remote run passed. The Python JSON Schema consumer also does not implement all TypeScript semantic validation rules; this fix establishes parity for the known/future element boundary specifically.

## 7. Prioritized remaining-work checklist

- [ ] **Protect work first:** fix autosave retry/concurrency and reconcile pending edits with agent results (G04).
- [ ] **Repair existing gates:** fix checkpoint test adapter, review stale pixel images and establish a mandatory CI baseline (G10/G12); add effective lint/rule coverage (G01).
- [ ] **Make the AI journey real:** expose story approval/resume and live progress, then chart edits with rendered proposal preview and isolated undo (G12/G13/G18).
- [ ] **Enforce AI controls:** bounded tools, workspace credits, safe degradation, mandatory untrusted-content handling and actual best-candidate selection (G14/G15/G17).
- [ ] **Finish manual editing:** blank decks, all MVP insertion/edit controls, group modes, equal-spacing guides and scene constraints (G05/G06/G07).
- [ ] **Close rendering correctness gaps:** connector anchors, image crop/mask and font loading (G08/G09).
- [ ] **Complete identity and GitHub:** actual sign-in, installation/repository wiring, incremental refresh and correct multi-repository provenance (G03/G20/G21/G22).
- [ ] **Complete feedback and motion:** accepted/dismissed memory events and full manual motion controls/browser verification (G16/G23).
- [ ] **Prove the exits:** generation statistics, real-repository demo, complete pixel/performance coverage and accurate documentation status (G02/G10/G11/G19/G24).

This checklist is the remaining work inside the agreed Phase 0–7 scope; it does not add later-phase deliverables.
