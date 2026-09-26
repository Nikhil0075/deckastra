# Desktop UI Phase 0–6 acceptance audit — 19 September 2026

The current Windows development build passes the tested core workflows, including real MCP creation and animated morph playback. It is **not ready for delivery solely on that basis**. Two interaction defects were reproduced independently: export can omit unsaved edits, and project switching can display another project's cards. Phase 2's notes editor also does not implement the planned rich-text editing contract. Phases 7 and 8 remain separate delivery work.

## Scope and evidence

- Baseline: the supplied “Deckastra editor UI rewrite to the DeckOS — Editor UI (Minimal) Figma” plan, Phases 0–6. This is the UI rewrite plan, not the older product Phases 0–9 or desktop D0–D6 plan.
- Reviewed HEAD: `025fcb2c01b33d81f3ac600c651f9eae9ca2ce54`, **plus the existing uncommitted UI/backend changes** on 19 September. Testing a clean checkout would not test this work.
- Fresh `npm run build --workspace @deckastra/desktop`; Electron 33.4.11 / Chromium 130.0.6723.191. Smoke records explicitly say `packaged: false`.
- Isolated data/profile: `.next/ui-phase6-review/profile`. No real user decks were used. MCP acceptance created its own deck in that profile.
- Native desktop inspection used the actual Electron window. Automated desktop checks used the repository's main-process smoke harness. Component reproducers used real components/hooks and the HTTP workspace client with controlled responses.
- Generation used the stub provider. No paid inference or model download was performed.
- No application source, fixture, or pixel baseline was changed by this audit. The two temporary failing tests were preserved as `.tsx.txt` evidence, then removed from the normal test discovery path.
- Durable evidence: [audit-evidence/2026-09-19-ui](audit-evidence/2026-09-19-ui). Full working logs and screenshots are also under `.next/ui-phase6-review/` (ignored build output).

## Confirmed defects

### UI-01 — P1: export can omit what the editor currently shows

**Evidence:** `packages/editor-ui/src/components/shell/AppBar.tsx:111` mounts `ExportPanel` with only `presentationId`. `ExportPanel.tsx:60` starts the export directly; it has no save/drain contract. `useEditor.ts:40` debounces autosave for 900 ms. `apps/api/deckastra_api/export_routes.py:63` loads the persisted head and pins that version for export.

**Reproduction:** apply a title change through the real `useEditor`, immediately press PDF in the real `ExportPanel`, and observe the persisted state when the export request arrives. The editor contains `latest`; the export request captures `old`. The assertion fails with `expected 'old' to be 'latest'`. This is a controlled component/HTTP-boundary reproduction, not a claim that a physical rapid click was timed in Electron. An in-flight or failed save exposes the same missing ordering contract for longer than the debounce window.

**Impact:** the exported file can exclude edits visible on screen. A successful export then gives a misleading impression that the current work was included.

**Remaining work:** supply an editor save barrier to the export action; await a successful drain before creating a job. A refused/conflicted save must prevent exporting stale state unless a separate explicitly labelled “export saved version” action is chosen. Ensure draft speaker notes have committed before that barrier.

**Acceptance:** with a queued edit, a held save, a failed save, and a 409, verify the export either pins the acknowledged edited version or does not start and explains why. Test PDF and PPTX entry points. Keep export retry semantics explicit about which version is retried.

Reproducer: [export-save-repro.test.tsx.txt](audit-evidence/2026-09-19-ui/export-save-repro.test.tsx.txt); [failure log](audit-evidence/2026-09-19-ui/export-save-repro.log).

### UI-02 — P1: late project responses overwrite the selected project's deck list

**Evidence:** `packages/editor-ui/src/components/DeckList.tsx:112–125` awaits `documents.list(projectId)` and calls `setDecks` without checking whether that project is still selected or whether a newer request completed.

**Reproduction:** hold project A's response, switch to B, allow B's cards to appear, then release A's response. The A card replaces the B card while B remains selected. The independent component test fails because `A only deck` is still present.

**Impact:** users can open, duplicate, move, or delete a deck from the wrong apparent project. This is a UI identity/race defect, not evidence of a server authorization bypass.

**Remaining work:** associate each list request and its error with the selected project and current request generation. Abort or ignore stale results, including refreshes after mutations. Preserve loading/error distinctions.

