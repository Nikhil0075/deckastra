# Gemma E2B and Vertex presentation assistant

Implementation date: 2026-10-03. This extends the existing plain-function agents and LangGraph generation runtime. No separate ADK application is introduced.

Measured status and pinned routing: [benchmark results](BENCHMARK_RESULTS.md), updated after the [advanced audit](ADVANCED_DECK_AUDIT.md). Cleanup and narration text qualification is withdrawn because coverage and independent review were insufficient. No text model currently qualifies under the revised contract. The authorized US$5 ceiling is unchanged. [Remediation and validation](ADVANCED_DECK_REMEDIATION.md).

The shared desktop/web Assistant panel starts bounded jobs for generation, scoped editing, layout cleanup, alt text, consistency, translation overlays, narration scripts, motion, asset metadata, research, images, spoken narration and PDF/PowerPoint export. Existing proposals compute risk on the server and retain approval and undo. Export jobs continue in the existing export service; assistant completion means the export was queued.

## Install and measure E2B

Run `scripts/setup-assistant-local.ps1`. It downloads a pinned Windows CUDA llama.cpp runtime and Google's E2B QAT Q4 weights and vision projector, verifies their published SHA-256 digests, and writes `%LOCALAPPDATA%/Deckastra/assistant/local-config.json`. Weights remain an optional installation, outside the application and workspace backups. The embedded GGUF chat template is enabled with `--jinja`; the projector runs on CPU to leave GPU memory for inference. The supervisor verifies declared artifact digests again before loading, hides the process, starts it on demand and unloads it when idle.

The desktop reads that configuration only in its main process and sends allowed fields to its workspace service. Environment variables take precedence. Use `DECKASTRA_ASSISTANT_CONFIG` for a different file. Web deployments configure the same backend environment; measure each deployment separately.

On this machine, `DECKASTRA_ASSISTANT_CONFIG` was saved in the user's Windows environment for future desktop launches. Configured model/runtime and cost-ledger paths are canonical physical paths because the Codex MSIX host redirects Local AppData. The existing ledger is shared with the desktop rather than creating fresh accounting outside that redirected directory. Restart the desktop to inherit updated environment settings.

```powershell
python scripts/benchmark-assistant.py --local-config "$env:LOCALAPPDATA/Deckastra/assistant/local-config.json" --tasks authoring narration --limit 2 --output docs/integrations/benchmarks/e2b-probe.json
```

A probe cannot qualify a task. Run twenty distinct cases per task, independently review their persisted outputs, and use `--rescore original-report.json --reviews reviews.json --output reviewed-report.json`. This scores the original outputs without repeating inference or paid calls. Review format:

```json
{
  "cleanup-00": {
    "reviewer": "Reviewer identifier",
    "independent_of_system_author": true,
    "result_sha256": "Copy this case's result_sha256 from the original report",
    "scores": {
      "factual_grounding": 0.9, "narrative_quality": 0.9,
      "visual_consistency": 0.9, "translation": 0.9,
      "accessibility": 0.9, "instruction_adherence": 0.9
    },
    "safety_failures": 0, "severe_regressions": 0
  }
}
```

Each applicable dimension requires at least 0.8. A reviewer independent of the system author must attest to that independence and explain neutral dimensions. Gates require 20 cases, six distinct slides, five feature groups, ≥95% first-attempt functional validity, ≥90% independently reviewed task success, zero safety failures or severe regressions, and warm p95 ≤30 seconds (planning ≤120). Historical reviews do not meet this contract. The revised corpus selects distinct slides from the 21-slide advanced deck. Cleanup now measures deterministic engines, so its zero model calls cannot qualify a model. Reports retain cold/warm latency, RAM, VRAM, retries, usage and cost.

Set `DECKASTRA_ASSISTANT_QUALIFICATION` to the accepted E2B report. It is bound to pack manifest, context, runtime configuration and hardware identity. Hybrid routes each matching passing task to E2B, permits one local repair, then one Vertex escalation for validation failures. Unqualified tasks route directly to Vertex. Local mode never escalates. Cancellation, permission failures, version conflicts and budgets stop the operation.

## Configure Vertex and Google speech

Set these variables on the server, never the browser:

| Variable | Value |
| --- | --- |
| `DECKASTRA_ASSISTANT_MODE` | `hybrid`, `local`, or `vertex`; default `hybrid` |
| `DECKASTRA_VERTEX_PROJECT` | Explicit Google project ID |
| `DECKASTRA_VERTEX_LOCATION` | Explicit region or `global` |
| `DECKASTRA_VERTEX_IDENTITY` | `attached` only when using an attached identity |
| `DECKASTRA_GOOGLE_CREDENTIALS` | Explicit credential-file path when not using attached identity |
| `DECKASTRA_VERTEX_MODELS` | JSON map of task to pinned model ID, optionally `default`; configure `image` separately |
| `DECKASTRA_VERTEX_QUALIFICATION` | Accepted functional qualification report for native Vertex text tasks |
| `DECKASTRA_VERTEX_THINKING` | Optional model-to-thinking-level map; benchmark that exact configuration |
| `DECKASTRA_VERTEX_PRICES` | JSON map of model to `{ "input": USD-per-million, "output": USD-per-million }`; image generation additionally requires `image_output`, and grounded search requires `search_max_usd` |
| `DECKASTRA_ASSISTANT_MAX_COST_USD` | Positive operator-wide cumulative assistant ceiling, including outstanding reservations |
| `DECKASTRA_WORKSPACE_ASSISTANT_CEILINGS` | JSON map of workspace ID to explicit cumulative ceiling; required for paid jobs in production, also enforced under the operator ceiling |
| `DECKASTRA_ASSISTANT_COST_LEDGER` | Optional persistent shared SQLite ledger path; application and benchmarks on the same host otherwise share the user-data ledger |
| `DECKASTRA_SPEECH` | Existing speech provider setting (`google` for real speech) |
| `DECKASTRA_SPEECH_USD_PER_MILLION` | Explicit speech price per million characters |

