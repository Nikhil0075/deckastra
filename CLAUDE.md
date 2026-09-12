# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Deckastra — an AI-native presentation studio. The product thesis, applied consistently across every design document: **agents propose, deterministic engines compose, humans stay in control.**

**Phase 9 of a 10-phase plan.** Built so far: `packages/presentation-schema`, `packages/presentation-core`, `packages/transactions`, `packages/renderer`, `packages/layout-engine`, `packages/editor`, `packages/editor-ui`, `packages/animation-engine`, `packages/export-core`, `packages/export-pdf`, `packages/export-pptx`, `packages/workspace-contracts`, `packages/workspace-client`, `agents/`, `integrations/`, `apps/api`, `apps/desktop`, `apps/mcp-server`, `apps/web`, `apps/worker`. The remaining `packages/*` directories are empty placeholders reserved by `docs/05_MVP_SYSTEM_REPOSITORY_ARCHITECTURE.md` §4 — do not treat an empty directory as a missing implementation to fill in unless the current phase calls for it.

The build order is a **walking skeleton first**, not doc 05's layering: Phase 1 is prompt → story → 5 rendered slides → present, deliberately shallow, to find out early how reliably an LLM emits valid documents against this schema. Every later phase deepens one layer.

## Commands

```bash
npm install
pip install -r requirements-dev.txt -r apps/api/requirements.txt

npm test                # all workspaces
python -m pytest apps/api agents -q   # the API and the agent system
npm run typecheck
npm run schema:emit     # regenerate generated/
npm run schema:drift    # CI gate: fail if generated/ is stale
npm run fixtures:build

npm run dev:api         # FastAPI on :8000 (needs DATABASE_URL)
npm run dev:web         # Next on :3000
npm run dev:desktop     # build all three Electron bundles, then launch
npm run db:migrate      # alembic upgrade head
npm run db:revision -- "message"
python -m pytest apps/api/tests -q
python -m pytest agents -q          # the agent graph, against the stub client
python -m pytest integrations -q    # ignore rules, ranking, chunking, GitHub
python -m pytest apps/api -q -m "not slow"   # skip the browser and subprocess tests
```

Single package, from `packages/animation-engine/`:

```bash
npx vitest run tests/playback.test.ts   # seek/play parity
```

The API needs a database. `DATABASE_URL=sqlite:///deckastra.db` works for local
development; the default is the compose Postgres.

Single test file or single test, from `packages/presentation-schema/` or `packages/renderer/`:

```bash
npx vitest run tests/validation.test.ts
npx vitest run -t "rejects a duplicate id"
npx vitest                                            # watch mode
```

Renderer-specific, from `packages/renderer/`:

```bash
UPDATE_BASELINES=1 npx vitest run tests/baseline.test.ts   # after a deliberate visual change
PREVIEW_OUT=/tmp/p.html npx vitest run tests/preview.test.tsx   # contact sheet of every fixture slide
PIXELS=1 npm run test:pixels                               # real Chromium, byte-compared PNGs
PIXELS=1 UPDATE_PIXELS=1 npm run test:pixels               # re-record this platform's pixel baseline
```

The slower gates are opt-in so `npm test` stays fast, and each needs something
the fast suite does not:

```bash
npx playwright install chromium          # once, for the pixel and e2e suites

# The drag budget, measured in a real browser. Needs both dev servers up.
E2E=1 npm run test:e2e --workspace @deckastra/web

# The database the product deploys on. Needs the compose Postgres.
docker compose -f infrastructure/docker/docker-compose.yml up -d postgres
POSTGRES_TEST_URL=postgresql+psycopg://deckastra:deckastra_local@localhost:5432/deckastra \
  python -m pytest apps/api -q
```

Cross-language contract check (needs `pip install -r requirements-dev.txt`):

```bash
python scripts/validate_fixtures.py
```

Backing services (not needed for schema work):

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

`npm run lint` exists at the root but no package implements it yet — it is currently a no-op.

## Architecture

### Generation: the model proposes intent, code composes geometry

```
prompt → Orchestrator → Research → Story → [human checkpoint] → Creative → Layout → Critic
                                                                                      ↓
                                              composer → .mydeck → renderer ← proposal
```

The graph is Phase 5 (`agents/`). `GenerateRequest.use_graph` still selects the
Phase 1 single-shot chain — the flag exists so an operator can go back without a
rollback, not as a permanent fork.

`apps/api/deckastra_api/models.py` defines `StoryPlan`: narrative, copy, and a
**layout name from a closed set**. It carries no coordinates, font sizes or
colours. `compose.py` turns that into a document — every geometric decision is
made there, by code, the same way every time.

Do not move geometry across that line. Doc 03 §10 forbids the Creative Director
from emitting pixel coordinates and doc 03 §2.3 puts geometry on the deterministic
side. Two consequences that are the point of the design: generated slides cannot
overlap, and the composer's output is always schema-valid, so the interesting
failure mode is the plan — small and cheap to re-ask — rather than the document.

**The stub planner (`stub.py`) is not a test mock.** It is what makes the whole
vertical slice runnable without an API key, so the composer, renderer and present
mode work on a fresh clone and in CI without spending money. Keep it working, and
keep its decks visibly labelled as stub-composed.

**Container layout runs in the scene build** (pipeline stage 6). A group with a
`containerLayout` positions its children through `layoutChildren`, and their own
`x`/`y` become advisory — kept in the document so pulling a child out restores a
sensible position, ignored while the container lays out (doc 02 §16.2).

The consequence for anything that emits a container: padding must be declared on
the layout, not baked into child coordinates. A card whose padding lived only in
those coordinates goes flush the moment the container takes over.

### The agent system

`agents/` is a top-level package, not a subpackage of the API. Doc 05 §17 says
agent implementations should not know database details, and separate trees is
what makes that checkable — an agent importing `deckastra_api` is an obvious
mistake in the diff. The cost is a path bootstrap, which lives in
`deckastra_api/__init__.py` so no entry point has to set `PYTHONPATH` correctly.

Five rules hold the design together. Each is structural, because a rule that
depends on every future agent remembering it lasts until the next agent:

- **Agents never write.** They produce operations; `proposals.py` decides whether
  those apply now or wait for a human. There is no route that would let an agent
  bypass it.
- **Agents cannot call an undeclared tool.** `ToolRegistry.for_agent` returns a
  *narrowed* registry rather than checking a list, so it is a property of the
  object graph.
- **Retrieved content is enveloped at the tool boundary**, not per agent.
- **Risk is computed server-side from the operations** (doc 02 §31.7). A
  caller-declared tier is a caller-controlled security boundary.
- **Nothing an agent emits carries geometry.** The Creative Director names a
  theme token; a literal colour is rejected and replaced, with a warning.

Nodes are plain `(state, ctx)` functions and nothing in `agents/` imports
LangGraph except `graph.py`. That is doc 03 §24's argument about model providers,
applied to the graph library: a node is testable by calling it, and the framework
stays replaceable.

**The state is a TypedDict, and LangGraph merges only the keys it declares.** An
undeclared key is silently dropped between nodes and the routing then falls
through to its default as though the node had said nothing. If a node starts
returning something new, declare it in `state.py` in the same change.

### Budgets degrade; ceilings stop

`budgets.py` holds the numbers doc 03 left unstated (gap S1). The distinction
that shapes it: a **token or wall-clock ceiling raises**, because past it the run
is spending money or a user's patience on something they did not agree to. A
**revision budget returns False**, because past it the run still has something
worth handing over — so the Critic accepts the best draft and attaches the
unresolved issues (gap S3). A user can act on an attached issue; they can do
nothing with a run that never finished.

"The best draft was kept" has to be true of something. Every reviewed draft is
retained in `reviewed_drafts` with its score, and on a forced acceptance
`propose` composes the highest-scoring one — a later revision can score *worse*
than the one it replaced, and the sentence is shown exactly when reviewer and
writer did not converge. The unresolved issues go into the document under
`extensions["deckastra.unresolvedIssues"]`, keyed by slide: graph state ends with
the run, and the editor reads a document.

Candidates are deep snapshots of story, creative direction, motion, layout,
research and the matching review. Proposal returns the selected inputs into
graph state so provenance describes the selected content. The API applies all
final proposal operations to the composed document and validates it before
persistence. Planning slide indexes in unresolved issues resolve to generated
slide IDs; `CriticIssues` displays deck-wide and selected-slide findings. The
runner's traversal limit scales with the supported revision budget, including
the multi-node story revision path.

### The proposal lifecycle

An agent change becomes a *pending* transaction unless the risk tier says it can
apply now. Low risk applies immediately on purpose: making someone approve a typo
fix trains them to approve without reading, which is worse than not asking.

A proposal expires after 24 hours and is **re-validated on approval** against the
document as it stands. Between proposing and approving the deck may have moved,
and applying blind would apply a patch to something the approver never saw.

### The autosave queue is emptied by an acknowledgement, never by an attempt

`packages/editor-ui/src/lib/useEditor.ts`. It used to clear `pending.current` before the
request, so a 409, a 500 or a dropped connection discarded the operations
permanently — and because the in-memory document still looked right, nothing
appeared wrong until a reload.

- A failed batch goes back on the **front** of the queue. Operations added while
  it was in flight are newer and must apply after it; a reordered patch is a
  different document.
- A 409 is retained and **never re-sent with a refreshed version**. That is
  last-write-wins, which is the one failure mode this persistence design exists
  to refuse.
- One drain at a time. Two concurrent flushes carry the same
  `expected_version_id`, and the user is told their deck changed elsewhere when
  nobody touched it.
- `saveNow()` returns whether the queue emptied, and anything about to let the
  server replace the document — approving an AI change, reverting one — must
  await it and stop on `false`. A queued operation is addressed against the
  version it was authored on; once that version is superseded it can never be
  sent, and `adoptDocument` says so rather than dropping it silently.
- Unload uses `keepalive`, because a browser cancels ordinary in-flight fetches
  from a page it is tearing down.

### One path mutates a document

`packages/transactions` is the only code that changes a `.mydeck` document. The
editor, the agents, an import and a data refresh all produce a patch and hand it
there.

`packages/presentation-core` therefore **never returns a modified document** —
every operation emits `PatchOperation[]`. Do not add an operation that mutates
and returns: a second mutation path means undo, validation, provenance and
autosave each need wiring in two places, and one will be missed.

Three properties that are easy to break:

