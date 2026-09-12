# Operations, Backups and Metric Targets

**Document type:** Operational specification
**Status:** v1.0
**Purpose:** Close the gap-register items that a product cannot launch without and
that none of the other five documents owns — backup and recovery, environment
topology, secret handling, accessibility scope, and the numbers success is
measured against.

Written because "your work is versioned and safe" is the product's central
promise, and until now nothing said what happens when a disk fails.

Closes: doc 05 S3 (no migration or backup policy), doc 05 S3 (no
environment/deployment topology), doc 05 S3 (observability tooling unnamed),
doc 01 S2 (non-functional targets unmeasurable, accessibility scope), doc 01 S3
(no pricing, packaging or quota model), doc 01 S3 (metric targets).

---

## 1. What this product promises about data

Three claims are made elsewhere and paid for here.

1. **"Every change is versioned and reversible."** Doc 05 §22's snapshot-plus-
   operation log is only as durable as the database under it.
2. **"Your deck is yours."** A user can export at any time to two formats that
   outlive us (§4 below).
3. **"An AI edit is reviewable."** The transaction log is the record, and a
   restore that loses it loses the audit trail as well as the work.

Anything in this document that trades one of those away is wrong, whatever it
buys.

---

## 2. Backup and recovery

### 2.1 Position

| Measure | Target | Why this number |
| --- | --- | --- |
| **RPO** — how much work a disaster may lose | **5 minutes** | One editing session's worth. Beyond that a user loses a train of thought, not a keystroke, and no version history helps because the versions are gone too. |
| **RTO** — how long recovery may take | **1 hour** | Long enough to restore and verify without a heroic rebuild; short enough that a working day is not lost. |
| **Retention** | **35 days** of point-in-time recovery | Covers "we deleted it last month and only noticed now", which is the actual shape of most restore requests. |
| **Restore rehearsal** | **Monthly**, to a scratch database | A backup nobody has restored is a backup nobody has. |

### 2.2 What is backed up, and what is not

**Backed up:**

- The PostgreSQL database. It holds documents, version history, transactions,
  agent runs, repository chunks, shares, quotas and themes — everything that is
  not a byte stream.
- Object storage (assets), with versioning enabled and a 35-day noncurrent-version
  expiry that matches the database's window. A restore that brings back a document
  citing an image the bucket has forgotten is a half restore.

**Deliberately not backed up:**

- Export artifacts. They are derived from a version and reproducible from it
  (doc 04 §32.3 makes a given `(versionId, adapter, options)` byte-stable), so
  backing them up would be paying to store something we can recompute.
- Redis. It carries ephemeral progress and pub/sub only — doc 05 §25 is explicit
  that it is not a source of truth, and this is what that means operationally.
- Rendered previews and thumbnails. Same argument as exports.

### 2.3 Point-in-time recovery, not snapshots alone

Daily snapshots give a 24-hour RPO, which is not the target. Continuous WAL
archiving is what makes 5 minutes achievable, and it has a second benefit worth
more than the first: **recovery to a moment**, so a bad migration or a mistaken
bulk delete can be undone by restoring to the second before it rather than to
yesterday.

### 2.4 The restore rehearsal is the actual control

Monthly, to a scratch database, checking four things:

1. The schema matches `alembic heads` at the restored point.
2. A known presentation loads and its version chain replays (`store.load_presentation`
   exercises the same path production does).
3. An asset the restored document cites resolves in object storage.
4. Time to complete, recorded, against the 1-hour RTO.

Failing any of these is an incident, not a chore.

---

## 3. Migrations

### 3.1 Policy

- **Alembic, always.** `test_migrations.py` gates drift between the models and
  the migration chain, so a column added without a revision fails CI.
- **Forward-only in production.** A `downgrade()` exists and is tested, but it is
  a development convenience. Rolling a schema backwards over live data loses the
  data the new column held.
- **Expand, migrate, contract.** A rename is: add the new column, backfill, write
  both, switch reads, stop writing the old, drop it. Four deploys rather than one,
  and the reason is that steps two and three are the only ones where a rollback is
  free.
- **A destructive step is never in the same revision as an additive one.** If a
  revision both adds a table and drops a column, the drop cannot be deployed
  without the add.

### 3.2 The autogenerate trap this project has already hit twice

`repository_chunks.embedding` is a PostgreSQL-only `pgvector` column added by raw
SQL, because `vector` has no SQLite equivalent and the models must compile on
both. Alembic autogenerate sees a column with no model behind it and proposes
dropping it — on **every** revision.

Taking that suggestion drops the semantic index on every deployment that
migrates, *silently*, because retrieval falls back to the JSON path and keeps
returning results. Every new revision must be read before it is committed, and
this specific drop removed.

---

## 4. Environments and deployment

### 4.1 Topology

| Environment | Purpose | Data |
| --- | --- | --- |
| **local** | Development | SQLite or the compose PostgreSQL; no real customer data |
| **staging** | Pre-release verification, migration rehearsal | Synthetic decks; a copy of production's *schema*, never its rows |
| **production** | The product | The real thing |

