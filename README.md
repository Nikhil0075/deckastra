# Deckastra

An AI-native presentation studio for web and desktop.

> **Agents propose. Deterministic engines compose. Humans remain in control.**

Deckastra is not a prompt-to-slides generator. A generated slide is a structured
document of real objects — text with semantic roles, diagrams with nodes and
edges, charts with data and intent — so an AI edit is a reviewable patch against
one property rather than a regeneration of the whole slide.

**Status: Phase 5.** A prompt becomes a real deck you can present in a browser,
every change to it is versioned, attributable and reversible, and there is a
direct-manipulation editor with in-place text editing. Every MVP element type
draws for real — charts, diagrams, tables, highlighted code and icons are laid
out deterministically from the document rather than standing in as placeholders
— and present mode has a presenter view with notes, a timer and a second-screen
window.

Generation now runs a real agent graph rather than a single-shot chain, and you
can select something on a slide, ask for a change in words, and see what it would
do before it happens.

---

## What is here

```
packages/presentation-schema/   the canonical .mydeck document model
packages/presentation-core/     pure document operations — every one emits a patch
packages/transactions/          patch apply, inverses, undo/redo, transaction lifecycle
packages/renderer/              document -> IntermediateScene -> DOM/SVG
                                charts, diagrams, icons, fonts, highlighting,
                                the semantic validation pass, render digests
packages/layout-engine/         text measurement, container layout, constraints
packages/editor/                selection, hit testing, transforms, snapping,
                                clipboard, keys, rich-text editing and paste sanitization
agents/                         the LangGraph agent system: nodes, contracts,
                                tool registry, budgets, memory, model routing
apps/api/                       FastAPI: generation, persistence, versioned history
apps/web/                       prompt box, deck preview, editor, present mode
docs/                           the six specification documents
infrastructure/database/        Alembic migrations
infrastructure/docker/          Postgres + pgvector, Redis, MinIO
scripts/                        cross-language contract checks
```

Everything else in the tree is a directory reserved by
`docs/05_MVP_SYSTEM_REPOSITORY_ARCHITECTURE.md` §4 and is currently empty.

---

## Getting started

```bash
npm install
pip install -r requirements-dev.txt -r apps/api/requirements.txt
npm test
```

Run it:

```bash
npm run dev:api    # http://localhost:8000
npm run dev:web    # http://localhost:3000
```

**Without an `ANTHROPIC_API_KEY` the whole path still works** — a deterministic
stub planner writes the narrative instead of a model, so the composer, the
renderer and present mode can all be exercised without credentials and without
spending anything. Every stub deck says so in the UI. Set the key and restart the
API for real generation.

The API needs a database. For local development, point it at SQLite:

```bash
DATABASE_URL=sqlite:///deckastra.db npm run db:migrate
DATABASE_URL=sqlite:///deckastra.db npm run dev:api
```

Or bring up Postgres and run against that:

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d
npm run db:migrate    # defaults to the compose Postgres
```

---

## How generation works

```
prompt
  ↓  a model, constrained to a StoryPlan by JSON schema
narrative + copy + a layout name per slide     ← intent only, no coordinates
  ↓  deterministic composer (apps/api/deckastra_api/compose.py)
a .mydeck document                             ← every coordinate decided by code
  ↓  validated against the generated JSON Schema
renderer -> IntermediateScene -> DOM/SVG
```

The model never emits a coordinate, a font size or a colour. That boundary is the
product thesis in one place: a model that proposes `x: 137` produces slides which
overlap the moment the real text is longer than the sample, and a model that
proposes `layout: "metrics"` produces slides a composer can always place
correctly. It also moves the interesting failure from the document — large, and
expensive to re-ask for — to the plan, which is small and cheap.

---

## What "deterministic" costs, concretely

The promise that the same document renders identically in the editor, a PNG and a
PDF is only worth anything if it survives contact with the ordinary things that
break it. Three of them cost real code here:

- **Number formatting is hand-written.** `Intl.NumberFormat` reads the ICU data
  compiled into the runtime, so an axis label reads "24.1K" in the editor and
  "24,1 K" in the exported PDF. Localised formatting is a real requirement and
  belongs behind an explicit, versioned locale table, not behind whatever ICU the
  process happens to carry.
- **Layout algorithms run a fixed number of iterations.** The force-directed
  diagram layout takes exactly 200 steps and stops. Running to convergence would
  make the result depend on a tolerance and on floating-point ordering; a diagram
  that settles differently each time moves under the user on reload.
- **Font availability is recorded, not assumed.** Which families resolved and
  which fell back is part of the scene and part of the render digest, so a visual
  difference caused by a missing face is attributable rather than mysterious.

Icons are inlined as path data and syntax highlighting is a hand-written scanner
for the same reason: both must work offline, in the headless export service, with
no asynchronous grammar or asset load that could resolve differently twice.

---

## How editing works

One path changes a document, and everything uses it:

```
editor gesture ─┐
agent proposal ─┼─> PatchOperation[] ─> transactions.applyPatch ─> document + inverse
data refresh   ─┘                                    │
                                                     └─> versioned, attributed, reversible
