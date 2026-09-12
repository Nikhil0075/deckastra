# D2 closure audit — 2026-09-12

**Verdict: substantial implementation progress, but D2 is not ready to close.**

Reviewed HEAD `fb9d66c9c570b5d0ebaa4197d7ef6d4d610e608a` plus current uncommitted changes, including motion and preview work. Production code was not modified by this audit. Temporary reproduction tests and logs are under `.next/` and use isolated temporary databases.

## What is now implemented

- A stdio MCP server with 13 registered tools: workspace_list, document_read, document_read_slide, slide_preview, motion_capabilities, motion_propose, document_versions, document_create, document_propose, proposal_list, document_export, export_status and export_cancel.
- The tools use WorkspaceClient and the existing authority, rather than a second store.
- Attachment publication/discovery, refusal when the desktop is unavailable, and launch-secret authentication.
- Caller-authored operations, server-computed risk, pending higher-risk changes, transaction inverses and a submission-time expected-version check.
- Slide images and pending-proposal previews; semantic motion plans use the existing composer.
- Editor head polling and adoption of outside changes.
- Electron rendering backend and sidecar configuration selecting it. This corrects the earlier source-level absence of a packaged rendering adapter; fresh clean-install behavior was not rerun here.

## Blocking correctness finding: version identity is not preserved end to end

### P1 — pending approval accepts a changed head

`apps/api/deckastra_api/proposals.py:238` reloads the current head during approval, then lines 264–265 pass that head as both parent and expected version. It does not compare that head with the pending transaction's recorded parent version.

Reproduction through FastAPI TestClient:

1. Create a pending proposal deleting two elements against version A.
2. Commit a user title edit, producing version B.
3. Approve the original proposal.
4. **Actual: HTTP 200 and application. Required by the strict D2 contract: HTTP 409.**

The operations remain applicable in this example, which is why checking only patch validity misses the defect. Atomic commit protects a race after the approval read, not the identity of the version the proposal was reviewed against. Pending previews similarly replay against the current head in `routes.py`, without a base-version comparison.

### P1 — a second load can bypass the submission check

`agent_routes.py:370` checks the caller's version, but `create_proposal` independently loads the document again and commits using that second version. The caller's expected version is not passed through.

A deterministic boundary reproduction interposes a real user transaction after the route check and before proposal creation, expires the session cache to model a fresh read, then calls the original proposal function. **Actual: HTTP 200 for stale caller-authored operations; expected: 409.** This is an injected interleaving test, not a probabilistic multi-process stress run.

**Required fix:** carry the caller/base version through proposal creation, preview and approval into the atomic store comparison. Reject changed heads without writing a transaction/version; ask the caller to reread and reauthor. Add retained regression tests for both interleavings and PostgreSQL concurrency coverage. Ordinary internal-agent paths also need an explicit policy rather than silently resetting the expected version.

## Other D2 closure gaps

| Priority | Gap and source evidence | Acceptance required |
| --- | --- | --- |
| P1 | Scoped grants are absent. `attachment.ts:74` publishes the full local-owner secret; the MCP adapter's omitted tools are not server-side credential restrictions. | Authority-enforced workspace/action grants, revocation/expiry and tests that the bridge credential cannot exceed them; verify Windows ACLs rather than only POSIX mode. Alternatively obtain an explicit change to the planned grant requirement. |
| P2 | Outside-edit undo is incomplete. `useEditor.ts:618–619` adopts the new head then clears local history. The ordinary toolbar cannot undo that external transaction. | User sees and can undo the external change through a conflict-safe inverse; preserve pending user work and test subsequent local/remote edits. A stored inverse alone is not the promised user experience. |
| P2 | Active-render cancellation remains a flag. `export_service.py:418` blocks in subprocess.run until completion/timeout; request_cancel does not interrupt it. | Cancel an active export, terminate its owned worker/render subprocesses, prevent publication of a late artifact and show a terminal canceled state. |
| P2 | MCP is checkout-dependent. package.json points its bin at src/cli.ts; README invokes repository-local tsx. Desktop packaging includes sidecar and worker, not a standalone MCP entry point. | Installed app provides a working MCP launcher/runtime without this repository, development tools or global Node assumptions; verify from a clean profile. |
| P2 | D2 documentation overstates interoperability closure. The SDK acceptance script edits the open deck and exports; it does not create a deck or invoke motion tools. CLAUDE describes a Claude restyle session and a user-reported successful Codex session, not retained evidence of every planned action in both clients. | Record each real client/version driving create → revise → animate → preview → approve/apply → undo → export, including stale refusal and cancellation. User-reported successes remain valuable partial evidence. |
| P2 | D0/D1/D2 ledger and original requirement dispositions remain missing from the general remediation ledger. | Add retained/moved/replaced/still-open mappings with current evidence and carryovers. Do not declare completion from a tool count. |

Low-risk auto-application and omitting an agent approval tool are documented product choices. They are not themselves a new correctness defect. They differ from the original generic proposal.commit surface; record that mapping explicitly. Human approval still needs the version guarantee above. Underscore tool names are likewise a naming choice, not a missing feature.

## D1 carryovers

- Packaged export has a real Electron backend now; verify a freshly built installed binary with Playwright browser lookup empty, then inspect the exported bytes. Do not reuse the September 10 failure as proof that current source still fails.
- Electron paint parity remains a separate gate from scene digests. This audit did not record a new Electron baseline or run a pixel comparison.
- Fresh PostgreSQL row-lock tests and real macOS acceptance remain necessary where not supplied by current run artifacts.
- The historical runtime report is an earlier binary observation, not a current-source acceptance result.

## Fresh checks

| Command/scope | Result |
| --- | --- |
| MCP unit suite | 18 passed |
| Desktop unit suite | 15 passed |
| Workspace-client unit suite | 12 passed |
| Worker unit suite, including Electron backend mocks | 19 passed |
| API authored-proposal, preview, motion-route and local-mode suites | 44 passed, 42.07s |
| MCP and desktop typechecks | Passed |
| Additional strict version-boundary reproductions | **2 failed**, both received 200 instead of 409 |

Totals are **64 regular TypeScript tests and 44 regular Python tests passed**, plus **two audit reproductions failed**. No whole-repository green claim is made. Worker unit tests mock the Electron child-process boundary; they do not prove packaging.

Reproduce the new checks with `python -m pytest .next/test_d2_review.py -q --tb=short` while the retained local audit file is available. Logs: `.next/d2-review-stale.log` and `.next/d2-review-python.log`. The audit tests import the existing authored-proposal fixtures and do not write to the user's desktop workspace.

No new real Claude/Codex session, live MCP acceptance script, packaged-app launch, clean-machine export, PostgreSQL run or macOS test was performed in this audit. The acceptance script mutates the currently open deck; run it on a designated test workspace rather than an arbitrary user deck.

## Recommended closing order

1. Fix the expected-version chain and both failing reproductions.
2. Finish scoped grants, outside-edit undo and active cancellation.
3. Package the MCP entry point and recheck export without developer dependencies.
4. Run the complete real-client journeys on an isolated workspace and retain outputs.
5. Reconcile the ledger and explicitly carry forward platform/pixel checks that belong to other milestones.

D2 can be called ready only after its explicit acceptance requirements are proved or an intentional scope change is approved and documented.