Staging holds no production data. A staging environment with a copy of customer
decks is a second production system with half the controls, and the value it adds
— realistic content — is available from generated fixtures.

### 4.2 Secrets

- Never in the repository, never in an image, never in a log line. The
  `AppCredentials.from_environment()` pattern (returning `None` when unconfigured)
  exists so that a missing secret degrades a feature rather than crashing the
  service.
- `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `GITHUB_APP_PRIVATE_KEY`,
  `GITHUB_WEBHOOK_SECRET`, `DATABASE_URL` and the object-storage credentials are
  the full set. Each is optional except `DATABASE_URL`, and the product states
  which feature is off when one is missing.
- Rotation is a config change plus a restart. Nothing caches a secret past
  process lifetime; installation tokens are minted per use with a refresh margin.

### 4.3 The render fleet

Doc 04 §41 introduces headless Chromium, which is the only component whose cost
scales with usage rather than with data.

- A hard per-render timeout (20s) and a browser pool with a fixed Chromium
  version. A render that hangs holds a process; one process per request exhausts
  a machine before anyone notices.
- **No network at render time.** Enforced in `apps/worker/src/render.ts` by
  aborting every request except `data:` URLs. This is a determinism property and
  an SSRF boundary at once — a document that could make the render server fetch a
  URL is an attack on the internal network.
- Exports are cacheable by `(versionId, adapter, options)`, which is what doc 04
  §32.3's byte-stability buys operationally: the second export of an unchanged
  deck costs nothing.

---

## 5. Observability

Doc 05 §32 lists what to track. The stack, per gap register S3:

| Layer | Tool | What it answers |
| --- | --- | --- |
| Traces and metrics | **OpenTelemetry** (`apps/api/deckastra_api/telemetry.py`) | Where did the time go, and how often does this happen |
| Agent runs | An LLM tracer (LangSmith or Langfuse) against the same run ids | What did the model actually see and say |
| Errors | Any aggregator, keyed on the same ids | What broke, for whom, how often |

Three rules the implementation encodes:

1. **It is optional at runtime.** A fresh clone starts with no collector. An
   observability layer that blocks startup is one people delete.
2. **Spans carry product ids** — `presentation_id`, `run_id`, `workspace_id`,
   `version_id` — not just HTTP routes. A trace saying "the API was slow" is not
   actionable; one naming the generation is.
3. **No user text in an attribute, ever.** Not a title, not a prompt, not a
   retrieved chunk. Traces leave the machine and land in a third party, and a
   span attribute is the easiest place in a system to leak a customer's words.
   Enforced by allowlisted keys and enum values, validated product IDs and numeric
   counts. The same filter applies to late span writes and metric labels. SDK
   automatic exception capture is disabled; only an error category is emitted.

### 5.1 Collector configuration and lifecycle

Telemetry starts during the API lifespan and flushes/shuts down with it. A fresh
clone with no telemetry configuration remains disabled; importing the OpenTelemetry
API package alone no longer counts as a configured exporter. Runtime dependencies
include matching SDK and OTLP HTTP/protobuf exporter versions in the API manifest.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to a collector's base URL (for example,
`http://localhost:4318`). The HTTP exporter appends `/v1/traces` and `/v1/metrics`.
Standard signal-specific endpoint, header, timeout and compression variables are
handled by the exporters. This integration supports `http/protobuf`; gRPC is not
silently substituted. `DECKASTRA_TELEMETRY=off` disables it explicitly.
`DECKASTRA_TELEMETRY=1` enables the exporters' default local collector addresses
when no endpoint is specified.

Ordinary `configure()` calls are idempotent. `configure(force=True)` rebuilds
owned providers and rebinds existing instruments; use it during a controlled
configuration transition, since in-flight spans from the old provider may no
longer export after shutdown. Providers are not installed as process-global
singletons. The app records fixed HTTP operation names and method/status, never
URLs, query parameters, authorization headers or document bodies. Agent run and
model-call spans carry the same run ID; generation spans also carry the workspace
ID. Model spans retain approved model/task names and token counts, not prompts,
responses, refusal text or exception messages.

`apps/api/tests/test_telemetry.py` exercises real SDK exporters against a local
HTTP/protobuf collector, provider reconfiguration/disable, sensitive-content
filtering and the HTTP generation path. These tests do not establish a deployed
collector/dashboard or LangSmith/Langfuse integration. Vendor-specific agent
inspection, complete failure/spend accounting and unused metric call sites remain
tracked in F11/F12 and G02/G14.

---

## 6. Accessibility scope

**Target: WCAG 2.1 AA.** Doc 01 §9.5 said "accessible" and named nothing, which is
a requirement no build can pass or fail.

### 6.1 In scope for MVP, and checked