Use the provider's current pricing for the configured model and capabilities. Image output must use a configured Vertex Gemini model supporting image response modalities. Search reserves and conservatively accounts for its configured maximum charge; this is an estimate where the API does not return an invoice charge. Reported text/image token usage is reconciled afterward. No paid request is automatically retried after an uncertain response; its reservation remains held. Raising the explicit ceiling is an operator action, not something the assistant does.

Benchmark pinned Flash and Pro candidates against identical fixtures. The durable ledger enforces one operator ceiling across benchmarks, application jobs and restarts. Configure a persistent shared path for replicas and explicit workspace ceilings for production. `select-assistant-routing.py REPORTS --output vertex-routing.json --qualification-output vertex-qualification.json` selects passing candidates by independently reviewed quality, then latency and cost. Configure both the map and qualification report; model, thinking configuration and location must match. Uncertain calls stay held. `reconcile-assistant-cost.py --ledger PATH --ceiling 5` lists them; `--evidence reviewed-receipt.json --database-url URL` reconciles confirmed usage and the matching application reservation with an evidence audit. A guessed or missing receipt cannot release a hold.

## Operations and boundaries

Cleanup reuses Fix all and keeps an element's changes only when they introduce no new severe findings, including distinct overlap pairs. Overlaps that need a layout decision remain visible. Motion uses the product planner and can change only animation tracks. Model-authored changes always require semantic proposal review, even when their operations are structurally low risk. Source attribution cannot be silently dropped; displayed summaries count validated operations.

Generation receives uploaded sources before orchestration, defaults to appending slides and checks generated slide findings rather than rejecting existing deck faults. Replacement requires an explicit request and the panel warns about removing existing slides. Completed research can be selected as a generation source; CSV arithmetic is computed from numeric records with its method and source IDs. Generation clarification appears in the panel.

Deck-wide editing, consistency, translation, scripts and alt-text jobs run in bounded slide batches. Missing image bytes produce warnings while other visual objects remain eligible; unseen images cannot receive invented alt text. Organisation inspects available images in batches and requires approval through `/runs/{id}/approve-metadata`, with metadata version checks and undo. Generated images produce a slide-placement proposal with a prompt-based description flagged for review.

Machine translations mark only changed entries draft. Reviewed entries on other slides retain their status, and the Languages panel shows partial review. Export reports selected slides with missing or outdated translations. History lists summary records and retrieves a complete result only when selected. Failures show concise user messages while internal validation diagnostics remain in checkpoints. Windows Job Objects release supervised runtimes when their parent is killed; graceful shutdown and idle unloading remain supported.

Run `npm run db:migrate` before starting an existing API database. The additive migration includes nullable asset metadata, versioned metadata audit records, assistant runs, ordered events and usage reservations. Old packs and existing endpoints remain supported.

`POST /v1/assistant/runs` takes task, presentation, expected version, operation key, scope and the `quality` preset. Read status/history, replay events after a sequence, connect the SSE stream, cancel, and resume interrupted runs through the same namespace. SSE reconnects use `after`; streams finish after 25 seconds so clients reconnect using the last sequence. The panel polls ordered events with abort cleanup. Request transactions commit before dispatch; model computation runs without a held database session. Four worker slots, a bounded queue, one local inference slot and serialized assistant writes bound execution. Request creation emits queued progress immediately.

Configure `DECKASTRA_WEB_ORIGINS` as comma-separated trusted web origins when serving a web editor outside localhost:3000. Credentials stay in the API process. Assistant exports retain the editor's selected language and requested slides; a missing translation fails before queueing. Narration script proposals preserve existing cue IDs, click steps and recordings. Assistant Google speech uses Chirp 3 HD voices at the explicitly configured family rate; other voice families require their own pricing support.

Checkpoints save individual model responses and speech clips, then the validated result before mutation. Media uploads occur outside the document write transaction and use deterministic run keys. A completed write and run result commit atomically. Resume preserves expected deck and asset metadata versions and replays completed responses instead of calling the provider again. Paid operations without a replayable checkpoint, or with uncertain usage, refuse resume. Membership is checked again before applying. Cancellation prevents subsequent calls and writes; an in-flight provider request can still incur usage and retain an uncertain reservation.

API and MCP share `design_check`, `asset_list`, `asset_view`, `asset_update`, `asset_duplicates`. Design Check calls the renderer/editor implementation through a bundled Node helper; measurements are labeled estimated. Asset previews are bounded PNGs with optional pixel crops. Metadata edits use optimistic concurrency and reversible audit history. SHA-256 detects exact byte matches; `dhash64` detects perceptual candidates, which are never deleted automatically. Duplicate detection is bounded and marks partial results; pairs spanning different pages are not exhaustively compared. Existing assets without fingerprints require reindexing before they participate in duplicate detection.

Research reads authorized uploaded PDF (first twenty pages), UTF-8 text and CSV (first 12,000 characters per source), plus explicitly enabled Vertex web grounding. Sources are enveloped as untrusted content and retained through planning, review and persisted slide citation IDs. The editor's normal source upload controls remain the upload surface. Factual correctness and translation quality require independent evaluation; schema validation alone does not certify them.

General computer control, automatic duplicate deletion and autonomous sharing remain outside the assistant. Cloud credentials, pricing, independent review and actual deployment benchmark results are necessary to enable qualified paid routing. The implementation does not claim a GTX 1650 fit or latency pass until measured.
