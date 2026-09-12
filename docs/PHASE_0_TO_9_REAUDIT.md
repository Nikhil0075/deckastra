# Deckastra — Phase 0–9 gap re-audit

**Remediation underway:** [Current fix progress](PHASE_0_TO_9_FIX_PROGRESS.md) records subsequent changes and verification. This report retains the findings as they stood before remediation.

**Reviewed:** 2026-09-06, Asia/Calcutta. **HEAD:** `6f06c46250879b287f9ba73bc41e15a2f7d7cf75`, plus the current uncommitted implementation and tests. HEAD alone does not identify this review because the eleven reported fixes are uncommitted.

**Implementation fingerprint:** SHA-256 `a2312529bc58ee54fe0e3225bccc797c6e194239ad0b8232e61760d6e53f6548`, over a sorted manifest of 311 implementation/test/configuration files and their SHA-256 hashes. The manifest excludes audit documents and `.claude/`; it is recorded locally as `%TEMP%/deckastra-recheck-manifest.json`. Tests completed before this fingerprint was taken. Review-only temporary probes were removed. Product code, the supplied specifications and pixel baselines were not edited during this re-audit.

This is the **current status report**, superseding the status statements in the historical [Phase 0–7 audit](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md) and [Phase 8–9 audit](PHASE_8_TO_9_IMPLEMENTATION_AUDIT.md). Their original evidence and acceptance criteria remain useful reference material. The supplied phased plan remains the delivery baseline; the six specifications, especially doc 02 §0.8, doc 03 §§13/22/28, doc 04 §§31–34/39/41 and doc 05 §38, remain supporting requirements. Instructions in those documents were reference material, not authorization to implement additional features.

## Result

**The existing suites are green locally, but the Phase 0–9 gaps are not all closed.** The changes fix several concrete defects and improve others. Additional checks reproduced remaining autosave, asset-history and Critic persistence failures that the existing tests do not cover.

The same **102 requirement groups** used in the two earlier audits are retained, with the same IDs and denominators: **47 complete, 48 partial, 3 missing and 4 unverified — 47/102, or 46.1%, fully covered.** No partial group is rounded up to complete. The percentage remains unchanged because these fixes address parts of broader groups whose other requirements remain open. This does not mean the fixes made no progress: the eleven-item reconciliation below identifies the concrete improvements, including the previously failing checkpoint and Windows pixel tests.

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
| 8 — Critic, export, headless | 6 | 7 | 0 | 1 | 6/14 — 42.9% |
| 9 — Launch hardening | 7 | 13 | 2 | 1 | 7/23 — 30.4% |
| **Total** | **47** | **48** | **3** | **4** | **47/102 — 46.1%** |

This is checklist coverage, not a percentage of code written or an estimate of remaining effort. A complete component does not establish its entire application journey. A passing policy/documentation row does not prove a production restore or live service. The full requirement matrix at the end makes the denominator inspectable.

## Reconciliation of the eleven reported fixes

“Verified fix” here refers to the named defect, not necessarily the whole phase requirement. “Partial” means a directly related case remains incorrect or a required application/CI path is still missing.

| # | Reported fix | Recheck | What is established and what remains |
| --- | --- | --- | --- |
| 1 | Autosave retains failed batches and protects AI adoption | **Partial** | The eight new [hook tests](../apps/web/tests/useEditor.test.ts) pass: offline/500/409 work is retained in memory and retries preserve ordering. Two extra probes fail: an empty pending queue returns success while another batch is in flight, and edits made after the initial save check are dropped during adoption. Unload also does not protect an already in-flight ordinary fetch. **R01**. |
| 2 | Asset recount includes materialized heads | **Partial** | The new head-after-snapshot test passes, including the JSON-null handling. An asset introduced and removed between snapshots remains required by a historical version but is still selected by a dry-run sweep. Actual byte deletion is also still absent. **R02**. |
| 3 | Workspace mutations enforce roles | **Partial** | Viewer writes/sweeps are refused and EDITOR/ADMIN requirements are explicit; launch tests pass. Role-dependent implicit workspace selection can make a read and subsequent write act on different workspaces. **R06**. |
| 4 | Sharing restricted to effective viewer links | **Verified fix** | Request schema, `create_share` and SharePanel no longer offer new editor links. The planned viewer-sharing scope is a valid implementation choice; token-scoped editing remains deferred. A public-sharing browser journey is still unverified. |
| 5 | Repository identity retained per retrieval hit | **Verified fix** | [retrieval.py](../apps/api/deckastra_api/retrieval.py), agent tool output and research dedup retain repository identity. The two-repository/same-filename test passes. Immutable indexed-commit references and provenance after best-story fallback remain separate open parts of P6.6. |
| 6 | Registry wraps untrusted tool fields | **Partial** | Declared fields on the existing tools are wrapped at `_invoke`; tests pass. Registering a new tool with `returns_untrusted_content=True` and no `untrusted_fields` still returns raw text without a configuration error. **R05**. |
| 7 | PPTX placeholder action says `dropped` | **Verified fix** | [shapes.ts](../packages/export-pptx/src/shapes.ts) and the added report regression correctly describe missing content. The images/charts/diagrams are still placeholders; this closes the misleading warning, not export fidelity. |
| 8 | Telemetry instruments resolve lazily | **Verified fix** | The fake-meter regression confirms calls reach the configured meter instead of retaining the import-time no-op. Actual SDK/exporter delivery remains unverified. Repeated public `configure()` calls return immediately while enabled, so generation tracking is not proof of a supported runtime reconfiguration API. **R07**. |
| 9 | Best draft retained and issues reach the document | **Partial** | `propose` chooses the best stored story and adds an extensions operation. A real generation-service probe completed with that operation but returned a document without the issues. Candidate snapshots omit creative/motion state, provenance still reads the latest story, and no editor consumer of the extension was found. A default-budget repeated-story-revision run also hit LangGraph's recursion limit. **R03/R04**. |
| 10 | PostgreSQL checkpoint tests repaired | **Verified fix** | The previously failing resume/isolation tests now pass as part of **358 passing Python tests**. The normal generation route still does not offer the planned human story-approval HTTP/UI journey; P5.4 remains partial. |
| 11 | Windows pixel baseline and required CI baseline | **Partial** | All four Windows pixel tests pass with `REQUIRE_PIXEL_BASELINE=1`. The baseline change is the described animation insertion/shift. Linux still has no committed baseline, so the configured Linux job is expected to fail. Full ten-slide reload coverage is still absent. **R08**. |

Five narrowly stated defects are verified fixed; six entries retain related gaps. Several historical findings combine multiple defects, so their status does not necessarily change when one part is repaired.

## Reproduced failures and remaining implementation risks

### R01 — Autosave acknowledgement and AI adoption still allow lost work

**P1. Affects P2.6/P5.14; historical G04/G18.** In [useEditor.ts](../apps/web/lib/useEditor.ts), line 230 checks whether `pending` is empty before line 233 checks `flushing`. A running drain has already moved its batch out of `pending`. A second `saveNow()` therefore returns `true` before the first request is acknowledged. AskPanel can proceed with an AI request against an older server document.