**Acceptance:** delayed A→B and A→B→A responses never replace the current list; stale errors do not replace a successful current response; delayed duplicate/delete refreshes cannot populate a different project's view.

Reproducer: [project-race-repro.test.tsx.txt](audit-evidence/2026-09-19-ui/project-race-repro.test.tsx.txt); [failure log](audit-evidence/2026-09-19-ui/project-race-repro.log).

## Phase coverage and remaining gaps

These are evidence-based classifications, not a percentage calculated from arbitrary feature counts. A passing smoke covers the assertions it makes, not every possible interaction in that phase.

| Phase | Assessment | Verified / remaining |
|---|---|---|
| 0 — foundations | Implemented; visual fidelity unverified | Tokens, bundled fonts and primitives are present; the actual light desktop shell renders. Exact Figma token/frame comparison was not performed, and complete keyboard/assistive-technology coverage remains a Phase 8 gate. |
| 1 — shell | Implemented core; partial acceptance | Split app bar, rail, strip, inspector and modes render; editor build/typecheck and edit/reload pass. Export's missing save barrier is UI-01. Existing inline-styled panels remain, e.g. `ExportPanel.tsx`; the plan's styling discipline is not fully met merely because the new shell uses `dk-*` classes. |
| 2 — slides and notes | Partial | Add, duplicate, move, note persistence and undo/reset passed in Electron. **Rich-text notes authoring is absent**: `SpeakerNotes.tsx:108` uses a textarea and warns at line 136 that existing formatting survives only until editing. Plain-text editing with a warning is an explicit implementation choice, but does not satisfy the plan's RichText/paste-allowlist requirement. Real OS IME composition and pointer reorder need dedicated acceptance beyond unit tests and the keyboard smoke. |
| 3 — present/presenter | Core tested; full display acceptance unverified | Real presenter window advances audience click steps; blackout round-trip passes. Morph movement and settling were sampled over time. Physical multi-monitor/DPI behaviour, sustained timer/remaining behaviour, reduced-motion OS configuration and interruption/backward navigation across a representative deck still need an acceptance matrix. |
| 4 — deck list | Partial; UI-02 blocks completion | Duplicate, open, delete/undo and restoration of the original deck pass. List/cards/counts/search/sort code and tests exist. The project-response race is reproduced. Large-project scrolling, delayed thumbnail loads, and cross-workspace move/asset behaviour were not exercised manually in this UI run. |
| 5 — history | Tested core complete; failure cases need broader runtime evidence | Drawer, changed-slide comparison, restore as a new version, undo, and restoring original content pass. Existing hook/API tests cover parts of persistence. Multi-window stale restore and service failure during restore were not separately driven through this new drawer. |
| 6 — AI | Core workflow tested with stub; partial product acceptance | Pending proposal before/after pictures and reject pass; story checkpoint appears, revise requires a note, revise/approve resumes generation and creates a six-slide deck. Real-model quality/latency and real Claude/Codex host interoperability remain unverified. See implementation choices below. |

### Choices that should be acknowledged, not misreported as broken features

1. **Proposal images:** the plan specified `documents.preview`; `ProposalsPanel.tsx` and `lib/proposal-preview.ts` instead apply operations to a copy and render locally with the editor renderer/browser measurer. Before/after images worked in Electron. This is a deliberate implementation deviation, not “proposal preview missing.” Acceptance should additionally establish image/asset fidelity and stale-preview behaviour against the version actually approved.
2. **Local checkpoints:** the original plan assumed no SQLite checkpoint support. Current local code and the real AI smoke offer and resume a story checkpoint successfully. Do not mark this missing from that older assumption. PostgreSQL checkpoint tests also passed in the service rerun.
3. **Notes:** the plain-text warning is honest, but it remains a reduced implementation of the requested rich-text workflow. Either implement it or explicitly revise the delivery requirement; do not silently count the original requirement as complete.

## Morph and MCP: answers to the specific concerns

**Morph did work in the tested fixture.** The smoke navigated to the actual morph destination, captured 35 frames with non-identity transforms over about 609 ms, then found zero displaced/moving elements and one settled stage. This disproves a blanket “morph is broken” claim for that path. It does not test Phase 7's forthcoming manual/automatic pair authoring UI or every geometry/content combination. [Morph evidence](audit-evidence/2026-09-19-ui/morph.json).

