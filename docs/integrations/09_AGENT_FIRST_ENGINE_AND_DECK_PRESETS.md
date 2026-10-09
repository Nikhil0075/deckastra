# 09 — Agent-first Deckastra: a stronger engine, deck presets and media

Status: implemented, merged to `main` and deployed to the `dev` cloud backend,
2026-10-09. What remains needs a person, a decision or hardware (§10.1).

Shipped:
- 2026-10-09: merged as #9, with `main`'s history merged in. All conflicts
  resolved to this plan's side. CI on `main` went green for the first time since
  #1, once the pixel baselines were re-recorded after review
  (`packages/renderer/baselines/pixels/REVIEW.md`).
- 2026-10-09: the first `dev` deploy failed its smoke test because the export
  worker had been blocked since 2026-10-06 by one abandoned upload. #10 fixed
  that, and #11 makes a failed release roll the worker back with the API and
  requires migrations that keep the previous release working. The `dev`
  deploy for #11 passed, and its worker logs show no retries.

Built so far:
- Gap closure unit 1: MCP can request narrated MP4 export; the transition
  vocabulary is now consistent across schema, engine, editor, API, contracts
  and MCP (including cover, wipe, split, iris, flip and blur dissolve); and a
  template's `voiceStyle` is retained in composed deck metadata. Known feature,
  evidence, packaging and repository-record gaps are tracked in §10.1 rather
  than hidden behind the phase-complete labels. Evidence is in
  `docs/evaluations/PLAN_09_GAP_CLOSURE_2026-10-09.md`.
- Phase 8 (complete): muted 720p Veo clips now travel through the authenticated
  media gateway behind a signed, 15-minute credit quote bound to the exact deck,
  prompt, duration and aspect ratio. A successful run stores a bounded MP4 and
  extracted poster frame, counts both against workspace storage, and creates a
  pending proposal that the agent cannot approve. PDF uses and reports the
  poster approximation; PowerPoint embeds the MP4 with its poster; narrated MP4
  export samples the clip on the shared timeline. Evidence is in
  `docs/evaluations/PHASE_8_VIDEO_MEDIA_2026-10-09.md`.
- Phase 7 (complete): the reviewed launch catalog now has 60 semantic slide
  patterns, 20 contrast-checked themes, seven motion styles and 24 ten-slide
  templates, with exactly four templates in each purpose group. The generated
  review sheet covers every pattern across three themes (180 cells); all
  templates compose to valid documents and clear the preset Design Check.
  Launch counts are enforced in tests rather than recorded only in prose.
  Evidence is in `docs/evaluations/PHASE_7_PRESETS_AT_SCALE_2026-10-08.md`.
- Phase 6 (complete): MP4 is a first-class export job. The worker samples the
  resolved scene at exact frame times, maps narrated time back to the slide
  timeline, mixes narration, cue sounds and the compiled music gain envelope,
  then encodes H.264/AAC through a configured ffmpeg executable. Cloud export
  images install the encoder; desktop releases resolve an audited executable
  from `Resources/ffmpeg` or `DECKASTRA_FFMPEG`. A real ten-slide narrated
  artifact decoded with audio/video drift within one 30 fps frame. Evidence and
  the WebCodecs/ffmpeg spike decision are in
  `docs/evaluations/PHASE_6_MP4_EXPORT_2026-10-08.md`.
- Phase 5 (complete): synthesized narration takes retain word-level time points;
  a cue can select its own speaker and advance the next reveal on a specific
  spoken word. Present mode seeks the continuing line across that reveal and
  highlights the current word in the presenter script. Deck or section music
  beds compile fades and narration ducking into an explicit gain envelope;
  PowerPoint embeds the bed and reports its playback approximation. The
  deterministic sound library now contains 40 recipes. Evidence is in
  `docs/evaluations/PHASE_5_NARRATION_2026-10-08.md`.
