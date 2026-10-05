# Reliable presentation tools

Deckastra's AI must produce useful proposals that preserve the author's facts,
selection and existing work. A schema-valid answer alone is insufficient. The
original independent critique review passed 0 of 20 cases and reported three
severe regressions; those results remain preserved, and AI remains disabled.

## Research and architecture decision

Google's [ADK safety guidance](https://adk.dev/safety/) puts validation and policy
checks at tool boundaries. [ADK plugins](https://adk.dev/plugins/) can apply hooks
across agent workflows, but an orchestration framework does not verify slide
scope, factual support, image availability or patch correctness on its own.
The existing bounded workflow already owns durable jobs, cancellation, review,
credits and immutable snapshots. This repair keeps it and adds shared checks
outside model execution. ADK can be reconsidered when a specific workflow needs
its orchestration features; it is not introduced as an untested quality fix.

Google recommends [structured output](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output)
with response schemas and consistent property ordering. Complex nested array
bounds can exceed the provider's schema complexity limits, so the application
enforces critique size limits instead of asking Vertex to expand those bounds.
[Thinking configuration](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking)
trades reasoning, latency and cost. LOW candidates are measured separately from
the previous MEDIUM candidate; changing thinking settings invalidates previous
qualification. Pricing uses configured conservative standard rates rather than
assuming promotional credits.

## Implemented boundaries

* Scoped snapshots omit unselected slides and unrelated deck metadata. Selecting
  a group includes its descendants; selecting a child stays narrow. Element
  scope hides unrelated slide notes, narration and motion. Source material
  remains untrusted data and cannot create authenticated request tags.
* Wording edits return exact target IDs and replacement words. Code creates
  patches on text leaves, preserving paragraphs, formatting, links and marks.
  Numbers with units/currencies, digit-bearing identifiers, links and email
  addresses must remain exact; a new script is rejected
  in wording edits. Translation uses locale overlays instead of rewriting source
  content.
* Narration returns words for existing cue IDs. Code preserves click steps,
  timing and recordings. A different requested language writes draft locale
  entries with source hashes, preserving the source cues and recordings. With
  no cues, it may create only an arrival cue; its source content and localized
  script remain separate. New scripts may summarize supplied facts; existing
  cue edits preserve every protected value.
* Alt text uses supplied image pixels or actual chart/diagram data. Missing
  pixels and existing descriptions are left unchanged. Asset organization also
  skips pictures without bytes rather than describing filenames. Localized alt
  text belongs to a draft locale entry, not a replacement of source-language text.
* Critique cites supplied fact/finding IDs on existing selected slides. It must
  include required Design Check findings and assess numerical text claims.
  A claim cannot be marked supported using only a filename or citation ID;
  actual source text is required. Unsupported/unverifiable claims must produce
  content findings. Requested response script is checked. This catches an
  obvious wrong language; it does not establish language fluency or factual
  correctness.
* Deterministic patch, schema, scope, attribution and Design Check validation
  run before a proposal is exposed. Major/blocker critique findings cannot
  accompany a pass verdict. Critique produces advice and no edit operations.
* Duplicate JSON keys, nonfinite values and unknown author-operation properties
  are rejected. Bounded repairs see the failed answer and its errors, preserving
  opaque provider signatures. Provider interruptions with uncertain usage are
  not retried automatically.
* Generation passes the authenticated output locale to its actual planner and
  composer, which records the correct source language. Appending a different
  source language is rejected before a paid call; translation overlays and
  replacement generation are explicit alternatives. Planner prose fields are
  checked for the requested script; original code and quotations are exempt.
* Qualification fingerprints include implementation files and prompts as well
  as the pinned model/thinking configuration. An evaluation stops if those files
  change during execution. Transient test caches are excluded. A Git-tree audit
  checks that the published source matches the evaluated fingerprint. Old
  reviews cannot qualify a changed implementation. Review records are bound to
  their task, and scoped tools require both slide and element corpus coverage.

## Evaluation and release

The old benchmark bypassed the production planner and sent whole-deck critique
input without its selected-slide scope or Hindi locale. The corrected benchmark
uses the real planner and hosted critique computation. Repair probes and full
task reports are kept separately from the original reviewed evidence. Never
transplant scores from an old output onto a new result hash.

Release still requires at least 20 representative cases per task, 95% first
attempt validity, 90% task success after independent rubric review, zero safety
failures/severe regressions, and p95 latency at most 30 seconds (120 for planning).
Numerical protection and evidence references do not prove semantic equivalence
or that a source supports an interpretation; independent review is essential.
Critique currently uses source data and Design Check, not a visual inspection of
a fully rendered slide. Generation needs complete workflow validation in addition
to testing individual task contracts.

`scripts/run-assistant-evaluation.py` records candidates using the same durable
approved spending ledger. It does not enable models or modify cloud resources.
The US$30 authorization and existing uncertain-call holds continue to apply.

## Repair candidate evidence, 2026-10-05

The final Flash LOW run covered all 140 cases on one immutable implementation.
The independent review pack is [repair-02](evaluations/2026-10-05/repair-02/README.md).
These are automatic contract results, not independent quality scores.

| Task | Automatic valid | First attempt | Local warm p95 |
| --- | --- | --- | --- |
| planning | 20/20 | 90% | 97.9s |
| authoring | 20/20 | 100% | 7.2s |
| cleanup | 20/20 | No model call | 2.9s |
| critique | 20/20 | 100% | 10.1s |
| translation | 20/20 | 100% | 14.6s |
| narration | 20/20 | 100% | 6.7s |
| vision | 19/20 | 95% | 14.0s |

The final candidate uses one immutable implementation, including selected-group
boundaries, protected values with units and currency, planner prose language
checks, and pooled transport. Scoped tools include five element-selection cases
alongside fifteen slide-selection cases. Every case remains in the report.
Vision case 00 failed before model execution when this Windows host's Google
token command returned access denied. It is not replaced with a later success.
No new independent quality scores exist; zero task-success metrics mean
unreviewed outputs, not completed human scoring. Safety and severe-regression
counts also require independent review. Cleanup made no model calls and cannot
qualify a Vertex cleanup model.

Every AI task remains disabled until all of its gates pass. Earlier probes and
superseded review packs are preserved locally; their results cannot qualify
this changed implementation or corpus.

A connection trace measured an 84.5-second TCP delay on this Windows machine
before any HTTP request. An explicit IPv4 transport option removed that
repeatable IPv6 stall using HTTPX's
[documented local-address setting](https://www.python-httpx.org/advanced/transports/).
The transport now reuses a bounded connection pool across stages and repairs,
following [HTTPX client guidance](https://www.python-httpx.org/advanced/clients/),
with fresh authorization and a separate timeout on each request. Confirmed
pre-request connection failures refund their reservation; uncertain provider
interruptions retain it and are not automatically retried. These local results
do not measure Cloud Run end-to-end latency or prove production readiness.

Two bounded smoke checks exercised the actual three-slide generation workflow
in English and Hindi. Both passed schema and deterministic proposal checks and
retained the requested source-language metadata. Their measured local times were
20.1 and 22.5 seconds respectively. These are smoke checks, not complete
workflow qualification; a hosted ten-slide workflow still needs measurement.
