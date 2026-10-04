# Assistant implementation and measured routing

Updated 2026-10-04 after the [advanced-deck audit](ADVANCED_DECK_AUDIT.md). Google project **deckastra**, project number **524807414967**, is connected with a server-side Google identity. The authorized cumulative assistant ceiling remains **US$5**.

**Cleanup and narration model qualification is withdrawn.** The old cases and reviews were too narrow to support the advertised tasks, and the reviewer authored the system. No text model task currently meets the revised qualification contract. Cleanup and motion now use the editor's deterministic engines; export remains available. Media availability checks the remaining reservation capacity. Local-only mode remains available for explicit experimentation and never escalates. [Remediation evidence](ADVANCED_DECK_REMEDIATION.md)

## Recorded results

New qualification requires 20 cases covering at least six distinct slides and five feature groups, ≥95% first-attempt **functional** validity (the patch applies and passes scope/rendering checks), ≥90% task success reviewed independently of the system author, no new severe findings or authorization/scope violations, and warm p95 ≤30 seconds (planning ≤120). Reviews bind to the exact result hash. Historical JSON validity below is not functional validity; the recorded percentages are retained as historical evidence, not current qualification.

| Deployment and task | Cases | First-attempt validity | Reviewed task success | Warm p95 | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| Gemma 4 E2B Q4, GTX 1650, cleanup | 20 | 100% | 5% | 63.43 s | Fail quality and latency |
| Vertex `gemini-3.8-flash`, LOW thinking, cleanup | 20 | 100% | 100% | 6.69 s | Withdrawn: narrow cases and system-author review |
| Vertex `gemini-3.8-flash`, LOW thinking, narration scripts | 20 | 100% | 100% | 23.84 s | Withdrawn: narrow cases and system-author review |
| Vertex `gemini-3.8-flash`, LOW thinking, Hindi translation | 20 | 100% | 85% | 25.83 s | Fail semantic quality |
| Vertex `gemini-3.8-flash`, LOW thinking, authoring | 20 | 90% | Unreviewed | 31.75 s | Fail validity and latency |
| Vertex `gemini-3.8-flash`, LOW thinking, planning | 20 | 100% | 0% | 22.35 s | Fail factual grounding |
| Vertex `gemini-3.8-flash`, LOW thinking, critique diagnostic | 20 | 100% | 0% | 10.45 s | Fail review quality; not a production critic qualification |
| Vertex `gemini-3.8-flash`, LOW thinking, vision | 14 | 100% | Unreviewed | 38.05 s | Incomplete and above latency target |
| Vertex `gemini-3.1-pro-preview`, LOW thinking, cleanup | 20 | 95% | Unreviewed | 43.07 s | Fail latency; several invalid final patches |

Gemma cleanup's first cold request took **102.09 seconds**. Peak process-tree RSS was **2,656.79 MiB**, and whole-device GPU memory usage peaked at **1,708 MiB**. These are observed process/device measurements, not a claim that all model context fits inside that VRAM. The deployment used llama.cpp b11146 CUDA 12.4, 16,384 context, one inference slot, GPU text offload and a CPU vision projector. Weight, projector and license verification is recorded in the installed pack manifest. The Google QAT Q4 pack occupies approximately 3.35 GB for weights plus 0.99 GB for the projector on disk.

Nineteen Gemma cleanup outputs persisted empty operations with warnings such as `None` or `No refusal.` despite the injected negative-x layout fault. One restored the correct safe-area position. Runtime validation has since been tightened to reject refusals and unchanged cleanup results with outstanding findings. The original report is retained; this fix does **not** turn the recorded failed deployment into a qualified one. No Gemma task is currently qualified. Earlier 4K/8K/16K probes of the other task categories are diagnostics with too few cases to qualify them.

Flash translation passed schema, protected-token and rendering checks, but three reviewed headings changed important meanings or actors. The prompt now asks explicitly to preserve actors, actions and line breaks; it has not been remeasured. Planning added claims beyond the supplied fact and used misleading citations. Critique diagnostics missed real accessibility/design issues; that diagnostic also did not provide the full production measurement input. These outputs remain rejected.

The historical cleanup corpus repeatedly changed one x coordinate on the first slide of two decks; narration repeatedly added a title-slide cue. These cases did not exercise the advertised task scope. Their reviews were by Codex, the system author. Raw reports remain unchanged for reproducibility. The revised benchmark selects distinct slides from the 21-slide advanced deck, including the seven stress slides; none of that new model corpus has been qualified yet.

