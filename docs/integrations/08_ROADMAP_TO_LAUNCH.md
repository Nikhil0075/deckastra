# 08 — Roadmap to launch: interface, backend, plans, hosting

Status: historical launch baseline, 2026-10-09. The current implementation and
remaining launch-gap register are in
[09](09_AGENT_FIRST_ENGINE_AND_DECK_PRESETS.md); where this document describes
the old text assistant or deleted plans, 09 takes precedence.

Originally covered plans [01](01_MULTILINGUAL_DECKS_NARRATION_AND_SOUND.md),
[02](02_ASSISTANT_IMPLEMENTATION.md), [03](03_ORGANIZATIONS_GROUPS_AND_SHARED_LIBRARY.md),
[04](04_GOOGLE_CLOUD_PLATFORM.md), [06](06_FILE_MANAGER_AND_MYDECK_PACKAGE.md) and
[07](07_VERTEX_ASSISTANT_AND_FREE_PAID_TIERS.md).

**Plan 05 (image text localization) is out of scope.** It needs vision and
inpainting work that the current state cannot support.

The work runs in four tracks, in this order of priority:

1. **Interface:** clean up the front end and fix a design system that holds until
   launch.
2. **Backend and Google Cloud:** the full backend, one Vertex client and the cloud
   setup.
3. **Plans and customers:** tiers, credits, customer groups and billing.
4. **Hosting and distribution:** the website, the web app and the signed desktop
   installer.

Tracks 1 and 2 can start together; tracks 3 and 4 need the back half of track 2.

## 0. Where each plan stands

| Plan | State | What is left |
| --- | --- | --- |
| 01 Languages, narration, sound | Built and checked in the desktop app | CJK font packs (need the packs bucket, 04 §4). Arabic PDF text for character-map-only readers. |
| 02 Assistant | Built, then audited and fixed | No text task is enabled. The local model is to be removed (07). |
| 03 Organizations and groups | Not built | Needed for the Business tier only. After launch, except possibly phase A. |
| 04 Google Cloud | Not built. `infrastructure/deployment/` is empty | All of it. The API already validates OIDC tokens (`auth.py`); no client signs in yet. |
| 06 File manager and `.mydeck` | Not built | Phases A and C before launch, because free desktop users need to send a deck as a file. |
| 07 Vertex assistant, tiers | Plan | All of it. |

## 1. Track 1 — Interface clean-up and a design system that lasts

### 1.1 What is wrong today (from the current screens)

- **The canvas is squeezed.** Speaker notes and the motion timeline sit open under
  it in every mode. On a 1080p screen the slide gets about 40% of the window.
- **The top bar holds 13 controls.** There is a 4-way mode switch ("CODE JSON"),
  a sparkle, "Agents off", language, history, preview, contrast, share, download
  and Present.
- **There are three AI entry points.** The Ask panel (`AskPanel`) and the
  Assistant (`AssistantPanel`) sit one above the other in AI mode, and generation
  has its own drawer in the deck list (`GenerateDeck`). They overlap: Ask edits,
  and the Assistant also has an "edit" task.
- **The Assistant speaks engineering.** It says "Model tasks require
  representative qualification; local-only mode allows experimental Gemma runs".
  It shows a budget in dollars to four decimals, and uses a form with Task,
  Scope and Instructions selects.
- **The Intelligence drawer** offers an Anthropic key, says what the release
  "does not include", and holds the agent switch.
- **Two homes.** The web home uses pre-rewrite tokens (`AccountPicker`,
  `EmptyState`). The desktop has the rewritten `DeckList`.

### 1.2 Design principles, fixed now and kept until launch

These go in `packages/editor-ui/DESIGN.md` and are enforced by tests where
possible.

1. **The canvas comes first.** Every other region collapses. Notes and timeline
   are a dock that is closed by default in Design mode and opens itself in
   Motion mode.
2. **One assistant.** One prompt box with quick actions, opened from one button
   in the top bar and from Ctrl+K. Ask, the task form and the generation drawer
   are absorbed into it.
3. **Colour has meaning.** Kept exactly as today and enforced by
   `ui-tokens.test.ts`: blue is the action, yellow is "waiting for you", red is
   danger. Square corners, cream and black, Jost and Inter. The token set is
   frozen as v1. Later changes add tokens and never rename them.
4. **No engineering words in the product.** Not "model", "qualification",
   "provider", "token", "reservation" or "local-only". People see credits, what
   is sent, and what changed.
5. **Every surface has four states:** empty, loading, error and done. Each one
   is written and tested.
