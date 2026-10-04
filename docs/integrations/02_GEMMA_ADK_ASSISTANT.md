# 02 — A small local assistant: Gemma 4 on Google ADK

Status: plan, 2026-10-01. Nothing here is built.
Related: [01](01_MULTILINGUAL_DECKS_NARRATION_AND_SOUND.md) (local translation),
[04](04_GOOGLE_CLOUD_PLATFORM.md) (hosting Gemma in the cloud),
[05](05_IMAGE_TEXT_LOCALIZATION.md) (reading the style of text in an image).

## 1. What is being asked

A very lightweight model that does **small** jobs on a deck: fix small problems,
organise assets, tidy things up. It uses Google's Agent Development Kit (ADK)
as the agent framework. It is not a replacement for the generation graph.

## 2. Discovery

### 2.1 The model

- **Gemma 4** came out on 2026-04-02 in four sizes: E2B, E4B (effective 2B and
  4B, built for devices), a 26B MoE and a 31B dense model. It supports
  tool calling ("agentic"), and every size accepts images; E2B and E4B also
  accept audio. It is the base of Gemini Nano 4 on Android.
- It runs locally through **Ollama** or **llama.cpp** (GGUF), and in the cloud
  through Vertex AI Model Garden, Google AI Studio, or a Cloud Run GPU service
  with vLLM or Ollama.
- **Licence:** confirm the exact Gemma 4 terms before shipping weights. The
  model-pack manifest *requires* a `license` field
  (`agents/deckastra_agents/model_packs.py`), and redistribution is a D6 gate.

### 2.2 The framework

- **ADK** (Python, and Java) builds agents from an `LlmAgent` with tools. Models
  are reached natively (Gemini) or through **LiteLLM** (`ollama_chat/gemma4:e4b`,
  any OpenAI-compatible endpoint, including the llama.cpp server this repo
  already supervises).
- ADK can use an **MCP server as a toolset** (`McpToolset`, with a `tool_filter`
  allowlist). That is the key fact for this plan.
- ADK has its own evaluation (`adk eval` with test sets) and a dev UI
  (`adk web`), plus deployment to Cloud Run or Vertex AI Agent Engine.

### 2.3 What the repository already has

| Fact | Where |
| --- | --- |
| `ModelClient` is one method, and local intelligence is a provider (`local_model.py`, a llama.cpp server on loopback) | `agents/deckastra_agents/local_model.py`, `router.py` |
| Packs are a directory with a manifest beside the weights | `agents/deckastra_agents/model_packs.py`, `scripts/install-model-pack.py` |
| The model server starts on demand, unloads after 10 idle minutes, and counts in-flight requests | `apps/api/deckastra_api/model_server.py` |
| Local is chosen, never fallen back to. A mistyped mode is refused. | `router.intelligence()`, `IntelligenceMisconfigured` |
| D3 measured a 4B model (Qwen3-4B Q4_K_M) on a GTX 1650: valid structured output 27/28 first time, 25–33 tok/s, 5.8 GB peak RSS | CLAUDE.md "Local intelligence" |
| The **MCP server** is a thin adapter over `WorkspaceClient`, with tools such as `document_read`, `document_read_slide`, `slide_preview`, `document_propose`, `proposal_list`, `proposal_withdraw`, `motion_propose`, `transition_propose`, `document_export` | `apps/mcp-server/src/tools.ts` |
| Agent grants: `read`, `write`, `export`; no `approve`, `manage` or sharing | `apps/api/deckastra_api/grants.py` |
| An agent's change is a proposal. Risk is computed from the operations. A stale `expected_version_id` is a 409. | `proposals.py`, `agent_routes.py` |
| Design Check (collisions W110, safe area W104, small text W216, contrast A102/W218, overflow W103, alt text) runs in TypeScript on the scene | `packages/renderer/src/layout-check.ts`, `editor-ui/src/lib/design-check.ts` |
| Assets have no tags, folders or descriptions | `db/models.py:813` |
| Nodes are plain `(state, ctx)` functions; only `graph.py` imports LangGraph | CLAUDE.md "The agent system" |

## 3. The design in one sentence

**An ADK agent running on Gemma 4 E4B that uses Deckastra's own MCP server as its
only toolset.** It therefore inherits every rule already enforced there: it can
only propose, risk is computed by the server, it cannot approve its own change,
a stale read is refused, and there are no paths.

```
┌────────────── apps/assistant (Python, google-adk) ─────────────┐
│  LlmAgent "tidy"      model: LiteLlm(gemma4:e4b)               │
│  LlmAgent "alt_text"  model: same, with image input            │
│  LlmAgent "assets"    model: same                              │
│  RootAgent routes by task; each sub-agent sees a filtered tool │
│  list (McpToolset(tool_filter=[...]))                           │
└──────────────────────┬──────────────────────────────────────────┘
                       │ stdio (MCP)
                ┌──────▼──────┐      grant: read, write
                │ mcp-server  │──── HTTP ────► apps/api
                └─────────────┘                (proposals, risk, 409s)
```

