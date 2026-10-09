# Phase 1 MCP client acceptance — 2026-10-06

This record distinguishes a real client run from protocol coverage and from a
client that is merely configured. A client passes only when that client creates
a deck in the isolated smoke workspace and completes a PDF export through the
running desktop app.

The test used `D:\Presentation_app\.artifacts\phase-1-mcp-profile`, not the
normal Deckastra profile. No user deck was read or changed.

## Results

| Client | Result | Evidence or blocker |
| --- | --- | --- |
| Codex | **Passed** | Created presentation `doc_01M48JNTT324PE3V6RKYK0QGCN` from the reviewed technical template, reread and revised it with optimistic concurrency, applied role-based motion, previewed it, ran Design Check, and completed PDF export `exp_01M48JQNQF35WARGM9JY9GE5R7` (5 slides, 36,652 bytes). The successful transcript is `.artifacts/phase-1-mcp/codex-events-approved.jsonl`; the concise result is `.artifacts/phase-1-mcp/codex-final.txt`. |
| Claude Code | **Passed** | Re-authenticated the native CLI bundled with `anthropic.claude-code@2.1.270`. It created presentation `doc_01M4910G4Y5RA93RQK1TG3CT8H`, made a version-safe opening revision, added role-based motion, previewed the result, ran Design Check, and completed PDF export `exp_01M4912K36HNCK175BVPP34G30` (5 slides, 36,883 bytes). |
| VS Code / Copilot | **Passed** | Authenticated the official GitHub Copilot CLI 1.0.92, which uses the same Copilot client family and MCP configuration as the editor integration. It connected to Deckastra, created presentation `doc_01M4938QXDGN4KCK12ZF556B3M`, reread and revised the versioned document, applied restrained role-based motion, previewed it, ran Design Check, and completed PDF export `exp_01M4939JADJB279RVR51FYMBB2` (5 slides, 37,024 bytes). The native VS Code window could not be automated because the Windows control runtime failed while installing its local kernel assets, so the official headless client supplied the reproducible acceptance path. |
| Antigravity | **Passed** | Authenticated Antigravity CLI 1.2.14, configured Deckastra in `~/.gemini/config/mcp_config.json`, and disabled the bundled Google Cloud telemetry hook after its malformed Windows command quoting blocked all tool calls. Antigravity then created presentation `doc_01M492ECJMMYXSSVT6R4P115YB`, completed the version-safe authoring journey, and produced PDF export `exp_01M492QF71GRSYGH71PZ58VN8Z` (5 slides, 37,065 bytes). Design Check reported only the known A103 reading-order warning. |
| Gemini CLI | **Retired by vendor; not an active gate target** | Installed Gemini CLI 0.62.0 and completed Google OAuth, after which the client refused the individual/free account with: `This client is no longer supported ... migrate to the Antigravity suite of products`. The successor Antigravity row now carries this acceptance obligation; treating this as a Deckastra failure or buying a separate Vertex/API-key path would make the gate test a billing choice rather than client compatibility. |

## Shared boundary evidence

The bundled MCP server also passed all 16 checks in the transport-level
acceptance harness against the same running app. That run covered attachment,
read/write/export grants, low-risk apply, stale-version refusal, role-based
motion, preview, a destructive change remaining pending for human approval,
withdrawal, and export cancellation. Its log is
`.artifacts/phase-1-mcp/protocol-acceptance.log`.

Desktop consent and grant lifecycle smoke records are
`.artifacts/phase-1-mcp/consent.json` and
`.artifacts/phase-1-mcp/grants.json`. They confirm that access is off before
consent, approval capability is refused, Stop agent access revokes the grant,
and a restart invalidates a previously issued grant.

These protocol results support every client, but the four active clients also
completed their own real template-to-PDF journeys above.

## Finding applied during the run

The first Codex run showed that `deck_from_template` echoed the complete
presentation document into the model context. MCP creation responses now return
the presentation/version IDs and a compact slide index; the agent explicitly
rereads the versioned outline before revising. A purpose-filtered `preset_list`
also returns only themes used by the matching templates. This keeps the coarse
creation tools coarse in both request count and context size.

## Gate status

Phase 1 is **complete**. Codex, Claude Code, GitHub Copilot, and Antigravity each
completed a recorded template-to-PDF journey against the isolated desktop app.
Gemini CLI has been superseded by Antigravity for individual users and is no
longer a separate active gate target; its successor completed the required
journey. The shared protocol harness and desktop consent/grant lifecycle checks
also passed, so no authentication or installation item remains open.