6. **Show the cost before the click.** Every AI action shows its credit cost and
   what leaves the computer. The disclosure sits at the button, not in a policy
   page.
7. **Keyboard and accessibility parity are kept.** The F6 regions, keyboard
   scope rules and the axe audit in the `a11y` smoke step stay in force.

### 1.3 The five screens (concepts in [concepts/](concepts/))

| Screen | Concept | Contents |
| --- | --- | --- |
| **Home / library** | `08-home.png` | Projects sidebar, a "Describe a deck…" prompt bar (generation lives here), Blank deck, Open `.mydeck`, a deck grid with "changes waiting" badges, and a plan card with credits. The web and desktop apps share it. |
| **Editor** | `08-editor.png` | Top bar with deck name, save state, Design / Motion / Code, Assistant (with credits), Share and Present. Labelled tool rail, slide strip, a large canvas, an inspector, and a closed dock for Notes and Timeline. |
| **Assistant panel** | `08-assistant.png` | Credits meter, a prompt box with a scope chip, quick actions with credit costs (Fix layout, Alt text, Translate, Narration, Add slides), "Waiting for you" before-and-after proposal cards, History, and one line on what is sent. |
| **Present and presenter** | (existing) | Unchanged. It was rebuilt in Phase 3 and works. |
| **Settings** | `08-plans.png` | Account, Plans and billing, AI and privacy, Agents (MCP), Languages. It replaces the Intelligence drawer. |

### 1.4 Remove from the interface

| Remove | Files | Instead |
| --- | --- | --- |
| "Cloud model (Anthropic)" section and key field | `apps/desktop/src/renderer/IntelligenceSettings.tsx`, `main/cloud-key.ts`, IPC in `shared/ipc.ts` and `preload` | Nothing. AI runs through Deckastra's Vertex gateway (07). |
| "What this release does not include" | `IntelligenceSettings.tsx`, `FirstRunNotice.tsx` copy | First-run notice rewritten for what *is* there. |
| Intelligence drawer | `IntelligenceSettings.tsx`, View-menu item | Settings › AI and privacy, and Settings › Agents. |
| Ask panel | `AskPanel.tsx`, its slot in `ModePanels.tsx` | The Assistant prompt box. |
| Task, Scope and Instructions form, and the dollar budget | `AssistantPanel.tsx` | Prompt box, quick actions and a credits meter. |
| Generation drawer in the deck list | `GenerateDeck.tsx` (outline review in `StoryCheckpoint.tsx` is kept as a step) | Home prompt bar and Assistant "Add slides". |
| "AI" as a separate mode | `ModePanels.tsx` AI mode | The Assistant opens beside any mode. Proposals, Critic issues and Sources move into it. |
| Top-bar clutter: sparkle, "Agents off", preview eye, contrast | `shell/AppBar.tsx` | Assistant button; agent status in Settings and Assistant; light/dark theme in the account menu; History stays. |
| Separate Share and Download buttons | `AppBar.tsx`, `SharePanel`, `ExportPanel` | One Share menu: Export PDF, Export PowerPoint, Save `.mydeck`, link (when cloud). |
| "CODE JSON" label | `AppBar.tsx` | "Code". |
| Notes and timeline always open | `CanvasStage.tsx`, `SpeakerNotes`, the timeline dock | A dock, closed by default in Design and open in Motion. Remembered per person. |
| Web legacy home (`AccountPicker`, `EmptyState`, `.dk-legacy` tokens) | `apps/web/app/page.tsx` | The shared `DeckList` home. |
| Repository picker on the web home | `apps/web/app/page.tsx`, `RepositoryPanel` | Assistant › Sources (attach repository, PDF, CSV). |
| Local-model and qualification copy | `AssistantPanel.tsx`, `FirstRunNotice`, docs | Deleted with the local model (track 2). |

**Reading the concepts.** They were generated with OpenArt (GPT Image 2) from
the principles above, and they fix layout and hierarchy, not pixels.

Take from them:
- the canvas taking most of the window;
- the three-item mode switch;
- Assistant, credits, Share and Present as the only top-bar actions;
- the closed Notes and Timeline dock;
- the Assistant's prompt box with costed quick actions and before-and-after
  cards;
- the home prompt bar, deck grid and plan card;
- the plan columns.

Do not copy:
- the Assistant concept's top toolbar, which replaces the labelled tool rail
  (the rail stays);
- any inspector values;
- the slide content shown.

**Keep every `data-testid` the desktop harness uses** (CLAUDE.md lists them),
or change the harness in the same commit.