**Reproduction 1:** queue a retitle, hold its mocked POST response open, call `saveNow()` again before releasing the response. Expected `false` or waiting for the existing drain; observed **`true`**. The temporary regression failed exactly at that assertion.

**Reproduction 2:** after a successful pre-AI drain, capture the server result, type another change, then call `adoptDocument`. Expected preservation/reconciliation or refusal to adopt; observed the old title restored and the new queue discarded. The code reports the loss at lines 424–433, but reporting a lost change does not preserve it. [AskPanel.tsx](../apps/web/components/AskPanel.tsx) checks only before awaiting `agentEdit`/approval/revert; editing is not locked across that interval.

The unload handler considers only `pending`. If its contents are already in an ordinary in-flight fetch, no keepalive request carries that batch. Even a queued keepalive is best effort; the code has no durable local recovery for a conflict/offline close. These are source-level limits beyond the two passing/failing mock-network cases, not claims of a new browser crash test.

**Remaining:** represent the active drain explicitly and await it; serialize or reconcile document replacement with editing and autosave, using the server version on which the AI operation was based. Preserve recoverable operations on conflicts and failed unloads instead of clearing them after a warning. **Accept when:** tests cover a second drain during an in-flight request, edits during AI processing, response arrival in both orders, conflicts and unload during an active save; no operation is lost or silently replayed on a different base version.

### R02 — Historical operation-only versions are not protected from asset cleanup

**P1. Affects P9.06–08; historical F09.** [assets.py](../apps/api/deckastra_api/assets.py) now scans snapshots and materialized heads. It still does not account for every retained intermediate version. [store.py](../apps/api/deckastra_api/store.py) explicitly supports loading such a version through `at_version`.

**Reproduction:** in a temporary SQLite database, register an asset old enough for cleanup; place it through the actual transaction route after a snapshot; remove it in the next manual transaction before a new snapshot. Load the placement version and confirm that it still references the asset. Run `POST /v1/workspace/assets/sweep?dry_run=true`. Observed **the asset ID in `deleted`**, despite the historical document requiring it. No real storage object was deleted by this probe.

Also, `sweep(remove=...)` still only logs keys at line 295; it does not remove storage bytes. The existing “bytes reclaimed” test checks database rows and reported sizes, not a real object's disappearance.

**Remaining:** track references reachable through all retained versions/operations and any restore/undo guarantees, then implement authorized, retryable storage deletion and accurate accounting. **Accept when:** the place/remove-between-snapshots case cannot be swept while its historical version remains accessible; real orphan deletion is verified against storage; failed deletions do not falsely claim reclaimed capacity.

### R03 — Critic issues are added to a patch that generation does not apply

**P1. Affects P5.12/P8.03; historical G17/F01.** [propose.py](../agents/deckastra_agents/nodes/propose.py) adds `/extensions`, but [agent_service.py](../apps/api/deckastra_api/agent_service.py) returns `produced["document"]` captured inside the composer before that operation is appended. [main.py](../apps/api/deckastra_api/main.py) saves `outcome.document`, not the final patched document.

**Generation-service probe:** deterministic stub Critic always requests story revision; set `RunBudget(max_revisions_per_run=1)` to exercise forced acceptance without the separate recursion problem. Observed:

```text
status: completed
forced: True
issues in proposed patch: True
issues in document returned to main: False
```

The new test checks `proposed_operations`; it does not establish persisted-document behavior. Repository search also found no web consumer of `deckastra.unresolvedIssues`.

**Remaining:** produce/save the validated final document after all proposal operations, preserve existing extensions and surface issues against the correct slides in the editor. **Accept when:** a forced generation through `/v1/generate`, followed by GET/reload, retains the issues and visibly exposes them. Keep the schema's loose extension/unknown-value contract intact.

### R04 — Best-candidate restoration is incomplete, and default revision flow can exhaust graph recursion

**P1. Affects P5.7/P5.12/P6.6/P8.03.** [critic.py](../agents/deckastra_agents/nodes/critic.py) records only score and story plan. [propose.py](../agents/deckastra_agents/nodes/propose.py) pairs the selected older story with the **latest** creative direction and motion plan. It also attaches the forced/latest review's issues rather than explicitly associating the selected candidate with its review. The selected story is not returned into graph state; `main.py` subsequently computes provenance from the latest `state.story_plan`, which can mismatch the older story that was composed. These conclusions follow the source paths; they are not covered by the new title-only candidate test.

A separate service run with the **default** revision budget and a deterministic Critic repeatedly returning deck-wide `revise_story` raised **`GraphRecursionError: Recursion limit of 25 reached`** before returning a fallback deck. [runner.py](../agents/deckastra_agents/runner.py) calls `graph.invoke` without a recursion limit coordinated with the multi-node revision path. The shortened one-revision run used for R03 completes. This is a newly reproduced coverage gap, not an attribution that the latest patch introduced the recursion behavior.

**Remaining:** retain/select a coherent candidate including all composition inputs and review/source metadata; make downstream provenance use that selected candidate; coordinate graph traversal limits with supported revision budgets and still return a usable candidate on exhaustion. **Accept when:** a worse later story/creative/motion revision cannot contaminate the selected output or citations, and repeated story revisions through the default full graph reach an honest bounded fallback instead of a recursion exception.

### R05 — Untrusted tool configuration can silently bypass wrapping

**P1. Affects P5.9; historical G15.** [registry.py](../agents/deckastra_agents/tools/registry.py), `register` and `_envelope_result`, permit `returns_untrusted_content=True` with empty `untrusted_fields`; line 266 immediately returns the result unchanged. The boolean still does not force wrapping or reject incomplete declarations.

**Reproduction:** register a tool with that flag, object input/output schemas and a handler returning `{"content": "External source text"}`. Call it through `for_agent(...).call(...)`. The returned content is the identical raw string; the regression expecting an envelope fails. Existing correctly configured tools do wrap, which is an improvement. This probe establishes a configuration bypass, not a demonstrated live-model prompt-injection exploit.

**Remaining:** fail closed on incomplete untrusted definitions, validate declared field coverage/paths or provide a safe default, and test newly registered tools as well as the existing six. **Accept when:** a flagged tool cannot deliver raw external text simply because its author omitted the field declaration; IDs/provenance remain usable and delimiter escaping still passes.

### R06 — Workspace choice changes with the requested role

**P1. Affects P9.03; historical F07.** [auth.py](../apps/api/deckastra_api/auth.py), lines 219–228, chooses the first membership satisfying `require`. A user who is VIEWER in workspace A and ADMIN in B can read the asset list for A and then have the same unqualified sweep URL operate on B. Role checks are now effective; they do not establish that a mutation targets the workspace the user reviewed. The source documents this as a stopgap.