### Why a separate app, not a node in `agents/`

- **The framework stays in one place.** "Nothing imports LangGraph except
  `graph.py`" becomes "nothing imports `google.adk` except `apps/assistant`".
  A reviewer can see an ADK import anywhere else in the diff.
- **Nothing can bypass the boundary.** The assistant holds no database handle
  and no internal function: it can do only what an external agent can. That is
  the D2 posture, and it is easier to audit than a trusted in-process agent.
- **It is a second client, not a second authority.** The same pattern already
  runs Claude Code and Codex against the app.

## 4. The jobs (scope)

Keep them small and bounded, which is what a 4B model is good at.

| Job | Tools used | Output |
| --- | --- | --- |
| **Fix Design Check findings** that need judgement (rewording overflowing text shorter, choosing which of two overlapping boxes moves). Mechanical fixes stay in code (`suggestedFix`). | `design_check` (new), `document_read_slide`, `document_propose` | a proposal |
| **Alt text** for images, charts and diagrams without it (WCAG 1.1.1) | `slide_preview` (PNG, sent to Gemma's image input), `asset_view` (new) | a proposal setting `altText` |
| **Organise assets**: tag, describe, name, find duplicates, find unused | `asset_list`, `asset_update` (new), `asset_duplicates` (new; perceptual hash computed in code, not by the model) | direct metadata update (write scope; not document content, so no proposal) |
| **Consistency**: font sizes that drift across slides, title case, trailing punctuation in bullets | `document_read`, `document_propose` | a proposal |
| **Speaker-note cleanup** into per-step narration scripts (see 01) | `document_read_slide`, `narration_propose` | a proposal |
| **Local translation** for a small deck (see 01) | `locale_propose` | a proposal |

**Not in scope:** generating a deck, restyling a deck, or research. Those stay on
the LangGraph path with a larger model.

## 5. What has to be added

### 5.1 MCP tools (in `apps/mcp-server/src/tools.ts`)

| Tool | Scope | Notes |
| --- | --- | --- |
| `design_check` `{presentation_id, slide_id?}` | read | Runs `buildDocumentScene` plus `layout-check.ts` in the MCP process, using the estimator. Findings carry `estimated: true` where the estimator was used, the same honesty rule as the export report. Returns codes, element ids, messages and any `suggestedFix` operations. |
| `asset_list` `{workspace?, filter: unused\|untagged\|all, cursor}` | read | Bounded page, never bytes |
| `asset_view` `{asset_id, max_px: 512}` | read | A downscaled PNG for the model's image input, produced server-side |
| `asset_update` `{asset_id, filename?, tags?, description?}` | write | Metadata only, validated and length-capped |
| `asset_duplicates` | read | Groups by `phash` (computed at upload; §5.3) |

A test asserts, as today, that the tool list has no approval, sharing, path or
risk-tier field.

### 5.2 API

- `GET /v1/presentations/{id}/design-check`, if the MCP-side scene build is not
  wanted. Prefer the MCP-side build: no new server code, and it is the same
  TypeScript the editor runs.
- `PATCH /v1/assets/{id}` for `filename`, `tags` and `description` (needs
  `write`, and editor role through `resolve_workspace_access`).
- Asset listing filters: `unused` (`reference_count = 0`), `untagged`, `q`.

### 5.3 Database (one Alembic revision)

- `assets.tags` (JSON list of strings), `assets.description` (text, ≤ 500),
  `assets.phash` (64-bit hex), `assets.sha256`.
- `phash` and `sha256` are computed at `complete_asset_upload` with Pillow (dHash).
  No model is involved: finding duplicates is arithmetic.

### 5.4 The assistant app (`apps/assistant/`)

```
apps/assistant/
  pyproject.toml / requirements.txt   google-adk, litellm, mcp
  deckastra_assistant/
    __init__.py
    agent.py        root agent + sub-agents, instructions, tool filters
    model.py        LiteLlm(...) from DECKASTRA_ASSISTANT_MODEL; refuses if unset
    toolset.py      McpToolset over stdio: runs apps/mcp-server (checkout or packaged cli.mjs)
    tasks.py        the five jobs as entry points: tidy(deck), alt_text(deck), organise(workspace)
    server.py       small HTTP/stdio entry for the editor to trigger a job and stream progress
  evals/            ADK eval sets: one per job, on fixtures
  tests/
```

- **Model selection follows D3's rule:** `DECKASTRA_ASSISTANT_MODEL` is
  `ollama_chat/gemma4:e4b`, `openai/<llama-server URL>`, or
  `vertex_ai/gemma-4-…`. Unset means the assistant is off and says so. There is
  no fallback to a cloud model.
- **Instructions** name the untrusted-content rule: slide text and asset names
  arrive as tool results, and are data. ADK's MCP results should still be
  wrapped: add an `untrusted_fields` declaration on the new tools, and the MCP
  server envelopes them, the same boundary as `ToolRegistry._invoke`.
- **Budgets:** a job has a step cap (for example 12 tool calls) and a
  wall-clock ceiling. Past the ceiling the job stops; nothing half-applied
  exists, because every change is a proposal.
- **Labels:** proposals are labelled `mcp:assistant-<job>`, so the approval card
  says a local assistant proposed them.

### 5.5 Running Gemma

| Where | How | Notes |
| --- | --- | --- |
| Desktop, local | A Gemma 4 E4B Q4 GGUF **model pack**, served by the existing `model_server.py` supervisor (llama.cpp `llama-server`) | Reuse the pack manifest and `install-model-pack.py` verification. Measure like D3 (§8). |
| Developer machine | `ollama pull gemma4:e4b` | Fastest way to start |
| Cloud | Cloud Run with an L4 GPU running vLLM or Ollama, or Vertex AI Model Garden | See 04. Scale to zero when idle. |

### 5.6 Editor surface

- AI mode (`shell/ModePanels.tsx` `AiPanel`) gets an **Assistant** section:
  "Tidy this slide", "Write missing alt text", "Organise images", each with
  a status line and cancel.
- Design Check (`DesignCheckPanel.tsx`): findings with no mechanical fix get
  "Ask the assistant".
- Results arrive in **Pending changes**. The Before/After card already exists
  (`ProposalsPanel.tsx`).
- The assistant's availability is reported through
  `/v1/account.capabilities.assistant` (provider, can work, reason), in the same
  shape as `capabilities.generation`, so the panel never guesses.

### 5.7 Desktop

- The assistant runs as a child of the main process, like the sidecar, and only
  after the person turns agent access on (`main/agent-access.ts`). It uses the
  same published grant: no new credential.
- Packaging: either freeze `apps/assistant` with PyInstaller like the service,
  or run it inside the sidecar's Python as a separate entry point
  (`--assistant`). The second is smaller. Decide after measuring the size of
  `google-adk` plus `litellm`, and exclude what is not executed (the D1 lesson:
  transitive dependencies were 330 MB of 480 MB).

## 6. Evaluation

- ADK eval sets per job on the three seed fixtures plus a "messy deck" fixture
  with known problems: seeded overflow, missing alt text, three duplicate
  images, and inconsistent title sizes.
- Metrics:
  - the proposal applies (it passes `author_service.check`);
  - Design Check findings go down and none are added;
  - alt text length is between 5 and 125 words and does not start with "image of";
  - there are no edits outside the requested slide.
- A benchmark script like `scripts/benchmark-model-pack.py`, recording tokens,
  wall clock, peak RSS and first-attempt validity, with the machine beside the
  numbers.

## 7. Risks

- **Small models over-edit.** Tool filters per job, "change only element ids
  named in the task", and a server-side check that the proposal only touches
  those ids (reject otherwise).
- **Image input size.** Gemma's image input is small. Previews are downscaled to
  a maximum of 512 px on the server; never send a full-size slide.
- **Dependency weight** in the desktop build (§5.7).
- **Licence** (§2.1).

## 8. Phasing

| Phase | Scope | Estimate |
| --- | --- | --- |
| A | `apps/assistant` with Ollama + MCP toolset; `alt_text` job end to end | 2–3 days |
| B | `design_check`, `asset_*` tools, migration, `tidy` and `organise` jobs | 3 days |
| C | Editor Assistant section, capability reporting | 2 days |
| D | Model pack + desktop child process + evals + benchmark | 3–4 days |

For the hackathon, A plus the `alt_text` and `tidy` jobs shows "Gemma + ADK +
Google Cloud" clearly. Run Gemma on Cloud Run GPU for the demo URL, and on
Ollama locally.

## 9. Sources

- [Gemma 4 on Android (Android Developers Blog)](https://android-developers.googleblog.com/2026/04/gemma-4-new-standard-for-local-agentic-intelligence.html)
- [Gemma 4 agentic skills at the edge (Google Developers Blog)](https://developers.googleblog.com/bring-state-of-the-art-agentic-skills-to-the-edge-with-gemma-4/)
- [ADK with Ollama](https://adk.dev/agents/models/ollama/)
- [ADK agent on local Gemma 4](https://medium.com/google-cloud/creating-adk-agent-using-locally-running-gemma-4-2883c29e2fd0)
- [ADK Java agent with Gemma 4](https://glaforge.dev/posts/2026/04/02/an-adk-java-agent-powered-by-gemma-4/)