- **Inverses are computed during application, against the pre-state.** They cannot
  be derived afterwards — a `remove` has already destroyed what it removed.
- **Inverses come back in reverse application order.** Undoing `[a, b]` means
  undoing `b` first. Getting this backwards works for single-operation patches and
  corrupts multi-operation ones.
- **Some inverses can only be index-addressed** — restoring a removed element has
  to name a position. Those are safe only against the state they were computed
  from, so a *deferred* undo must first check nothing later disturbed the target.
  `disturbs()` implements that rule (in both languages); the server calls it
  before a revert, and `History.undoLastAgentChange` before an AI undo.

### Persistence is snapshot + operations

Most versions store only their patch; a full snapshot is written every
`SNAPSHOT_EVERY` operations and around every agent run. A read loads the nearest
snapshot and replays forward through the same applier that produced the patches.

`expected_version_id` gives optimistic concurrency. A mismatch is a 409, never a
last-write-wins overwrite — silently discarding someone's change is the worst
failure mode a document product has.

### There are two patch appliers, and that is deliberate

TypeScript (`packages/transactions`) for the editor and agents; Python
(`apps/api/deckastra_api/patch.py`) because the store replays server-side on a
read. This is the one place the project tolerates a second implementation.

It is made safe by `apps/api/tests/test_patch_conformance.py`, which runs the same
patches through both and asserts byte-identical documents *and* inverses, plus
identical rejections. **Changing behaviour in one applier without the other is how
drift starts** — treat that test as part of both modules.

### The schema is the product

`docs/02_MYDECK_PRESENTATION_SCHEMA.md` is the source of truth. Docs 01, 03, 04 and 05 reference it rather than restating it. Source comments cite sections as `doc 02 §31.3` — follow those when changing behaviour, because most non-obvious decisions have a stated reason there.

Two corollaries that decide arguments:

1. **If a fact about the presentation is not in the document, it does not exist.** A feature needing the renderer to remember something between sessions is a schema gap, not a renderer feature.
2. **If a fact is in the document but no one can agree on it, it does not belong there.** Camera, selection, hover and zoom fail that test and live in editor state. A test asserts none of them appear in a saved document.

### One definition, generated downward

```
Zod schemas (src/, normative, hand-written)
      ↓  npm run schema:emit
JSON Schema (generated/, committed)
      ↓
Python validation, MCP tool schemas, external tooling
```

There is deliberately **no hand-written Python model** of the schema, and there must never be one. `apps/api/deckastra_api/schema.py` validates composed documents against the generated artifact directly, so there is no second definition to drift. If Pydantic document models are ever needed, generate them from that artifact rather than writing them.

`generated/` and `fixtures/` are both generated and committed. Never hand-edit either; CI fails on drift in both.

### Validation is not serialization

`PresentationDocumentSchema.parse()` returns a **reconstructed** object — keys come back in schema-declaration order with unknown keys appended. Persisting that would reorder keys on every open-and-save and turn every version diff into noise.

**Parse to check. Write with `serializeDocument()`** (`src/serialize.ts`), which emits a canonical byte form: identity keys first, then alphabetical, recursively; arrays never reordered because array position carries meaning. Deeply equal documents produce identical bytes — that is what makes content hashing, version diffing and byte-identical render tests mean anything.

### Open vs closed enums

Descriptive enums (transition type, semantic role, chart/diagram/shape kind, text block type) are **open** — they accept unknown strings, because doc 02 §0.8 requires unknown values to survive a round-trip. A v1 reader opening a v2 deck must not delete a transition it has never heard of. Use `openEnum()` from `src/primitives.ts`; the known set stays attached as `.known` for validator warnings and editor UI.

Structural enums stay **closed**: patch op codes, paint variants, constraint kinds. An unknown value there cannot be interpreted at all, and accepting it pushes the failure somewhere far less diagnosable.

Unknown element types and enum values are preserved and reported as `W240`/`W241` — warnings, never errors. Refusing them would delete the user's content.

The unknown-element fallback excludes every own key of `ELEMENT_SCHEMA_BY_TYPE`.
A malformed known type must fail its specific schema, including inside groups and
component slots. The fallback's string refinement and JSON Schema `not`/`enum`
metadata use the same registry-derived list: refinements alone are not emitted.
The refinement aborts its union branch so validation can expand the known member's
field errors instead of reporting only a fallback refinement error on `type`.
Keep both together so Python rejects the same malformed elements without a second
handwritten type list. `scripts/validate_fixtures.py` checks both this rejection
and preservation of genuine future types against the generated artifact.



### Ordering has exactly one authority

Array position, for both slides and z-order. `Slide.order` was removed in v1.1 precisely because two sources of truth meant a reorder had to update N fields. `zIndex` is an override only — "bring to front" is an array `move`, not a `zIndex` increment.

### Change lineage

`PatchOperation` → `Patch` → `Transaction`, defined once in `src/patch.ts`. Doc 03 §16, doc 05 §11 and doc 04 §29 previously had four names for this; they now reference these types. Do not introduce a local transaction type anywhere.

- Paths are **id-addressed** (`/slides/id:sld_x/elements/id:el_y/transform/x`). Index paths break the moment an earlier sibling is inserted, which is exactly what agents do. Numeric indices remain valid only for arrays whose members have no id (keyframes, spans, blocks, chart rows).
- Inverses are computed **at apply time against the pre-state** — the only moment the old value is known.
- Risk tier is computed **server-side from the operations** (`computeRiskTier`), never declared by the caller. A caller-declared tier is a caller-controlled security boundary.

### The renderer is a pure function of the document

`packages/renderer` owns no state. `buildScene` (stage 9) resolves tokens,
composes transforms and produces an `IntermediateScene` of concrete values; the
React layer emits markup from numbers and does no layout, measurement or token
lookup. That split is what makes the same slide render identically in the editor,
a PNG and a PDF, and what will let the renderer run headlessly in Phase 8.

Three things there that look incidental and are not:

- **`mode="export"` excludes editor chrome structurally** — the subtree is never
  mounted, not hidden with CSS. A CSS-only guard someone later overrides puts
  selection handles in a customer's PDF.
- **Unimplemented element types render a labelled placeholder**, never nothing.
  Same path an `UnknownElement` from a newer schema takes.
- **Groups paint their own fill, stroke and radius** via `positionStyle`, because
  a group draws no content of its own — its children are separate scene nodes.

### Text measurement uses the browser when one is available

`buildDocumentScene` takes a `TextMeasurer`. The app passes `browserMeasurer()`,
which puts the real string in a real off-screen element and reads the line boxes
back. A plain Node scene build uses the estimator. Headless exports use the
worker batch service below to obtain browser measurements before the final build.
Only text that actually uses the estimator carries `estimated: true`.

Both paths quantize font size the same way, so a document that shrank to 93px in
Node does not shrink to 93.0001 in the browser and produce a spurious diff.

The estimator wraps by **word**, with a per-character width table calibrated so
its weighted mean is 1.0 for ordinary prose. Both parts are load-bearing:
dividing a character count by an average advance assumes a line can break
anywhere and under-counts lines for real text, and a table whose mean drifts to
0.88 makes every estimate 12% narrow. Either error turns a three-line headline
into a predicted two-line one, and the headline then overflows onto the subtitle.
If you touch the table, re-check it against a canvas measurement.

### Charts and diagrams are geometry in the scene, not in React

`buildChartPayload` and `buildDiagramPayload` emit fully-resolved numbers — plot
rect, tick positions, bar rects, arc paths, node placements, edge paths. The
React layer draws them and computes nothing. That is what lets the PDF and PPTX
adapters consume the same structure in Phase 8 rather than each re-deriving a
chart and drifting from what the user approved on screen.

Everything they do is deterministic and bounded: fixed iteration counts, document
order as the tie-break, and a seeded generator for the force layout. A force
layout without a `seed` degrades to layered *and says so* (doc 02 §18.5) rather
than producing a diagram that moves on the next open.

Degradations are surfaced, never silent: an unknown chart type draws as a column
chart with a warning, a top-N limit folds the tail into "Other" and says how
many, a dangling edge is dropped and named, an uncurated icon draws its own name.

### Determinism has three named enemies here

- **`Intl`.** Number formatting is hand-written (`format.ts`) because Intl output
  depends on the ICU compiled into the runtime. Same document, three renderers,
  three answers. `NumberFormat.locale` is recorded and deliberately not honoured.
- **Float noise.** All chart and diagram geometry goes through `round()` (3
  decimals) before it reaches the payload. Two runs differing by 1e-15 produce
  different markup and a failed baseline.
- **Font availability.** Recorded on the scene as `fonts` / `fontDigest` and
  included in the render digest. Without that, a snapshot failure caused by a
  missing face is indistinguishable from a code regression.

### In-place text editing

The model half is in `packages/editor/src/text-editing.ts` and the surface is
`packages/editor-ui/src/components/TextEditor.tsx`. Three rules there are not negotiable:

- **The DOM is never the document.** The user types into a browser-owned tree; on
  commit that tree is read back into blocks and spans and handed over as a patch.
  There is no path where the editable writes the document.
- **An IME composition defers the commit.** Reading mid-composition writes half a
  character. That is not an edge case in Japanese, Chinese or Korean — it is
  every word.
- **Paste is an allowlist, not a denylist.** Pasted HTML is markup someone else
  wrote arriving in a document other people will open. Only blocks, the marks the
  schema has, and links with a permitted scheme survive; a denylist is always one
  trick behind.

### The visual-regression gate

`packages/renderer/baselines/*.digest.txt` are committed scene digests for the
three seed decks, compared by `tests/baseline.test.ts` on every run. The digest
is readable on purpose — a hash says something changed, these lines say which
node moved and how.

It digests the **scene**, not pixels. `tests/pixels.test.ts` covers the rest:
real Chromium, PNGs compared byte for byte — twice in a row, and across a page
reload, which discards the caches a same-page second shot would leave warm. It
carries a negative control in the bottom-right corner so a cropped capture
cannot silently pass. All ten slides are captured at 1920×1080 CSS pixels and
DPR 2 (3840×2160 PNG), with animations sampled at their explicit final frame.
Diagram edge-label text and positions are included in scene digests.

Pixel baselines are **per platform**, because font rasterisation is. A developer
on a platform with no recorded baseline gets a report and still runs the
determinism properties; failing for a reason nobody on that OS can act on is how
a gate gets switched off.

