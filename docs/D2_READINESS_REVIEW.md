# D2 readiness review

Reviewed 2026-09-10 against the current uncommitted worktree. This is a code and targeted-test review, not a new installed-application acceptance run.

## Verdict

Proceed toward D2, but keep D1 partial. The suggested sequence is sensible. D2 is more than a protocol wrapper: several authority contracts must be added first. Fold packaged export into D2 because its exit depends on export, while retaining its original D1 ownership in the ledger.

## Corrections and findings

1. **Stale proposal approval is not currently a strict 409 boundary.** `apps/api/deckastra_api/proposals.py:approve` loads the current head, reapplies the stored operations, and passes that head as both parent and expected version. A valid patch can therefore apply after the proposal's original base changed. Atomic commit protects against a race after that read; it does not bind approval to the reviewed version. D2 must persist the proposal's base version, validate it at creation and approval, and reject a changed head with 409. Test an intervening edit where the original patch still validates.

2. **Proposal creation currently may mutate immediately.** `create_proposal` auto-applies when risk does not require approval; it has no caller base-version argument. For the proposed external `document.propose` / `proposal.preview` / `proposal.commit` flow, define an explicit pending-only path. Keep risk server-computed and reuse the existing validator, transaction store and inverse calculation. Do not accidentally auto-commit caller-authored operations before preview.

3. **The discovery file is proposed, not implemented.** `apps/desktop/src/main/sidecar.ts` creates a per-launch secret in memory, and the renderer uses a main-process proxy. `workspace-state.ts` persists a presentation pointer, not service credentials. A new external-agent bridge needs lifecycle-aware discovery and authorization. Prefer a separate scoped bridge credential rather than distributing the full local-owner bearer. If a credential file is selected, enforce user-only access/ACLs, atomic replacement, restart invalidation and stale-process checks. Do not claim same-user processes cannot read a disk credential.

4. **WorkspaceClient needs additive contracts before MCP can be thin.** `packages/workspace-contracts/src/client.ts` provides document create/read/commit, instruction-based agent edits and export jobs. It does not yet expose caller-authored proposals, rendered proposal previews, motion capabilities or motion proposals. Account context can supply workspace discovery. Keep the MCP adapter over these authority methods; never implement persistence in the adapter. Tests must make model construction/invocation fail if called during external proposal handling.

5. **Packaged export is genuinely open; CDP is an approach, not an existing integration.** `apps/worker/src/render.ts` still calls `chromium.launch()`. Bundled worker code exists, and `export_service.py` has an explicit missing-browser explanation. Reusing Electron requires a rendering-session adapter and clear ownership: jobs must not close the desktop browser, navigate an editor page or expose unrestricted debugging access. Test isolated export pages, concurrency, cancellation, timeout cleanup and app shutdown. Run the installed application without a Playwright browser cache and verify downloaded bytes, not only the presence of a Download button. The current smoke export step checks the latter.

6. **PIXELS=1 alone does not test Electron.** `packages/renderer/tests/pixels.test.ts` launches Playwright Chromium. Add an Electron capture backend or acceptance harness and record the Electron/Chromium version, fonts, scale and platform with a separately reviewed baseline. Do not overwrite the Playwright baseline with Electron paint. Keep repeat/reload and negative-control checks.

7. **PostgreSQL is pending for this review, not proven never tested.** `POSTGRES_TEST_URL` is unset here. The repository contains PostgreSQL asset-quota and export-claim concurrency tests. Earlier ledger entries contain PostgreSQL evidence for earlier code, which does not prove the current row-lock branches. Run the current relevant suite against PostgreSQL and record its revision, command and results. A single service process still permits concurrent requests/jobs; SQLite write serialization alone is not proof that every read-then-write invariant is safe.

8. **A presenter window already exists.** Desktop window creation and the `present` smoke step are implemented. D4 should finish presenter behavior, motion authoring and acceptance rather than list a second window as entirely missing. Likewise D3 needs more than one ModelClient class: model packaging, capabilities, structured output, accounting, cancellation and hardware behavior remain substantial work.

9. **D1 evidence needs reconciliation.** CLAUDE.md labels D1 measurements as a development build, then labels its table and following claims as installed-app results. Resolve this using retained run artifacts. The general progress ledger lacks explicit D0/D1 rows and the original-requirement disposition mapping. Do not infer completion from prose or from these unit tests.

## Recommended D2 order

1. Add evidence-backed D0/D1 ledger rows; distinguish implemented, locally tested, installed-tested and unavailable-platform checks. Map each applicable original requirement to retained/moved/replaced/still-open, with rationale and evidence.
2. Define version-bound, non-mutating external proposals and authority-owned commit/preview/motion contracts. Include request deduplication and scoped client grants.
3. Implement desktop bridge discovery/lifecycle, attach-only behavior and restart failure handling.
4. Add the stdio MCP adapter and protocol tests; keep stdout reserved for protocol messages.
5. Complete packaged rendering/export and Electron pixel evidence.
6. Run real Claude Code and Codex sessions: create, revise, animate, preview, commit, undo and export. Include a stale proposal, an unsaved editor change, service restart and canceled job. Verify open-editor refresh/reconciliation after external commits; a correct database write alone is not a complete user journey.

## Fresh verification

- Desktop unit tests: **11 passed**.
- Workspace-client unit tests: **12 passed**.
- Tests cover bridge/client behavior; they do not establish installed export, Electron pixel parity, macOS behavior or external-client interoperability.
- No installed application, PostgreSQL, macOS or MCP client acceptance tests were run in this review.
- Application code was not changed by this review.

The original desktop proposal and Phase 0–9 ledger remain the baseline documents. This review qualifies the supplied remaining-work summary; it does not mark D1 or D2 complete.