### 1.5 New shared pieces

- **`CreditsMeter` and `PlanBadge`:** read from `/v1/account` capabilities, never
  computed in the client.
- **`CommandPalette` (Ctrl+K):** every menu command and the Assistant prompt. The
  future-proof entry point: new features add a command, not a button.
- **`SettingsShell`:** the five sections above, shared by web and desktop.
- **`EmptyState`, `ErrorState` and `Toast`, rebuilt on v1 tokens:** written and
  tested for all four states (§1.2, rule 5).
- **`Dock`:** the collapsible bottom region for Notes, Timeline and Audio lanes.

### 1.6 Done when

- **Five screens built.** They match the concepts in layout and pass the
  `ui-tokens`, `a11y` and keyboard tests in light and dark.
- **No leftover words.** A search of shipped strings finds no Anthropic, Gemma,
  local-only, qualification or dollar amounts.
- **Smoke steps green** on the packaged build: open, edit, verify, slides,
  history, export, motion, presenter, decks, a11y, menu and design.

**Estimate:** 2–3 weeks.

## 2. Track 2 — Backend and Google Cloud

### 2.1 Remove (07 Phase 0, backend half)

- **Anthropic:** `AnthropicClient` and the `ANTHROPIC_*` handling in
  `router.py`; the single-shot planner in `story.py`; the setup hint in
  `apps/web/app/page.tsx`; the cloud-key plumbing in `sidecar.ts`,
  `diagnostics.ts` and `logs.ts`; the key steps in `smoke.ts`.
- **Local model stack:**
  - `local_model.py`, `model_server.py`, `model_packs.py`;
  - the local half of `hybrid_model.py`;
  - the hardware binding in `qualification.py`;
  - `main/assistant-config.ts`, `setup-assistant-local.ps1`,
    `install-model-pack.py`;
  - the local parts of the benchmark scripts.
- **Keep:**
  - the stub planner, for development and CI only;
  - `process_job.py`, reused for the exporter's browser children;
  - all deterministic engines.

### 2.2 One Vertex client (07 Phase 1)

`router.default_client` and `HybridClient` merge into one factory that returns
a `VertexClient` per task from a pinned model map. Generation, Ask (`author.py`),
assistant runs and the translation `model` provider all use it.

The cost ledger becomes per account with a monthly reset (§2.4).

### 2.3 Google Cloud setup (04, made concrete)

| Piece | Choice | Notes |
| --- | --- | --- |
| Projects | `deckastra-dev`, `deckastra-prod` | The existing `deckastra` project becomes dev. Separate billing alerts per project. |
| Region | One region close to users (for example `asia-south1`); Vertex on `global` as configured today | Confirm each Gemini model's availability per region before pinning. |
| Containers | Artifact Registry; images for `api`, `web`, `export-worker`, `migrate` | `infrastructure/deployment/docker/`. |
| Compute | Cloud Run: `api`, `web`, `export-worker` (CPU always on, concurrency 1), `migrate` job | Exports need Chromium; the worker image carries it. |
| Database | Cloud SQL for PostgreSQL | The suite already runs against Postgres (`POSTGRES_TEST_URL`). |
| Files | Cloud Storage buckets: `assets`, `exports`, `packs` | Use S3 interoperability first, a native backend if it falls short (04 §3.3). |
| Accounts | Identity Platform: Google sign-in and email link | `auth.py` already verifies OIDC. Add claims mapping and a sign-in UI. |
| Secrets | Secret Manager; service accounts per service | No keys in images. The desktop never holds Google credentials. |
| AI | Vertex AI (Gemini), Cloud Translation, Text-to-Speech | The gateway's service account only. |
| Deploys | GitHub Actions with Workload Identity Federation → Cloud Run | `.github/workflows/deploy.yml`; migrations run as a job before traffic moves. |
| Observability | `telemetry.py` OTLP → Cloud Trace and Monitoring; error reporting; uptime checks | No user text in spans (already a rule). |
| Cost guardrails | Billing budgets and alerts per project; a Vertex quota cap; the app's own monthly ledger | Three independent stops. |
| Infrastructure as code | Terraform in `infrastructure/deployment/terraform/` | After the first manual deploy works (04 phase D). |

### 2.4 The AI gateway (07 §4)

**Routes:** the existing `/v1/assistant/*` and `/v1/generate*`, served by the
hosted API with the signed-in account's token.

**New tables:**
- `credit_accounts`: plan, monthly allowance and period start;
- `credit_entries`: grants, charges, refunds and top-ups;
- per-account reservations, extending `assistant_reservations`.