**Remaining:** use an explicit workspace ID or a stable selected workspace independent of required role, then authorize within that workspace. **Accept when:** the A-viewer/B-admin sequence cannot silently retarget the mutation; reads, previews, confirmations and writes identify the same workspace, and forbidden writes are refused rather than redirected to another membership.

### R07 — Telemetry binding is fixed, operational delivery is not established

**P2. Affects P9.14–15; historical F12.** Lazy instrument resolution is verified with a fake meter. `configure()` still returns early while `_enabled` is true, so its public API does not itself replace the meter or increment the configuration generation on another call. The test changes internal fields directly. SDK/provider/exporter configuration, real collector delivery, LLM-specific tracing and a content-safe attribute policy remain open; the string-length check alone does not exclude short user text.

**Remaining:** specify startup-only configuration or implement a supported reconfiguration lifecycle, and demonstrate delivery through the chosen SDK/exporter and LLM tracer. **Accept when:** generation/export/failure records reach a test collector with linked IDs and required redaction; reconfiguration is either supported and tested or explicitly unsupported. Do not label the fixed import-time bug as still present.

### R08 — Local pixels pass; Linux comparison and full reload coverage remain unfinished

**P2. Affects P4.5–06; historical G10/F16.** Windows baseline comparison passes with the required flag. Only `win32-x64.json` is present in the baseline directory; CI runs on Linux and now requires a baseline. Therefore its historical pixel comparison is expected to fail until a reviewed Linux baseline exists. A remote CI run was not inspected or claimed green.

The repeat test still samples the first slide of each fixture, and reload checks only `technical/1`. Comparing all ten slides to baseline hashes is not the same as reloading all ten slides. There is also a source-level capture defect: `shoot()` clips to half the logical slide width/height, while [SlideView](../packages/renderer/src/react/SlideView.tsx) renders at full logical size without a scale override in this test. Device scale changes pixel density, not the clip's CSS bounds; the gate therefore covers the top-left quarter of the slide rather than the full slide at 2×.

**Remaining:** review a Linux artifact in the pinned runtime before committing its baseline, test repeat/reload across all ten slides, and verify full-slide capture dimensions. **Accept when:** a required Linux comparison passes against an intentionally reviewed baseline, a deliberate visual change fails, and all-slide 2× reload parity is checked. No baselines were regenerated in this review.

## Other remaining work, reconciled with the old registers

The detailed acceptance criteria in the earlier registers still apply unless replaced by R01–R08. These rows account for every original G/F finding; a resolved sub-defect is named rather than erasing the rest of the requirement.

| Previous finding | Current disposition / next work |
| --- | --- |
| G01 — Validation/evaluation gates | Open: real lint, rule-by-rule fixtures and real-model evaluation corpus/rates. |
| G02 — Generation measurements | Open: first-attempt validity/retry diagnostics must reflect actual model outcomes. |
| G03 — Actual authentication | Open: development tokens remain; email/social authentication and a complete account journey are absent. |
| G04 — Autosave | Improved; not closed. Failed batches survive, but R01 remains. |
| G05 — Manual authoring | Open: blank creation and full element/content/style controls remain incomplete. |
| G06 — Group resize/distribution | Open: helper implementations are not wired into all editor paths. |
| G07 — Constraints/collision | Open: deterministic solver/validation are not integrated into authoring/render composition. |
| G08 — Rendering semantics | Open: anchored lines, image crop/mask and other documented semantic gaps. The schema guard/fallback fix remains valid. |
| G09 — Font loading | Partial: the measurement service invalidates its cache on `loadingdone`; worker measurement now waits on browser fonts. The app still lacks the complete load barrier and scene-rebuild protocol. This narrows the earlier report's broad invalidation wording. |
| G10 — Visual gates | Windows mismatch fixed; Linux baseline and full coverage remain R08. |
| G11 — Performance/dashboard | Open: current drag E2E passes its dropped-frame allowance at 16.7ms p95/60Hz, not the literal <16ms criterion or all resize/p99/RSS/dashboard budgets. |
| G12 — Human checkpoint | Test harness fixed and PostgreSQL resume tests pass; product story-approval HTTP/UI path remains absent. |
| G13 — Live generation progress | Open: synchronous generation/home-page subscription gap. |
| G14 — Budgets/timeouts | Open: daily workspace credits, hard tool deadlines, full spend accounting and usable fallback on exhaustion; R04 adds default recursion evidence. Monthly quotas are partial adjacent coverage, not the planned daily ceiling. |
| G15 — Untrusted boundary | Existing declared fields now wrap centrally; incomplete declarations still bypass it (R05). |
| G16 — Memory feedback | Open: accepted-layout and dismissed-issue feedback are not a complete persisted user loop. |
| G17 — Critic/creative | Story selection improved; issue persistence, coherent candidates, source alignment and creative application remain R03/R04. |
| G18 — Contextual editing | Open: chart/data/style intents and rendered approval preview; R01 pending-edit protection. |
| G19 — Documentation | CLAUDE now records many decisions. Reconcile remaining claims about saved issues, best complete candidates, reconfiguration and whole-suite/phase completion with this review. Original supplied specifications remain historical inputs. |
| G20 — Real GitHub connection | Open: browser callback authentication/state, discovery/selection and external installation-ID resolution; no credentialed installation demo. |
| G21 — Incremental refresh | Open: push does not queue the incremental indexing path; live freshness/retry evidence absent. |
| G22 — Provenance | Wrong-repository/same-filename defect fixed. Indexed-commit identity and correct selected-story provenance remain open, especially after fallback (R04). |
| G23 — Motion authoring | Open: delay/start, reorder/keyframe authoring and complete browser motion acceptance. |
| G24 — External acceptance | Unverified: real model, real GitHub, embedding quality and externally reachable deployment demonstration. |
| F01 — Critic evidence/retention | Partial: eight scores/routing exist; plan counts are not render metadata; R03/R04 prevent closing fallback. |
| F02 — Headless reliability/cache | Open: bounded concurrent pool leases, total deadlines, authorized asset materialization/font manifest and version/options cache. |
| F03 — PDF fidelity | Open: assets, notes/options and metadata; tagged PDF remains an explicit deferral. |
| F04 — PPTX fidelity/report | False `rasterized` action fixed. Real native/media content or embedded visual fallbacks still needed. |
| F05 — Asynchronous exports | Open: POST remains synchronous; queued/failed job durability, live progress, retries/cancellation are unfinished. |
| F06 — Export performance | Unverified against an agreed SLO: prior 60-slide 6.299s/5.315s figures are historical observations, not fresh load/percentile/RSS results. |
| F07 — Sharing/roles | New viewer links and role checks fixed; R06 and public-share browser verification remain. |
| F08 — Theme workflow | Open: saved/default theme selection/application in normal UI flows. |
| F09 — Asset lifecycle | Current heads now protected; historical versions, storage deletion, upload/restore wiring and quotas remain (R02). |
| F10 — Onboarding/recovery | Open: blank action still just sets `idle`; stale/font named components lack consumers; mid-run recovery incomplete. |
| F11 — Spend enforcement | Open: contextual edits/continuations and failed work/concurrent reservations not fully accounted for. |
| F12 — Observability | Import-time no-op fixed; SDK/exporter/LLM tracer and content policy remain (R07). |
| F13 — Recovery | Policy exists; actual WAL/PITR/object retention and restore rehearsal unverified. |
| F14 — Accessibility | Helper tests pass; application integration, composite contrast, alt editing and focus/keyboard/zoom checks remain. |
| F15 — Product metric pipeline | Missing: retained-slide session/cohort calculation and dashboard. Targets alone are complete. |
| F16 — MVP exit | PostgreSQL tests and current editor navigation/drag check now pass. Twelve-step signup/project/GitHub/authoring/export launch demonstration remains incomplete. |