`REQUIRE_PIXEL_BASELINE=1` turns that report into a failure, and **CI sets it**.
Without it the gate protected nothing anywhere: CI runs on Linux, only a Windows
baseline was committed, and a missing baseline passed silently — a green job
comparing against nothing. The run writes the hashes it computed to
`<platform>.json.computed`, plus full PNGs and browser runtime information under
`baselines/pixels/artifacts/`. CI uploads these on failure. The pixel job pins
the Playwright Linux image by digest to stabilize Chromium and installed fonts.

Regenerate either baseline only after reading the diff: one updated reflexively
is a gate that has been turned off while still looking on.

### The semantic pass is where brand rules become real

`validateDocument` (schema) checks what a document says. `validateScene`
(renderer) checks what it renders as — contrast pairs, overflow at the applied
font size, font-size counts, allowed families, text density, required roles.
Rules marked `REQUIRES_RENDER_CONTEXT` in the catalog run there and only there.

Rule codes live in the schema's `RULES` catalog even when the implementation is
in the renderer, because the editor, the Critic and export reports all reference
them; a code defined next to its implementation cannot be referenced by anything
else. A brand rule with no `check` is prompt context and is deliberately not
evaluated.

### The editor works in world space; the document does not

`packages/editor` is pure interaction logic — selection, hit testing, transforms,
snapping, clipboard, keyboard — with no React and no document mutation. It hands
back transforms; `packages/editor-ui/src/components/EditorCanvas.tsx` turns them into
patches.

The one thing to get right when touching any of it: **an element's `transform`
is local to its parent group, while every editor surface — hit testing, the
marquee, the spatial index, the snap lines, the selection overlay — is world
space.** `buildSelectableNodes` accumulates the parent origin into `bounds` and
keeps it on the node as `offset`; the canvas adds `offset` on the way out and the
commit path subtracts it on the way back in. Treating the two spaces as the same
is invisible for top-level elements and puts every grouped element's selection
box at the slide origin.

Two more that are easy to undo:

- **Rounding happens once, in `commitTransform()` on pointer-up.** Rounding each
  pointermove accumulates error across a drag.
- **Frame time is sampled per gesture** and shown in the shell. It measures the
  interval *between* frames, not the duration of the handler: a handler that
  takes 3ms but forces a synchronous layout costs 40ms of frame time, and only
  the interval sees it.
- **Pointermove is coalesced into one rAF callback**, and scene nodes are
  memoized on identity. Together those are what keep a drag on a 120-object slide
  from dropping frames; both are prescribed by doc 04 §31.2 and neither is
  optional.
- **The renderer's element boxes are `pointer-events: none` except in
  `mode="editor"`.** The editor resolves selection from `data-element-id` on
  exactly those boxes, so making them inert everywhere leaves nothing on the
  canvas selectable; making them live everywhere lets a click land on an element
  in present and export.

### The desktop runs the API, it does not reimplement it

`apps/desktop` is a window, a supervised child process, and a presenter window.

D0 answered one question — is `WorkspaceClient` the right seam? — by driving the
editor from a JSON file. It was, and no component changed. D1 threw that stand-in
away: the desktop now speaks the same HTTP the web app does, to `apps/api`
running as a child process on SQLite. The store, the version chain, the
authorization ladder and the agent graph are worth trusting precisely because
there is one of each, and a local reimplementation would have been a second set
of bugs in the code that owns people's documents.

**Local mode is a posture, not a fork** (`apps/api/deckastra_api/local_mode.py`).
Same routes, same `resolve_*` chain, same roles — the caller is a singleton
account seeded through `provision_personal_account`, the same function real
sign-in uses. Three refusals are structural: it cannot combine with
`DECKASTRA_ENV=production`, the launch secret has no default, and a dev token
does not work in local mode. Two ways in is one more than a single-user service
should have. Sharing and `/v1/dev/session` return 404 — a link this machine mints
leads nowhere, and the product's only unauthenticated read has no business on a
personal machine.

**The renderer reaches the service through a proxy on its own origin**
(`deckastra://app/__api/…`, `main/protocol.ts`). A reserved path rather than a
second host, and that is the design: same origin means no CORS and
`connect-src 'self'`, but far more importantly **the page never learns the
loopback port or the bearer token**. The main process holds both and injects the
`Authorization` header itself, discarding any the page sent. A compromised
renderer cannot reach the service except through requests the proxy is willing to
make; nothing else on the machine can reach it at all.

**"Ready" means answering.** The service binds and listens *before* printing its
ready line, then the supervisor polls `/health`. The obvious version — pick a
port, print it, start uvicorn — has a race that is not theoretical: the first
request is refused because uvicorn has not bound yet. That cost a debugging cycle.

**A crash is visible.** `sidecar.ts` restarts with backoff and pushes state to the
window, which renders it. A packaged app whose backend died must say so; a blank
window with no explanation is the worst thing it can do.

**Exports need a worker, and locally nobody was starting one.** The deployed
product runs `python -m deckastra_api.export_worker` as its own process. A
desktop install has one user and one machine, so `local_server.py` runs the same
loop on a daemon thread — without it a local export sat at `queued` forever while
the editor reported progress that would never arrive.

**The exporter is bundled, not shelled out to.** `export_service` runs
`npx tsx apps/worker/src/cli.ts` in a checkout and a bundled JavaScript entry
point in a packaged app (`DECKASTRA_WORKER_CMD`), executed by Electron's own
binary in Node mode (`DECKASTRA_WORKER_NODE` + `ELECTRON_RUN_AS_NODE=1`), so no
second runtime ships. Two things had to change for that to work at all: React's
CommonJS needs a real `require` in an ESM bundle (a `createRequire` banner), and
the worker **esbuilds its DOM measurer at runtime** from a `.ts` file a bundle
does not carry — so the measurer is pre-built and passed as
`DECKASTRA_MEASURER_JS`. It is never generated into the repository: a committed
build artifact beside its source is a second definition, and the two drift.

**Row locks are branched on, not assumed.** `supports_row_locks()` in
`db/session.py`. SQLAlchemy **silently drops** `FOR UPDATE` on SQLite, so
`export_service.claim_next` and `assets.register` read as though they lock and did
not. They now ask, and the code says why the unlocked path is safe: one desktop
app, one service process, and SQLite serialises writers. It is not safe if either
stops being true.

**`resource_root()` (`paths.py`) is the one answer to "where are the data files".**
Three things are read by path rather than imported — Alembic's migrations, the
generated JSON Schema, and the agent prompts — so a frozen build finds none of
them without help. One function, because the answer cannot be right in two places
and wrong in a third.

**The CSP had two bugs that nothing failed on.** `script-src` named the scheme as
a quoted source (`'deckastra:'`), which is not valid CSP — Chromium ignored the
entry. And `style-src 'unsafe-inline'` with no source list allowed inline styles
while **refusing the app's own stylesheet**, so the desktop build ran unthemed
from D0 until the acceptance harness started recording console output. Both were
visible in the console the entire time. The harness now **fails on any
content-security-policy message**, excluding the one the offline probe
deliberately provokes: a console nobody reads is not a check.

**The exporter bundle is `.mjs`, and that is load-bearing.** Node decides module
kind from the extension or the nearest `package.json`. A checkout is covered by
the desktop package's `"type": "module"`; the installed app puts the exporter in
a resources directory with no `package.json` at all, and Node parsed the first
`import` as a CommonJS syntax error. It is also shipped **outside the asar** —
`ELECTRON_RUN_AS_NODE` runs a plain Node, which has no asar support, so a path
into the archive does not exist to it.

**An outage must not unmount the editor.** D1's first crash test lost work,
because the app swapped `EditorShell` for a status screen when the service went
down — throwing away the document, the undo history and the autosave queue, which
is precisely the work the queue exists to protect. It now shows a banner and
leaves the editor mounted. For the same reason the deck is **opened once**: a
reconnect must not re-read the document, because remounting with the server's
copy discards anything still queued locally.

**Packaging the service** (`scripts/build-sidecar.mjs`, `npm run build:sidecar`).
PyInstaller `onedir`, so no per-launch unpack. Excludes matter as much as
includes: `jax`, `scipy`, `tensorstore` and `pandas` arrived transitively through
optional branches nothing here executes, and were **330MB of a 480MB build**.
It is 103MB now. `psycopg` and `boto3` are excluded too — this binary can only
ever be SQLite and a local directory.

`local_server.py` is the entry point: it configures the process, migrates on
every launch (a desktop app has no operator to run migrations), seeds the
account, and prints one JSON line — the same narrow contract the export worker
uses. Everything lives under one directory, so a backup is a directory copy.
Assets go to `DECKASTRA_ASSET_DIR` through `object_storage.py`'s local backend,
where a "presigned" URL is an ordinary authenticated API path: there is nothing
to sign, and a second signing scheme would be a second thing to get wrong. The
URL is relative so it can never carry the loopback port into a stored document.

Three bundles, because Electron runs three things under three sets of rules
(`scripts/build.mjs`). The one that bites: **the preload must be CommonJS.** With
`sandbox: true` a preload runs in a restricted context with no ESM loader, so an
`.mjs` preload does not fail loudly — it simply never loads, and the bridge is
absent at runtime.

**The renderer is served from a custom scheme, not `file://`.** A `file://` page
has an opaque origin, and three things the editor already depends on stop working
there: `localStorage` throws (so the recovery journal cannot be written),
`navigator.locks` is unavailable outside a secure context (so nothing can own the
journal), and `BroadcastChannel` never delivers (so present mode's two windows
never find each other). `deckastra://app`, registered `standard` + `secure`, fixes
all three and — unlike a loopback HTTP server — is not reachable from anything
else on the machine. The CSP is served with it, and has no `connect-src` at all:
D0 talks to the main process and to nothing else.

The IPC surface (`src/shared/ipc.ts`) is the allowlist, and it is small on
purpose. **No path crosses it** — the renderer names no file, so document content
cannot steer a read or a write. No `openExternal`, no `shell`, no `exec`. A
`.mydeck` file is a document other people send you, and an imported deck must not
gain filesystem access by being opened.

**`unavailable()` returns a rejected promise rather than throwing.** Every method
it stands in for is declared to return one, and callers written against the HTTP
client attach `.catch` to the returned value; a synchronous throw escapes before
that handler exists and takes the surface down instead of showing a message. The
local client's tests caught this, and any future stand-in has the same shape of
bug available to it.