**Rules:**
- **Monthly reset by date.** Lazy, on the first request after the period ends,
  like `quotas.py`, so a missed job never locks anyone out.
- **No deck content kept.** Run records keep the task, model, usage, credits and
  outcome. `result_json` keeps only what the client needs to show the proposal,
  and it expires.
- **Abuse limits:** verified email, per-account and per-device daily caps, and a
  global daily cap.

### 2.5 Desktop and cloud

- **Signing in.**
  - The desktop signs in through the system browser (OAuth with PKCE and a
    loopback redirect).
  - The token is stored with `safeStorage`, like the old key.
  - The main process adds it to gateway calls, the same proxy pattern as
    today, so the page never sees it.
- **Decks stay local.** The local sidecar keeps owning them. Only an AI job
  calls the gateway, with the selected scope.
- **Signed out, everything except AI credits works.** That includes MCP and
  export.

### 2.6 Feature work that belongs in this track before launch

- **06 phases A and C:** the `.mydeck` package (export, import with every
  container check), the desktop file association and Open file. Free desktop
  users send decks as files.
- **01 open items:** CJK font packs from the `packs` bucket, and Arabic PDF text
  for character-map-only readers.
- **03 phase A** (orgs and members) only if the Business tier launches with the
  product. Otherwise it waits.

### 2.7 Evaluation before AI tasks are switched on (07 §8)

- 20 cases per task from the advanced-deck corpus.
- Review by someone other than the system's author.
- A separately approved budget of about $15–30.
- Each task is enabled only for the exact model that passed.

### 2.8 Legal and data

- Privacy policy and terms.
- A data-processing statement that names Vertex AI and Google's data-use terms
  for it, confirmed before publication.
- Account deletion that removes cloud data.
- GST registration and invoices (with track 3).

**Estimate:**
- Removal and one client: 1 week.
- GCP and gateway: 2–3 weeks.
- `.mydeck` and packs: 1–2 weeks, in parallel.

## 3. Track 3 — Plans and customer groups

### 3.1 Who the customers are

| Group | What they need | Plan | Why they pay, or stay |
| --- | --- | --- | --- |
| **Students and individual creators** | Make and export a good deck quickly at no cost | Free | The full editor, layout fixes, export, a few AI credits each month. |
| **Professionals, consultants, founders** | Board and client decks fast, on-brand, editable PowerPoint | Plus | AI credits for drafting and editing, brand kits, translation and voiced narration. |
| **Technical users with coding agents** | Decks from repositories, docs and data, driven by Claude Code, Codex or Gemini CLI | Free (MCP is unlimited), Pro for the cloud extras | MCP costs Deckastra nothing; they upgrade for sync, sharing and media. |
| **Multilingual presenters** (India and the Gulf first) | One deck in several languages, narrated, for sales and training | Plus or Pro | Locale overlays, Indic and Arabic scripts, narration per click step, PPTX with audio. Few competitors do this. |
| **Teams and companies** | Shared library, groups, roles, admin, SSO | Business, later (plan 03) | Seats, a shared library, governance. |

### 3.2 Plans (from 07 §6, refined)

| | Free | Plus | Pro | Business (later) |
| --- | --- | --- | --- | --- |
| Price (India / international) | ₹0 / $0 | ₹399 / about $9 a month | ₹899 / about $19 a month | Per seat, on request |
| AI credits a month | 60 | 600 | 2,000 | Pooled |
| Editor, engines, export (no watermark), MCP | ✓ | ✓ | ✓ | ✓ |
| Translation, voiced narration, AI images | Trial | ✓ | ✓, higher limits | ✓ |
| Brand kits | 1 | 3 | Unlimited | Shared library |
| Cloud sync and links | — | 1 device + links | Sync + pinned links | Org-wide |
| Top-ups | — | ✓ | ✓ | ✓ |

Annual billing is 25% off, the market norm. A student discount on Plus can come
later with verification.

### 3.3 Credits and entitlements

- **Credits per action** are set after measuring real Vertex cost, priced so one
  credit costs at most about $0.005. Starting points:

  | Action | Credits |
  | --- | --- |
  | Fix layout | 0 (engine) |
  | Motion | 0 (engine) |
  | Alt text, per image | 1 |
  | Narration script, per slide | 1 |
  | Edit, per slide | 2 |
  | Translate, per slide | 2 |
  | Voice, per minute | 5 |
  | AI image | 15 |
  | 10-slide draft | 40 |