## Verification performed

| Command/check | Current result | Limits |
| --- | --- | --- |
| `npm run typecheck` | Pass | Whole workspace. |
| `npm run schema:drift` | Pass | All five generated artifacts match. Emitter was not rerun because this was a review with no schema edits. |
| `python scripts/validate_fixtures.py` | Pass | Three fixtures, six base negative cases and both element-boundary cases. Known malformed elements still fail; unknown values survive. |
| `npm test` | **685 passed, 1 opt-in suite skipped** | Existing suite; temporary review probes were not part of this run. The earlier 676 count is historical. |
| `POSTGRES_TEST_URL=… python -m pytest apps/api agents integrations -q` | **358 passed** | Includes the repaired checkpoint tests; one LangChain pending-deprecation warning. Some test fixtures deliberately use temporary SQLite even when the PostgreSQL-specific tests are enabled. Provider-dependent tests use stubs. |
| `PIXELS=1 REQUIRE_PIXEL_BASELINE=1 npm run test:pixels --workspace @deckastra/renderer` | **4 passed** | Windows x64 only; no regeneration. Linux baseline still absent. |
| `npm run test:browser --workspace @deckastra/worker` | **5 passed** | Actual editor-measurer/worker scene digest parity, fit cases and real export flags. |
| `E2E=1 npm run test:e2e --workspace @deckastra/web` | **1 passed** | 120-object drag: **16.7ms p95**, 123 frames, ~60Hz, **0.8% dropped**. The previous navigation timeout did not recur. Test created its synthetic deck in the local development database. |
| Additional autosave review regressions | **2 failed as described in R01** | Existing-hook fixtures with a held POST and a delayed AI-result adoption; no product code changed. |
| Additional asset/untrusted review regressions | **2 failed as described in R02/R05** | Asset probe used the real API/transaction path in a temporary database and dry-run cleanup. One initial probe collection/import error was corrected before obtaining these behavioral results. |
| Forced Critic generation-service probe, one revision | Completed, **issues absent from returned document** | R03: patch contains extensions, service result document does not. |
| Same repeated-story-revision flow, default budget | **GraphRecursionError at limit 25** | R04; no live model/provider spend. |

Local logs use `%TEMP%/deckastra-recheck-*.log`. Temporary regression files were removed after recording their results; existing application/test files were not rewritten. A green existing suite is compatible with failures in additional cases it does not test. These failures are not being hidden by changing assertions or baselines.

**Not established:** production deployment/build, remote CI status, Linux baseline approval, public share/create/present/revoke browser flow, a live twelve-step MVP demo, actual email/social auth, real GitHub installation/model quality, complete font/media fidelity across hosts, concurrent render stress, export latency percentiles/RSS, storage-object deletion, PITR restoration, collector/LLM-tracer delivery or real retained-slide cohorts. The previous 60-slide benchmark is retained as historical evidence of an unchanged core export path, not reported as rerun today.

## Next work in priority order

- [ ] **P1:** close the two autosave/adoption cases and protect all retained asset versions (R01/R02).
- [ ] **P1:** persist/render Critic issues, restore a coherent candidate and make default revision exhaustion terminate with a usable deck (R03/R04).
- [ ] **P1:** reject incomplete untrusted-tool declarations and make workspace selection explicit/stable (R05/R06).
- [ ] **P1:** finish durable asynchronous exports, actual PDF/PPTX content fidelity and complete workspace spend enforcement (F02–F05/F11).
- [ ] **P1:** implement the missing user journeys: authentication, blank/manual creation, real GitHub connection, story approval and contextual chart editing (G03/G05/G12/G18/G20).
- [ ] **P1/P2:** demonstrate recovery, observability and accessibility; finish the Linux/all-slide visual gate, agreed performance budgets, theme workflow and product metrics (R07/R08/F06/F08/F12–F15).

## Current requirement matrix

The following tables preserve the earlier requirement titles/IDs and counts. Changed or disproven evidence is replaced below; links back to historical G/F registers supply the longer original requirement/acceptance descriptions, not a claim that their old failure messages are still current. Component test passes are carried forward only where the code/evidence remains applicable; broader runtime exits retain their partial/unverified status.

### Phase 0

| ID | Requirement group | Current status | Current evidence / remaining boundary |
| --- | --- | --- | --- |
| P0.1 | Correct root, monorepo, Deckastra identity | Complete | [Root manifest](../package.json), workspaces under `D:/Presentation_app`; old name remains only as historical explanation. |
| P0.2 | MVP and deferred schema shapes, versions, downward generation | Complete | [Schema source](../packages/presentation-schema/src/index.ts), [emitter](../packages/presentation-schema/scripts/emit-json-schema.ts), [Python consumer](../apps/api/deckastra_api/schema.py); emit/drift and contract checks pass after the fix. |
| P0.3 | Three canonical seed decks | Complete | [Fixture generator](../packages/presentation-schema/scripts/build-fixtures.ts), committed technical/repository/animation fixtures; 5/2/3 slides respectively. All validate. |
| P0.4 | CI lint, typecheck, tests, round-trip and drift gates | Partial | [CI](../.github/workflows/ci.yml) runs typecheck/tests/build/drift/contracts; root lint delegates to nonexistent workspace lint scripts and CI does not run it. Rule-by-rule fixture coverage is incomplete. [G01](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g01--validation-and-evaluation-gates). |
| P0.5 | Compose PostgreSQL, Redis and MinIO | Complete | [Compose configuration](../infrastructure/docker/docker-compose.yml) defines all three and bucket initialization; PostgreSQL was available for this audit. Redis/MinIO runtime smoke was not performed. |
| P0.6 | Rename and PRD decisions/NFR reconciliation | Complete | [PRD](01_PRODUCT_REQUIREMENTS_AND_USER_JOURNEYS.md) §8.3 references the canonical element list; §9.1 has budgets; §16.1 closes Q3/Q4/Q6. |
| P0.7 | Seed validation in TS/Python and lossless unknown-property round-trip | Complete | Schema tests and `scripts/validate_fixtures.py` pass, including new negative known-element and positive future-element cases. |

### Phase 1