`src/main/smoke.ts` is the D0 acceptance harness, inert without
`DECKASTRA_SMOKE_DIR`. D0's exit gate is a claim about an *installed application* —
opens the fixture, edits it, restarts with the edit intact, presents in a second
window — and none of that can be asserted from a unit test. It observes the
rendered DOM from the main process, exactly as an external driver would, and
grants the page nothing:

```bash
cd apps/desktop && npm run build
DECKASTRA_SMOKE_DIR=<dir> DECKASTRA_SMOKE_STEP=open   npx electron .
DECKASTRA_SMOKE_DIR=<dir> DECKASTRA_SMOKE_STEP=edit   npx electron .   # adds a shape, waits for "Saved"
DECKASTRA_SMOKE_DIR=<dir> DECKASTRA_SMOKE_STEP=verify npx electron .   # relaunch; the edit must still be there
DECKASTRA_SMOKE_DIR=<dir> DECKASTRA_SMOKE_STEP=present npx electron .  # a real second BrowserWindow

# Rendering parity: rebuild all three baselines inside Electron's Chromium and
# compare byte for byte. Needs the repository, so it runs against a dev build.
DECKASTRA_SMOKE_FIXTURES=packages/presentation-schema/fixtures DECKASTRA_SMOKE_BASELINES=packages/renderer/baselines DECKASTRA_SMOKE_DIR=<dir> DECKASTRA_SMOKE_STEP=digest npx electron .
```

**D0 measured, on Windows 11 x64, from the installed app (2026-09-08):**

| Gate | Result |
| --- | --- |
| Runs from the installer | Yes — `packaged: true`, no dev server, no `node_modules` |
| Network | `connect-src` absent from the CSP; a `fetch` from the page fails |
| Scene digests | All three fixtures byte-identical to the committed Node baselines |
| Cold start | 549ms to window, 1376ms to an editable deck (first run); 242/787ms warm |
| Memory | ~375MB across 4 processes; ~485MB across 5 while presenting |
| Edit survives restart | Yes — added shape present after quit and relaunch |

**D1 measured, same machine, development build (2026-09-09):**

| | D0 (file-backed) | D1 (installed app) |
| --- | --- | --- |
| Cold start to an editable deck | 787ms warm | 2522ms warm, 3802ms first launch |
| Memory | ~375MB | ~383MB |
| Installer | 82MB | 247MB |

The ~1.7s is the service process starting, and it is the honest price of running
the real store rather than a local imitation of it. First launch is longer again
because it migrates and seeds.

**Verified on the installed app**, with no Python on the machine: open, edit,
restart-with-the-edit, present in a second window, a service killed mid-session
without losing work, and two editor windows with separate recovery journals.

**A packaged build exports with the app's own Chromium** (2026-09-12). It used to
fail installed, because the exporter needed Playwright's Chromium — a ~290MB
browser the installer never carried — while the app it ran inside already had
one.

It fails *honestly*: `explain_export_failure` recognises a missing browser on both
routes a failure can take (the exporter's own JSON answer, and an exporter that
printed nothing) and says "this build cannot render", keeping the original text
for a bug report. Retrying will never help, so the message must not read like a
transient failure.

That message still covers a checkout without Playwright. A packaged build no
longer reaches it: `sidecar.ts` sets `DECKASTRA_RENDER_BACKEND=electron`, and the
exporter starts the app's own binary in **render-host mode**
(`DECKASTRA_RENDER_HOST=1`, `main/render-host.ts`) and drives it over Node's IPC
channel (`apps/worker/src/electron-backend.ts`). `RenderPage` (`render-page.ts`)
is the handful of page operations the exporter performs; Playwright and Electron
both implement it, and the message shapes live in `workspace-contracts` so the
two sides compile against one definition.

**Not Playwright's Electron driver, and not a debugging port.** That driver starts
Electron with `--inspect=0` and `--remote-debugging-port=0`: an unauthenticated
Node inspector on loopback for the length of every export — code execution for
anything on the machine that finds the port. D1's posture is that nothing else on
the machine can reach the service, and a render path that reopened that door would
undo it. An IPC channel belongs to the two processes that share it.

Five facts decided the design, each found by a probe against this Electron
version rather than assumed:

- **An Electron main process never receives piped stdin on Windows** — the
  request arrives as an immediate end-of-file. Node's IPC channel works. So the
  exporter stays Node-mode (where stdin does work) and the browser is a child.
- **An installed Electron app ignores a script path on its command line** and
  always runs its own bundle. The host is therefore *in* the main bundle, and
  `main/index.ts` is only a dispatcher that `import()`s either `render-host.ts` or
  `app.ts`. Dynamically, because a static import of `app.ts` would run its
  single-instance lock in the host, which would then find the user's running app
  holding it and quit. The built bundle keeps `app.ts` inside a lazy `__esm`
  wrapper; a host was verified to run beside a live app and leave it running.
- **A hidden window never produces a frame**, so a CDP screenshot of one waits
  forever. `capturePage({ stayHidden })` returns pixels at the *monitor's* scale —
  2400×1350 on a 125% display — which would bake one machine's settings into every
  export. **Offscreen** windows paint, and gave exactly 3840×2160 at scale 2.
- **`Emulation.setDeviceMetricsOverride` before the first navigation kills the
  browser process.** The host loads `about:blank`, then attaches and emulates.
- **The host needs its own profile**, or it fights the running app over the cache
  ("Unable to move the cache: Access is denied"). It makes a throwaway one and
  reports it; the exporter deletes it after the host exits, because Chromium holds
  it open until then.

The host's page gets what the Playwright path's did and nothing more: no network
except `data:`, no permissions, no pop-ups, no navigation, no preload and no Node,
reduced motion and dark scheme set explicitly. The exporter discards the host's
stdout and keeps only a tail of its stderr — its own stdout is the export's single
JSON answer and its stderr is progress, one object per line.

**A second packaging bug was hiding behind the first.** The bundle imported
`esbuild` *statically*, for a fallback the packaged app never takes. A static
import resolves before any code runs, so the installed exporter could not load at
all — and a checkout could not show it, because a checkout has `node_modules`. The
missing-browser message had been masking it. It was found by running the bundle
from a directory with nothing beside it, which is what an installed app is.
`scripts/build.mjs` now reads esbuild's metafile and **fails the build if the
exporter statically imports any external package**; externals are allowed only as
dynamic `import()`. The guard was shown to flag a static import and ignore a
dynamic one before it was trusted.

**Measured, 2026-09-12**, the bundle run from an isolated directory with no
`node_modules`, on `technical-deck`: PDF 5 pages, all 1440×810pt, read by `pypdf`
with its text; PPTX 5 slides at 13.33×7.5in, read by `python-pptx`. Text was
browser-measured in both (`metricsEstimated: false`). Against the Playwright
backend on the same deck the slide counts, estimate flags and degradation warnings
are identical — PPTX's four (code and groups flattened, a diagram and a table
dropped) belong to the adapter, not the renderer. Byte and pixel identity across
the two browsers is **not** claimed: they are different Chromium builds, and pixel
baselines are per browser as well as per platform.

The same run from the **packaged pieces alone** — `release/win-unpacked`'s own
`Deckastra.exe` running its own `resources/worker/cli.mjs` in Node mode, and
lending itself as the render host with no arguments, which is exactly how an
installed app is configured — gave the same answers: PDF 5 × 1440×810pt,
PPTX 5 slides, browser-measured text, the same warnings, no profile left behind.
**Then from the installed app itself, 2026-09-12** — the NSIS build installed
silently (`/S`, 27s), launched with `DECKASTRA_SMOKE_STEP=export`: the export
panel's PDF ran through the packaged service, the packaged exporter and the app's
own Chromium, and finished — "3 slides · 31 KB", with the report naming two
animated slides flattened to a single frame, which is what a PDF can hold. No
console errors, no CSP violations, 7s from launch, ~382MB across 4 processes, no
render profile left behind. The stored artifact itself, read back through the
export row's `artifact_path` by `pypdf`: 3 pages at 1440×810pt, 31,797 bytes,
with its text. **D1's last gate is met.**

**Exports live in the data directory** (2026-09-12). That run showed them going to
`%TEMP%\deckastra-exports`: outside the one directory D1 promised a backup could
copy, on the system drive, and in a folder Windows' own cleanup may empty — so a
finished export's "Download" could outlive its file. The cause was not a missing
setting so much as a fragile one: the directory was a module constant read at
import, so anything that set `DECKASTRA_EXPORT_DIR` after `export_service` first
loaded was silently ignored (the export tests had to patch the module to cope).
It is now `export_root()`, read when an export runs — the same rule
`object_storage.local_root()` already followed — and `local_server` points it at
the data directory, so exports land in `workspace/deckastra-exports` beside the
database and assets. Rows written before the change keep their absolute temp
paths and download from there for as long as those files survive.

Verified on the **installed** app after a rebuilt service and a reinstall: an
export from its own UI stored its artifact at
`%APPDATA%\Deckastra\workspace\deckastra-exports\exp_….pdf` — inside the data
directory, nowhere under `%TEMP%` — and `pypdf` read it: 3 pages at 1440×810pt,
the byte count matching the export row. The dev app has to be
closed for this run, because it and the installed app share one single-instance
lock.

macOS is **not** measured and cannot be from here: it needs real hardware, and a
passing Windows run says nothing about it. Pixel parity inside Electron's Chromium
is also still open — the digest gate covers the scene, not the paint.



Two environment notes that cost an hour each if unknown:

- **`electron`'s binary comes from GitHub releases.** Where that is unreachable,
  `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ npm install`
  works.
- **Packaging needs symlink privilege on Windows.** `electron-builder` always
  fetches its `winCodeSign` bundle, which contains macOS symlinks that 7-Zip
  cannot create without Developer Mode or an elevated shell. `electronVersion` is
  pinned in `electron-builder.yml` for a separate reason: npm workspaces hoist
  `electron` to the repo root, where electron-builder does not look.

Signing and notarization are D6 and are **not** done. The packaging config
describes the shape only.

### An agent reaches the app the way a person does

`apps/mcp-server` is milestone D2: Claude Code and Codex drive the same command
authority a human does, over stdio. It is a **thin adapter over
`WorkspaceClient`** — every tool is one call on that interface, so optimistic
concurrency, proposal-before-apply, server-computed risk and the authorization
ladder hold for an agent without any of them being restated. A second write path
would have been a second set of the bugs those rules exist to prevent.

**If the app is not running, it refuses.** The tempting alternative — starting a
headless service of its own — puts two processes on one SQLite database, which is
the corruption case the single-instance lock already exists to prevent.

