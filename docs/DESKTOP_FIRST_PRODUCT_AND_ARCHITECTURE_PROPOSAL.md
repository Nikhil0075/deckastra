# Deckastra: desktop-first agentic presentation studio

**Date:** 2026-09-08  
**Status:** Proposal for product and engineering direction; no desktop implementation is claimed.  
**Baseline:** repository HEAD `6f06c46250879b287f9ba73bc41e15a2f7d7cf75` plus the current uncommitted remediation work.  
**Scope:** macOS and Windows as primary authoring platforms; optional cloud workspaces and browser sharing/presenting.

## 1. Recommended direction

Build a **local-first presentation studio that people and agents can operate together**. A user should be able to open local material, turn it into an editable narrative, refine its visual explanation and motion, and present without a network connection. Signing in adds shared workspaces, invitations and publishing rather than unlocking basic local work.

Keep the existing schema, renderer, animation engine and transaction system. Extract reusable editor UI from the Next.js application and put it inside a desktop shell. Retain the web application for shared viewing, presenting and progressively richer collaboration. Do not rewrite the presentation engine in a native UI framework.

The product promise should be: **“Bring your work and your preferred AI. Build an editable visual story, including motion, and present it anywhere.”** This is a positioning hypothesis, not a verified claim that competitors lack these capabilities.

Desktop shifts inference, indexing and rendering onto user hardware and can lower recurring server compute. It also introduces installers, updates, device variability, local recovery and distributed synchronization. It is not automatically easier overall; the existing shared engines make the migration practical.

## 2. The experience to build

### Local creation

1. Launch directly into a local workspace, without requiring an account.
2. Drop in a folder, repository, PDF, notes or an existing `.mydeck` document.
3. Choose an audience and outcome, then select local AI, an external agent or an optional cloud model.
4. Review the proposed story and source citations before generation.
5. Watch editable slides appear. Change a slide manually or ask for a targeted revision.
6. Ask for a visual explanation: “Reveal these services in dependency order; animate the request path; retain the diagram across the next slide.”
7. Preview, undo, export and present locally.

Show where each task runs and what material leaves the machine. Local mode must never silently fall back to a cloud model.

### Agent-led creation

A user working in Claude Code, Codex or another compatible client asks it to create a presentation from the current project. The client calls Deckastra's tools, receives structured diagnostics and previews, and proposes changes to the open workspace. The user can keep editing normally; stale agent proposals must not overwrite newer changes.

### Team use

The owner opts a workspace into sync and invites collaborators. Each member has a local working copy. The browser can open a shared version without installing the app. Presenting pins a document version and its assets so collaborator edits do not unexpectedly change the slide being shown.

Start with asynchronous collaboration and explicit conflict recovery. Add live co-editing as a separate milestone; synchronization alone is not live collaboration. Co-presenting also needs its own presenter authority and playback-state protocol.

## 3. What the current repository gives us

| Existing foundation | Reuse | Required adaptation |
| --- | --- | --- |
| `packages/presentation-schema` | Portable documents, generated validation, forward compatibility | Continue one schema authority across desktop, cloud and external tools |
| `packages/transactions` and `packages/editor` | Patches, inverses, selection and editing primitives | Route local, agent and synchronized writes through a common command boundary |
| `packages/renderer`, `packages/layout-engine` | DOM/SVG scenes, measurement and layout | Desktop fonts/assets, display scaling and platform verification |
| `packages/animation-engine` | Tracks, compilation, playback and presets | Complete authoring tools, agent motion tools and transition acceptance |
| `apps/web/components`, `apps/web/lib/useEditor.ts` | Working editor, undo and recovery workflows | Extract UI and replace embedded HTTP assumptions with host services |
| `agents/deckastra_agents` | Orchestration, model routing, tools and budgets | Package a local runtime; add local providers and durable local runs |
| `apps/api/deckastra_api/store.py` | Versioned storage and concurrency behavior | Separate local ownership from cloud authorization and synchronization |
| `apps/worker` and export packages | Browser measurement and export foundation | Local job lifecycle and packaged rendering runtime |

The root workspace currently lists `apps/web` and `apps/worker`; a desktop application and public MCP server are not implemented. The original architecture in doc 05 explicitly chooses web-first and a later Electron shell. This proposal changes delivery priority; it does not silently rewrite the original specifications or declare their remaining gaps closed.

## 4. Desktop framework recommendation

**Start with an Electron feasibility build, with macOS Apple Silicon and Windows x64 as the initial target matrix.** Decide Intel Mac support after measuring demand and maintaining a build/test target for it.