| ID | Requirement group | Current status | Current evidence / remaining boundary |
| --- | --- | --- | --- |
| P1.1 | Document → intermediate scene → React/SVG, theme and layer boundaries | Complete | [Scene pipeline](../packages/renderer/src/scene.ts), [SlideView](../packages/renderer/src/react/SlideView.tsx); renderer scene/render/container tests pass. |
| P1.2 | Keyboard navigation, fullscreen, cut/fade presentation | Complete | [PresentMode](../apps/web/components/PresentMode.tsx), [transitions](../packages/renderer/src/transitions.ts); present synchronization and transition tests pass. |
| P1.3 | Single-shot request/story/composition/validation with one model retry | Complete | [Story service](../apps/api/deckastra_api/story.py), [composer](../apps/api/deckastra_api/compose.py), generation tests. Retry is at the intent-plan boundary; deterministic invalid composition is reported as a bug. |
| P1.4 | Prompt box → busy state → rendered deck/present | Complete | [Home page](../apps/web/app/page.tsx), [generation route](../apps/api/deckastra_api/main.py), passing generation tests and local browser editor flow. |
| P1.5 | Record observed first-attempt schema validity | Partial | Diagnostic fields exist in [models](../apps/api/deckastra_api/models.py) and the single-shot chain. No real-model sample/rate was established; graph diagnostics default validity flags rather than aggregating retry outcomes. [G02](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g02--honest-generation-measurements). |
| P1.6 | Share a working URL demonstrating a real generated deck | Unverified | Local stub-backed servers work; no external deployment/demo or credentialed real-model demonstration was verified. [G24](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g24--external-acceptance-evidence). |

### Phase 2

| ID | Requirement group | Current status | Current evidence / remaining boundary |
| --- | --- | --- | --- |
| P2.1 | Pure slide/element operations and reference checks | Complete | [Core operations](../packages/presentation-core/src/operations.ts), reference utilities; 40 core tests pass. Operations emit patches. |
| P2.2 | Id paths, atomic apply, pre-state inverses, undo/redo/grouping | Complete | [Applier](../packages/transactions/src/apply.ts), [history](../packages/transactions/src/history.ts); 61 transaction tests pass. |
| P2.3 | Snapshot plus operation log, periodic/agent snapshots | Complete | [Store](../apps/api/deckastra_api/store.py); replay, history and persistence tests pass. |
| P2.4 | Membership, project ownership chain, version/transaction lineage tables | Complete | [DB models](../apps/api/deckastra_api/db/models.py), migrations, [authorization](../apps/api/deckastra_api/auth.py); migration and PostgreSQL persistence checks pass. |
| P2.5 | Email/social authentication plus authorization | Partial | Membership/role authorization exists; only signed development tokens and `/v1/dev/session` establish identity. [G03](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g03--actual-authentication). |
| P2.6 | Optimistic autosave, batching, acknowledgements and retry | Partial | Failed batches now survive and the eight new hook tests pass. Still partial: saveNow returns true while a drain is in flight; typing during an AI request is lost on adoption. See R01 and [useEditor.ts](../apps/web/lib/useEditor.ts). |
| P2.7 | Inverse property test, insertion-safe id resolution, 20-slide round-trip | Complete | [Transaction tests](../packages/transactions/tests/apply.test.ts) include 400 generated patches, earlier insertion, and a 20-slide round-trip; Python/TS patch conformance passes. |

### Phase 3

| ID | Requirement group | Current status | Current evidence / remaining boundary |
| --- | --- | --- | --- |
| P3.1 | Selection, group click/enter/exit, indexed hit testing | Complete | [Selection](../packages/editor/src/selection.ts), [spatial index](../packages/editor/src/spatial-index.ts), [canvas](../apps/web/components/EditorCanvas.tsx); library tests and real drag flow pass. |
| P3.2 | Move/resize/rotate including both group resize modes | Partial | Rotation helpers and `resizeGroup` exist/test, but canvas commits only selected transforms and does not call the group resize helper. [G06](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g06--group-resize-and-distribution-are-not-fully-wired). |
| P3.3 | Zoom-independent snapping and distribution guides | Partial | Edge/grid snapping is wired; `findEqualSpacing` is only referenced by unit tests. [G06](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g06--group-resize-and-distribution-are-not-fully-wired). |
| P3.4 | Clipboard, keyboard shortcuts and layers panel | Complete | [Editor helpers](../packages/editor/src/index.ts), [EditorShell](../apps/web/components/EditorShell.tsx); clipboard/keyboard/layer operations have passing tests. |
| P3.5 | In-place rich text, IME, sanitized paste, four fit modes/0.25px sizing | Complete | [TextEditor](../apps/web/components/TextEditor.tsx), text-editing tests, [text metrics](../packages/renderer/src/text-metrics.ts), DOM measurer and tests. Full formatting/inspector breadth is tracked separately in P3.9. |
| P3.6 | Group container layouts and cached text measurement | Complete | [Container resolver](../packages/layout-engine/src/container.ts), scene `layoutChildren`, shared [browser measurer](../apps/web/lib/measurer.ts). Container sizing currently takes child transform dimensions, not a content-growth feedback loop. |
| P3.7 | Collision and align/distance/anchor/containment constraint handling | Partial | [Constraint solver](../packages/layout-engine/src/constraints.ts) and [layout validation](../packages/layout-engine/src/validate.ts) pass library tests; app/renderer do not call these entry points. [G07](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g07--constraint-and-collision-integration). |
| P3.8 | Editor state excluded from canonical document | Complete | State is held in hooks; [editor tests](../packages/editor/tests/editor.test.ts) assert exclusion from saved data. |
| P3.9 | Journey D: zero-AI complete deck and hand-rebuilt animation fixture | Partial | Toolbar inserts text/rectangle/ellipse; inspector geometry is read-only. Rebuild test is programmatic and explicitly omits timelines even after Phase 7. [G05](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g05--complete-manual-authoring-is-not-available). |
| P3.10 | 120-object drag acceptance/performance criterion | Partial | Current browser E2E passes its dropped-frame gate: 16.7ms p95, 0.8% dropped over 123 frames at ~60Hz. This does not establish literal <16ms p95, resize/p99, or all performance budgets. G11. |

### Phase 4