That refusal was first described here as also solving the *stale editor*. It did
not, and running the app showed it: an agent renamed the deck over MCP, the store
had the new title, and the open window went on showing the old one — so the
user's next edit would have met a conflict they did not cause. An editor learned
the head only from its own saves, which was enough while it was the only writer.

**An open editor now watches the head** (`useEditor`, `watchHeadMs`, default 4s).
It polls `GET /presentations/{id}/head` — one row, where the full read replays the
version chain — and asks again on window focus, because returning from the
terminal where you told an agent what to change is exactly when a stale deck is
noticed. A hidden window does not poll. A poll rather than a push: it works the
same through the web app's HTTP and the desktop's proxy, and needs no channel a
service restart could silently drop.

Three rules keep it from becoming the data loss it exists to prevent:

- **It only replaces a document with nothing unsaved in it.** With operations
  queued, in flight, or under conflict review, it does nothing; the next save
  carries a stale `expected_version_id`, the server refuses it, and the existing
  conflict review keeps both versions.
- **It cannot mistake the editor's own save for someone else's.** An acknowledged
  save moves the head too. A save generation counter, plus the version known when
  the poll began, discards any answer that raced one.
- **Local undo is cleared on adoption.** Its inverses were computed against the
  document before the outside change, and some are index-addressed; replaying one
  against a document that has moved is how a patch lands on the wrong element.
  The user's own edits are already saved, so what goes is stepping back past
  someone else's change — the honest limit.

**The attachment file is the one deliberate way in** (`main/attachment.ts`). D1's
posture is that the service is unreachable: a random loopback port, a per-launch
secret, and a renderer that learns neither because the main process proxies for
it. D2 does not relax that; it adds one door and writes down the cost. The file
lives in `userData` (inside the user's own profile, `0o600` where that means
anything), carries the **launch** secret rather than a durable one — so a copy
recovered from a backup authorises nothing — and is withdrawn when the service
stops. A crash withdraws nothing, so the reader verifies rather than trusting:
the pid must be alive, the version must match, and `/health` must answer *with
that secret*. Only the last one distinguishes our service from whatever else was
given that port.

**Publishing tracks the service, not the app.** A restart comes back on a
different port, and the `ready` status the window renders is the only moment that
knows the new one. The first launch is the exception and needed its own call: the
supervisor reports `ready` from inside `startSidecar`, while the assignment of
`sidecar` is still pending.

**The single-instance lock now guards the whole of startup.** It used to sit at
the bottom of `index.ts`, which quit the second instance correctly and then let
its `whenReady` handler run anyway — starting a service, broadcasting a status,
and **withdrawing the first instance's attachment on the way out**. An agent
attached to the running app lost it because someone double-clicked the icon. The
lock is decided before anything else and `startup()` is behind it.

**Results are bounded summaries, never whole documents.** `outline.ts` answers a
deck read with slides, roles, text and — the load-bearing part — the *ids*, since
every operation this product accepts is id-addressed. A `.mydeck` document is
mostly geometry and token references; the animation fixture in full is tens of
thousands of tokens, and an agent that spends its context reading a deck has none
left to change it. Full geometry is one slide at a time, asked for deliberately.

**An external client supplying its own intelligence must not trigger a paid model
call.** `POST /v1/presentations/{id}/proposals` (`agent_routes.py`) takes
caller-authored operations straight to `create_proposal`. `agent/edit` exists for
words and pays a model to turn them into operations; a caller that has already
done that work would be billed twice, and the second bill buys a worse answer.
There is no client in that function to call, and a test makes any model call an
error.

Three refusals in that route are structural rather than conventional:

- **`expected_version_id` is required**, and checked against the head before
  anything is created. `create_proposal` derives its own base version, which is
  right for the editor's agent — it composes operations from the document it just
  loaded, in the same request — and is last-write-wins for an agent that read the
  deck thirty seconds ago while the user was typing. A caller that could omit it
  would eventually omit it.
- **The caller cannot declare a risk tier**, so it cannot mark a destructive
  change low-risk and skip the human who would have caught it.
- **The caller cannot claim to be an internal agent.** Its label is prefixed
  `mcp:`, because `agent_id` reaches the approval prompt and "editor" there would
  tell a user the product's own edit agent proposed something an external client
  did.

**`workspace_list` returns every deck, and for a while it did not.** It promised
decks and returned only workspaces and projects, because `/v1/account` carries no
decks and no route listed them — so an agent asked "which decks do I have" could
name the one open in the window and nothing else. The first real Claude Code
session over this server found that and said so. `GET /projects/{id}/presentations`
(`routes.py`) answers from rows, newest first, through `resolve_project_access`;
titles are content, so a stranger gets the same 404 as for the deck itself. The
tool caps each project at 50 and counts the rest. Titles stay accurate because
`commit_transaction` copies `metadata.title` onto the row on every commit.

**What the tool surface omits is the feature.** No approval tool — an agent that
could approve its own pending proposal reduces "a human stays in control" to a
delay. No sharing — a share link is a bearer credential to a document. No path
anywhere, for an export destination or a repository: document content reaches this
process, and a tool that took a path would let a deck someone emailed you choose
where bytes are written. A test asserts each absence, so none is restored by
someone wiring up "the missing tool".

**D2 measured, Windows 11 x64, development build (2026-09-10).** The claims are
about software someone is using, so `scripts/acceptance.mjs` drives the real
stdio transport against a running app rather than a mock — 13/13: attach, name
the open deck, read an outline, apply a low-risk change and see it in the store,
be refused for a stale one *without losing the earlier change*, watch a
destructive change become a pending proposal attributed to `mcp:acceptance`, and
export a 25KB PDF.

Still open, and not claimed: a rendered image preview for a proposal — no longer
blocked by a missing browser now that a packaged build renders with its own, but
not wired (`PREVIEW_SIZES.mcp` exists; the textual outline of what a change
*would produce* is what ships) — motion tools, and a real **Codex** session.

**A real Claude Code session, 2026-09-12**, against the running dev build: it
found the server, listed the workspace, read a six-slide deck as an outline, and
authored a restyle — gradient backgrounds, radial glows, italic gold accent words,
shadowed cards — as one patch across every slide. The server rated it high risk
because it touched all six, so it became a pending proposal rather than applying;
the user approved it in the app, the agent re-read the stored document to confirm
it landed, and the user checked the rendered result. That is the whole design
exercised by someone other than its author: the agent brought its own
intelligence, paid for no second model call, could not choose its own risk tier,
and could not approve its own change. The session also found the `workspace_list`
gap above, which is the other thing a real session is for.

### The editor is a package; the shell decides where it runs

`packages/editor-ui` is the canvas, present mode, the panels and `useEditor`.
`apps/web` is four routes. That split exists because a second shell is coming
(doc `PHASE_0_TO_9_FIX_PROGRESS.md` / the desktop plan, milestone D0), and the
only way to know the editor is portable is to have moved it somewhere it cannot
reach the things it used to.

Two rules keep it that way, and both are checkable in a diff:

- **No `next/*` import in `packages/editor-ui`, ever.** Routing belongs to the
  shell. The one `useRouter` in the product is in `apps/web/app/page.tsx`.
- **No `fetch` and no environment variable in `packages/editor-ui`.** Requests go
  through the `WorkspaceClient` in React context (`@deckastra/workspace-client`),
  which is HTTP against the API today and the same HTTP against a loopback
  sidecar on the desktop. `apps/web/lib/client.ts` is the only place in the app
  that reads `NEXT_PUBLIC_API_URL`; there used to be ten, which is exactly how
  many places had to be found before anything could be mounted elsewhere.

`@deckastra/workspace-contracts` holds the shapes and nothing else — no runtime,
no React — so the web app, the desktop shell and the future MCP adapter agree at
compile time rather than at runtime. Document payloads there are
`presentation-schema` types and are never restated: doc 02 is the source of truth
and a second description of a slide is a second definition to drift.

Where the browser genuinely differs from a packaged app, the difference is an
**injected default**, not a branch:

- `PresentMode` takes `openPresenter`, defaulting to `browserPresenterWindow`
  (`window.open`). It is synchronous and returns `null` on failure on purpose — a
  browser only honours `window.open` inside the task that handled the click, and a
  blocked pop-up is something the user did rather than an error.
- `PresentChannel` already took a `BroadcastChannel` factory.
- `HostBridge` (in the contracts) is the allowlist for everything else a shell can
  do — a native save dialog, a second window. It is deliberately separate from
  `WorkspaceClient` and deliberately tiny: an imported deck must not gain
  filesystem access by being opened, so nothing on it takes a path from document
  content and there is no general "open URL".

Tests moved with the code. `packages/editor-ui/tests` owns the editor's
behaviour; `apps/web/tests` keeps only what a route does with the answers it
gets. The shared harness is `@deckastra/workspace-client/testing`, which builds a
**real** client over a stubbed `fetch` rather than a fake client — these suites
exist to check what reached the server, and a fake would let a changed request
body pass every one of them.

### Validation is a product surface

`RULES` in `src/validate.ts` is the catalog (doc 02 §42). Codes are stable because the editor, agents, exporters and the MCP surface all reference the same rule. Messages must be actionable and name the offending id.

- `MECHANICALLY_FIXABLE` rules must emit a `suggestedFix` — that turns "this text overflows" into a one-click repair and lets an agent self-correct without another model round-trip.
- `REQUIRES_RENDER_CONTEXT` rules need text metrics or resolved geometry, so they run in the semantic pass after a render, not in `validateDocument`.
- `W240`/`W241` extend doc 02 §42 and should be folded back into the spec at its next revision.

Union parse failures are expanded via `ELEMENT_SCHEMA_BY_TYPE` before being reported: a raw `z.union` failure collapses to "Invalid input" at the element and loses the real reason.

### No expression language, anywhere

A `.mydeck` file must be safe to email. Data bindings use a fixed transform allowlist (`BindingTransformSchema`), binding targets use a path allowlist (`isAllowedBindingTarget` — unrestricted paths would let a binding rewrite `id`, `type` or `children`), and component parameters wire to concrete template paths rather than substituting into strings. Assets carry an opaque `storageKey`, never a signed URL; signed URLs are minted at render time.

### Motion: compile once, then sample a pure function of time

```
document tracks ──┐
                  ├─> compileTimeline ──> CompiledTimeline ──> sampleAt(t) ──> styles
scene nodes ──────┘        (once)          absolute ms         pure of t
```