## Installed routing

| Job | Provider/model | Evidence or reason |
| --- | --- | --- |
| Fix design findings | Editor Fix all engine | Safe validated subset; unresolved findings remain visible; no inference |
| Improve motion | Product motion planner | Animation-only changes, existing 2.5-second entrance budget; no inference |
| Write narration scripts | Unavailable in hybrid mode | Qualification withdrawn; fresh representative evidence required |
| Create an image | Vertex `gemini-3.1-flash-image`, currently unavailable | Its minimum reservation exceeds US$0.048116 remaining |
| Create spoken narration | Google Chirp 3 HD | Existing speech provider; one successful live sample |
| PDF/PowerPoint export | Existing deterministic export worker | Version and selected-slide scope preserved |
| Other model tasks | Unavailable in installed hybrid map | No passing candidate recorded within this budget |

The [pinned text routing](benchmarks/vertex-routing.json) is now empty. Native Vertex routing requires an accepted report through `DECKASTRA_VERTEX_QUALIFICATION`, bound to the pinned model, thinking configuration, location, coverage and review contract. [Cloud configuration](benchmarks/cloud-configuration.json) records the withdrawal. Historical local/Vertex reports remain available; no stronger candidate is newly claimed to pass.

Live media checks produced a valid 1,408×768 PNG in **11.12 seconds** and a 4.656-second MP3 in **3.04 seconds**, with conservative usage costs of **US$0.067304** and **US$0.002100**, respectively. The image was visually inspected against its prompt. These samples establish provider integration, not broad media quality qualification. [Media record](benchmarks/media-live.json)

## Spend and remaining work

The durable ledger records **US$4.7505635** in reconciled conservative usage estimates and **US$0.2013205** held for pending/uncertain requests, leaving **US$0.048116** reservable under the US$5 ceiling. These estimates are not a Google billing invoice. There are 278 tracked provider operations, including failed and uncertain requests. Flash estimates use standard rates without promotional credits. Maximum remaining input/output/media cost is reserved before each call, so further broad benchmarks stop when their reservation cannot fit. Unknown reservations remain held across restarts and are not retried or cleared automatically.

Remaining work includes qualifying authoring, grounded planning/critique, translation, vision, consistency, asset organization and research; measuring the complete ten-slide text/layout draft against the 120-second p95 goal; independently qualifying a deployed web model service; and broader media/deck fixtures. These steps require additional successful evaluation evidence. The spend ceiling has not been raised.

## Verification

The implementation preserves LangGraph/plain-function orchestration, tool allowlists, untrusted source boundaries, workspace permissions, server-computed risk, version checks, proposals and undo. It adds durable bounded jobs, progress replay, cancellation/resume, shared asset/design tools, local supervision, native Vertex multimodal/tool/stream interfaces and persistent usage reservations. See [implementation and configuration](02_ASSISTANT_IMPLEMENTATION.md).

The earlier full Python suite passed **797 tests with 23 skipped**. After the later prompt, translation, speech and job changes, the focused agent/API set passed **246 tests**; the final assistant API checks passed **19 tests** and the shared panel passed **4 tests**. Workspace TypeScript checks and the desktop production build passed. The build bundles the assistant Design Check helper, renderer, worker and MCP service. The Python service was also frozen successfully from the hash-locked dependencies and started against a fresh isolated profile: Design Check and asset listing returned 200, only the intended five tasks were available, and the existing spend ledger was reused. [Packaged service verification](benchmarks/packaged-verification.json). A new signed installer and hosted web release were not published.

The real web editor reached the API, created an export run with progress in **968 ms**, showed successful queue handoff in **1.836 s**, and exposed history without application alerts, JavaScript errors or failed API responses. Its selected-slide PowerPoint then completed through the existing export worker: exactly one slide, no ZIP corruption. Assistant completion means the export was queued; export completion is verified separately. [Browser record](benchmarks/browser-verification.json), [artifact integrity](benchmarks/browser-export-integrity.json)

Live verification also found and fixed SQLite naive/aware timestamp comparison during run polling, a stale error banner after recovery, and export requests dropping selected-slide scope. Regression tests cover these boundaries. Temporary verification used an isolated database and a stub input deck; no extra paid inference was used for that browser check.

The final UI check after adding shortcuts also passed without application alerts, JavaScript errors or failed API responses. [Final UI record](benchmarks/browser-final-ui.json). The temporary verification servers were stopped afterward; isolated data and reports remain available for review.