| ID | Requirement group | Current status | Current evidence / remaining boundary |
| --- | --- | --- | --- |
| P4.1 | Full theme model/token resolution and brand checks | Complete | [Theme schema](../packages/presentation-schema/src/theme.ts), [theme resolution](../packages/renderer/src/theme.ts), [semantic checks](../packages/renderer/src/semantic.ts); theme/visual/semantic tests pass. |
| P4.2 | Every MVP type renders correctly, deterministic charts/diagrams | Partial | Charts, diagrams, tables, code and icons have real implementations/tests. Anchored line endpoints are not resolved; image crop/mask data is not consumed by the image payload. [G08](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g08--mvp-rendering-still-has-semantic-gaps). |
| P4.3 | Curated fonts, loading protocol, matched fallback, availability input | Partial | Worker measurement now waits on browser fonts. The shared DOM service invalidates its cache on loadingdone, but application font-load/scene-rebuild coordination remains incomplete. See [measure.ts](../packages/layout-engine/src/measure.ts), [measurer.ts](../apps/web/lib/measurer.ts), G09. |
| P4.4 | Presenter view, notes, timer and transitions | Complete | [PresenterView](../apps/web/components/PresenterView.tsx), PresentMode, BroadcastChannel synchronization; synchronization/transition tests pass. |
| P4.5 | Visual regression harness gating merges | Partial | Scene tests and all four required Windows pixel checks pass. CI now refuses missing baselines, but its Linux baseline remains absent. R08 replaces the earlier Windows-failure statement. |
| P4.6 | All fixture slides byte-identical at 2× after reload | Partial | Repeat covers the first slide of each fixture; reload covers technical/1. Full ten-slide reload parity and full-slide 2× capture verification remain open. R08. |
| P4.7 | Every doc 04 §31.1 budget instrumented as a dashboard line | Partial | [Performance module](../packages/renderer/src/perf.ts) has budgets and timers, with a last-drag readout; it explicitly says no telemetry reporting yet. Memory budget is absent. [G11](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g11--performance-coverage-and-dashboard). |

### Phase 5

| ID | Requirement group | Current status | Current evidence / remaining boundary |
| --- | --- | --- | --- |
| P5.1 | LangGraph stages, typed contracts, revision routing | Complete | [Graph](../agents/deckastra_agents/graph.py), [contracts](../agents/deckastra_agents/contracts.py), typed state and node tests. Motion is integrated into routing. |
| P5.2 | Per-agent prompt contracts and evaluation fixtures | Partial | Structured output validation and mock/stub tests exist; only one standalone prompt file and no repeatable real-model quality/grounding benchmark were found. [G01](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g01--validation-and-evaluation-gates), [G24](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g24--external-acceptance-evidence). |
| P5.3 | Tool permissions, tracing, retries, input/output validation and timeouts | Partial | [Registry](../agents/deckastra_agents/tools/registry.py) enforces schemas/permissions and records retries; timeout is checked after a synchronous handler returns. [G14](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g14--budgets-and-timeouts-are-incomplete). |
| P5.4 | Durable PostgreSQL story checkpoint and human resume flow | Partial | Both PostgreSQL resume/isolation tests now pass. The normal generation route still disables human checkpoints and lacks the story-approval HTTP/UI flow. G12 remains partial. |
| P5.5 | Redis progress and SSE event contract in the UI | Partial | [Events](../agents/deckastra_agents/events.py) and [SSE endpoint](../apps/api/deckastra_api/agent_routes.py) exist. Generation returns the run id only after synchronous completion; home page never subscribes. [G13](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g13--live-progress-does-not-reach-the-generation-ui). |
| P5.6 | Proposal status, 24h expiry, approve/reject/revalidate, server risk | Complete | [Proposal service](../apps/api/deckastra_api/proposals.py), routes/risk module and passing lifecycle tests. User-facing rendered preview is assessed in P5.14. |
| P5.7 | Revision/token/run ceilings and degrade-and-warn behavior | Partial | Revision/token/time counters exist. A real service probe with the default budget and repeated deck-wide revise_story raised GraphRecursionError at 25 steps instead of producing the fallback. R04; hard token/time exhaustion handling remains G14. |
| P5.8 | Enforced per-workspace daily credit ceiling | Missing | The phased plan explicitly asks for a per-workspace daily credit ceiling. daily_credit remains declarative. Phase 9 monthly token/generation quotas provide adjacent controls but do not implement this daily ceiling or cover every spend path. G14/F11. |
| P5.9 | Untrusted-content envelope enforced at registry boundary | Partial | Existing declared untrusted fields now wrap at the registry boundary. A newly registered tool with returns_untrusted_content=True and no fields still returns raw external text. Reproduced in R05; no live-model exploit claim. |
| P5.10 | Explicit edit scope including sources | Complete | [Agent state](../agents/deckastra_agents/state.py) declares sources scope; request/scope handling has tests. This establishes the scope contract, not a complete sources-editing UI. |
| P5.11 | Persistent accepted-layout/rejection/dismissal memory | Partial | [Memory](../agents/deckastra_agents/memory.py), SQL store and rejection recording exist; accepted-layout and dismissed-issue writers are only called by tests. [G16](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g16--memory-feedback-loop-is-incomplete). |
| P5.12 | Highest-scoring fallback, attached unresolved slide issues | Partial | Earlier story selection works in node tests; the actual generation service returns a pre-extension document. Complete candidate inputs, associated issues, provenance and editor visibility remain incomplete. R03/R04. |
| P5.13 | Internal model-provider routing interface | Complete | [Router](../agents/deckastra_agents/router.py), stub and configured provider client; agent tests exercise replacement without document-schema changes. |
| P5.14 | Journey C: selected chart edit → preview → approve → isolated undo | Partial | Scoped text/role/delete/reorder intents and proposal tests pass, but the chart-change journey and rendered preview remain incomplete. Pending local work still needs R01 protection during the AI request, despite the new preflight save check. G18. |
| P5.15 | Close graph naming/streaming/checkpoint documentation gaps | Partial | CLAUDE records the newer fixes, but claims about issues reaching saved documents, coherent best drafts and reconfiguration need reconciliation with R03/R04/R07. Source specifications remain reference material. G19. |

### Phase 6

| ID | Requirement group | Current status | Current evidence / remaining boundary |
| --- | --- | --- | --- |
| P6.1 | GitHub App installation, short-lived tokens, connected repositories | Partial | JWT/token adapter, installation storage and callback exist. Browser callback authentication, repository discovery/wiring and the id used for installation tokens are incomplete. [G20](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g20--real-github-connection-is-not-complete). |
| P6.2 | Tree → ignores → ranking/docs/frameworks → chunks; no repo execution | Complete | [Source adapters](../integrations/deckastra_integrations/sources.py), ignore/ranking helpers, [indexer](../apps/api/deckastra_api/indexing.py); local ingestion tests pass and read source bytes without executing repository code. |
| P6.3 | pgvector storage, file/line provenance and retrieval | Complete | RepositoryChunk metadata and PostgreSQL vector/HNSW migration exist; [retrieval](../apps/api/deckastra_api/retrieval.py) has vector and labelled lexical paths. Migration tests pass. Live provider embedding quality was not evaluated. |
| P6.4 | Webhooks, staleness, incremental re-index and access removal | Partial | Push marks head stale; removals delete chunks. Incremental `changed_paths` exists at service level but the webhook does not enqueue it and the UI reindex route does a full pass. [G21](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g21--webhooks-do-not-drive-incremental-refresh). |
| P6.5 | Repository size/read/index quotas | Complete | File-size/count limits and ranked read budget in ignore/index modules; quota warning/filter tests pass. This is repository ingestion limiting, not workspace AI credit enforcement. |
| P6.6 | Repository context and inspectable per-slide provenance | Partial | Per-hit repository identity and same-filename deduplication are fixed and tested. Source references still omit an immutable indexed commit; forced best-story composition leaves main.py building provenance from the latest story. G22/R04 keep the broader group partial. |
| P6.7 | Real repository → grounded eight-slide architecture deck → inspect sources | Unverified | Local-source/stub grounding passes; real GitHub App and real-model eight-slide demonstration were not performed. [G24](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g24--external-acceptance-evidence). |