| Criterion | Where |
| --- | --- |
| 1.1.1 Non-text Content | `packages/renderer/src/accessibility.ts` — alt text on images, charts and diagrams |
| 1.4.3 Contrast (Minimum) | Same, measured against what is actually behind the text |
| 1.3.1 Info and Relationships | Same — reading order against visual order |
| 2.1.1 Keyboard | Present mode, the editor and the shared-deck page are all keyboard-operable |
| 2.3.3 Animation from Interactions | `packages/animation-engine` — the viewer's setting wins over the document's |
| 1.4.4 Resize Text | Logical coordinates scale; nothing is pinned to a device pixel |

The three seed decks pass every one of these, asserted in
`packages/renderer/tests/accessibility.test.ts`. A product whose own examples are
inaccessible is not one that can ask anyone else to comply.

### 6.2 Deferred, and stated so

- **Tagged PDF.** Doc 04 §34.2 designs the DOM so it is achievable; the tagging
  itself is not built.
- **Full screen-reader support for the editor.** The *decks* are accessible; the
  editing canvas is direct manipulation, and making one genuinely usable without
  sight is a project rather than a checklist item.

Naming these is the point. "Accessible except for some things" is a claim nobody
can rely on.

---

## 7. Plans and quotas

Model spend is the dominant variable cost, and doc 03's budget work and doc 04
§45.4's rate limits both needed something to reference.

| | Free | Pro | Unlimited |
| --- | --- | --- | --- |
| Generations / month | 30 | 500 | — |
| Model tokens / month | 2M | 50M | — |
| Storage | 500 MB | 20 GB | — |
| Repositories | 1 | 20 | — |

Implemented in `apps/api/deckastra_api/quotas.py`. Three decisions worth
repeating here because they are operational rather than architectural:

- **The period resets lazily**, on the first request after it lapses. A scheduled
  job that misses a month locks every workspace out, and the failure looks like a
  bug in generation.
- **Refusal before the work, accounting after it.** A workspace can overshoot by
  at most one run, which is cheaper than the alternatives: charging first means
  refunding on failure, and reserving means releasing after a crash.
- **`unlimited` is a plan, not a missing row**, so self-hosting is a decision
  someone made rather than a gap.

`RunBudget` (doc 03) and these quotas are different controls and both are needed:
per-run ceilings stop one runaway generation, quotas stop a hundred ordinary ones.

---

## 8. Metric targets

Doc 01 §9.1's "quickly" and "instantaneous" are replaced by doc 04 §31.1's
budgets, which are instrumented in `packages/renderer/src/perf.ts`. What follows
is the product half — the numbers that say whether this is working, which doc 01
S3 left unstated.

### 8.1 The one that matters most

**Percentage of generated slides kept without regeneration.**

Target: **> 60%** by the end of the first quarter after launch.

It is the single number that says whether "agents propose, deterministic engines
compose" is true in practice rather than in the architecture. A user who
regenerates every slide is a user for whom the model is a slot machine, and no
amount of renderer quality fixes that.

Measured as: slides present in the version at the end of a session that were also
present, unmodified, in the version the generation produced.

### 8.2 The rest

| Metric | Target | Why it is the right question |
| --- | --- | --- |
| Time to first deck, from sign-up | < 5 minutes | The whole promise is speed; if a first deck takes longer than making one by hand, nothing else matters |
| Generations reaching present mode | > 50% | A deck that is generated and never presented was not useful |
| AI edits accepted, of those proposed | > 70% | Below this the proposals are noise and the review step is a tax |
| AI edits undone within a session | < 10% | The complement: an accepted edit that gets undone was accepted without being read |
| Decks exported | > 30% | Export is where a deck leaves and becomes real work |
| Repository-grounded decks whose sources are opened | > 25% | Provenance nobody opens is provenance nobody trusts |
| Share links created per deck | > 0.5 | Presenting to an audience is the core use case |
| Generation failures reaching the user | < 2% | Distinct from refusals: a quota refusal is the system working |

### 8.3 What is deliberately not a target

**Number of slides generated.** It is the metric that would make every decision
worse: more slides is not better, and optimising for it produces the seven-bullet
decks doc 04 §24.4 and the Critic both exist to prevent.

---

## 9. Incident posture

| Class | Example | Response |
| --- | --- | --- |
| **Data loss** | A restore is needed | Page immediately. RTO 1 hour, and the version chain is the thing being protected |
| **Access** | A share link leaked, a token compromised | Revoke first, investigate second. `presentation_shares` keeps revoked rows so "who could see this, and when did that stop" is answerable |
| **Availability** | Generation or export is down | Degrade rather than fail: the stub planner keeps generation working without a model, and the editor works with no agent at all |
| **Cost** | A workspace or a bug is spending unexpectedly | Quotas cap it per workspace; `RunBudget` caps it per run. Both are visible in metrics before they are visible in a bill |

The degradation posture is a design property rather than a runbook step. Every
external dependency in this product — the model, the embedder, GitHub, the
collector — returns `None` when unconfigured and the feature says it is off. That
is what makes "availability" mostly a matter of saying so.