```

`packages/presentation-core` never returns a modified document — every operation
emits a patch. That is what makes "human and AI editing are equal citizens"
(doc 01 §4.7) true rather than aspirational: adding a text box from a toolbar and
adding one from an agent are literally the same operations, so undo, validation,
provenance and autosave are wired up once.

Storage is snapshot-plus-operations (doc 05 §22): most versions carry only their
patch, a full snapshot is written periodically and around agent runs, and a read
replays forward through the same applier that produced them.

`packages/editor` sits in front of that and owns no document state at all. It
computes transforms; the canvas turns them into patches, coalescing one gesture
into one undo entry. Selection, hover, isolation and zoom stay out of the
document — a test asserts none of them ever appear in a saved file.

---

## The one rule worth knowing before reading any code

The `.mydeck` document is the source of truth. React components, DOM nodes,
animation timelines, exported PPTX shapes, rendered previews and AI prompts are
all temporary representations derived from — or applied to — that model.

Two corollaries, both load-bearing:

1. **If a fact about the presentation is not in the document, it does not exist.**
   A feature that needs the renderer to remember something between sessions is a
   schema gap, not a renderer feature.
2. **If a fact is in the document but no one can agree on it, it does not belong
   there.** Camera position, selection and hover state all fail that test, which
   is why they live in editor state and never touch the saved file.

---

## How the schema stays singular

The model is defined once, in TypeScript, and everything else is generated from
it:

```
Zod schemas (normative, hand-written)
      |
JSON Schema (generated, committed)
      |
Python validation, MCP tool schemas, external tooling
```

The Python service validates documents against the *generated artifact*, not
against a translated copy of the model. There is no second definition, so there is
nothing to drift. CI fails if the committed artifact is stale.

---

## How the agents work

```
Orchestrator → Research → Story → [you approve] → Creative → Layout → Critic
                            ↑                                            |
                            +-------------- revise ----------------------+
                                                                         |
                                            proposal → you decide → transaction
```

The rule underneath all of it: **agents manipulate intent and structured
operations, not pixels.** An agent says "this slide should be a metrics layout"
or "this element's text should read X"; deterministic code turns that into
geometry and into a patch. So a generated slide cannot overlap, and an AI edit is
the same kind of object as a human one — one transaction, with an inverse, in the
same history.

Four boundaries make that hold rather than merely intend it:

- **No agent writes to the store.** They produce operations and hand them over.
- **No agent can call a tool it did not declare** — the registry hands each agent
  a narrowed view rather than checking a list.
- **Everything an agent did not write is enveloped as data.** A README that says
  "ignore your instructions" is content to be described, not a command; the
  envelope escapes its own delimiter so the content cannot break out of it.
- **Risk is computed from the operations, server-side.** A small change applies;
  anything larger waits for a person, expires in 24 hours if nobody answers, and
  is re-validated against the current deck when they do.

Without an API key the whole path still runs on a deterministic stub — the graph,
the routing, the checkpoint, the proposal lifecycle — and every deck and edit it
produces says plainly that no model was involved.

---

## What is actually verified

Claims in a README are cheap; these are the ones with a gate behind them.

| Claim | Gate |
| --- | --- |
| A patch and its inverse round-trip | Property test over 400 generated patches |
| Both patch appliers agree | Byte-identical conformance suite, TypeScript vs Python |
| The scene is a pure function of the document | Committed scene digests for three seed decks |
| The same slide renders identically twice, and after a reload | Real Chromium, PNGs compared byte for byte |
| A drag stays smooth on a 120-object slide | Measured in a real browser: no dropped frames against the display's own cadence |
| Editor state never reaches the document | Assertion on a saved document |
| A deck is buildable with no AI | The animation seed deck rebuilt through editor operations alone |
| Migrations match the models, on the engine that deploys | Alembic run against PostgreSQL in CI |
| Pasted HTML cannot carry a script or a `javascript:` link | Parsed with a real HTML parser and asserted |
| Retrieved content cannot escape its envelope and become instruction | Closing tags inside content are neutralised; asserted |
| An agent cannot call a tool it did not declare, or one it lacks permission for | Asserted against the registry |
| An agent edit stays inside the user's selection | An out-of-scope edit is dropped and reported |
| A generation can pause for approval and resume in another process | Run against a real LangGraph PostgreSQL checkpointer |
| An AI change is one transaction, undoable on its own | Journey C, end to end in a browser |

---

## Documentation

| Document | What it settles |
| --- | --- |
| `docs/00_DOCUMENT_REVIEW_AND_GAP_REGISTER.md` | Known gaps and their fix order |
| `docs/01_PRODUCT_REQUIREMENTS_AND_USER_JOURNEYS.md` | Scope, journeys, MVP definition |
| `docs/02_MYDECK_PRESENTATION_SCHEMA.md` | **The document model. Start here.** |
| `docs/03_AGENT_ARCHITECTURE_LANGGRAPH.md` | Agent boundaries and the graph |
| `docs/04_CANVAS_RENDERING_ANIMATION_ENGINE.md` | Renderer, animation, export |
| `docs/05_MVP_SYSTEM_REPOSITORY_ARCHITECTURE.md` | Services, data model, deployment |

---

## Decisions locked early

These are settled and should not be renegotiated casually, because everything
downstream assumes them (doc 05 §39):

- The canonical schema is doc 02 v1.1. Docs 01, 03, 04 and 05 reference it rather
  than restating it.
- Ids are ULIDs with a type prefix — stable forever, never reused, never parsed
  for meaning beyond the prefix.
- Patch paths are id-addressed (`/slides/id:sld_x/elements/id:el_y/...`). Index
  paths break the moment an earlier sibling is inserted, which is exactly what
  agents do.
- One change lineage: `PatchOperation` → `Patch` → `Transaction`.
- Array position is the ordering authority for both slides and z-order; `zIndex`
  is an override only.
- Logical coordinates, 1920×1080 by default. DOM + SVG rendering.
- No expression language anywhere in the document. Bindings and component
  parameters use declarative allowlists — a `.mydeck` file must be safe to email.

---

## Tooling notes

npm workspaces rather than pnpm + Turborepo as doc 05 §2 suggests: pnpm is not
installed in the development environment, and npm workspaces cover a single-track
solo build with no setup step. Revisit when the package count or build times make
a task runner worth its configuration.