### Phase 7

| ID | Requirement group | Current status | Current evidence / remaining boundary |
| --- | --- | --- | --- |
| P7.1 | Presets, timeline compiler, playback and group master clock | Complete | [Animation engine](../packages/animation-engine/src/index.ts), five suites/102 passing tests including grouped sequencing. |
| P7.2 | Per-preset reduced-motion fallback and resolution order | Complete | [Preset registry](../packages/animation-engine/src/presets.ts), compile tests and fixture coverage. |
| P7.3 | Motion/timeline UI with transaction-based edits | Partial | [MotionPanel](../apps/web/components/MotionPanel.tsx) supports presets, duration, easing, triggers, delete and scrubbing; delay/start editing, drag/reorder and keyframe authoring remain absent. [G23](PHASE_0_TO_7_IMPLEMENTATION_AUDIT.md#g23--motion-authoring-and-browser-verification). |
| P7.4 | Motion Agent semantic sequencing and restrained defaults | Complete | [Motion node](../agents/deckastra_agents/nodes/motion.py), [deterministic composer](../apps/api/deckastra_api/motion.py); roles/pacing stay separate from generated milliseconds. Agent/API motion tests pass. |
| P7.5 | Per-slide entrance budget enforcement | Complete | `_fit_to_budget` includes per-step fan-out, scales/drops to fit and warns; API motion and schema W132 tests pass. |
| P7.6 | Seek/play parity and transactional model edits | Complete | [Playback tests](../packages/animation-engine/tests/playback.test.ts) cover every millisecond of a representative timeline, backward seeking and segments; timeline tests check patch operations. Browser-level motion interaction coverage remains a separate verification limitation. |

### Phase 8

| ID | Requirement group | Current status | Current evidence / remaining boundary |
| --- | --- | --- | --- |
| P8.01 | Eight Critic score dimensions and routing to Story/Layout/Creative/Motion | Complete | [contracts.py](../agents/deckastra_agents/contracts.py), [critic.py](../agents/deckastra_agents/nodes/critic.py), [graph.py](../agents/deckastra_agents/graph.py); agent tests pass. Doc 03 §13. This establishes the contract/routing, not visual judgment quality. |
| P8.02 | Critique informed by actual rendered slides or render metadata | Partial | [_signals.py](../agents/deckastra_agents/nodes/_signals.py) counts plan words, layout material, citations and motion; the Critic precedes composition. It receives neither worker previews nor resolved bounds/contrast/overflow. Full eight-dimensional visual scoring is not grounded in the rendered result. **F01**. |
| P8.03 | Repeated-disagreement fallback retains the highest-scoring candidate and exposes unresolved issues | Partial | Best story selection and extension patch generation are implemented. The normal generation path does not save that extension; full candidate/source/review restoration and editor issue display remain missing. R03/R04. |
| P8.04 | Standalone headless rendering and browser text measurement | Complete | [render.ts](../apps/worker/src/render.ts), [text-measurement.ts](../apps/worker/src/text-measurement.ts); real Chromium tests produce PNG/PDF and match editor scene digests. Shared `SlideView`, explicit motion frame and offline page. Doc 04 §§31.2, 41.1–2. |
| P8.05 | Production headless lifecycle, font verification and permitted assets | Partial | `RenderPool` reuses a browser but closes/replaces its page on acquire; it has no lease/serialization for simultaneous callers. The 20-second constant covers `setContent`, not the entire render. No manifest-mismatch failure or tenant-aware asset materialization was found. Doc 04 §41.3; **F02**. |
| P8.06 | Adapter interface and explicit capabilities | Complete | [export-core](../packages/export-core/src/index.ts), [PDF](../packages/export-pdf/src/index.ts), [PPTX](../packages/export-pptx/src/index.ts). Both declare capabilities and consume pre-resolved scenes. Doc 04 §32. |
| P8.07 | PDF fidelity, notes and metadata | Partial | Real PDFs open with the right page count and selectable text; [render.ts](../apps/worker/src/render.ts) prints shared DOM. Requested notes do not produce appendix/notes pages, document metadata is not populated explicitly, and external images have no allowed-storage delivery path. Tagged PDF is deliberately deferred. Doc 04 §34; **F03**. |
| P8.08 | Editable PPTX and faithful, honestly classified degradation | Partial | The misleading rasterized report action is fixed to dropped and tested. Images/charts/tables/diagrams/icons still become boxes instead of native content or actual visual fallbacks. [shapes.ts](../packages/export-pptx/src/shapes.ts), F04. |
| P8.09 | Report persisted and shown before download | Complete | [export_service.py](../apps/api/deckastra_api/export_service.py) persists the report; [export_routes.py](../apps/api/deckastra_api/export_routes.py) separates status/download; [ExportPanel.tsx](../apps/web/components/ExportPanel.tsx) presents warnings before a download button. API/reader tests pass. The classification/content shortcomings remain P8.08. |
| P8.10 | Export runs as a durable asynchronous job with observable progress | Partial | A job table/status route exists, but POST calls `run_job` synchronously. `subprocess.run` buffers progress until completion. DB middleware commits only on a successful response and rolls back failures, so the claimed durable failed-job record is not established by this request path. Doc 04 §32.4; **F05**. |
| P8.11 | Version/options determinism and preview/export reuse | Partial | PPTX has byte-stability tests; scene parity is now checked. No preview/artifact cache by version/options was found; every API export launches a process. Chromium PDF timestamps are not normalized, and repeated PDF byte identity is not tested. Doc 04 §§32.3, 41.3; **F02**. |
| P8.12 | A 60-slide deck produces both file formats | Complete | Historical 60-slide runs through the same core CLI path opened as 60 PDF pages/PPTX slides with independent readers. Not rerun in this review. Current API artifact tests and browser exports pass; fidelity remains P8.07–08. |
| P8.13 | The 60-slide exit satisfies an agreed performance budget under representative load | Unverified | Historical local 60-slide figures were 6.299s PDF and 5.315s PPTX. An agreed export SLO and representative load/percentile/RSS evidence remain absent. F06; no new benchmark claimed. |
| P8.14 | Independent artifact readers and export regression checks | Complete | Current Python API/export/independent-reader checks, 40 PPTX tests and worker browser tests pass. Reader validity is not a PowerPoint/Acrobat visual-fidelity demonstration. |

### Phase 9

| ID | Requirement group | Current status | Current evidence / remaining boundary |
| --- | --- | --- | --- |
| P9.01 | Share persistence, secret tokens, expiry and revocation | Complete | [sharing.py](../apps/api/deckastra_api/sharing.py), [models.py](../apps/api/deckastra_api/db/models.py), [test_launch.py](../apps/api/tests/test_launch.py): hashed random tokens, one-time disclosure, expiry/revocation, viewer boundary and cross-deck checks. Gap doc 01/doc 05 S2. |
| P9.02 | Audience can open a share URL and present without an account | Partial | Public API tests pass; [shared page](../apps/web/app/shared/%5Btoken%5D/page.tsx) uses `PresentMode`, and [SharePanel](../apps/web/components/SharePanel.tsx) is mounted in the editor. A live share/create/open/present/revoke browser sequence was not completed during this review. **F07**. |
| P9.03 | Permission promises match effective access and workspace mutation roles | Partial | Viewer-only sharing and role-checked mutations are implemented and tested. Implicit workspace choice changes with require, so reads and writes can target different authorized workspaces. R06. |
| P9.04 | Workspace themes, theme reference plus portable resolved snapshot, transactional application | Complete | [themes.py](../apps/api/deckastra_api/themes.py), [workspace_routes.py](../apps/api/deckastra_api/workspace_routes.py) and launch tests: schema validation, workspace checks, `/metadata/themeId` plus `/theme`, apply and inverse transaction. Gap doc 05 S2 and doc 02 portability. |
| P9.05 | Theme selection/defaults integrated into creation and editing | Partial | `default_for` is defined without a production caller; no web theme library/select/apply surface was found. A complete API does not establish the brand-theme user journey. **F08**. |
| P9.06 | Asset registration, soft delete and restore connected to actual uploads/storage | Partial | [assets.py](../apps/api/deckastra_api/assets.py) has these functions, but registration callers found are tests; the workspace HTTP surface lists/sweeps assets and does not deliver the complete upload/delete/restore path. **F09**. |
| P9.07 | Reference counting protects every accessible document version | Partial | Materialized heads now join snapshots in reference counting. An asset placed and removed between snapshots remains reachable through at_version but is selected by dry-run sweep. R02 reproduces this remaining failure. |
| P9.08 | Orphan cleanup actually reclaims bytes with correct quota accounting | Partial | Grace periods, dry-run and row deletion exist. `sweep(remove=...)` logs keys but never invokes storage deletion; “reclaimed_bytes” therefore measures candidate row sizes, not confirmed reclaimed storage. No scheduled sweep/storage retry was found. **F09**. |
| P9.09 | First run, first deck and meaningful empty-state actions | Partial | Home has a prompt flow, but `NoDecksYet` is not mounted. [page.tsx](../apps/web/app/page.tsx) wires “Start from a blank deck” to resetting status to `idle`, not blank creation. Earlier account/project/manual-authoring gaps remain. **F10**. |
| P9.10 | Mid-generation failure and quota recovery UX | Partial | `GenerationFailed` and `QuotaReached` are mounted with retry/reset details. The blank fallback is ineffective, and “Nothing was saved” is not verified across durable/checkpointed agent failures. No full failure/resume browser check exists. **F10**. |
| P9.11 | Actionable stale-repository and missing-font feedback | Partial | [EmptyState.tsx](../apps/web/components/EmptyState.tsx) defines both named components but neither has a consumer. Repository status and export font warnings provide narrower feedback; live font/stale recovery behavior remains incomplete. **F10**. |
| P9.12 | Explicit plans, quotas, period/reset and usage model | Complete | [quotas.py](../apps/api/deckastra_api/quotas.py), workspace usage route and launch tests; [operations doc §7](06_OPERATIONS_AND_TARGETS.md) defines Free/Pro/Unlimited. These are implemented allowances, not billing/subscription integration. Gap doc 01 S3. |
| P9.13 | All paid work is accounted for and workspace caps survive concurrent requests | Partial | Main generation checks before work and accounts only after success. [agent_routes.py](../apps/api/deckastra_api/agent_routes.py) has no workspace quota calls; read/increment counters are not reservations or atomic conditional updates. Multiple concurrent runs and paid failures invalidate the documented “at most one run” overshoot claim. **F11**. |
| P9.14 | Working OpenTelemetry traces/metrics linked to product runs | Partial | Import-time instrument capture is fixed and fake-meter calls pass. No actual collector/provider/exporter delivery or complete agent tracing is established; configure returns early while enabled. R07. |
| P9.15 | LLM-specific run tracer integrated with the evaluation loop | Missing | Operations doc names LangSmith or Langfuse as choices; no configured integration/export path for the agent runs was found. Stored agent events alone do not meet this requirement. Doc 03 §22, gap doc 05 S3. **F12**. |
| P9.16 | Stated backup, RPO/RTO/retention and migration policy | Complete | [operations doc §§2–3](06_OPERATIONS_AND_TARGETS.md): RPO 5 minutes, RTO 1 hour, 35-day retention, monthly rehearsal, WAL/PITR, object versioning, expand/migrate/contract. This marks the policy requirement only. |
| P9.17 | Provisioned recovery controls and demonstrated restoration | Unverified | No production WAL archive/object-versioning configuration, backup records or timed restore rehearsal was supplied. A local PostgreSQL test does not demonstrate disaster recovery. **F13**. |
| P9.18 | Migration chain matches launch models and has a test gate | Complete | Migration/model checks and all 358 Python tests pass with PostgreSQL-specific tests enabled; the two historical checkpoint failures are resolved. |
| P9.19 | Deterministic accessibility helpers for alt text, simple contrast and reading order | Complete | [accessibility.ts](../packages/renderer/src/accessibility.ts) and [tests](../packages/renderer/tests/accessibility.test.ts) implement and test these bounded checks. Seed decks have no helper-reported errors; that is not all-WCAG conformance. |
| P9.20 | In-scope WCAG 2.1 AA behavior in the application | Partial | Keyboard and reduced-motion code exists, but the accessibility helpers have no application call site. Contrast checks use the text node fill or slide background, not all overlapping content, gradients or alpha composites. Full focus/dialog/keyboard/zoom/alt-editing checks are absent. **F14**. |
| P9.21 | Product metric targets, including retained generated slides | Complete | [operations doc §8](06_OPERATIONS_AND_TARGETS.md) defines retained slides >60% after the first quarter plus first-deck, acceptance/undo, export and provenance targets. This establishes targets, not achieved results. |
| P9.22 | Retained-slide metric can actually be computed and monitored | Missing | No implemented session-finalization/cohort query or retained-slide dashboard was found. Project-memory helpers and generation counts do not compute the defined metric. **F15**. |
| P9.23 | All twelve doc 05 §38 user-facing steps work end to end | Partial | Current 120-object editor drag E2E passes. A complete twelve-step launch run still lacks real signup, project/blank/manual-authoring breadth, GitHub/model demonstrations and complete exports. The historical twelve-step breakdown still applies except its transient navigation failure is resolved. |