- Phase 4 (complete): themes now carry safe, data-only custom motion presets
  with normalized keyframes. Missing reduced-motion fallbacks fail validation;
  the compiler resolves custom and built-in fallbacks through one path and
  clamps oversized entrances to the theme budget. PowerPoint maps custom motion
  to the nearest native effect, preserves the resolved entrance/emphasis/exit
  category and reports the approximation. The Phase 4 emphasis, exit, path and
  text builds plus wipe, split, iris, flip and blur-dissolve transitions now
  have seek/play, reduced-motion and export-mapping acceptance coverage.
  `motion_preview` now returns a time-labelled six-frame contact sheet through
  MCP, sampled and painted in one pass by the same worker used for export.
  Evidence is in `docs/evaluations/PHASE_4_ANIMATION_2026-10-07.md`.
- Phase 3 (complete): the catalog now has 20 semantic patterns,
  six reviewed ten-slide templates that collectively use every pattern, and
  three applied motion styles. The searchable gallery previews real opening
  content; MCP publishes the pattern/motion contracts and returns semantic
  pattern plus motion summaries. Both the repeatable real-stdio control and the
  authenticated official GitHub Copilot CLI built and verified a ten-slide
  animated deck in three Deckastra calls, below the five-request budget. The
  literal client-specific exit check passes. Evidence is in
  `docs/evaluations/PHASE_3_FIRST_PRESETS_2026-10-07.md`.
- Phase 2 (complete): seven slide-pattern schemas define typed named slots with
  required fields and item bounds; the generated catalog publishes that
  contract. `presets:check` validates all six reviewed templates, proves eleven
  deliberate broken-preset controls, and drift-checks a 21-cell contact sheet
  covering every pattern in three themes. Every reviewed preset composes to a
  schema-valid document and clears the preset Design Check codes; all patterns
  also clear short, typical, forty-word, Hindi, Arabic and CJK stress fills.
  Evidence is in `docs/evaluations/PHASE_2_PRESET_GATE_2026-10-07.md`.
- Phase 1 (complete): the bundled MCP transport passed 16/16 live-app checks,
  and Codex, Claude Code, GitHub Copilot, and Antigravity each completed a
  recorded template-to-PDF client run. Gemini CLI now refuses individual
  accounts and directs them to its Antigravity successor, so it is no longer a
  separate active gate target; Antigravity completed that successor obligation.
  The evidence matrix is in
  `docs/evaluations/PHASE_1_MCP_CLIENT_ACCEPTANCE_2026-10-06.md`.
- Phase 1 (guidance and setup unit): MCP publishes authoring and live-theme
  resources, six purpose-specific worked examples, and `build_deck` /
  `revise_deck` prompts. Desktop Settings now generates copy-ready MCP
  configuration for VS Code / Copilot, Claude Code, Codex, Antigravity, and
  Gemini CLI from the installed app's actual launcher path. The active-client
  acceptance matrix is complete.
- Phase 0: removed the text-model router, per-task Vertex map, qualification
  gate, critique job, and text benchmark/selection scripts. The native Vertex
  transport remains only for the explicitly pinned paid image model; video will
  join that media surface later.
- Phase 0: removed the general text-model translator and its assistant task.
  Translation now uses only the explicit Google Cloud provider in an installed
  product, with the visible deterministic stub retained for development and CI.
- Phase 0: removed the in-app Ask/edit route and the model-backed edit,
  consistency, alt-text, narration-writing, research, and asset-organising jobs.
  The Assistant panel is now the four-section hub described below; connected
  agents submit authored operations through the proposal boundary. Deterministic
  tidy and motion remain.
- Phases 1–3 (first vertical slice): the home is now **New from template** plus
  **Build with your agent**. `packages/deck-presets` defines six reviewed
  templates (one per purpose group) and emits `generated/deck-presets.json`
  under `npm run presets:check`. The API and shared client expose deterministic
  preset and StoryPlan composition, and MCP exposes `preset_list`,
  `deck_from_template`, and `deck_compose`. `GenerateDeck.tsx`,
  `StoryCheckpoint.tsx`, and their route helper/tests are removed.