- **Entitlements are server data.** `plan → {credits, features, limits}` is
  returned in `/v1/account` capabilities and enforced in the API. The interface
  only reads it.
- **Every charge** has a reservation, a reconciliation and a refund path, using
  the same machinery as today, per account.

### 3.4 Billing

- **Providers:** Razorpay for INR (UPI, cards) and Stripe for international cards,
  if the company is Indian. Confirm with an accountant (07 §2.5).
- **Entitlements change only through webhooks**, never from the client.
- **Subscription handling:** dunning, cancellation at the end of the period,
  proration, and GST invoices.

### 3.5 What to measure from day one

- **Activation:** the first export.
- **Weekly active creators.**
- **Credit burn per plan.**
- **Cost per active user.**
- **Free-to-paid conversion:** 6–8% is the AI-product "good" benchmark.
- **Churn and refund rate.**

**Estimate:** 1–2 weeks after the gateway exists.

## 4. Track 4 — Website hosting and distribution

### 4.1 Website (new: `apps/site`)

- **Pages:** Home, Features (languages and narration, MCP for coding agents,
  design engines), Pricing, Download (installer with SHA-256 and release notes),
  Docs (getting started, MCP setup for Claude Code, Codex and Gemini CLI,
  `.mydeck` format), Privacy, Terms, Changelog, Status.
- **Hosting:** Firebase Hosting or Cloud Run behind Cloud CDN. Domain, DNS and
  managed TLS.
- **Analytics:** privacy-respecting, no third-party ad trackers. The product's
  pitch is that decks stay private.

### 4.2 Web app

- **Address:** `app.<domain>` on Cloud Run behind an HTTPS load balancer.
- **Code:** the same `apps/web`, with the shared home and editor from track 1 and
  Identity Platform sign-in.
- **Before launch:** sharing links and the shared viewer are already built and
  only need the hosted service.

### 4.3 Desktop distribution

- **Code signing.** A Windows certificate (OV or EV, or a cloud signing service),
  then `npm run release:win`. It refuses to run without signing and verifies the
  release strictly.
- **Licence notices.** Record decisions for the five libraries that ship no
  licence text (brotli, dfa, fontkit, langsmith, sqlite-vec), or a release build
  fails.
- **Updates.** Only once signing works: an update feed (for example a Cloud
  Storage or GitHub Releases channel) with staged rollout. Until then, manual
  upgrades as `docs/UPGRADING.md` describes.
- **Before calling it done:** run the installer on a clean Windows account or
  Windows Sandbox (item 26), which has not been done yet.
- **macOS.** After launch, with real hardware, signing and notarization (D6).

### 4.4 MCP distribution

- **Desktop:** ships inside the app, as today.
- **Web:** a hosted MCP endpoint with scoped OAuth grants, later, after the
  desktop route has real users.

### 4.5 Release process

- CI on `windows-latest` builds the signed installer.
- Tag, then publish to the download page with checksums.
- The changelog entry comes from commit messages.

**Estimate:** about 2 weeks, mostly the site and signing.

## 5. Order and timeline

| Week | Track 1 Interface | Track 2 Backend and cloud | Track 3 Plans | Track 4 Hosting |
| --- | --- | --- | --- | --- |
| 1 | Freeze tokens v1; Settings shell; remove the Anthropic drawer and Ask | Remove Anthropic and the local model; one Vertex client | Confirm segments and prices | Choose domain, signing route |
| 2 | Assistant panel; command palette; the dock | GCP dev: Cloud Run, Cloud SQL, GCS, Identity Platform | Credit costs measured on dev | Site skeleton |
| 3 | Home shared by web and desktop; editor top bar | Gateway: credits ledger, sign-in on desktop | Entitlements in `/v1/account` | Pricing and docs pages |
| 4 | Four states everywhere; a11y in dark | Evaluation runs (approved budget); `.mydeck` A and C | Billing (Razorpay and Stripe) in test mode | Signed installer from CI |
| 5 | Packaged smoke sweep | Prod project, Terraform, alerts | Live billing | Launch: site, web app, signed installer |

**Launch gate:**
- every smoke step green on the signed installer;
- evaluation reports published for every enabled AI task;
- billing works end to end in live mode;
- privacy and terms published;
- cost alerts tested.

## 6. Decisions only you can make

1. Free exports with **no watermark**, as recommended, or a small removable end
   slide.
2. Prices in INR and USD, as above or adjusted.
3. Whether **Business** (plan 03) launches now or after.
4. The domain name, and which company entity bills customers.
5. The code-signing route and budget.
6. The evaluation budget for the Vertex tasks.
