# Items 01–04 and delivery-plan recheck — 20 September 2026

**Conclusion: 03 and 04 pass this targeted review. The original reproductions for 01 and 02 are fixed, but both remain partially resolved because narrower failures still reproduce.** Do not interpret the green existing suites as closing those failures.

Reviewed HEAD `025fcb2c01b33d81f3ac600c651f9eae9ca2ce54` plus current uncommitted changes. This review tests and documents; it does not implement the remaining delivery plan, commit, sign or publish anything. Existing user data and source changes were preserved.

## 01 — close approval is not proof of durable recovery

**P1. Reproduced with real notes/useEditor/close-barrier components and controlled storage/HTTP failures.**

1. Type a note still inside its draft interval.
2. Make `Storage.prototype.setItem` throw `QuotaExceededError`.
3. Make transaction saves return HTTP 503.
4. Call `prepareToClose`.
5. Assert the journal contains no copy and no transaction was saved. Both assertions pass.
6. Assert closing is not approved. This fails: `closeApproved()` is **true**.

The queue survives in memory, but closing can discard its only copy. This is an explicit double-failure case, not a claim that ordinary close or offline recovery still fails.

**Code:** `useEditor.ts` catches recovery-write errors without returning durable-write success; its close participant returns `journalled` whenever `flush()` returns false. `close-barrier.ts` also converts rejected/timed-out participants to `journalled`. `apps/desktop/src/main/close-guard.ts` maps every non-clean response to `journalled` and approves after timeout. `app.ts` ignores the readiness result when quitting.

**Required correction:** propagate an explicit readiness result through every layer: `clean`, `journalled` only after confirmed current journal persistence, and `blocked/unknown` otherwise. A failed draft flush must also prevent a false `clean`. Keep the window and service available on blocked/unknown; offer retry, saving a recovery copy, or an explicit user choice to discard. A timeout is not evidence that a hung page received the request or journalled its latest draft.

**Regression acceptance:** storage-full + failed save, thrown participant, never-answering renderer, draft-flush failure and multiple windows with one unsafe participant must not silently approve quit. Ordinary clean and genuinely journalled closes should continue to work.

Evidence: [storage-repro.log](audit-evidence/items-01-04-recheck-2026-09-20/storage-repro.log), [reproducer source](audit-evidence/items-01-04-recheck-2026-09-20/audit-close-storage.test.tsx.txt).

## 02 — an older response can overwrite a newer run's resume pointer

**P1. Reproduced with the real GenerateDeck and HTTP client, using deferred responses.**

1. Start generation in project A; hold the response.
2. Unmount its drawer, as happens when switching projects.
3. Return to A in a fresh drawer and start another generation.
4. Complete the new request first; its pointer is `run_new`.
5. Complete the old request last.
6. The pointer becomes **`run_old`**, even though the current UI had the newer outline.

The cross-project display guard works, but persistence remains last-response-wins. On reopening, the user can recover the wrong outline and lose the visible route to the newer one. Neither server run is shown to be deleted.

**Code:** `GenerateDeck.tsx`, `settle`: the `awaiting_story` branch calls `remember(origin, answer.run_id)` unconditionally before applying the mounted/project guard. `remember` always overwrites. Compare-and-delete in `forget` protects removal, not this write.

**Required correction:** bind pointer writes to a generation/request identity that survives drawer remounts for the project. A completion may update its own run record, but only the still-current request may replace the project's active resume pointer. Alternatively keep a run list instead of one lossy pointer. Scope completed navigation and deciding responses to that identity too.

**Regression acceptance:** old/new generations completing in both orders across A→B→A, unmount/remount, and a late revision cannot replace a newer active run or navigate the current drawer incorrectly.

Evidence: [outline-repro.log](audit-evidence/items-01-04-recheck-2026-09-20/outline-repro.log), [reproducer source](audit-evidence/items-01-04-recheck-2026-09-20/audit-outline-order.test.tsx.txt).

## 03 and 04