| Option | Benefit for Deckastra | Cost or risk | Recommendation |
| --- | --- | --- | --- |
| Electron | Closest fit to the existing React/DOM/SVG and Chromium rendering pipeline | Larger runtime, memory overhead and platform packaging | First implementation candidate |
| Tauri | Uses operating-system webviews and avoids bundling the same browser runtime | macOS uses WKWebView; Windows uses WebView2, introducing another parity matrix | Reconsider if measured footprint requirements defeat Electron |
| Separate native UIs | Strong platform-specific integration | Duplicate UI work and a difficult bridge to the existing renderer | Defer |

Tauri's platform webview differences are documented in its [process model](https://v2.tauri.app/concept/process-model/). Choosing Electron is an engineering inference from this repository's renderer, not proof of identical rendering across machines: fonts, GPU drivers and scaling still differ.

Use a sandboxed renderer with context isolation and a narrow, typed preload bridge. Keep filesystem access, secrets and process management outside the renderer. Electron documents these boundaries in its [security guidance](https://www.electronjs.org/docs/latest/tutorial/security). Do not expose arbitrary shell execution to slide content or agent tools.

Ship a bundled editor frontend, not a desktop window pointing at the hosted website. Extract the editor into a reusable package with a small desktop frontend entry point; keep Next.js routes in the web host. A running development server must not be an installation prerequisite.

## 5. Target process and package boundaries

```text
Desktop React editor / presenter          External agent client
             |                                   |
       typed host commands                    MCP bridge
             +-------------------+---------------+
                                 |
                     Local workspace authority
             validation / versions / transactions / jobs
                    |             |              |
                SQLite       asset store    agent supervisor
                    |                            |
                sync outbox              local model / optional provider
                    |
          Optional cloud workspace service
            identity / membership / sync / assets
                    |
         Browser sharing, presenting, collaboration
```

Proposed repository additions:

```text
apps/desktop/                 Electron main, preload, frontend and packaging
apps/mcp-server/              External agent protocol adapter
packages/editor-ui/           Shared editor components, independent of Next routes
packages/workspace-contracts/ Host commands, events and capability schemas
packages/workspace-client/    Desktop IPC and web HTTP implementations
packages/sync-core/           Outbox protocol, reconciliation and version rules
```

Initially reuse the Python agent and persistence modules as a packaged, supervised sidecar. Avoid porting LangGraph and simultaneously changing the host. Give the sidecar a private local data directory, bounded job execution and explicit shutdown/restart behavior. Users should not install Python, Node, Docker or PostgreSQL.

Use an authenticated local IPC channel; if a temporary loopback HTTP adapter is needed, bind only to loopback, use a per-launch secret, validate origins and never expose it to the LAN. Keep one writer authority per workspace. External tools must call that authority, not edit its database directly.

SQLite is local persistence; PostgreSQL remains the cloud service store. This is not SQLite database-file replication. Persist a committed version and its outbound sync record in one local transaction, then upload idempotently. Store asset bytes separately by content hash. A portable bundle can package the document and dependencies; do not silently change the existing JSON `.mydeck` format into an archive.

## 6. Local AI: include the capability, choose the model by evidence

Use a downloadable model pack, offered during onboarding or on first use, rather than making a multi-gigabyte download mandatory for every installation. Manual editing and external-agent access should work without it.

Evaluate `llama.cpp` as the initial packaged inference backend. It supports Apple Silicon acceleration and multiple hardware backends; its server offers schema-constrained output. See its [project](https://github.com/ggml-org/llama.cpp) and [server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md). Grammar conversion covers a subset of JSON Schema, so generated output still needs authoritative document and semantic validation; see [grammar support](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md).

Do not select a permanent model name or promise hardware performance yet. Benchmark quantized small instruction-model candidates, including approximately 3–4B and 7–8B classes, on real target machines. These are evaluation classes, not guaranteed device requirements. Model licensing, redistribution permission, chat templates and structured-output compatibility are release gates.

| Task | Default candidate execution |
| --- | --- |
| Rewrite, summarize, titles, speaker notes and intent classification | Small local model |
| Outline from a bounded set of retrieved passages | Local model when quality gates pass |
| Geometry, alignment, validation, timing and rendering | Deterministic engines |
| Complex narrative synthesis, visual critique and specialist reasoning | External agent or explicitly selected stronger model |
| Embeddings/indexing | Separate local embedding model or lexical retrieval fallback |
| Image/video generation | Optional connector; never assumed to exist in the small text model |

A small model should propose a compact story or edit intent. The composer and motion compiler turn that intent into valid geometry and animation. Asking it to emit the whole deck, exact coordinates and hundreds of keyframes in one response increases failure risk.

Add provider capability metadata: context limit, output schema support, tools, images, cancellation and token accounting. Reuse the current router and budget boundary. Bound concurrency, context and memory; unload idle models, support cancellation, verify model hashes and recover interrupted downloads. Report local errors and offer manual editing or an explicit alternative rather than uploading automatically.

Benchmark latency, peak resident memory, thermal behavior, first-pass validity, factual source alignment and time to a user-accepted deck. A model that produces valid JSON but poor content does not pass.

## 7. Connectivity and external agents

There are two independent directions:

- **Inbound:** Claude/Codex/other clients operate Deckastra through an MCP server.
- **Outbound:** Deckastra reads approved folders, repositories and connected services through scoped connectors, including selected MCP servers.

Start inbound access with a stdio adapter attached to the running local authority. Add remote HTTP access only for explicitly shared cloud workspaces. MCP defines stdio and HTTP transports; pin a supported protocol/SDK version and test client negotiation rather than assuming universal compatibility. See the [transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp). Actual Claude and Codex interoperability is a release test, not established by implementing tool names.

Proposed initial tool surface:

| Tool | Result |
| --- | --- |
| `workspace.list`, `document.read` | Authorized workspace/deck context and base version |
| `document.create` | A valid local draft |
| `document.propose` | Validated proposal, affected objects and diagnostics |
| `proposal.preview` | Rendered slide previews, scene digest and motion samples |
| `proposal.commit` | Version-checked transaction under the user's configured grant |
| `motion.capabilities`, `motion.propose` | Supported motion primitives and a validated plan |
| `document.export`, `job.status`, `job.cancel` | Local asynchronous job lifecycle |

Prefer stable IDs and structured errors. Include request IDs for deduplication and expected base versions for commits. Return bounded summaries and resource references instead of whole workspaces or unrestricted local paths. Proposals are reversible through ordinary history. Approval policy can allow routine edits within a scoped session grant; sharing, changing access or exporting outside an approved location requires the appropriate user authority.

The external client may supply the intelligence itself. Its call to compose or validate must not automatically start a second paid model call. Using an external agent also does not mean content stays local: explain that the client may process tool results with its own provider.

Connector sequence: selected local files/folders and repositories first, then the existing GitHub integration, then user-prioritized document/design services. Each connector needs provenance, incremental refresh, revocation and content boundaries. Do not add many shallow integrations before one complete source-to-deck flow works reliably.

## 8. Animation and transitions as a central product capability

Keep authored intent separate from executable playback. Agents should work with semantic targets such as “database node,” “the retained diagram” or “third reveal,” which resolve to stable element IDs.

Provide three authoring levels:

1. **Presets:** reveal, emphasis, path drawing and sequencing with duration, easing and reduced-motion behavior.
2. **Editable motion plans:** dependency order, click segments, stagger, named markers and shared-element mappings across slides.
3. **Advanced tracks:** property keyframes, timeline drag/trim/split/group/ripple, conflict diagnostics and precise scrubbing.

Example: “On click, move the request through the gateway and database; on the next slide preserve those services and reveal caching.” The planner produces targets, relationships and timing intent; deterministic tools create tracks and mappings; the renderer samples the result for review. Unknown or unsupported effects remain explicit diagnostics, not silently successful agent claims.

Complete both the animation and slide-transition experience. Test interruption, backward navigation, reduced motion, seeking, refresh and missing shared targets. Identical time samples should resolve to the same scene on the supported runtime. Use fonts and assets pinned to the deck version.

The existing timeline controls now cover start/delay, duration, track ordering and duplication, but this is not the complete motion framework. Advanced authoring and full desktop transition acceptance remain required.

Full motion fidelity belongs to Deckastra playback. PDF and PNG are static; PPTX must report supported native animation versus approximation or omission. Do not promise arbitrary interactive transition fidelity in another presentation format. An optional video exporter is a later separate deliverable.

## 9. Optional cloud collaboration and cost control

The cloud owns identity, membership, accepted shared versions, asset transfer and publication. Local devices own their durable pending edits and local execution. Enforce workspace roles again at the server; local membership caches are not authorization for server writes.

Initial sync protocol: snapshot plus ordered transactions, base-version checks, idempotent operation IDs, asset hashes, tombstones and an outbox. Merge disjoint edits where safe; present conflicts for overlapping edits and delete-versus-edit. Never resolve an entire deck with last-write-wins. Current recovery/versioning work is useful groundwork, not a complete sync protocol.

For live co-editing, run a design spike for property/text-level merge semantics and ordering before choosing a CRDT library. Animation tracks, object deletion and shared-element mappings need explicit semantics. Do not bolt a generic CRDT onto JSON and assume invariants survive.

Present locally without cloud compute. For shared presenting, distribute the immutable presentation version/assets and small playback events; clients render locally. Remote playback synchronization needs a leader, sequence numbers, reconnect snapshots and drift recovery. Video conferencing/screen sharing is a different feature.

Measure cloud cost as storage + asset egress + collaboration connections + background jobs + optional inference. Deduplicate assets, sync changes rather than whole decks, coalesce presence updates and retain history under an explicit policy. There is no honest cost percentage before workload measurement. Optional cloud AI and team storage can be separately metered; basic local use should not consume inference credits.

## 10. Delivery order and acceptance gates

These are new desktop milestones D0–D6, not renumbered or retroactively completed original phases.

| Milestone | Build | Exit evidence |
| --- | --- | --- |
| D0: architecture spike | Extract a minimal editor host interface; package Electron on both target OSes; render one real deck | No dev server; offline open/edit/present; scene and pixel comparisons; measured startup/RSS |
| D1: local workspace | Single local authority, SQLite/assets, durable jobs, file open/save, recovery | Airplane-mode create/edit/restart/export; crash during commit; two windows; migration and backup recovery |
| D2: agent access | Inbound MCP tools and scoped grants; existing composer/validator/preview | Actual Claude and Codex create/revise/animate flow, stale-write rejection, undo and cancellation |
| D3: local intelligence | Packaged inference, model manager, local retrieval and task routing | Held-out content benchmarks on target hardware; no cloud traffic in local mode; low-memory recovery |
| D4: motion studio | Advanced timeline and semantic transitions; agent motion planning; presenter window | Frame sampling, interruption/backward navigation, reduced motion, projector/display scaling and export diagnostics |
| D5: shared workspaces | Auth, invitations, assets, offline outbox and conflict UI; browser shared viewer | Two devices edit offline/reconnect without silent loss; revoked access denied; shared version presents correctly |
| D6: release/team polish | Live co-editing/co-presenting, updates, signing, observability, full acceptance | Signed installations, update/recovery rehearsal, real team sessions and original applicable phase exits |

Do not wait for every cloud-centric gap to close before D0. Prioritize the shared invariants first: durable transactions, schema validation, deterministic rendering, font/asset handling and agent permissions. Retain remaining cloud and desktop gaps in the audit with dependencies.

### First implementation slice

Create a desktop app that opens the animation fixture, allows a text edit and motion edit, saves locally, restarts correctly and presents in a second window while offline. Use the shared editor through host contracts. This tests the proposed architecture before adding model downloads or synchronization.

Suggested initial work sequence:

1. Inventory editor imports and HTTP dependencies; define document, asset, job and file host contracts.
2. Extract the smallest reusable editor UI slice without changing the schema or renderer.
3. Add Electron main/preload/frontend, a supervised local service and explicit data directories.
4. Exercise save/restart, local preview/export and dual-window presenting on Windows and a real Mac.
5. Record startup, memory and scene parity; decide whether the shell is acceptable before broad migration.
6. Add MCP around the same command authority; then compare local-model candidates.

## 11. Release and product decisions

macOS needs a real build/test environment, signing and notarization; Windows needs its own packaged installation/update checks. Electron's [code-signing](https://www.electronjs.org/docs/latest/tutorial/code-signing) and [distribution](https://www.electronjs.org/docs/latest/tutorial/distribution-overview) guides describe the platform release work. A successful Windows development run cannot verify a Mac release.

Keep install/update, database migrations and model downloads independently recoverable. Validate shortcuts, menus, file associations, drag/drop, external displays, sleep/wake and accessibility. Keep untrusted document/network content outside privileged desktop APIs. An imported deck must not gain filesystem access through executable scripts.

Recommended defaults pending product input:

- macOS Apple Silicon and Windows x64 first; Linux/Intel Mac only with explicit support targets.
- Local workspace without sign-in; optional downloadable AI; user-selected cloud/external providers.
- Local-file/repository context and inbound MCP before a wide connector catalog.
- Asynchronous shared workspaces before unrestricted live co-editing.
- Desktop authoring and browser consumption share one document/runtime contract.

Needed before release planning: actual target Mac hardware, minimum memory expectations, model distribution preference, signing access, first two external connectors and expected collaboration scale. No credentials are needed in this document or chat.

## 12. Relationship to existing work

The previous web work remains the reusable product core. Keep the [Phase 0–9 remediation ledger](PHASE_0_TO_9_FIX_PROGRESS.md) as the implementation record. Add desktop requirements as new rows when D0 starts; map old requirements to retained, moved, replaced-by-approved-decision or still-open status with reasons. Do not discard authentication, security, performance, accessibility, export or backup requirements because execution becomes local.

This proposal recommends the direction and the first development slice. It does not claim an installed desktop app, local-model quality, MCP interoperability, cloud cost reduction or real collaboration has already been verified.