`packages/animation-engine`. Everything relative — `afterPrevious`, `click`, a
clip's `startMs` offset — is resolved to absolute milliseconds at compile, and
nothing downstream resolves anything. That is what makes `seek(t)` stateless,
which doc 04 §26.2 makes an acceptance criterion: **playing to `t` and seeking to
`t` must produce identical styles.** The way that breaks is a value advanced
frame by frame, so there is exactly one function that computes a value and
playback is a loop that calls it.

`sample.ts` is deliberately the engine rather than WAAPI, against doc 04 §23.1's
recommendation. WAAPI owns the interpolation, which moves parity into the browser
and leaves a fixed-step video export (§26.1) reproducing whatever the browser did.
The adapter interface (§22.1) still allows a WAAPI adapter later.

Six things that look like details and are load-bearing:

- **`x`/`y` are offsets, not positions.** Doc 04 §22.2's sketch animates to
  `node.bounds.y` while §22.4 applies them as CSS `translate`; the two cannot
  both hold. Offsets win, because an animation written as one survives the
  element moving or the container re-laying out.
- **Backwards fill is the default** (`CompiledClip.fill` = `"both"`), against the
  CSS default of `forwards` that doc 02 §24 inherited. An entrance is only an
  entrance if the element is in its starting state before the clip runs; a bullet
  visible until its click-triggered fade-in begins has flashed, not been revealed.
- **Every preset declares a reduced-motion fallback**, enforced by a build-time
  test (doc 04 §27.3). `drawPath` and `numberCount` fall back to `"instant"` —
  the drawn path and the final number — because a fade is a different statement,
  not a quieter one.
- **Springs are sampled into keyframes at compile.** A live spring's state at `t`
  depends on the frames before `t`, so it cannot be seeked.
- **Determinism, again**: a fixed Newton iteration count in the bezier solver, a
  fixed spring step, and `round()` to three decimals. An epsilon-terminated loop
  runs a different number of times on different inputs.
- **Longhands only** (`translate`, `scale`, `rotate`). The scene already puts a
  base `transform` on the element and a shorthand written by the adapter would
  erase it, sending the element to the slide origin.

**The timeline is a view of document state.** A clip edit is `clipPatchOperations`
→ patch → transaction, in the same history as a text edit. There is no local
timeline state and no way for the timeline and the document to disagree.

### The Motion Agent names roles; code computes milliseconds

Same split as the Story Architect's, applied to time. `nodes/motion.py` emits
semantic roles, a preset name and one word of pacing;
`apps/api/deckastra_api/motion.py` turns that into tracks.

It has to work this way — the agent runs before the composer, so no element id
exists to name — and the constraint pays for itself twice. A sequence written in
roles survives a re-layout, and the **entrance budget becomes enforceable**: doc
04 §24.2's 2.5s ceiling is something `_fit_to_budget` computes, not something a
model is asked to respect. The fan between elements sharing a step counts toward
it; ignoring that satisfies the arithmetic while the slide visibly over-runs.

Restraint is the default and the composer encodes it: no motion plan means a
still deck, a role the plan does not name does not animate, body text past
~24 words is left in place (doc 04 §24.4), and a role is consumed the first time
it is reached so nothing is ever animated twice.

### A share link is a bearer credential, and everything follows from that

`sharing.py`. Whoever holds the link is authorised — no identity, no second
factor — so:

- **256 random bits** from `secrets.token_urlsafe`, never an id or a UUID. A
  guessable link is a public deck nobody chose to publish.
- **Only the hash is stored**, so a database read cannot hand out working links to
  every deck. The plaintext is returned once, at creation, and the UI says so
  because it is literally true.
- **Every refusal is the same refusal.** Expired, revoked and never-existed all
  answer with one message: telling a holder which it is confirms a deck exists
  behind the id they tried.
- **Revoked, not deleted.** "Who could see this, and when did that stop" is the
  question asked after a leak.

- **Viewer only, for now.** Nothing can redeem an editing link:
  `/v1/shared/{token}` returns a document and the shared page only presents it.
  Storing a role the product cannot honour tells whoever made the link that they
  granted something they did not. The column and the `Role` plumbing stay, so
  token-scoped editing needs no migration — only a write path that authenticates
  a token instead of a session.

`/v1/shared/{token}` is the only unauthenticated read in the product, and it
returns one document and nothing about the workspace around it. The role on a
share is a real `Role` from the membership ladder, so a shared viewer and a
workspace viewer are the same thing to every downstream check — an `is_public`
boolean would have been a second thing every authorisation site had to consult,
and one of them would have missed it.

### Quotas refuse before the work and charge after it

`quotas.py`. `RunBudget` (doc 03) caps one run; quotas cap a hundred. Both are
needed and they are different controls.

- **Refuse first, charge later.** Checking after means paying for the request
  that broke the limit; reserving up front means releasing a reservation through
  a crash. A workspace overshoots by at most one run.
- **The period resets lazily**, on the first request after it lapses. A cron that
  misses a month locks every workspace out and the failure looks like a bug in
  generation.
- **Null is unlimited and it is not zero.** One integer cannot say both.
- Storage is a *level*, not a flow, so it is recounted from the assets and never
  reset with the month.

### An asset outlives the slide that used it

`assets.py`. Version history is the product's promise, so a deck's third version
can cite an image its fifth deleted, and an undo has to bring the picture back.

- **References are recounted from every stored snapshot and every materialised
  head**, not incremented on edit. An increment missed once is wrong forever; a
  recount is right every time. Both passes are needed: history keeps an image a
  later version deleted, and snapshots are only written every
  `store.SNAPSHOT_EVERY` operations — so an image placed by an ordinary edit
  after the last one is in the *current deck* and in no snapshot at all.
- **`JsonColumn` stores a Python `None` as JSON `null`, which is not SQL NULL.**
  `snapshot_json.is_(None)` matches none of those rows. Both passes test
  emptiness in Python; a SQL-side filter here silently skips every head.
- **Zero references starts a clock.** Only the sweeper removes bytes, after
  `ORPHAN_GRACE_DAYS`, so an undo inside that window finds the file.
- `referenced_ids` walks the whole document rather than its asset manifest,
  because the manifest is a convenience and the elements are the truth.
- `sweep` defaults to `dry_run=True`. It deletes user data by inference.

### A themed document carries both the id and the tokens

`themes.py`. A `themeId` alone would make a `.mydeck` file unopenable outside the
workspace that owns the theme, and doc 02's first rule is that a document is
portable and safe to email. So the id records which brand this deck follows and
the resolved definition is what renders.

Applying a theme goes through the **one mutation path** — apply, capture the
inverse, validate, commit — so it undoes like every other edit. The `themeId`
operation is an `add` rather than a `replace` because a deck themed for the first
time has no such property and `replace` refuses one that does not exist.

### JSON columns are not `MutableDict`

`JsonColumn` is a plain `JSON`/`JSONB` type. Mutating a nested list in place and
then re-assigning a shallow copy leaves SQLAlchemy comparing an already-equal
value: **no UPDATE is issued and the change vanishes**. Assign a deep copy, or
build a fresh object. Nothing in the product does this today; a test did, and it
failed silently until the row was read back.

### Accessibility has a named target and a named scope

**WCAG 2.1 AA.** `packages/renderer/src/accessibility.ts` checks 1.1.1 (alt text
on images, charts and diagrams), 1.4.3 (contrast against *what is actually
behind* the text, not the theme's nominal background) and 1.3.1 (reading order
against visual order, with a row tolerance so a two-column slide reads across).
Keyboard and reduced motion are covered by present mode and the animation engine.

Deferred and stated so: tagged PDF, and full screen-reader support for the
*editor* as opposed to the decks. "Accessible except for some things" is a claim
nobody can rely on.

The three seed decks pass every in-scope criterion, which is the gate: a product
whose own examples are inaccessible cannot ask anyone else to comply.

### Telemetry is optional, and carries no user text

`telemetry.py` owns real OpenTelemetry SDK providers and OTLP HTTP/protobuf
exporters. It stays disabled without an endpoint or `DECKASTRA_TELEMETRY=1`;
`DECKASTRA_TELEMETRY=off` explicitly disables it. API lifespan starts and flushes
the providers. Ordinary `configure()` is idempotent; `configure(force=True)`
replaces providers and rebinds instruments during a controlled transition.
Spans carry `presentation_id`, `run_id`, `workspace_id`, `version_id` — a trace
saying "the API was slow" is not actionable; one naming the generation is.

**No user text in a span attribute, ever** — not a title, not a prompt, not a
retrieved chunk. Traces land in a third party, and an attribute is the easiest
place in a system to leak a customer's words. Keys and enum values are allowlisted,
product IDs validated, and numeric counts checked. Filtering includes metric
labels and late writes through the returned span. Automatic SDK exception capture
is disabled: error categories are recorded without messages/stacks. HTTP spans
exclude URLs, bodies and headers; model spans exclude prompts and responses.
Real collector and API/agent trace tests are in `apps/api/tests/test_telemetry.py`.
Vendor-specific LLM inspection and deployed dashboards remain separate open work;
the metadata-only OpenTelemetry model spans do not claim to implement them.

**The instruments resolve on first use, not at import.** `GENERATIONS` and its
siblings are module-level, and `configure()` runs at startup — later. Created
eagerly they captured the no-op meter and stayed no-ops for the life of the
process: every metric the product recorded went nowhere, with nothing failing and
nothing logged. Anything else declared at import that depends on `configure()`
has the same shape of bug.

### Export: resolved scenes in, a reported degradation out

```
PresentationDocument
       |
       v  buildDocumentScene, once
IntermediateScene --+--> packages/export-pdf   --> apps/worker, Chromium printToPDF
                    +--> packages/export-pptx  --> OOXML, no browser
```

**Adapters receive scenes, never the document for geometry.** Doc 04 §32.1, and
it is what stops PDF and PPTX disagreeing about where an element sits. The one
thing PPTX reads from the document is *semantics* the scene resolved away — a
shape's kind, because `prstGeom prst="ellipse"` is editable in PowerPoint where a
converted path is not. Coordinates never come from there.

**`DegradationLedger` is the only way to degrade something.** An adapter cannot
skip a feature without the skip landing in the report, so doc 04 §32.2's "every
degradation is reported" is a property of the object graph rather than a rule
someone remembers. The report names the *action* — flattened, rasterized,
dropped, approximated — because "unsupported" tells a reader nothing.