- **03:** transient checkpoint failures retain the pointer and expose retry. A late 404 compare-and-deletes only the pointer it requested. Existing targeted tests pass. The overwrite failure above belongs to 02, not the fixed transient-error branch.
- **04:** explicit invalid modes now raise `IntelligenceMisconfigured`; both provider selection and client construction share validation. API tests verify health/error handling and the ModelUnavailable→503 boundary. No real model request was made. The old router docstring's statement that the typo “sent their brief” overstates the earlier probe: it established cloud selection, not an observed transmission. Reword that historical claim when next editing the file.

## Added plan: sound scope, with these corrections before execution

The supplied plan narrows the first release to **Windows x64, local-only, MCP or user-key cloud generation, 0.9.0-beta.1, manual upgrades**. Excluding macOS, local packs, cloud collaboration and `.mydeck` file handling is a scope decision; do not build them as mandatory gates. Their exclusions must become actual onboarding/release copy as planned.

1. **Close timeout policy must change.** “Every window answered or timed out” is not the condition for safe automatic shutdown. Use the durable-result contract described in 01.
2. **Use request identity as well as project identity.** A project key/mounted ref alone does not fix the 02 pointer overwrite across remounts.
3. **Resolve the stub-mode contradiction.** Stage 1 allows only unset/local/cloud; Stage 2 proposes explicit `DECKASTRA_INTELLIGENCE=stub` in development. Either introduce that value deliberately with distribution refusal tests or keep a separate explicit test-only mechanism. Do not bypass validation ad hoc in smoke code.
4. **Finalize the manifest after all payloads exist.** `build.mjs` currently runs before `build:sidecar` in packaging. A manifest claiming to hash the final sidecar cannot be finalized at that earlier step. Hash after bundling/freezing all resources; define which files are included and exclude the manifest's own hash to avoid a cycle. Dirty-tree identity must cover relevant untracked source, not just `git diff` of tracked files.
5. **Coordinate the backup snapshot.** Separate online backups of the main SQLite DB and checkpoints plus an asset copy are not automatically one consistent snapshot. Quiesce relevant writers/asset deletion or implement a defined snapshot boundary across DB, checkpoints, assets and renderer journals. Test a generation/export/edit occurring during backup, not only idle restoration.
6. **Prepare installed tests that do not depend on the checkout.** The current `a11y` smoke dynamically reads `axe-core` and explicitly says it needs a checkout. Supply a separate acceptance bundle or documented test-runner dependency; do not require it in the customer payload or silently skip it as an installed pass.
7. **Scope the redaction guarantee.** A generic pass cannot reliably recognize arbitrary document text. Prefer structured, allowlisted diagnostic fields and avoid logging prompts/documents at source; test keys, grants and known sensitive content. Do not claim comprehensive document-text removal from arbitrary stderr.

The remaining order is reasonable after these corrections. Build the unsigned internal candidate before tests that require installation; strict signing verifies the exact final artifacts after the applicable checks. Keep real-host MCP, real IME/NVDA/displays and certificate-dependent runs open until evidence exists.

## Independent verification

- `npm test`: **1,241 passed, 1 skipped** (optional renderer contact-sheet writer).
- `npm run typecheck`: pass.
- Targeted API/agent tests (`test_intelligence_selection.py`, `test_story_review.py`, `test_local_intelligence.py`): **48 passed**.
- Current desktop bundle build: pass. No new installer was built.
- Additional storage reproducer: existing copied cases **8 passed**, the added storage-failure case **failed**.
- Additional outline reproducer: added ordering case **failed**; 8 inherited cases deliberately deselected with `-t audit:`.
- Full Python suite and all 18 ordinary desktop smoke steps were **not rerun** in this focused review. Prior/user-reported results are not counted as new passes.

Native close/relaunch checks passed in **all four variants**: window close and app quit, each with the service running and killed first. Each `close-verify` found the note after relaunch on its isolated profile. Evidence is stored in the four scenario directories beside this report's test logs. The first harness attempts timed out before producing smoke records; after explicitly precreating the isolated profile/output directories, the reruns completed. Those initial timeouts are not presented as successful tests or as a demonstrated application regression. Real OS shutdown/sign-out and real IME remain unverified.

Reproducer files are stored with `.tsx.txt` suffixes, outside normal test discovery. To rerun, copy into `packages/editor-ui/tests` with `.test.tsx` suffixes and run Vitest there. Application source and supplied plan were left unchanged.