- Phase 0: removed the legacy deck model graph, single-shot story generator,
  stub planner, `/v1/generate*`, story checkpoint routes/savers, and the hidden
  assistant `generate` job. Deck creation now has only the deterministic preset
  and `StoryPlan` composition paths.
- Phase 0: removed Deckastra-managed repository grounding: GitHub/local
  connectors, indexing and retrieval, repository tools/routes/UI, repository
  quota and database tables. Document provenance remains available for evidence
  supplied by connected agents and imports.

Supersedes:
- [07](07_VERTEX_ASSISTANT_AND_FREE_PAID_TIERS.md) §1.3 and §5 for every
  **text** task (generate, edit, consistency, alt text, narration scripts,
  research, critique). The rows for translation, spoken narration and images
  stand. §8 now applies only to the paid media tasks.
- [08](08_ROADMAP_TO_LAUNCH.md) §2.2 (one Vertex client for text) and §2.7
  (evaluating text tasks), and the assistant panel's prompt box in track 1.

Related: [04](04_GOOGLE_CLOUD_PLATFORM.md) (hosting the paid media services),
[benchmark results](BENCHMARK_RESULTS.md) and the
[advanced-deck recheck](ADVANCED_DECK_RECHECK.md) (the evidence this plan acts on).

The rule this plan applies everywhere:

> **Build what coding agents cannot do. Hand them what they already do better.**

Coding agents (GitHub Copilot, Claude Code, Codex, Antigravity, Gemini CLI)
reason, write and read repositories better than anything Deckastra can afford
to run. They **cannot** render, animate, voice, generate video, export to
PowerPoint or guarantee a slide has no overlap. Deckastra's job is to be the
engine those agents drive, and to make that engine very good.

## 1. What is being decided

1. **Remove every in-app text-model task.** Remove deck generation through the
   agent graph, Ask, edit, consistency, alt text, narration script writing,
   research and the model translator. In each case a person's own agent does
   it better, and the product pays nothing for it.
2. **MCP becomes the main way to author with AI.** Free agents are enough to
   start. GitHub Copilot Free includes agent mode and MCP servers.
3. **Invest in the engine.** Make animation presets extensible, deepen
   narration and sound, and add MP4 export.
4. **Ship many deck presets.** These are templates an agent fills rather than
   layouts it invents. Each passes an automatic quality gate.
5. **Keep a small paid assistant for media and language only.** That means
   Cloud Translation, Chirp voice, image generation and, new, Veo video. Each
   is quoted before it runs and becomes a proposal.

## 2. Why

### 2.1 Our own evidence

From [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md):

- **No text task qualifies.** Planning had 0% factual grounding and critique 0%
  review quality. Authoring was 90% valid and over the latency target. Gemma
  cleanup succeeded 5% of the time.
- **What works is deterministic.** Fix all, the motion planner and export use
  no model.
- **Qualification spent the budget.** About $4.75 of the $5 ceiling went on
  evaluation runs, and every text task still failed.

The opposite also happened. Real Claude Code and Codex sessions over MCP
authored a full restyle that a person approved. They brought their own model,
paid for no second call and could not approve their own change.

### 2.2 Free agents are good enough to start

