# 07 — One assistant on Vertex AI, MCP for code agents, free and paid tiers

Status: historical baseline, 2026-10-09. For current implementation scope and
open gaps use [09](09_AGENT_FIRST_ENGINE_AND_DECK_PRESETS.md). Plan 09 removes
the general Vertex text assistant described here; only explicit media and
language services remain paid product capabilities.

Supersedes:
- the local-model half of [02](02_GEMMA_ADK_ASSISTANT.md) and
  [02 implementation](02_ASSISTANT_IMPLEMENTATION.md);
- the Anthropic key route described in `CLAUDE.md` items 19, 20 and 23.

Related:
- [04](04_GOOGLE_CLOUD_PLATFORM.md) (Google Cloud);
- [03](03_ORGANIZATIONS_GROUPS_AND_SHARED_LIBRARY.md) (teams, later);
- [the advanced-deck recheck](ADVANCED_DECK_RECHECK.md) (the evidence this
  plan acts on).

## 1. What is being decided

1. **Remove the "Cloud model (Anthropic)" section** and the bring-your-own-key
   route behind it.
2. **Drop the local model.** Gemma E2B on a 4 GB card is not a good experience.
   It failed every model task on the stress deck except research:
   - edit and alt text failed the output format on both attempts;
   - translation and narration produced no usable change;
   - cleanup succeeded 5% of the time.

   Model start-up alone is 15–20 s.
3. **Run every assistant task on Vertex AI (Gemini)**, with a pinned, evaluated
   model per task. Credentials and billing are Deckastra's, not the user's.
4. **Keep MCP as the route for code agents.** Claude Code, Codex and Gemini CLI
   bring their own intelligence and can do most of the heavy authoring. It costs
   Deckastra nothing to serve.
5. **Build one product that works for free and paid users.** Free users get the
   whole editor, the deterministic engines, exports and MCP. Paid users get
   Vertex credits and the paid media capabilities.

## 2. What the research says

### 2.1 Market