**Byte-stability is load-bearing** (doc 04 §32.3). `packages/export-pptx` has its
own zip writer because every general-purpose one stamps the current time into
each entry; timestamps come from the document, and shape names derive from
element ids rather than a counter — which is also what gives PowerPoint's Morph
something stable to pair on (§33.3). A counter renumbers when a slide gains an
element and every morph silently stops working.

**PDF is one paginated page, not N merged documents.** Chromium paginates with
CSS page breaks, so one `printToPDF` gives one file; merging would mean parsing
cross-reference tables. `break-after: page` is cleared on the last section —
without that every export ends with a blank sheet (doc 04 §34.3).

**The exports are checked by readers that are not us.** `python-pptx` and `pypdf`
are independent implementations of the same specifications, and a package they
refuse is one PowerPoint refuses. Every other assertion about these files is made
by the code that wrote them and shares its misunderstandings.

### The render service is the renderer's determinism claim, checked

`apps/worker` mounts the same `SlideView` the editor does, in `mode="export"`,
with no editor, no session and no user (doc 04 §41.1). Three things there are not
incidental:

- **No network at render time.** Every request is aborted except `data:` URLs. A
  document that could make the render server fetch a URL is an SSRF primitive as
  well as a source of nondeterminism.
- **Reduced motion is set explicitly**, not inherited. A render that picked up the
  *server's* preference would bake one machine's accessibility setting into every
  user's export.
- **Animations resolve to a chosen frame** (`final` by default). Otherwise a
  render catches whatever frame the entrance happened to be on.

Text measurement uses two synchronous scene builds around one asynchronous
browser batch (`apps/worker/src/text-measurement.ts`, doc 04 §31.2). The first
records complete requests while answering with the estimator. The browser runs
the shared `createDomMeasurer` over those requests, including paragraph layout
and the entire shrink-to-fit search. The second build reads a synchronous cache.
The key includes content, typography, width, height, fit and font bounds; caching
only text/width or the estimator's intermediate font sizes can mismeasure fit.

Font availability is captured in the same browser and supplied to the final
scene. The cache is local to that page and document. Any second-pass miss uses
the estimator and retains its flag; both PDF and PPTX reports inspect the actual
exported scene, including nested text. Image rendering uses the same service.
The PDF renderer consumes the adapter's measured scene rather than rebuilding it.

Both export formats need a browser, including PPTX — Playwright's Chromium in a
checkout and CI, the desktop app's own in a packaged build (see "The desktop runs
the API"). The worker
bundles the shared DOM measurer in memory with its direct `esbuild` dependency;
no generated measurement implementation or network script is maintained. Fonts
must be installed on the render host, as before. Browser measurement does not
promise identical results across machines with different installed fonts.

Run `npm run test:browser --workspace @deckastra/worker` after installing Chromium.
It compares worker scene digests with the editor's actual `browserMeasurer()` in
Chromium, checks fit modes, and verifies PNG/PDF/PPTX report no estimates. Unit
tests cover cache misses and their PDF report flag. CI's export job runs the
browser tests; plain `npm test` keeps browser tests separate.

### The API reaches the worker through a subprocess

The renderer, the adapters and the animation engine are TypeScript; the API is
Python. `export_service._invoke_worker` shells out to `apps/worker/src/cli.ts`,
with a deliberately narrow contract — **JSON in on stdin, JSON out on stdout,
bytes to a file** — so it can become an HTTP call later without its callers
changing. Progress goes to stderr, one object per line, which keeps stdout a
single parseable value.

`tsx` reads the JSX transform from the root `tsconfig.json`. Without that file it
defaults to the classic runtime and every `.tsx` in the renderer fails with
"React is not defined" — which is why a root config exists even though nothing
compiles through it.

### The Critic scores eight dimensions, and measures before it judges

Doc 03 §13's full score model: hierarchy, readability, contrast, alignment,
density, consistency, narrative clarity, and motion quality when there is motion.
Eight rather than one because the verdict has to *route* — a single 0.6 leaves a
human to work out what to do, while `hierarchy: 0.4, narrative_clarity: 0.9` says
the words are fine and the slides are not.

`nodes/_signals.py` is doc 03 §14's deterministic service: word counts, layout
misfits, uncited numbers, repeated layouts, motion counts. Nothing there has an
opinion. It exists because density is a count, and a model asked to count will
sometimes say four where there are three and then raise an issue about the four.
The Critic argues about what the numbers mean, never about what they are.

Doc 03 §13 also allows a rendered preview image, and the render service now makes
that a wiring job rather than a missing capability — it needs a vision model and
a composed document, and the Critic runs before the composer.

### Repository grounding runs on bytes, never on execution

`integrations/` reads repositories; `apps/api` indexes, searches and cites them.
The pipeline is `tree → ignore → rank → read the top N → chunk → index`, and the
step that makes it viable is **read only what ranked** — deciding from the tree
alone is the difference between seconds and an hour.

Five things there are load-bearing:

- **No repository code is executed**, and that includes `git`:
  `LocalDirectorySource` parses `.git/HEAD` as a file. A rule with an exception
  is not a rule.
- **`ignore.py` runs before the ranking.** A path that will never be indexed must
  not occupy a slot in it, and `looks_like_secret` is the one check that must
  never be relaxed — an embedded private key is a private key in a database.
- **Retrieval declares which kind it is.** `default_embedder()` returns `None`
  without a key and the index falls back to BM25 (`lexical.py`), labelling itself
  `embedding_model="bm25"`, `embedding_semantic=False`, which the UI surfaces.
  The previous hashing "embedder" was deleted rather than kept as a fallback: 1024
  hashed dimensions are mostly collisions, and a search that confidently returns
  the wrong file is worse than one that admits it matches words.
- **`staleness()` has three states and "unknown" is not "fresh".** A working
  directory with no commit, or a repository whose head cannot be read, lands
  there. Reporting it as up to date is how a deck silently drifts from `main`.
- **Losing access deletes content.** `apply_webhook` removes the chunks on an
  uninstall, a suspension or a repository deletion. An index that outlives its
  permission is data we are no longer allowed to hold.

A hit carries **its own repository** (`repository_full_name`, `source_id`), and
deduplication is keyed on `(repository, reference)`. A search spans every
connected repository: attributing every hit to the first one is correct only when
there is exactly one, and with two it cites a file that is not in the repository
it names — while collapsing two same-named files into one citation. A citation
naming the wrong repository is worse than no citation.

Provenance lives in the document (`provenance.py`, doc 02 §30) as
`owner/repo#path:12-48`, attached to the element carrying the claim — not to the
slide, because the schema targets an element. A slide that cites nothing gets no
record: the absence is information.

The webhook is the only unauthenticated endpoint in the product. It verifies
HMAC-SHA256 over the **raw body** (re-serialising the JSON changes the bytes),
**no configured secret means reject**, and a rejection returns 401 with nothing
in it — a detailed error is an oracle for guessing the secret.

### The stub planner is repository-aware, and that is deliberate

When research retrieved repository chunks, `stub_repository_story_plan` writes
the deck out of those chunks and cites them. It is not decoration: without it,
the entire provenance path — records, the sources endpoint, the UI panel — would
be unreachable in CI and only exercised by hand with an API key. The citations
are true because the slides quote the blocks that were actually retrieved.
`StubClient.register` therefore accepts a callable, so a stub answer can depend
on what the prompt actually contains.

### One session per request, committed before the response

`session_middleware` in `db/session.py`, not a `Depends` with `yield`. FastAPI
runs a yield-dependency's teardown *after* the response is sent, so a client that
reads a write's response and immediately issues the next request beats the
commit. That is not hypothetical — connect-a-repository and index-it are two
calls the UI makes back to back, and the second returned 404 until this moved.
`get_session` reads the session off `request.state` and falls back to
`session_scope()` when there is no middleware.

## Fixtures

Three seed decks in `packages/presentation-schema/fixtures/`, generated by `scripts/build-fixtures.ts`:

| Fixture | Covers |
| --- | --- |
| `technical-deck` | Every MVP element type; container layouts; the general renderer and export fixture |
| `repository-context` | Repository-grounded content where every claim carries a provenance record |
| `animation-test` | Every MVP trigger, preset shape and reduced-motion path — including click segments, a staggered group and a drawn path |

Fixture ids are **deterministic** so regeneration produces a zero-line diff — a fixture whose ids churn makes every visual-regression snapshot fail for no reason. Do not use hand-written ULIDs in tests; call `newId()`.

## Conventions

- All lengths and coordinates are **logical presentation pixels** as bare numbers — never `"12px"` strings. Durations are integer milliseconds. Angles are degrees, clockwise positive. Timestamps are ISO 8601 UTC.
- Ids are `{prefix}_{ULID}`, stable forever, never reused, never parsed for meaning beyond the prefix.
- `packages/presentation-schema` must not depend on React or on any renderer or animation runtime.
- Source comments explain *why*, citing the spec section. Match that when adding code — the reasoning is the part that stops a future change from silently undoing a decision.
- Relative imports inside packages are **extensionless** (`from "./scene"`), matching `moduleResolution: "Bundler"`. Turbopack does not map `.js` → `.ts`, so extensions break the web build.
- Authorization resolves `User → Workspace → Project → Presentation` through `resolve_presentation_access`, by **membership and role**, never by `owner_id`. A missing resource and a forbidden one both return 404: a 403 on something you cannot see confirms it exists.
- Risk tier is computed server-side from the operations. Never accept one from a caller.
- The workspace-scoped routes take no workspace id, so they resolve the caller's
  own through `resolve_workspace_access`, which **requires a `Role`**. Each of
  them used to carry a private `_workspace_of` that returned the first membership
  and checked nothing, so a viewer could write a workspace-wide theme and run the
  asset sweeper. A new workspace route cannot forget the check by omission: it
  has to pass a `require` to get a workspace id at all.
  Legacy unqualified routes select the first membership by workspace ID before
  checking its role; they never switch workspaces to satisfy a write privilege.
- Content an agent did not write goes through `envelope()` — and the envelope
  escapes the delimiter, because content that can close its own tag continues
  outside it, where the model reads it as the operator talking.