**MCP could create and modify a deck.** All 16 checks passed using a real MCP SDK client over stdio attached to the current desktop authority. It listed 14 tools, created its own deck, applied low-risk operations, refused a stale change, planned motion, paired a shared headline across slides, warned about carry on an unsupported transition, rendered a preview, left destructive work pending for a human, attributed the client, cancelled a running export, and completed a PDF export of 10,616 bytes. No product model was needed. [MCP evidence](audit-evidence/2026-09-19-ui/mcp.log).

Agent access is deliberately off until enabled. The consent smoke verified no attachment before consent, grant success, approval refusal (403), and revocation (401). I enabled access only on the isolated profile for MCP testing and revoked it afterwards. Neither this SDK run nor the consent smoke is a real Claude Code/Codex host session.

## Verification results

| Check | Result |
|---|---|
| Current desktop build | Pass |
| `npm test` | **1,131 passed, 1 skipped** across workspace test runs |
| `npm run typecheck` | Pass |
| `npm run schema:drift` | Pass; no generated artifacts changed |
| `python scripts/validate_fixtures.py` | Pass: 3 fixtures, 6 base negatives, malformed-known-line rejection and genuine-unknown preservation |
| `python -m pytest apps/api agents integrations -q --tb=short -ra` | **660 passed, 22 skipped**, 530.87 s; PostgreSQL/MinIO unavailable for the initial run |
| Service-dependent rerun after starting existing PostgreSQL/MinIO images | **33 passed, no skips**, 41.32 s; includes all 22 previously skipped cases plus 11 already-covered cases |
| `npm run test:browser --workspace @deckastra/worker` | **7 passed**: browser metrics/digests and actual image pixels |
| `PIXELS=1 REQUIRE_PIXEL_BASELINE=1 npm run test:pixels --workspace @deckastra/renderer` | **4 passed**, Windows committed baseline unchanged |
| Desktop smoke steps | **15/15 records `ok: true`**: open, edit, verify, slides, presenter, decks, history, ai, export, timeline, morph, windows, resilience, consent, digest |
| Real MCP stdio acceptance | **16/16 passed** |
| Two independent adversarial component reproducers | **2 expected failures revealing UI-01/UI-02**; not hidden inside the green existing-suite claim |

The Python runs together cover all 682 collected tests successfully, but this was **not one 682-pass run**: the rerun selected the service-dependent files. The single skipped TypeScript test is the optional renderer HTML contact-sheet writer (`tests/preview.test.tsx`, requires output configuration), not a failed renderer check.

Desktop smoke console and CSP arrays were empty. Digest baselines matched all three fixtures inside Electron. PDF smoke completed with four slides and displayed degradation reporting. Timeline smoke exercised drag, keyframe drag, duplicate, conflict suggestions, applying a fix and undo. Resilience smoke retained edits during a sidecar outage and verified them after restart/reload.

**Limits of green checks:** `runWindows` in `apps/desktop/src/main/smoke.ts` records the second writer's conflict surface but does not assert the full merge/retirement contract. It returned `secondWindowSaved: false` and showed retained local work, which is an expected refusal, not proof that merging is complete. The separate `present` smoke step was not run; presentation was exercised through presenter and morph steps. Renderer pixels are not full-editor screenshot baselines.

## Before delivery after Phase 8