- **Free tiers are standard.** All seven priced AI presentation tools in one 2026
  comparison have a free tier. The category averages about $17 per user per
  month, and ranges from free to $35.
  ([CostBench](https://costbench.com/stats/ai-presentations-pricing-2026/))
- **Gamma (the closest comparison):**
  - Free: 400 one-time AI credits that never refill, and a "Made with Gamma"
    watermark on PDF and PPTX exports.
  - Paid: Plus at about $8–10 with 1,000 credits a month, Pro at about $18–20,
    Ultra at about $90–100.
  - Exports are not gated; the AI budget is.
  - Sources: [CostBench](https://costbench.com/software/ai-presentations/gamma/free-plan/),
    [Gamma guide](https://gamma.app/explore/content/guides/best-ai-presentation-tools-export-beyond-live-link),
    [Rework](https://resources.rework.com/tools/ai-tools/best-ai-presentation-tools-2026).
- **Beautiful.ai** has no free tier; Pro is about $12 a month billed annually.
  **Pitch** has a free tier and Pro at about $20.
  ([Rework](https://resources.rework.com/tools/ai-tools/best-ai-presentation-tools-2026))
- **Canva** gates by capability rather than by export:
  - background remover and Magic Resize are Pro only;
  - Free gets one brand kit with three colours, Pro gets several;
  - AI credits are small on Free and large on Pro.

  Pro is about $15 a month or $120 a year.
  ([Style Factory](https://www.stylefactoryproductions.com/blog/canva-pro-vs-free))

**Takeaway.** The market charges for **AI budget and premium capabilities**,
not for the editor. A free user can make and export a real deck everywhere.

### 2.2 Conversion

- **Traditional freemium** converts about 3.7% on average.
  ([First Page Sage via Userpilot](https://userpilot.com/blog/freemium-to-premium))
- **AI-native products:** good is 6–8% and great is 15–20%.
  ([Mewayz](https://mewayz.com/cs/blog/free-tier-conversion-rates-across-saas-what-the-data-actually-shows))
- **Serving free users now costs real money** because model tokens are not free.
  ([Kingy AI](https://kingy.ai/news/the-12-billion-ai-market-where-97-of-users-dont-pay-and-how-smart-startups-are-closing-the-gap/))

**Implication.** Plan for about 95% of users never paying. A free user's
model spend must be bounded per month, and as much of the free experience as
possible must run on code that costs nothing to serve.

### 2.3 Unit costs (list prices, to be re-measured)

| Capability | Price | Source |
| --- | --- | --- |
| Gemini Flash class | about $0.30–1.50 input and $2.50–9 output per 1M tokens, depending on generation | [Curlscape](https://curlscape.com/blog/google-gemini-api-pricing-guide-2026), [DeployBase](https://deploybase.ai/articles/gemini-api-pricing-2026) |
| Gemini 3.1 Pro | $2 input and $12 output per 1M tokens (≤200K context) | same |
| Chirp 3 HD speech | $30 per 1M characters, with the first 1M free | [Google Cloud](https://cloud.google.com/text-to-speech/pricing) |
| One generated image | $0.067, conservative, measured here | [media record](benchmarks/media-live.json) |
| Flash cleanup or narration, one slide | about $0.01–0.03 actual, measured here | [benchmark results](BENCHMARK_RESULTS.md) |

The prices this repository's ledger uses (`DECKASTRA_VERTEX_PRICES`) must be
checked against the live price page before launch. Model names and prices have
moved twice this year.

### 2.4 MCP

Presentation MCP servers are now an expected integration. SlideSpeak and 2Slides
both ship guides for Claude Code, Codex and Gemini CLI.
([SlideSpeak](https://slidespeak.co/guides/build-presentations-with-claude-code-and-slidespeak),
[2Slides](https://2slides.com/blog/use-any-ai-agent-with-2slides-mcp-server))

Deckastra's MCP server is already stronger than a "make a PPTX" tool:

- it edits a live, versioned deck;
- risk is computed by the server;
- destructive changes wait for the person;
- exports and previews go through the real renderer.

That is the differentiator to lead with for technical users.

### 2.5 Getting paid from India

If the company is Indian, the common pattern is **Razorpay for INR** (UPI and
domestic cards) plus **Stripe for international cards**.

A merchant of record (Paddle and similar) handles worldwide tax. For an Indian
entity, though, it can break the documentation GST zero-rating and FEMA expect.
Lemon Squeezy has been moving merchants to Stripe Managed Payments, which does
not list India. ([StartupTalky](https://startuptalky.com/lemonsqueezy-alternative-for-indian-saas-accepting-global-payments/),
[Dodo Payments](https://dodopayments.com/blogs/best-merchant-of-record-platforms))

Confirm with an accountant before choosing.

## 3. What this repository has today

Three ways to get intelligence, which is two too many:

| Path | Where | Status |
| --- | --- | --- |
| Generation and Ask through `router.py` | `AnthropicClient`, `story.py` single-shot, `stub.py`, the local llama.cpp client; desktop key in `cloud-key.ts` | Anthropic key or local pack or stub |
| Assistant runs through `HybridClient` | `hybrid_model.py`, `qualification.py`, `vertex_model.py`, `local_model.py`, `model_server.py` | Gemma first, Vertex escalation |
| MCP (`apps/mcp-server`) | The person's own agent | Works, scoped grants, consent switch |

The assistant routing map is empty after the remediation. With $0.048 of the
$5 ceiling left, no paid task can run.

## 4. Target architecture

```
Desktop / Web editor ──► Deckastra API (local sidecar or hosted)
                              │  documents, versions, proposals stay here
                              │
                              ├─ deterministic engines (free, no network)
                              │    tidy · motion planner · Design Check · export
                              │
                              └─ AI gateway (hosted, signed-in account)
                                   │ credits · reservations · audit (no content kept)
                                   ▼
                              Vertex AI (Deckastra's project)
                                   Gemini per task · Gemini image · Chirp speech

Claude Code / Codex / Gemini CLI ──MCP──► local API (free, no credits)
```

**Deck storage does not change.** A desktop deck stays on the computer.

**Only the job's input leaves the machine:** the selected slides, the brief and
the chosen sources. It goes to the AI gateway only when the person presses Run,
after a sign-in, and with a one-line disclosure at the button.

The gateway keeps no deck content. It records:
- the account;
- the task, model and provider used;
- tokens and characters, cost and credits;
- the outcome.

**Why a gateway rather than calling Vertex from the desktop.** Google
credentials and the spend ceiling must never be on a user's machine. Credits
also have to be enforced somewhere the user cannot edit. The existing
`AssistantReservation` table and `cost_ledger.py` logic move there, keyed by
account. They gain a **monthly reset**, fixing the current lifetime ceiling, and
a **per-account ceiling**, fixing the host-wide ledger shared by every workspace.

**The web app** uses the same gateway, already server-side.

## 5. Model per task (Vertex only)

Pin one model per task. Enable a task only when the evaluation in §8 passes for
that exact model and thinking setting. This keeps the qualification idea and
drops the local hardware binding.

| Task | Starting candidate | Why |
| --- | --- | --- |
| Generate a deck (orchestrate, story, critic) | Gemini Pro | Planning and grounding failed on Flash LOW (0% reviewed). Needs the stronger model. |
| Edit, consistency, alt text (vision) | Gemini Pro, then try Flash | Authoring on Flash LOW was 90% valid and over the latency target. |
| Narration scripts | Gemini Flash | Passed review on the narrow corpus. Re-run on the new one. |
| Translation | Cloud Translation, then Flash polish | Translation was 85% on Flash. The deterministic MT provider already exists. |
| Research with web grounding | Gemini Flash plus Google Search grounding | Configure the search price ceiling (`search_max_usd`). |
| Image | Gemini image model | A separate media price. |
| Spoken narration | Chirp 3 HD | Already integrated and priced. |
| Tidy, motion, Design Check, export | **The editor's engines, no model** | Free, instant, already done. |

"Robust model" means the highest-quality model that passes, with latency and
cost as tie-breakers. That is what `select-assistant-routing.py` already
computes; it now runs on Vertex reports only.

## 6. Free and paid

Credits are priced so that **one credit costs Deckastra at most about $0.005**
of provider spend. Each action is charged a fixed number of credits, set after
measuring its real cost, so people see "this costs 2 credits" and never a token
count.

| | **Free** | **Plus** (about $9/month, India ₹399) | **Pro** (about $19/month, India ₹899) |
| --- | --- | --- | --- |
| Editor, Design tab, themes, Code mode, Motion, presenter | ✓ | ✓ | ✓ |
| Design Check, tidy and motion engines | ✓ unlimited | ✓ | ✓ |
| PDF and PPTX export | ✓, no watermark | ✓ | ✓ |
| MCP for Claude Code, Codex and Gemini CLI | ✓ unlimited, no credits | ✓ | ✓ |
| Languages: manual overlays, record your own narration, sound library | ✓ | ✓ | ✓ |
| AI credits (Vertex) | 60 a month, refilling | 600 a month | 2,000 a month |
| Machine translation, voiced narration, image generation | Small trial | ✓ | ✓, higher limits |
| Brand kits and object styles | 1 | 3 | Unlimited |
| Cloud workspace, sharing and sync (when D5 ships) | Not included | 1 device + sharing | Sync and pinned share links |
| Top-up credit packs | No | ✓ | ✓ |

**What it costs to serve.** At 100% of allowance:
- a free user costs about $0.30 a month;
- Plus costs about $3, a 67% margin before payment fees;
- Pro costs about $10, a 47% margin.

Most people use a fraction of their allowance. Revisit the allowances with real
usage after a month. Teams and Business (plan 03) come later and are not part
of this launch.

**Why no watermark.** Gamma watermarks free exports. Deckastra's deterministic
engines and MCP cost nothing to serve, so the free tier can be a real tool and
the reason to pay is AI budget.

This is a positioning choice. The alternative, a small removable "Made with
Deckastra" final slide, is easy to add later and hard to remove once people
expect it. Decide before launch.

**Why credits refill monthly for free users.** Gamma's one-time bucket turns a
free user into a lapsed user. A small monthly refill brings them back, and the
monthly ceiling bounds the cost.

## 7. Remove, keep, change

### Remove

| Item | Files | Notes |
| --- | --- | --- |
| "Cloud model (Anthropic)" UI and key storage | `IntelligenceSettings.tsx`, `main/cloud-key.ts`, its IPC in `shared/ipc.ts` and `preload`, `sidecar.ts` key injection, `diagnostics.ts` and `logs.ts` key fields, the `smoke.ts` key steps | Also delete any stored key file on upgrade, and say so in the release notes. |
| Anthropic client and single-shot planner | `router.py` `AnthropicClient`, the `ANTHROPIC_*` env handling, `story.py` single-shot path, `apps/web/app/page.tsx` setup hint | `GenerateRequest.use_graph` loses its fallback. The graph becomes the only path. |
| Local model stack | `local_model.py`, `model_server.py`, `model_packs.py`, `hybrid_model.py` (local half), `qualification.py` hardware binding, `main/assistant-config.ts`, `scripts/setup-assistant-local.ps1`, `install-model-pack.py`, `benchmark-model-pack.py`, `benchmark-full-generation.py` local parts | Uninstall instructions for the existing pack folder go in the release notes. |
| "Local-only mode" and the `DECKASTRA_INTELLIGENCE=local` value | Router, assistant routes, panel copy | Turning AI off becomes a setting with nothing sent anywhere, rather than a separate mode. |
| The Gemma half of the 02 docs and benchmarks | Mark superseded, do not delete | They are evidence of why. |

### Keep

- **Editor and engines:** the editor, the Design tab and every deterministic
  engine (tidy, the motion planner, Design Check, export).
- **Document safety:** the proposal lifecycle, risk computed by the server,
  version checks, undo and the scope gates.
- **MCP:** the MCP server, grants and the consent switch, unchanged.
- **Assistant infrastructure:** runs, events, resume, cancellation, reservations,
  the typed failure messages and the per-slide time allowances, retargeted to
  Vertex.
- **Vertex adapter:** `vertex_model.py` (images, tools, streaming, accounting).
- **Languages and speech:** Google Cloud Translation and Chirp speech providers.
- **`process_job.py`:** a general child-process guard. Reuse it for the
  exporter's browser children.
- **The stub planner, development and CI only:** it keeps the vertical slice
  runnable without a key, and installed builds already refuse it.

### Change

- **One client.** `router.default_client` and `HybridClient` collapse into one
  `VertexClient` factory with a per-task model map. Generation, Ask (`author.py`)
  and assistant runs all use it.
- **Gateway.** Assistant runs call the hosted gateway with the signed-in
  account's token. The local sidecar never holds Google credentials.
- **Sign-in on desktop.** It is needed only for AI credits, never to open,
  edit or export a deck.
- **Intelligence drawer.** Three sections:
  - *AI assistant*: credits left, plan and what is sent;
  - *AI agents*: MCP, unchanged;
  - *What runs where*.
- **Capabilities** report remaining credits per task. This replaces the
  remaining-dollars check.

## 8. Evidence before a task is switched on

The audit showed the old evidence was too narrow. For each task, on its pinned
Vertex model:

- **Cases:** 20, built from the advanced-deck corpus (at least 6 slides and 5
  feature groups), not slide 0 of a fixture.
- **Validity:** at least 95% patch validity, meaning patches that apply, not
  just well-formed JSON.
- **Review:** at least 90% reviewed success, judged by someone other than the
  system's author.
- **Safety:** zero safety failures and no new severe Design Check findings.
- **Speed:** warm p95 of 30 s or less per slide, and 120 s or less for a
  10-slide draft.
- **Budget:** a separately approved evaluation budget. The current $5 ceiling
  cannot cover one pass. Estimate about $15–30 for all tasks on Pro and Flash.

## 9. Phases

| Phase | Work | Exit |
| --- | --- | --- |
| **0. Remove** | Delete the Anthropic UI, key storage and client, and the local model stack (§7). Update the drawer, release notes and `CLAUDE.md`. | Desktop builds and passes smoke steps. No setting mentions Anthropic or local models. Old key files are deleted on first launch. |
| **1. One Vertex client** | Collapse the router and hybrid client. Use a per-task model map. Generation, Ask and assistant all go through it. | Python suites green. Generation and Ask run on Vertex in a test project. |
| **2. Evaluate** | Run §8 per task with an approved budget and an independent reviewer. Pin the routing map from the reports. | Published reports and a pinned map. Tasks that fail stay off, with a clear reason. |
| **3. Gateway and accounts** | Hosted API with sign-in, a credits ledger (monthly reset, per-account ceiling), no content retention, and abuse limits (verified email, per-device limits). | Desktop and web run a task signed in. Credits are charged and refunded correctly, and a reservation is released on a confirmed failure. |
| **4. Plans and billing** | Free, Plus and Pro. Razorpay plus Stripe, or the chosen provider. Top-ups, entitlements read by capabilities. | A test purchase unlocks Plus, a cancel reverts at period end, and refunds work. |
| **5. Launch** | Signed installer (D6), pricing page, data-handling page, support. | First 100 users, with measured cost per active user and conversion. |

Phase 0 is independent of the rest and can ship in the next build.

## 10. Risks

- **Privacy.** Desktop users chose this product for local decks. AI is opt-in per
  job, says what is sent, and the gateway keeps no content. Confirm and state
  Google Cloud's data-use terms for Vertex before launch.
- **Free-tier abuse.** Bounded by the monthly credits, verified sign-up and
  per-device limits. The deterministic engines and MCP cost nothing, so abuse
  only reaches the credits.
- **Model churn.** Gemini model names and prices change. Pin versions,
  re-evaluate on change, and keep prices in configuration that is checked at
  start-up.
- **Single provider.** Everything rides on one cloud. The one-client factory
  keeps a second provider possible later, but this plan deliberately does not
  build one.
- **Offline.** AI needs the network. Everything else, including MCP, keeps
  working offline.

## Sources

- [CostBench: AI presentation pricing benchmarks 2026](https://costbench.com/stats/ai-presentations-pricing-2026/)
- [CostBench: Gamma free plan](https://costbench.com/software/ai-presentations/gamma/free-plan/)
- [Gamma: export beyond a live link](https://gamma.app/explore/content/guides/best-ai-presentation-tools-export-beyond-live-link)
- [Rework: best AI presentation tools 2026](https://resources.rework.com/tools/ai-tools/best-ai-presentation-tools-2026)
- [Style Factory: Canva Pro vs Free](https://www.stylefactoryproductions.com/blog/canva-pro-vs-free)
- [Userpilot: freemium to premium](https://userpilot.com/blog/freemium-to-premium)
- [Mewayz: free tier conversion rates](https://mewayz.com/cs/blog/free-tier-conversion-rates-across-saas-what-the-data-actually-shows)
- [Kingy AI: the AI market where most users do not pay](https://kingy.ai/news/the-12-billion-ai-market-where-97-of-users-dont-pay-and-how-smart-startups-are-closing-the-gap/)
- [Curlscape: Gemini API pricing 2026](https://curlscape.com/blog/google-gemini-api-pricing-guide-2026)
- [DeployBase: Gemini API pricing 2026](https://deploybase.ai/articles/gemini-api-pricing-2026)
- [Google Cloud: Text-to-Speech pricing](https://cloud.google.com/text-to-speech/pricing)
- [SlideSpeak: Claude Code guide](https://slidespeak.co/guides/build-presentations-with-claude-code-and-slidespeak)
- [2Slides: MCP server](https://2slides.com/blog/use-any-ai-agent-with-2slides-mcp-server)
- [StartupTalky: global payments for Indian SaaS](https://startuptalky.com/lemonsqueezy-alternative-for-indian-saas-accepting-global-payments/)
- [Dodo Payments: merchant of record platforms](https://dodopayments.com/blogs/best-merchant-of-record-platforms)