- **A tool declares which leaves of its result are untrusted** (`untrusted_fields`,
  `untrusted_kind`) and the registry envelopes them in `_invoke`. The boolean
  `returns_untrusted_content` was declared on six tools and read by nothing;
  every node called `untrusted()` by hand, which is a boundary that lasts until
  someone writes a node without reading the others. `untrusted()` is still public
  for content that never passes a tool — the user's brief, slide text read from
  state — and calling it on tool output now nests one envelope inside another. Detection of an
  injection attempt **warns and never filters**: the envelope is what makes it
  safe, and a filter would block a legitimate deck about prompt injection.
  Registration now rejects an untrusted tool without field declarations and
  rejects blank field names. This is a configuration error before any tool call.
- Durable checkpoints need PostgreSQL. LangGraph has no SQLite saver, so a run on
  the local database cannot pause — `agent_service._checkpointer` returns None
  and says so, rather than letting a checkpoint silently do nothing.
- Models and migrations are two descriptions of one schema, so `test_migrations.py` gates the drift. Add a column → generate a revision.
- The schema is **not** dialect-neutral: `JsonColumn` is JSONB on PostgreSQL and
  JSON everywhere else. `test_postgres.py` compiles the DDL for both dialects
  with no server, and runs the migration, a document round-trip and the
  optimistic-concurrency guard against a real server when `POSTGRES_TEST_URL` is
  set. CI sets it, so every push exercises the engine that actually deploys.
- Performance budgets are data (`perf.ts` `BUDGETS`), transcribed from doc 04
  §31.1. Changing a number there means changing the spec.
- **The drag budget is judged as dropped frames, not milliseconds.** §31.1 says
  "<16ms p95", which cannot be read literally against a frame *interval*: on a
  60Hz display a perfectly smooth drag measures 16.67ms, so the budget would be
  unreachable by any code, and on a 144Hz display it would pass while visibly
  stuttering. `checkFrameBudget` compares against the display cadence the sampler
  observes instead.
- `.gitattributes` forces LF. Both drift gates compare generated files against their committed form, and the generators emit LF; a CRLF checkout fails them on a clean tree.

## Tooling deviations from doc 05

- **npm workspaces**, not pnpm + Turborepo — pnpm is not installed in the dev environment and npm workspaces cover a single-track solo build with no setup step.
- **Zod-first**, though doc 02 §34.4 calls TypeScript normative. Types are `z.infer`red, so there is one definition rather than two hand-synced ones. Recursive types (`GroupElement.children`, `Slide.elements`, `ComponentDefinition.template`) need an explicit interface plus a `z.ZodType<T>` annotation on the schema.

## Gap remediation — 2026-09-06

Current implementation work is tracked in `docs/PHASE_0_TO_9_FIX_PROGRESS.md`.
This does not declare all audited phases complete.

Autosave callers share an active drain promise. An AI document arriving during
unsaved/in-flight edits is refused rather than clearing local work, and AskPanel
reports that refusal. A versioned browser recovery journal holds the local
snapshot, operations and base version before sending. A successful acknowledgement
removes only acknowledged work from recovery. Reload on the same base recovers the
queue; another server version recovers the local snapshot as a conflict, without
replaying on a refreshed version. Browser storage failure is reported. A native
modal compares the historical base, local copy and current server version;
independent edits merge automatically, conflicting fields require explicit
choices, and the reviewed result uses the server version's concurrency check.
A stale review or a second conflict retains the local copy. The modal includes
rendered previews and a local-document download. Each editor owns a separate
localStorage journal. A sessionStorage pointer supports reload, while an exclusive
Web Lock prevents duplicated tabs from sharing that pointer's writable journal.
Closed-tab copies can be explicitly recovered; active copies cannot be taken.
Recovery writes the new journal before removing the exclusively owned old copy.
Legacy shared journals are copied and retained; browsers without Web Locks use
fresh keys and retain sources on explicit recovery. Storage quota failures keep
the original. These fallbacks prioritize retention and can leave duplicate copies.
Small saves use keepalive;
unload journals larger/in-flight batches and does not start competing saves.

Version advancement in `store.commit_transaction` uses a conditional database
UPDATE against the composition base and any supplied expected version. An ORM
identity-map read alone is not a concurrency check. A savepoint keeps a rejected
candidate out of version/history tables even if a caller handles the conflict.
SQLite's legacy transaction mode needs a physical outer BEGIN before that
savepoint so releasing it cannot bypass request rollback. The PostgreSQL conflict
and SQLite rollback regressions pass with the existing persistence tests (26
tests). Broader verification status is tracked in the remediation report.

Asset recount now loads every retained version, using store replay for
operation-only versions. An image added and removed between snapshots remains
protected while that historical version is accessible. Actual storage deletion
and its retry/accounting workflow remain open; reference counting alone does not
prove reclaimed bytes.

Generation diagnostics derive graph schema-attempt counts and first-attempt
validity from observations in `RunBudget.structured_requests`. Each entry describes
one structured request; critic revisions are separate requests. `attempts` in the
HTTP response is the maximum schema attempts for any request, excluding provider
transport retries. The overall validity flag includes repaired structured output;
the plan flag covers story requests. Single-shot repairs clear both flags.
Observations retain stage/contract/count/outcome, never prompts or model text.
Budget input/output totals include charged invalid responses and are reported
separately. Stub token counts are simulated and must be excluded from real-model
validity/cost studies. Cross-resume cumulative measurement and provider-internal
retry measurement are still open; these fields do not establish either.

Canvas resize previews and commits share
`packages/editor-ui/src/lib/resize-operations.ts`.
Free groups default to `scaleChildren`; container groups default to
`resizeContainer`, with an explicit inspector override. Scaling an ancestor
recursively scales descendant boxes and text (minimum axis factor), including
font limits and letter spacing. A nested group's own resize preference applies
when directly resized, not when its ancestor scales the entire subtree. The
active-slide scene is rebuilt for resize previews so geometry/text match the
eventual patch; ordinary moves retain their fast scene overlay. Group resizing is
covered by interaction/undo tests; full browser performance and remaining group
semantics are still open in the remediation ledger.

Equal-gap snapping is now wired through `snapRectWithSpacing` in the editor
package. It chooses one target per axis alongside alignment/grid, uses a constant
screen threshold, rejects negative gaps, and draws final-position arrow/number
indicators in canvas chrome. The canvas ranks its spatial candidates by rectangle
distance and caps them at 40. Ctrl/Cmd disables snapping; Shift prevents either
alignment or spacing from moving the constrained axis. Local model/component
tests establish this wiring; full browser performance and additional distribution
and transformed-parent cases remain in the remediation ledger.

React scene builders use `useBrowserMeasurer`, not a one-time singleton lookup.
Font readiness/loadingdone/loadingerror changes its wrapper identity to invalidate
scene useMemo dependencies while retaining one underlying measurement host/cache.
All current editor/preview/share/presenter consumers use the hook. Subscription
cleanup ignores late readiness callbacks after the last consumer unmounts.
`DomMeasurer` clears cache on successful or failed font loading and removes its
own listeners on disposal. An unavailable initialization attempt can be retried.
This implements scene invalidation, not a complete font manifest/loading barrier;
live delayed-font and hydration acceptance remain open in the progress report.

Blank authoring uses `POST /v1/presentations`, not the generation endpoint. It
requires project/workspace editor access, creates one empty slide in the canonical
document shell and saves a user-attributed initial version without an agent run.
The home and generation-failure actions open the persisted editor route; a failed
request retains the brief and exposes retry. Blank documents omit fabricated
generation provenance. HTTP/component tests cover creation, persistence, editing,
role boundaries and retry; the full live authoring/onboarding journey remains open.

Generated and blank deck creation share `resolve_creation_project`. Both require
editor access before any run/model/quota work. Explicit projects can belong to
any authorized workspace; omitted projects follow stable default workspace
selection and cannot skip a viewer-only membership to gain authority. Generation
quota/repository/telemetry scope comes from the authorized project's workspace,
not an unrelated first membership. Regression tests cover both graph/single-shot
viewer rejection and correctly scoped second-workspace generation/accounting.

`ThemePanel` uses presentation-scoped theme list/save/proposal endpoints, so a
deck in a second workspace never silently uses the first workspace's theme list.
Fetching a theme proposal is read-only; its portable definition and themeId patch
are applied to the current local document through `editor.apply`, preserving
pending edits, undo and normal autosave. Archived/foreign themes are refused.
Saving the current theme explicitly replaces a matching workspace name, as stated
beside the control. Live rendering/export acceptance remains open.

Default adoption is now implemented for blank and synchronous generated creation:
resolve the authorized workspace's default, freeze its definition once, and pass
the snapshot into the canonical composer for graph candidates or single-shot
composition. Store the resolved definition plus themeId so later workspace-theme
changes cannot silently alter existing decks. The editor can mark its current
theme as default when saving. Concurrent default selection and durable resumed-run
retention are still open; current tests cover new synchronous/blank creation.

Theme saves serialize same-workspace writers with a no-op workspace UPDATE held
through the caller's transaction. Default flags change in one database UPDATE
with session synchronization, avoiding stale assignments that could leave two
defaults. SQLite stale-session and parallel-writer regressions pass; PostgreSQL
counterparts await a test database. This is a service-level invariant, not a new
database constraint or historical-data repair.

Canvas pointer cancellation/capture loss discards the in-flight preview and
queued frame rather than committing it. It leaves prior document/history edits
intact and resets snap exclusions/guides/sampling before another gesture. Normal
pointer-up still flushes the final queued movement and commits one transaction.


### Motion timing controls

MotionPanel edits source startMs and optional clip delayMs through ID-addressed
transactions with ordinary undo. Compiled absolute start times must not be used
as source offsets because they include preceding tracks and trigger timing.
Invalid/negative numeric input does not mutate the document. Reorder/keyframe
authoring and full browser motion acceptance remain open.


MotionPanel also moves the selected clip's whole source track earlier/later using
one move transaction. Clips, future fields and relative trigger semantics survive;
the compiler resolves the new order. This does not implement timeline dragging,
keyframes or all doc 04 section 25.2 operations.


Clip duplication preserves source timing/content and assigns a new clip ID;
normal overlap diagnostics apply. Stagger child bars address the source clip for
all edits, because compiled child IDs are not document IDs. Duplication selects
the corresponding generated child of the new source clip. Both paths are covered
by component/transaction tests; keyframe editing and remaining timeline tools are
still outstanding.


Animation compilation reads motion.* from resolved scene theme tokens, including
inherited settings. Raw theme.motion is not present on ResolvedTheme. Full-motion
fixture assertions explicitly select full motion; document fallback preferences
otherwise take effect. The duration inspector edits the source duration, not the
shortened compiled duration under reduced motion.
