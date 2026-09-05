# Deckastra

An AI-native presentation studio for web and desktop.

> **Agents propose. Deterministic engines compose. Humans remain in control.**

Deckastra is not a prompt-to-slides generator. A generated slide is a structured
document of real objects — text with semantic roles, diagrams with nodes and
edges, charts with data and intent — so an AI edit is a reviewable patch against
one property rather than a regeneration of the whole slide.

**Status: Phase 2.** A prompt becomes a real deck you can present in a browser,
and every change to it is versioned, attributable and reversible. There is no
editing UI yet — Phase 3 — but the machinery an editor needs is here and tested.

---

## What is here

```
packages/presentation-schema/   the canonical .mydeck document model
packages/presentation-core/     pure document operations — every one emits a patch
packages/transactions/          patch apply, inverses, undo/redo, transaction lifecycle
packages/renderer/              document -> IntermediateScene -> DOM/SVG
apps/api/                       FastAPI: generation, persistence, versioned history
apps/web/                       prompt box, deck preview, present mode
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