- **GitHub Copilot Free** includes agent mode and MCP servers. Since 1 June 2026
  chat and agent requests draw on a small monthly credit allowance, about 50
  chat requests, which sources describe as "a few serious sessions".
  ([GitHub Docs](https://docs.github.com/en/enterprise-cloud%40latest/copilot/get-started/plans-for-github-copilot),
  [Costbench](https://costbench.com/software/ai-coding-assistants/github-copilot/free-plan/),
  [AI credits guide](https://wellstsai.com/en/post/github-copilot-ai-credits-pricing-guide/))
- **Requests are scarce on a free tier, so tools must be coarse.** One call
  should build a whole deck from a template and content. An agent should not
  spend twenty requests placing boxes. Presets (§6) are what make that
  possible.

### 2.3 The market

Presentation MCP servers are now common: SlideSpeak, Presenton, Prezent,
2Slides, AhaSlides.
([SlideSpeak](https://slidespeak.co/guides/build-presentations-with-claude-code-and-slidespeak),
[Presenton](https://cdn.jsdelivr.net/npm/presenton-mcp@1.0.1/README.md),
[Prezent](https://docs.prezent.ai/docs/agents-and-mcp))

Most of them generate a PowerPoint file and stop. Deckastra's difference is
the engine behind its tools:
- a live, versioned deck;
- proposals the person approves, and undo;
- a timeline, morph and narration by click step;
- deterministic export.

That difference grows only if the engine does.

## 3. Remove

**Process for every row:** read the code before deleting it, and keep the
suites green. Then update `CLAUDE.md` in the same change, because several of
its sections describe this code. Benchmark reports and audits stay as evidence
of why.

| Item | Files (verify each) | Replaced by |
| --- | --- | --- |
| Deck generation through the model graph | `agents/deckastra_agents/graph.py`; nodes `orchestrate`, `research`, `story`, `creative`, `layout`, `critic`, `propose`; `runner.py`; `state.py`; `story.py`; `/v1/generate*` and `/v1/runs/{id}/checkpoint\|resume` in `main.py`; `GenerateDeck.tsx`; `StoryCheckpoint.tsx`; the checkpoint savers | **New from template** (§6) and `deck_compose` over MCP (§7) |
| Ask and the edit agent | `nodes/author.py`, `nodes/edit.py`, `edit_service.py`, `agent/edit` in `agent_routes.py`, the assistant panel's prompt box | The person's agent over MCP; the panel shows how to connect one |
| Model assistant tasks | In `assistant_tasks.py`: `edit`, `consistency`, `alt_text`, `narration` (script writing), `research`, asset organising | Tidy and motion stay; they are engines |
| Text-model routing and qualification | `vertex_router.py`, `qualification.py`, the per-task text model map, `select-assistant-routing.py`, the text benchmark scripts | Nothing. `vertex_model.py` stays for images and video only |
| Model translator | `DECKASTRA_TRANSLATION=model` in `translation.py` | Cloud Translation (unchanged) |
| Repository grounding | `integrations/`, `indexing.py`, `retrieval.py`, `embeddings.py`, `lexical.py`, `repository_routes.py`, `repository_service.py`, the Repositories option | A coding agent already has the repository open. **Removed in Phase 0.** |
| The stub planner | `stub.py` | Composer tests use fixed `StoryPlan`s. The stub existed to stand in for a model that is gone |

**Keep:**
- `compose.py` and `motion.py` (the deterministic composer and motion planner);
- Design Check and Fix all; the export worker;
- the proposal lifecycle, risk tiers and grants;
- `cost_ledger.py` and reservations, for paid media;
- `speech.py`, the Cloud Translation provider, `vertex_model.py` for media.

**Interface changes:**
- The home prompt bar becomes **New from template** plus **Build with your
  agent**, which shows setup steps.
- The assistant panel keeps four sections: Waiting for you (proposals),
  Languages, Voice, and Media.

## 4. Track A — Animation the engine can grow

The compiler already makes every value a pure function of time (doc 04 §26.2).
That is what lets presets be **data** without giving up determinism.

**Today:**
- 13 entrance presets: fade, slide, blurReveal, maskReveal, staggerReveal,
  drawPath, numberCount, springIn, sharedElementMorph, shimmer, byWord,
  byLetter, typewriter.
- 7 transitions: cut, fade, push, slide, zoom, cover, morph.

### A1. Custom presets in the theme

`theme.motionPresets[name]` holds keyframes over the existing longhands
(`translate`, `scale`, `rotate`, `opacity`, `filter`, `clipPath`), with
normalised offsets and named easings.

- **No expression language**, the same rule as data bindings. A `.mydeck` file
  must stay safe to email.
- **A `reducedMotion` fallback is required.** A new validation code refuses a
  preset without one, the same rule the built-ins pass at build time
  (doc 04 §27.3).
- **Budget.** Durations are clamped by the 2.5 s entrance budget at compile
  time, never trusted.
- **Exports.** PowerPoint maps a custom preset to the nearest native effect
  and reports it `approximated`. PDF takes the final frame, as today.
- **Portability.** Presets travel with the theme, so a template carries its
  motion personality.

### A2. New built-ins

| Group | Presets | PowerPoint |
| --- | --- | --- |
| Emphasis | pulse, highlight sweep, underline draw, colour shift, shake | Native emphasis effects |
| Exit | fade out, slide out, scale out, wipe out | Native exits |
| Path | move along a `path` element | Native motion path |
| Text | line by line, word cascade | By-paragraph and by-word builds |
| Transitions | wipe, split, iris, flip, blur dissolve | Nearest native, reported |

Each one needs:
- seek and play parity;
- a reduced-motion fallback;
- an export mapping row;
- a case in `deck-acceptance.test.ts`.

### A3. Deck motion styles

A motion style is a named map from semantic role to preset, plus pacing:
- **Calm:** fades, 450 ms, few reveals.
- **Energetic:** springs, staggers, push transitions.
- **Editorial:** mask reveals, morph between sections.
- **Playful:** bounce, word cascades.
- **Technical:** draw paths, number counts, wipes.

The motion planner applies a style by roles, so it survives re-layout. Agents
name a style, never milliseconds.

### A4. `motion_preview` over MCP

`motion_preview` returns a strip of frames (for example, 6 frames across the
slide's timeline). An agent can then check its own animation the way
`slide_preview` lets it check a static slide. It is rendered by the same worker
an export uses.

## 5. Track B — Narration and sound

The schema already has narration by click step, takes per locale, a sound
library and pronunciations.

1. **Word timings.** Chirp returns time points for SSML `<mark>`s. Store them
   on the take, then:
   - a cue step can advance **on a word**, not only when the line ends;
   - captions can highlight the word being spoken (present mode, MP4).
2. **Music under the voice.** Add a `soundtrack` on the deck or a section:
   - a library recipe or an uploaded file;
   - looped and faded;
   - lowered automatically while narration plays, with the lowering compiled
     into the narration schedule rather than done live.

   PowerPoint carries it as a background audio object with a reported
   approximation.
3. **Voice per cue.** Allow a second speaker for a dialogue or a quotation.
   The take records the voice, and changing it makes only that line due.
4. **More sounds.** Extend the deterministic synthesis recipes to about 40:
   UI ticks, whooshes, risers, chimes and ambient beds. They are byte-stable
   and need no notices.
5. **MP4 export: the narrated deck as a video.**
   - **How:** the fixed-step sampling already exists (doc 04 §26.1). The render
     host draws frame *n* at `n / fps`, and narration and music are mixed from
     the compiled schedule.
   - **Research first, before building:** WebCodecs `VideoEncoder` in
     Electron's own Chromium plus a JavaScript MP4 muxer, against bundling
     ffmpeg (licence and size). Measure on the 60-slide performance deck.
   - **Why it matters:** this is the product's most shareable output, and no
     agent can make it on its own.

## 6. Track C — Deck presets

### 6.1 What a preset is

Five layers, each reusable on its own:

| Layer | What it is | Where it lives |
| --- | --- | --- |
| Theme | Colours, type, effects | `theme-presets.ts` (12 today) |
| Slide pattern | A slide with **named slots** (title, kicker, metric[1..4], image, quote…) and a container layout | `ComponentDefinition` with `slots`: the schema has it and nothing ships one yet |
| Motion style | Role → preset map and pacing | §4 A3 |
| Voice style | Voice, rate, music bed | §5 |
| **Deck template** | Theme + an ordered list of slide patterns + motion style + transition style + voice style + purpose tags | New: `packages/deck-presets` |

Presets are **data**:
- Source lives in `packages/deck-presets/src`.
- Output is emitted to `generated/deck-presets.json` under the drift gate, so
  Python reads the same definition, as it does for theme presets.
- Slot geometry is computed by container layouts, never stored as coordinates
  an agent must respect.

### 6.2 Organised by purpose

People and agents search by what the deck is for, then by look:

- **Business:** pitch, investor update, quarterly report, board meeting,
  sales proposal.
- **Product:** launch, roadmap, release notes, case study.
- **Teaching:** lesson, workshop, training module, thesis defence.
- **Technical:** architecture review, incident review, research talk.
- **Team:** all-hands, onboarding, retrospective.
- **Personal:** portfolio, event, wedding or story.

### 6.3 How many

Quality first. Each step is shipped only when the gate in §6.4 is green.

| | Launch | Later |
| --- | --- | --- |
| Slide patterns | 60 | 150 |
| Themes | 20 | 40 |
| Motion styles | 7 | 12 |
| Deck templates | 24 (4 per purpose group) | 100+ |

Templates multiply with themes. 24 templates × 20 themes is 480 distinct
starting points from 60 tested slide patterns. That is the cheap way to "tons".

### 6.4 The gate

`npm run presets:check` runs on every preset in CI. It is the reason presets
can be authored in bulk, including by coding agents, without lowering quality.

1. **Schema.** Every template composes to a valid document.
2. **Design Check:** zero findings for overlap (W110), safe area (W104),
   small text (W216) and contrast (A102).
3. **Stress fill.** Each slot is filled with short, typical and long content
   (2×, plus a 40-word paragraph), then Hindi, Arabic (right to left) and a
   CJK sample. Text fits or shrinks within the theme's bounds, and nothing
   collides.
4. **Motion.** Seek and play parity; reduced motion leaves everything visible;
   the entrance budget holds.
5. **Exports.** PDF and PPTX open in `pypdf` and `python-pptx`, with
   degradations listed.
6. **Contact sheet.** Render every pattern × 3 themes to one HTML page for a
   person to review before the preset is marked `reviewed`. Unreviewed
   presets stay hidden.

### 6.5 Writing presets in bulk

1. Write a short brief per template: purpose, audience, slide sequence and
   mood.
2. A coding agent writes the preset files from the brief and runs the gate,
   repeating until it is green.
3. A person reads the contact sheet and marks the preset `reviewed`.

This is the repository's own rule, "agents propose, code checks, humans
decide", applied to the presets.

### 6.6 Where presets appear

- **Home:** New from template, a gallery filtered by purpose with a theme
  switcher on the previews.
- **Editor:** slide patterns in the Add library, and Apply motion style in
  the Motion panel.
- **MCP:** the tools in §7.

## 7. Track D — MCP as the main surface

The 24 existing tools stay. Additions:

| Tool | Does | Why |
| --- | --- | --- |
| `preset_list` | Templates, patterns, themes and motion styles by purpose, with thumbnails | One call to choose |
| `deck_from_template` | Template + theme + content per slot → a new deck in **one call** | Saves free-tier requests |
| `slide_insert_pattern` | Insert a pattern with its slots filled | Same |
| `deck_compose` | A `StoryPlan` (layouts by name, no geometry) → a composed deck | Keeps `compose.py`'s guarantee: no overlap, always valid |
| `motion_style_apply` | A style name → a motion proposal | Roles, never milliseconds |
| `motion_preview` | A strip of frames | §4 A4 |
| `media_generate` | An image or video from a brief, after quoting credits → an asset plus a proposal | Agents cannot render media |
| `voice_lines` | Voice the due narration lines in a language | Already a service; exposed |

**Teach the agent; don't make it guess.** Add MCP prompts and resources:
- an authoring guide: roles, tokens, slots and what is refused;
- the theme's token list;
- one worked example per purpose.

Today an agent learns the conventions by being refused. This is the cheapest
quality improvement available.

**Setup for every agent.** Settings › Agents shows copy-ready configuration for:
- VS Code with Copilot (`.vscode/mcp.json`);
- Claude Code;
- Codex;
- Antigravity;
- Gemini CLI.

The setup page also says Copilot Free is enough to start.

**Evidence.** Run the acceptance journey on each client and record it. The
journey is: from a template, revise, animate, preview, approve, undo, export.
The last open D2 item, one client driving the whole journey, closes here.

## 8. Track E — Paid media in the app

All of these run through the gateway in 07 §4, are quoted in credits before
running, and arrive as proposals.

| Capability | Provider | Notes |
| --- | --- | --- |
| Translation | Cloud Translation | Unchanged. Protected spans already enforced |
| Spoken narration | Chirp 3 HD | Unchanged; gains word timings (§5) |
| Image | Gemini image | Unchanged. $0.067 per image measured |
| **Video clip** | **Veo, Fast or Lite by default** | New |

**Veo specifics:**
- **Price.** About $0.15 per second on Fast and $0.40–0.75 per second on
  Quality, so an 8-second clip costs $1.20–6. Retries multiply that.
  ([Magic Hour](https://magichour.ai/blog/veo-3-pricing),
  [Coverr](https://coverr.co/blog/ai-video-generation-api-pricing-2026))
  Show the credit cost before every run, and default to Fast, 4–8 s, no audio.
- **Use.** Background loops, B-roll and short product shots. The `video`
  element already exists.
- **Export:**
  - PDF takes a poster frame and the report says so.
  - PowerPoint embeds the MP4.
  - MP4 export (§5) includes it.
- **Storage.** Cap the clip size, and count it against the storage quota like
  any asset.
- **Budget.** The ledger has $0.048 left. Media needs a separately approved
  budget before any live test.

## 9. Changes to 07 and 08

These two plans stay, with these changes:

- **07 §5:** keep only the translation, spoken narration, image and engine rows.
  Add video.
- **07 §6:** AI credits buy media and language. MCP stays free and unlimited.
  Templates and engines are free.
- **07 §8:** applies to media quality only. Text tasks are not evaluated
  because they are not built.
- **08 track 1:** home and assistant panel per §3 above.
- **08 track 2:** 2.2 and 2.7 are dropped; 2.1's removal list grows by §3.
- **08 §5 timeline:** the weeks freed from text evaluation go to tracks A
  and C.
- Both link to deleted plans (01, 02, 03, 05, 06); those links are now
  historical.

## 10. Phases

| Phase | Work | Exit |
| --- | --- | --- |
| **0. Remove** | §3, with `CLAUDE.md` updated in the same change | Python and TypeScript suites green; desktop smoke steps green; no screen offers a text model |
| **1. MCP guidance** | Prompts and resources; setup page for five agents; `deck_compose` | One recorded run per agent from an empty workspace to an exported deck |
| **2. Preset format and gate** | `packages/deck-presets`, the schema for slots, `presets:check`, contact sheet | Gate catches a deliberately broken preset of each kind (control) |
| **3. First presets** | 20 patterns, 6 templates, 3 motion styles; `preset_list`, `deck_from_template`, the gallery | A Copilot Free session builds a 10-slide deck in 5 requests or fewer |
| **4. Animation** | A1 custom presets, A2 built-ins, `motion_preview` | Parity, reduced-motion and export-mapping tests per preset |
| **5. Narration** | Word timings, music bed with lowering, voice per cue, more sounds | Acceptance step: a word-triggered reveal plays on the right word |
| **6. MP4 export** | Research spike, then the exporter | A 10-slide narrated deck exports, plays in a standard player, and audio drifts by ≤1 frame |
| **7. Presets at scale** | Up to the launch counts in §6.3 | All `reviewed`, gate green |
| **8. Video** | Veo through the gateway | Credit quote, proposal, and all three exports handle the clip |

Phases 1–3 make the product useful to agents fastest. Phase 0 can ship
alongside them.

### 10.1 Launch-gap closure

The phase rows describe implemented vertical slices, not a release declaration.
The repository audit on 2026-10-09 reopened the following work:

- Completed 2026-10-09: quoted generated images alongside the existing quoted
  video path, plus exact translation and speech quotes through the account
  credit gateway.
- Completed 2026-10-09: `slide_insert_pattern`, `motion_style_apply`, and
  `voice_lines`, plus editor slide-pattern insertion and named motion-style
  application. See `docs/evaluations/PLAN_09_GAP_CLOSURE_2026-10-09.md`.
- Completed 2026-10-09: the planned `playful` style applies word cascades to
  text and spring entrances to non-text elements. Stored template voice styles
  now choose the default live voice persona unless an explicit voice overrides
  them.
- Completed 2026-10-09: `presets:check` motion-checks all 24 templates and
  exports and reopens each as PDF and PowerPoint. A real human contact-sheet
  review remains open rather than being inferred from a source flag.
- Packaging: choose and audit an LGPL-compatible ffmpeg build, ship it as a
  signed resource, rebuild the desktop package, and run its smoke journey.
- External acceptance: record the full approve/undo client journey, verify the
  Copilot account tier claimed by the exit check, and make one live Veo call only
  after a media budget is approved.
- Completed 2026-10-09: the critic and story leftovers and the empty legacy
  package remnants are removed, and `CLAUDE.md` and plans 07 and 08 are
  reconciled. The tree was committed as seven reviewable commits, merged through
  #9 and deployed. CI covers the 24-template export readback in its Export job,
  where Python and Chromium exist.
- Raw evaluation reports (about 697k lines under
  `docs/evaluations/2026-10-05/`) are in `main`'s history by decision. Removing
  them now would mean rewriting published history.

## 11. Decision only you can make

The in-app creation, launch-count and encoder-route decisions are implemented:
template composition remains, the launch catalog is at the §6.3 counts, and
MP4 uses configured ffmpeg. The remaining product-owner decision is the
**media budget** for live Veo and image quality checks.

## 12. Risks

- **People without any agent.** Copilot Free covers the cost. Setup is the
  barrier, so the setup page must be excellent. Templates still work with no
  agent at all.
- **Free-tier request limits.** Coarse tools (§7) and templates keep a deck
  within a handful of requests.
- **Presets that all look alike.** The purpose taxonomy, 20 themes and motion
  styles give variety. The contact-sheet review catches sameness.
- **Agent quality varies by client.** The guidance resources and the server's
  refusals hold every client to the same rules. The acceptance run per client
  shows where one falls short.
- **Video cost.** Quoted per run, Fast by default, and bounded by monthly
  credits.

## Sources

- [GitHub Docs: Copilot plans](https://docs.github.com/en/enterprise-cloud%40latest/copilot/get-started/plans-for-github-copilot)
- [Costbench: GitHub Copilot Free plan 2026](https://costbench.com/software/ai-coding-assistants/github-copilot/free-plan/)
- [GitHub Copilot AI credits pricing guide](https://wellstsai.com/en/post/github-copilot-ai-credits-pricing-guide/)
- [SlideSpeak: Claude Code guide](https://slidespeak.co/guides/build-presentations-with-claude-code-and-slidespeak)
- [Presenton MCP](https://cdn.jsdelivr.net/npm/presenton-mcp@1.0.1/README.md)
- [Prezent: agents and MCP](https://docs.prezent.ai/docs/agents-and-mcp)
- [Magic Hour: Veo 3 pricing](https://magichour.ai/blog/veo-3-pricing)
- [Coverr: AI video API pricing 2026](https://coverr.co/blog/ai-video-generation-api-pricing-2026)