- [ ] **P1:** resolve UI-01 and UI-02 and retain their regressions in the normal test suite.
- [ ] **P2:** deliver rich-text notes, or formally narrow the notes requirement and verify the deliberate formatting-loss UX, IME and paste behaviour.
- [ ] **Phase 7:** author cut/fade/slide/zoom/morph, duration/easing and manual/automatic shared pairs through ordinary undoable operations; test add/break pair, reorder/delete/missing pair, real playback, backward navigation, reduced motion and interruption. Playback already working does not close authoring.
- [ ] **Phase 7:** test the role-based motion proposal UI, pending approval behaviour, timeline drag/trim/split/ripple and its frame-budget gate in the restyled layout.
- [ ] **Phase 8:** canonical read-only code mode, dark tokens and all hosted panels, keyboard shortcuts, focus restoration/trapping, screen-reader labels and comfortable narrow-window layouts. The token file explicitly says dark values are not implemented yet.
- [ ] Compare all target screens to the actual Figma frames, including export, theme, history and conflict panels; verify scrolling, long labels, loading, empty, error and disabled states. No exact Figma fidelity score is claimed here.
- [ ] Exercise stale AI approval, stale history restore, project switching under delay, autosave/export ordering and recovery through the complete UI.
- [ ] Run actual Claude Code and Codex create → revise → animate → export sessions, including clear instructions for enabling/revoking agent access.
- [ ] Test real local-model refusal, valid structured output, performance and no-cloud-fallback behaviour on the release configuration; stub generation alone cannot establish these claims.
- [ ] Build/install the **current** UI package outside the checkout, test first launch/migrations, assets, export/download, native menus and restart/recovery. This run used current development assets, not a rebuilt installer; historical packaged-export evidence does not certify this UI build.
- [ ] Verify macOS on real hardware, signing/notarization/update/recovery and multi-display presentation. Windows results are not macOS evidence.
- [ ] Run Linux CI/pixels against its own baseline and shared-workspace/offline conflict acceptance on the release candidate. The current Windows run does not establish those environments.

## Reproducing the audit defects

Copy one `.tsx.txt` reproducer from `audit-evidence/2026-09-19-ui` into `packages/editor-ui/tests` with its `.test.tsx` suffix, then run from `packages/editor-ui`:

```powershell
node ../../node_modules/vitest/vitest.mjs run tests/export-save-repro.test.tsx
node ../../node_modules/vitest/vitest.mjs run tests/project-race-repro.test.tsx
```

These files intentionally assert the desired safe behaviour and fail on the audited implementation. They use controlled transport responses to make the races deterministic, not live production accounts. Full original test logs and initial working-tree status are retained under `.next/ui-phase6-review`.

## Follow-up — 19 September 2026 (UI Phase 9)

Added after the audit; the findings above are unchanged. Details are in `CLAUDE.md`, "Phase 9".

- **UI-01 fixed.** `ExportPanel` commits a focused field's draft, drains the save queue, and exports the acknowledged version. The API refuses a mismatched `expected_version_id` with 409. A failed or conflicted save starts nothing and offers an explicitly labelled "Export the last saved version". The reproducer is now `packages/editor-ui/tests/export-save-barrier.test.tsx`. It covers queued, held, failed and 409 saves, the service's 409, a draft in a focused field, and both PDF and PPTX; five of its seven cases fail with the barrier removed. The `export` smoke step types a note, leaves it unsaved, presses PDF from script, and checks the file's version is the head holding the note.
- **UI-02 fixed.** List loads take a ticket and write only if they are the newest request and still for the selected project. This covers stale answers, stale errors, and refreshes after mutations. The reproducer is now `packages/editor-ui/tests/deck-list-race.test.tsx`, covering A→B, A→B→A, a stale error and a delete-refresh. All four cases fail with the guard removed. There is no real-app step, because the race needs controlled timing.
- **Notes: rich text implemented**, rather than the requirement being narrowed. The notes field is a contenteditable on the canvas editor's model, with Bold, Italic, Underline and both list types, allowlisted paste that keeps marks, IME deferral, and structured rendering in the presenter view. Real-engine formatting is checked by the `slides` smoke step. Real OS IME composition is still covered only by events in unit tests, not by a physical IME session.
- **Found along the way:** blank lines read back as two, `<ol>` items read back as bullets, and Ctrl+Z in any text field undid the deck. These were shared with the canvas editor and are fixed in `packages/editor`.
- **Verification:** `npm test` green across workspaces; typecheck clean; `pytest apps/api agents -m "not slow"` 600 passed / 15 skipped; the new export route test passes; renderer digest baselines unchanged. Desktop smoke is 18/18 on a fresh isolated profile: open, edit, verify, slides, history, export, a11y, ai, motion, presenter, decks, present, timeline, morph, consent, menu, windows, resilience.
- **Still open from the delivery list:** Figma fidelity comparison, an installer built from this UI, real Claude Code/Codex sessions, local-model release checks, macOS, and Linux CI on the release candidate. Phases 7 and 8 were delivered after this audit was written.
