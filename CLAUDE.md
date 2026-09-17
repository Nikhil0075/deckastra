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
document as it stands.

**Re-validating the patch was necessary and not sufficient** (found by the D2
closure audit, 2026-09-12). A patch can still apply cleanly to a deck that moved
after the preview a human said yes to, and applying it then applies a change to
something the approver never saw — the one thing this lifecycle exists to
prevent. So `approve` compares the head with the version the approval is *for*:
the proposal's own base, or `expected_version_id` when the approver names the
version they were shown. A blanket refusal would have been wrong in the other
direction, stranding every pending proposal behind an unrelated edit elsewhere in
the deck, so the way through is to look again and say what you looked at.
`ProposalsPanel` and `AskPanel` send what they had on screen.

**The check belongs where the base is loaded.** A route that compared the
caller's `expected_version_id` against the head and then called `create_proposal`
was checking a different read: that function loads the document again, and
anything committed in between became the silent base of the agent's change. The
version now travels into `create_proposal` and is compared there, before any
transaction or version row exists. The product's own edit agent is not exempt —
it passes the version it composed against.

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

# D2.3: the consent flow, driven through the button a person presses. Off by
# default, allowed produces a working credential, stopped kills one already
# issued. Delete userData/agent-access.json first to start where a user does.
DECKASTRA_SMOKE_DIR=<dir> DECKASTRA_SMOKE_STEP=consent npx electron .
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

**Packaged export verified against current source, with no Playwright anywhere
the app can reach** (2026-09-17). The earlier runtime check found a packaged
export failing once the browser lookup path was emptied, and was right to add
that its binary predated the source — that package was built before D4, and the
*sidecar* is the process that runs export jobs.

Rebuilt from current source (261MB installer, 105MB sidecar), installed silently,
and run from the installed location with an empty `PLAYWRIGHT_BROWSERS_PATH` and a
working directory outside the checkout. The packaged sidecar migrated through
every revision to `d94c1ba7f082`, which is itself the evidence that the binary is
current. Result: **`exportFinished`, no console errors, no CSP violations**, and
the artifact read back through the export row's `artifact_path` by `pypdf` — 4
pages at 1440×810pt with extractable text, 34,365 bytes matching the row's
`bytes`, stored inside the data directory rather than `%TEMP%`.

**The control matters more than the run**, because this machine *does* have a
Playwright cache at the default location, so an empty lookup path only proves
something if Playwright could otherwise have been used. It could not: the
installed app answers `ERR_MODULE_NOT_FOUND` for `import("playwright")` from its
own directory, because an install has no `node_modules` and the build refuses a
bundle that statically imports an external package. A packaged export therefore
cannot render through Playwright at all — the app's own Chromium via the render
host is the only path there is, which is what makes the empty-cache result
decisive rather than circumstantial.

Two things that run turned up. `msToWindow` was **30,174ms** — a first launch on a
fresh profile that runs fourteen migrations against a cold file cache, so it is
not comparable to D1's 3,802ms and is one observation rather than a regression.
And the harness's `exportSurface` diagnostic captured the **Share** panel, because
its new copy says "You can export a copy to share" and the capture matched a loose
`/EXPORT/i` over `textContent`. The assertion beside it was correctly scoped and
unaffected; the diagnostic is now scoped the same way, because a record that shows
the wrong panel is how a passing run comes to be believed about something it never
looked at.

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
- **Local undo is cleared on adoption**, and replaced by one that works. Its
  inverses were computed against the document before the outside change, and some
  are index-addressed; replaying one against a document that has moved is how a
  patch lands on the wrong element. Clearing it alone left the user with a deck
  that moved under them and nothing to press, so `/head` also names the
  transaction that produced the version, and `undoExternalChange` reverts *that*
  through the server — where its inverse was computed, against a pre-state this
  editor never had, and where `disturbs()` refuses if a later edit would be
  disturbed. It drains the autosave queue first, like everything that lets the
  server replace the document.

**The attachment file is the one deliberate way in** (`main/attachment.ts`). D1's
posture is that the service is unreachable: a random loopback port, a per-launch
secret, and a renderer that learns neither because the main process proxies for
it. D2 does not relax that; it adds one door and writes down the cost. The file
lives in `userData` — inside the user's own profile, `0o600` where that means
anything, and on Windows an explicit ACL, because the mode is ignored there and
an inherited permission is not a decision anyone made.

**What it publishes is a grant, not the launch secret** (D2 closure audit,
2026-09-12). It used to be the secret, which meant "an agent cannot approve its
own proposal" and "an agent cannot mint a share link" were true only because the
MCP adapter registered no such tools — an omission in one file, not a boundary,
and anything else that read the attachment held the app's whole authority. A
grant is signed with the launch secret, carries `read`, `write` and `export`, and
expires; `grants.py` maps method and path to the capability required and refuses
the rest with 403. One table rather than a check per route, so a route added
tomorrow inherits `write` from its method and forgetting fails closed. It is a
second gate, never a replacement: membership and role still decide what the
*person* may do. A grant is still tied to the launch secret, so a copy recovered
from a backup authorises nothing.

The attachment is withdrawn when the service
stops. A crash withdraws nothing, so the reader verifies rather than trusting:
the pid must be alive, the version must match, and `/health` must answer *with
that secret*. Only the last one distinguishes our service from whatever else was
given that port.

**Nothing is published until the user allows it** (`main/agent-access.ts`, D2.3).
The grant is narrow, and narrow is not the same as asked for: an app that
published a credential the moment it started would have decided on the user's
behalf that anything able to read one file may edit their decks. The window
carries the switch, it is **off on a fresh install and after an update**, and the
permission **lapses after twelve hours** — a permission that never expires is one
nobody revisits.

Stopping means stopping: the app withdraws the attachment *and* calls
`POST /v1/local/agent-access/revoke`, which refuses every grant issued up to that
moment. Withdrawing the file alone would stop only the next reader, while whoever
already held a twelve-hour grant kept working. That route needs `administer`,
which no grant carries — an agent that could revoke grants could revoke someone
else's.

**The grant format is written twice, and it drifted.** `mint_grant` is Python and
`mintGrant` is TypeScript, because the desktop signs the credential it publishes
and the service verifies it. Adding revocation added an `iat` claim, and only one
side learned it: the desktop kept minting grants without one, `scopes_for`
defaulted the missing claim to `0`, and `0 <= _revoked_before` is true of the
initial `0.0` — so **every credential the app published was refused by every
request**, while the app went on publishing and the window went on saying agents
could work. Nothing failed loudly; an agent was simply told it was
unauthenticated. The claim is now required rather than defaulted, both sides have
a test naming it, and the `consent` acceptance step below is what actually runs
the two implementations against each other. Treat these two functions the way the
patch appliers are treated: a change to one is a change to both.

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

**Verified from a freshly built installer, 2026-09-12** (260MB, built from
current source, installed silently in 32s). Export from the app's own window:
finished in 8s, no CSP violations, artifact stored in
`workspace\deckastra-exports` and read back by `pypdf` as 3 pages at 1440×810pt
with the byte count the export row records. Then the **installed app's own MCP
server** — `resources/mcp/cli.mjs`, run by `Deckastra.exe` under
`ELECTRON_RUN_AS_NODE`, with nothing from this repository in the server path —
drove the acceptance journey 13/13: create, propose, a refused stale change,
motion in roles, a rendered preview, a pending proposal attributed to
`mcp:acceptance`, a *running* export cancelled to a terminal cancelled state, and
an export that completes.

**An installed app ships the server** (`dist/mcp`, `extraResources`). It ran only
from a checkout through `tsx` and this repository's `node_modules`, so anyone who
installed Deckastra without cloning it had no agent access at all. It is bundled
beside the exporter and run the same way — the app's own binary under
`ELECTRON_RUN_AS_NODE`, which is also the only mode where stdin works. The build
refuses a bundle that statically imports an external package, for the exporter
and the server alike, because that is what an installed process cannot resolve.

**The acceptance journey is 16 steps now** (2026-09-16), the two new ones being
an agent pairing elements across slides from roles alone, and being refused when
it asked a push to carry them.

**D2 measured, Windows 11 x64, development build (2026-09-10).** The claims are
about software someone is using, so `scripts/acceptance.mjs` drives the real
stdio transport against a running app rather than a mock — 13/13: attach, name
the open deck, read an outline, apply a low-risk change and see it in the store,
be refused for a stale one *without losing the earlier change*, watch a
destructive change become a pending proposal attributed to `mcp:acceptance`, and
export a 25KB PDF.

**An agent can see its own work** (`slide_preview`, `POST /presentations/{id}/preview`).
Two real sessions ended with the agent asking the user whether the result looked
right, because it could describe its change and not look at it — which is the
review a preview exists to support. The route renders one slide through the same
worker and browser an export uses; a preview produced any other way would be a
picture of a deck this product would not export. With a `proposal_id` it replays
that pending proposal's operations onto a *copy* and renders that, so a change can
be seen before it is approved — and a proposal that no longer applies is the same
409 approval gives, because a picture of a patch that cannot apply is worse than
no picture: someone would approve it.

One slide per call, because rendering starts a browser. The scale comes from the
deck's own viewport (`PREVIEW_WIDTH / viewport.width`), so a deck authored at any
size arrives at doc 04 §41.4's 1024×576 rather than its own dimensions. The
reported size is read from the PNG's IHDR chunk, not computed from the scale the
caller asked for — the worker reports the slide's *logical* size, and answering
1920×1080 about a 1024-wide image is telling the caller something false.

**A real Codex session, 2026-09-12**, reported working by the user against the
same server and the same running app.

What that pair of sessions is evidence *for* is narrower than "the journey":
between them they listed a workspace, read a deck, authored and approved a
restyle, and confirmed the tools answer. Nobody has yet recorded one client
driving create → revise → animate → preview → approve → undo → export end to end,
including a stale refusal and a cancellation. The acceptance script now does most
of it — on a deck it creates, so nobody's real work is touched — but the two steps
it deliberately cannot take are the two that belong to the human: approving a
pending change, and undoing an applied one. That is the remaining interoperability
evidence, and only a person sitting in front of the app can produce it.

**An agent plans the move *between* slides too** (`transition_propose`,
`POST /presentations/{id}/transition`, `motion.plan_transition`). The same split
as the entrance planner, applied to the boundary: a caller names a kind, one word
of pacing and the semantic **roles** that carry across, and the app resolves
those roles against both slides and computes the duration. No milliseconds, no
element ids — an agent plans before a composer has minted any, and a pairing
written in roles survives a re-layout. A test asserts the tool's schema carries
neither.

Shared elements are the one place a guess is written down. Doc 02 §26 says two
unrelated objects are never silently morphed, which the transition engine
enforces by refusing to pair on its own; a mapping proposed here lands in the
document as an explicit mapping, visible in the editor and breakable by the
author — which is the difference between a suggestion and a silent decision.
Three refusals are stated rather than swallowed: only a morph carries objects (a
push naming roles is told so), a role missing on either slide is named, and a
role appearing twice pairs the first and says it guessed.

**An agent plans motion in roles** (`motion_capabilities`, `motion_propose`,
`GET /motion/capabilities`, `POST /presentations/{id}/motion`). The tool surface
has no field for a duration, a delay or an easing curve, and that absence is the
feature: doc 04 §24.2's 2.5s entrance budget is enforceable exactly because
`motion.py` computes the numbers from a pacing word. A plan that could name
milliseconds could over-run it, and a model asked to respect a budget eventually
will not. A test asserts the tool's schema has no such field.

The route runs `animate_slide` — the composer's own function — on a *copy* of the
slide and turns the result into one patch operation, so an agent's motion is the
product's motion: the same presets, the same restraint rules, the same
`_fit_to_budget` compression, and the same warnings when long body text is left
in place. Whatever it left alone is returned rather than dropped. The change then
becomes an ordinary proposal, with risk computed from the operations and an
inverse recorded.

Two refusals worth naming: a plan whose roles match nothing on the slide commits
**no version at all** — an empty change would put a row in the history that every
later diff has to be read past — and a plan authored against a version that has
moved is the same 409 every other agent write gives.

Nothing in D2's tool list is unbuilt, and the four things this paragraph used to
list as open are closed: cancelling stops a running render, an adopted outside
change has an Undo that reverts through the server, the installed app ships the
server beside the exporter, and D2.3 is a scoped grant the authority enforces
plus a consent switch in the window — each written up in its own section above.

What remains is evidence rather than code, and one gap of each kind:

- **The undo of an agent's change has never been pressed by a person.** It has
  unit coverage (`external-change.test.ts`) and a wired control
  (`EditorShell.tsx:576`), which is not the same as someone watching an agent
  edit their deck and stepping back out of it.
- **No single client has driven the whole journey.** See the paragraph above.
- **macOS**, unchanged from D1: not measured, and not measurable from here.

**D2.3 measured, 2026-09-12**, development build, by the `consent` step driving
the window's own button: no attachment file before anyone allowed one; after
"Allow agent access" the published grant read `/v1/account` (200) while an
approval it does not carry was refused by the service (403, `required_scope:
approve`); after "Stop agent access" the file was withdrawn *and* the grant
already handed out answered 401. Then, with access allowed, the full MCP
acceptance journey against the running app: **13/13** — attach, list, author,
be refused for a stale read, plan motion in roles, render a preview, leave a
destructive change pending as `mcp:acceptance`, cancel a running export, and
finish one (10,133 bytes).

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

### Local intelligence is chosen, never fallen back to

D3. `ModelClient` is one method, so a third provider is plumbing
(`local_model.py`, a llama.cpp server on loopback). Everything around it is not.

**A fallback chain is a decision made silently**, so there isn't one
(`router.default_client`). Three branches: local is honoured or refused, cloud is
honoured or refused, and only the *unset* case — the web app, CI, every existing
test — keeps the old "a key if there is one, the stub if not". Someone who
selected local did it because nothing of theirs should leave the machine, or
because there is no network; answering from Anthropic when the pack is missing
would be a privacy decision taken on their behalf, in the one direction that
cannot be taken back once the request has been sent. The local branch therefore
returns without any expression in it that could reach a key, and a test sets a
real-looking key alongside it to prove the refusal holds.

**`api_key_available()` was the wrong question in four places**, and stayed right
only while a keyless install meant a stub install. It decided which client the
graph built (so a local install would have run the *stub* and never reached the
selection at all), what generation provenance recorded as `source` (so a deck a
local model wrote would carry "stub" in the document, where it outlives the run),
and what `/health` reported. They all ask `selected_provider()` now, which
answers `local` / `cloud` / `stub` without building anything. `/health` also
reports it by name, because "no cloud traffic in local mode" is a claim someone
has to be able to check from outside the process.

**The single-shot planner refuses rather than stubbing.** `story.py` talks to the
SDK directly and cannot serve a local model, and left alone it would have fallen
through to "no key, so use the stub" — a stub deck on the one path where the user
asked for nothing to leave the machine. A missing provider is **503** at the
route, not 502 and not "the agent run failed": nothing failed and nothing is
upstream, something is not installed, and the message names it.

**A pack is a directory with a manifest beside its weights** (`model_packs.py`),
installed by copying it in and removed by deleting it. No registry, because a
half-finished download would leave one wrong — and that download is the failure
users actually hit, so a manifest whose weights are missing is reported with its
reason rather than silently not listed. The manifest must name a license:
redistribution is a D6 gate, and "nobody wrote it down" is otherwise discovered
at release. Two installed packs and no `DECKASTRA_MODEL_PACK` is a refusal, not a
choice — which model wrote a deck is not a fact to leave unrecorded, and the
benchmark has to say which one it measured.

**A server process, not in-process bindings.** `llama-cpp-python` would put a
compiled runtime, and a GPU variant of it, inside the PyInstaller sidecar D1
fought down to 103MB — carried by every user whether or not they ever install a
model. A child process keeps "not installed" a coherent state rather than an
import error, keeps offload flags a property of the server, and is the pattern
the desktop already has. The OpenAI-compatible endpoint is used because that is
where llama.cpp exposes schema-constrained sampling and a `usage` object, not
because compatibility is a goal.

**The schema is a hint; our validation is the authority.** llama.cpp converts
JSON Schema to a GBNF grammar and its converter covers a subset, so a constraint
can be dropped and the output still parses — which is worse than a refusal.
`ask_model` validates against the Pydantic contract and repairs, unchanged. A
contract the runtime cannot express at all comes back as a 400 and gets its own
message, because a generic error sends someone to look at the model.

**Tokens are reported, never estimated.** A run that looks cheap because nobody
counted it is worse than one that says its total is short. Note the ceiling means
something different here: for a cloud model the token budget is money, and for a
local one the honest bound is the wall clock — so a request's timeout is the
run's own remaining time, and a wedged model cannot hold a user past the ceiling
that exists to stop exactly that.

**The runtime is supervised from the API, not the desktop**
(`deckastra_api/model_server.py`), and started **on demand**. The desktop
supervises the workspace service because a window is useless without it; nothing
is useless without a model until someone generates, and holding gigabytes for the
other 95% of a session is a cost the user did not agree to. The same argument
from the other end unloads it after ten idle minutes. A crash is *not* retried
with backoff, unlike the workspace service: a model that died is usually a model
this machine cannot hold, each attempt costs tens of seconds and several
gigabytes, and the refusal in between carries what the runtime actually printed —
"could not allocate 4096 MiB" is the whole diagnosis, and it is the difference
between "try a smaller pack" and "file a bug". "Ready means answering" applies
again and harder: a model server binds its port and *then* spends tens of seconds
reading weights, so readiness is a poll of `/v1/models` rather than a bind.

`build_client()` is the single entry point the three generation call sites use,
because three sites each remembering to start a server is two that will not.

**The idle fix was half a fix, and a review found the other half** (2026-09-16).
`_KeptAlive` touched the supervisor on the way *in*, so the window still ran down
*during* a call — and one story plan is minutes against a ten-minute window.
Repeated short calls kept it alive and the regression test drove exactly those,
so it passed on a runtime that was never left alone mid-request. The supervisor
now counts requests in flight (`_active`), the reaper waits rather than stopping
while any are, and the window is measured from when the last one **finished**,
released in a `finally` so a refusal or a cancellation frees the runtime as
surely as an answer. The second half: `ensure_ready()` returns the URL for a
reason — a restart takes a fresh port, and the wrapper discarded it, so a client
that outlived one idle shutdown addressed a port nothing was listening on and the
next generation failed with "the local model server is not answering" on a
machine where it was. `LlamaServerClient.retarget()` is how the supervisor says
where it moved to.

`scripts/install-model-pack.py` installs a pack, downloading it or taking
`--from-file` when the bytes arrived another way, and verifying either against
the size and sha256 HuggingFace publishes. It reads those off the **302 without
following it**: for an LFS object they are on the redirect, and the CDN it points
at is a different host — one that a filtered network can block while
`huggingface.co` still resolves, which is exactly the state this was written in.
Following the redirect lost facts already in hand, and a 12-byte file installed
as a 2.3GB model. Two more traps there: `content-length` on a 302 describes the
redirect (236 bytes of "you want it over there"), and a file stored in git rather
than LFS reports a git blob SHA-1 where an LFS file reports a sha256.

**D3 measured, 2026-09-12**, Windows 11, GTX 1650 (4GB) + Intel UHD 630, 12GB
RAM, `Qwen3-4B-Q4_K_M` (Apache-2.0) on llama.cpp b10927 Vulkan, served
`-c 4096 --parallel 1`. Six runs of the real `story()` node, two briefs:

| | |
| --- | --- |
| Runs completed | 6 of 6 |
| Valid on the first attempt | 5 of 6; the sixth repaired and was then valid |
| Slide count honoured | 6 of 6 |
| Invented citations | none, in any run |
| Throughput | 7.9–10.4 tok/s |
| One story plan | 136–576s, median 248s |
| Model load | 8.0s |
| Peak RSS | 4,432MB |

**The contract question is answered, and that was the risky one.** A `StoryPlan`
is nested, has a closed layout enum and carries citation ids, and a 4B holds it —
never once fabricating a source id, which matters because the product renders
those as provenance. What it costs is minutes: ~4 for a story plan here. The
full-graph measurement below replaces the extrapolation that used to sit in this
sentence. That is the honest shape of local intelligence on entry-level hardware,
and it is why local is **chosen, never defaulted to**.

One number bounds the configuration: the six-slide brief produced **4,687 output
tokens against a 4,096-token context**. It still came back valid, but that is
where a larger deck starts to fail, and it is the figure to size context from
rather than a guess.

**The bug that cost five benchmark runs was in this code, not the hardware.** The
idle reaper unloaded the model *during* generation, because `_last_used` was
refreshed by `ensure_ready()` and nothing else — and the client learns the URL
once, then talks to the port directly, so the supervisor never heard about the
work going through it. "Idle" meant *time since the runtime started*. Every crash
landed within a second of the 600s window — 600.8, 600.9, 600.8, 600.5, 600.9 —
while VRAM pressure, context size and a second GPU's TDR were each investigated
and written up as the cause. A hardware fault does not keep time to a tenth of a
second; adding up the per-run times found in a minute what four configurations
could not. `_KeptAlive` makes use the thing that keeps a model loaded, and the
benchmark now goes through `build_client()` like every other caller — reaching
past the product's own entry point is how a harness comes to measure a path
nobody takes.

**The full-graph benchmark found a bug in our own contract, not in the model**
(`scripts/benchmark-full-generation.py`, 2026-09-17). `benchmark-model-pack.py`
calls `story()` directly, so it never runs the **orchestrator** — the first
decision the model is actually asked to make. Running the whole graph on three
held-out briefs produced **no deck at all**: every run stopped at orchestrate,
asking the user a question.

The question was the word "false".

`OrchestratorPlan.clarification_needed` was a *string* whose "no" answer was the
empty string, and the node halted on its truthiness. A model asked "is a
clarification needed?" answers in the field it is given: two briefs came back
with the literal string `"false"` and one with `"No - the request is clear about
the scope..."`, and every one of those is truthy. Nothing failed, no contract was
violated, the structured output was valid on the first attempt every time — and
the product asked three nonsense questions and generated nothing. A cloud model
that ever answered "none" would have done the same.

It is now a `bool` plus a separate `clarification` string: a boolean cannot be
answered in prose, and Pydantic coerces exactly the strings a model emits for one
("false", "no", "0") to `False`. A halt needs **both** the flag and a non-empty
question — a checkpoint with a blank question is a dead end, with nothing for the
user to answer and nothing for the run to resume on, so that case proceeds and
warns instead. This is the same shape as the `iat` defaulting to `0`: a sentinel
that a reasonable answer collides with, failing silently and looking like
nothing.

**The whole graph measured, 2026-09-17**, same machine, `Qwen3-4B-Q4_K_M` on
llama.cpp Vulkan, served `-c 8192 --parallel 1 -ngl 99` — all layers offloaded,
which the 2026-09-12 run did not do. Three held-out briefs (warehouse operations,
a hospital funding case, a support-team policy), one run each, through
`scripts/benchmark-full-generation.py`:

| | |
| --- | --- |
| Produced a valid deck | 3 of 3 |
| Slide count honoured | 3 of 3 — 6/6, 7/7, 5/5 |
| Structured requests valid first time | 27 of 28 (one repair, at two attempts) |
| End to end | 122s, 123s, **1,136s** |
| Throughput | 25–33 tok/s |
| Peak RSS | 5,814MB |
| Output tokens | 3,541 / 3,690 / 32,073 |

**The spread is the finding, and it is not the model being erratic.** It is which
stages the orchestrator routed. Two briefs went orchestrate → story → layout →
propose and finished in **two minutes**; the third ran creative, motion and the
critic as well and took **nineteen**. Of that run's 1,136 seconds, roughly **946
were the critic and the revisions it sent back** — 83% of the run, and 21
structured requests against 3 and 4 for the short route.

That reverses the assumption the single-node measurement encouraged. The story
contract is the largest and it is *not* where local generation spends its time;
the critic is, because it scores eight dimensions and can send the graph round
again. The "15–20 minutes for a full deck" figure extrapolated from one node was
about right for the long route and wrong by a factor of ten for the short one.

Peak RSS of 5,814MB is worth stating beside the pack manifest's `min_ram_mb:
6000`: on a 4GB card the run is well into system memory, and the earlier
4,432MB figure was a story-only run that never reached the critic.

**Grounding is not measured by that harness**, and the flag that appeared to has
been removed rather than left to mislead. Injecting context blocks into
`state["research"]` does nothing — the research node replaces that key wholesale,
and it is repository-specific, profiling connected repositories and writing
questions a code search can answer. These briefs are about warehouses and
hospitals, so the blocks were silently discarded and the first run reported
`cited: []`, which read like a model ignoring its sources when it had none.
Citation behaviour is `benchmark-model-pack.py`'s measurement, because that one
calls `story()` directly and keeps what it injects. Measuring it through the whole
graph needs a repository-grounded brief against a real index.

**Not done, and not claimed:** there is no download or settings surface, the
runtime is configured (`DECKASTRA_MODEL_SERVER_CMD`) rather than shipped, the
**8B is unmeasured** (it cannot fit a 4GB card, so the number would describe
partial offload rather than the model), and nothing has driven the *whole graph*
locally — only the story stage, which is the largest contract but not the only
one.

### Sync would replay a log, and version ids would not survive it (D5.0)

The spike the rest of D5 waits on (`apps/api/tests/test_sync_replay.py`): can a
device's transaction log be replayed onto another store and produce the same
document? If yes, syncing a deck is an outbox plus a divergence policy. If no, it
has to be document-level — upload a snapshot and merge — which is a different
product with a conflict surface an order of magnitude larger.

**The content answer is yes.** A log authored on one store, replayed in order
onto a second store seeded from the same starting document, produces an identical
deck — compared as the whole document and in canonical key order, not only its
slides, since theme, viewport, metadata and extensions are most of what a
`.mydeck` file is and all of them replay through the same operations (tightened
after review, 2026-09-16). That includes operations addressing elements *earlier
operations in the same log created*, an array `move`, a `remove` whose inverse is index-addressed, an
animation track, and a morph pairing two slides. That works because there is one
API and one applier: the desktop and the cloud run the same `apps/api`, and
`test_patch_conformance.py` already holds the two languages' appliers to one
answer.

**Presentation identity travels for free.** `create_presentation` takes the id
from `document["id"]`, so the same starting document seeds the same presentation
id on both sides and every path in the log resolves.

**Version identity does not, and that is the finding.** `commit_transaction`
mints `new_id("ver")` itself and takes no id from the caller, so a replayed change
is the same content under a different identity. An upload keyed on the version id
would therefore re-apply the whole log on every retry. D5.2's idempotency needs
either a client-supplied change key recorded with the transaction, or an optional
`version_id` on the commit path so the two chains are literally one chain — and a
test names that so the decision is made rather than discovered.

**The log is a sequence, not a set.** Replaying it in another order either fails
outright or produces a different deck, which is also what makes the equality
check above mean something: if any order gave the same answer, it would be
passing on a property nothing has.

### Signing in adds a workspace; it conscripts nothing (D5.1)

A desktop install has a singleton account and a workspace full of decks that have
never left the machine. The tempting next step, and the one most sync products
take by default, is to upload what is already there the moment someone signs in.
That is a privacy decision taken on the user's behalf in the one direction that
cannot be taken back — the same shape as D3's refusal to fall back to a cloud
model, and it gets the same answer. **Local decks stay local until someone
explicitly moves one.**

`workspaces.origin` (`local` | `cloud`) is the column the rest of D5 branches on.
A `local` workspace is one this machine owns outright; a `cloud` one is a mirror
of a workspace the server owns, kept here so the app works offline. They cannot
be authorized the same way — **a mirrored workspace's roles are a cache, and a
cache is not authorization** — and without a row saying which is which, a desktop
that had signed in could not tell its own decks from someone else's, so local
mode's posture would silently extend over both. It is reported by `/v1/account`,
carried on `AccountWorkspace`, and surfaced through `workspace_list`, because a
picker that renders both kinds identically hides the only part of the choice that
is irreversible.

Local mode is *not* "one account owns everything on this machine". It resolves
through the same membership chain as every other caller, so a workspace with no
membership row for the singleton account answers 404 — the same refusal a
stranger gets. That is the assumption D5.4 needs and the one most likely to go
quietly wrong, so `test_local_mode.py` names it.

**`POST /v1/presentations/{id}/move` is the whole of the other path**: one deck,
to a project the person picked. Three refusals, each because the alternative is a
deck that looks moved and is broken:

- **Editor on both sides.** On the destination because a move is a write there;
  on the source because it is a removal from everyone else who could see it. Read
  access to a deck is not permission to take it somewhere the people who shared
  it with you cannot follow.
- **No pending proposals.** A pending change is a question put to the people in
  *this* workspace, about a preview they were shown. Moving the deck hands that
  decision to a different set of people, which is precisely what the proposal
  lifecycle exists to prevent.
- **No assets.** `Asset.workspace_id` scopes an upload to the workspace holding
  it, so a deck citing images would arrive with every picture unreadable by the
  people it arrived for. Carrying them is a per-file copy-or-move decision —
  an asset can be cited by other decks in the source workspace — and that belongs
  to D5.5. Refusing by name is honest; moving the rows and hoping is not.

What survives a move is everything that makes it the same deck: the presentation
id, the version chain, the transaction history and any share links, all of which
key on the presentation rather than on the project it sits in. A "move" that
minted a new id would be a copy with the original deleted.

**No agent can move a deck**, and a test asserts the absence. A deck reaching a
shared workspace is the moment it stops being private to this machine — the same
class of decision as minting a share link, and the same answer. There is also no
bulk move and no "sync my decks": the negative control in
`test_deck_location.py` drives an ordinary session — read the account, open the
deck, poll its head — and asserts the second workspace is still empty, so every
"nothing moved" assertion is not passing on a product that never moves anything.

**Not done, and not claimed:** there is no sign-in surface on the desktop and no
mirroring yet, so nothing writes `origin = "cloud"` outside a test. Building a
move dialog now would be UI for a state no user can reach; it lands with D5.2,
which is also where the version-id decision D5.0 wrote down has to be made.

### A change has a name, and the outbox owes it to somebody (D5.2)

D5.0 left exactly one decision and this is it: **idempotency keys on a change
key, not on a version id.** The alternative — letting a caller supply the
`version_id` so the two chains become one — reads well until divergence, which is
the case sync exists for. Two devices edit offline, one uploads first, and the
second's change is applied behind it and lands at a *different version* than it
did locally. A key naming the version is wrong the moment that happens, and the
retry applies the change twice. A key naming the change survives being rebased,
because it is the same change wherever it ends up.

`transactions.change_key` is the receiving half, unique per presentation — a key
only has to be unique where it is applied, and that is what lets two devices mint
keys with no coordinator between them. `sync_outbox` is the sending half. Three
rules, each structural rather than remembered:

- **The outbox row is written in the same database transaction as the change it
  describes.** `store.commit_transaction` writes the version, the transaction and
  the outbox row inside one savepoint, so there is no path that produces a
  syncable change without its row. A device that enqueued afterwards loses the
  enqueue to any crash in between — silently, because the deck looks right
  locally and simply never reaches anyone. A test commits and then throws, and
  neither row survives.
- **A deck's changes upload in order, and a stuck deck blocks only itself.** A
  log is a sequence, not a set (D5.0), so a failure stops that deck's queue where
  it stands — the change behind it may address an element it created. A row
  waiting out its backoff holds its place rather than letting the next one
  overtake; "send everything whose `next_attempt_at` has passed" reorders the log
  the moment one row is delayed.
- **Nothing is ever abandoned.** There is no `failed` state, only `pending` and
  `sent`. A change that cannot upload is something a person has to be shown
  (D5.3), and a queue that quietly gave up would lose what it exists to protect.
  `last_error` keeps the whole message, because a desktop install has no logs to
  go and read.

**Only `cloud`-origin decks are enqueued** (D5.1). A local workspace's decks have
nowhere to go, and an outbox that can never drain makes "3 changes waiting" a
permanent fixture of the UI. That also falls out correctly on a server: from the
server's own side its workspaces are `local`, so a received change enqueues
nothing — the authority owes no one.

Two kinds, because a deck reaches a server in two shapes: `create` carries the
deck as its **first version** holds it (every change since is queued behind it, so
a current snapshot would apply them all twice), and `change` carries one applied
transaction. Rows are kept after sending rather than deleted — "what did this
device send, and when" is the question asked when two sides disagree — and
pruning them is not implemented.

**The retry is recognised before the version check, not after**, and that ordering
is what makes the whole mechanism work. Applying a change is what moves the head,
so every retry of a change that landed necessarily carries a stale
`expected_version_id`. A version check running first would answer 409 to every
retry and the device could never clear its outbox — it would retry a change that
had already succeeded, forever. The idempotent answer is not a revert: a later
edit by someone else still stands, and the response says `duplicate: true` because
"it worked" and "it had already worked" are different facts to a device
reconciling its queue.

**A local deck cannot be moved into a workspace that syncs.** D5.1's move route
refuses it, because a deck that lived its whole life locally has no change keys
and no outbox rows: it would look shared and silently never upload. Seeding one is
an upload of current state rather than a replay of a keyless history, and it is
its own work.

**Not done, and not claimed:** there is no transport. There is no cloud server to
reach and no sign-in to reach one, so `drain` takes the send as a callable and the
tests drive it with a function — which is the point of taking one, since ordering,
retry and idempotency then arrive tested rather than alongside a transport later.
Nothing schedules a drain, nothing writes `origin = "cloud"` outside a test, and
the divergence a stuck queue eventually produces has no UI: that is D5.3.

### A refused change is not a failed one (D5.3)

D5.2's outbox could tell a working server from an unreachable one and nothing
else, so a change the server *refused* — because the deck had moved there — was
retried on the same backoff as a dropped connection. That is a loop with no exit,
and worse than useless: it makes the deck look busy rather than stuck, so nobody
is ever told their work is not going anywhere.

`SyncRefused` is the distinction, raised by the transport instead of any other
exception. A refusal sets the row `blocked` — no attempt count, no backoff, no
next attempt — and everything queued behind it stays queued, because the change
behind a refusal may address an element it created and because the person has not
yet said what should happen to the one in front. A different deck is a different
sequence and keeps going.

The outbox has four states now, and none of them is the queue giving up on its
own: `pending`, `sent`, `blocked` (refused, waiting for a person), and
`superseded` (a person reconciled and a later change carries this one's intent —
terminal because someone decided it, never because the queue tired of trying).

**The remote document is kept at the moment of refusal**, and that is the design
decision worth the storage. Reconciling takes three documents; two of them — the
base the refused change was authored against, and this device's head — are
ordinary local reads. Keeping the third means a person who diverged on a plane
can resolve it on the plane. Fetching the other side at reconcile time would make
resolving a conflict require the network whose absence caused it, which is
backwards for a local-first product. It is held on the blocked row rather than in
a table of its own because a deck has at most one at a time — the queue stops at
the refusal, so that row *is* the point of divergence — and it is cleared when the
divergence is resolved, because one whole document per disagreement forever is a
database that grows with every argument anyone ever had.

**There is no Python merge, deliberately.** A three-way merge over this schema is
the hardest logic in the product and `packages/editor-ui/src/lib/reconcile.ts`
already is it, for the autosave conflict. A second implementation beside it would
be held together by nobody — the patch appliers are the one duplication this
project tolerates, and only because a conformance test holds them to one answer.
So `GET /presentations/{id}/sync` reports the state and, on request, the three
documents; the editor merges, commits the result through the **ordinary
transaction path** (one mutation path, ordinary undo, ordinary provenance); and
`POST /presentations/{id}/sync/reconciled` says which version did it.

**A resolution is a change that names what it merged, committed in the same
request that acknowledges it.** That contract took four corrections, each from a
review, and each because an earlier version answered a weaker question:

- **"Does this version belong to the deck?"** The pre-divergence version does, so
  handing it back retired the whole queue and answered "in sync" while the work
  sat in the local document, unowed to anyone.
- **"Is it queued after the refused change?"** Everything behind a refusal is. So
  is every change that was already waiting when the server said no, and those
  were authored before anyone knew there was a conflict.
- **"Was it written after the refusal?"** Necessary, and nowhere near sufficient:
  an ordinary edit a minute later satisfies it, and so does an agent's low-risk
  change. **Time says when; it cannot say what was merged.**
- **"Did it arrive before anything else?"** It could not, because the
  acknowledgement was a second request and everything committed in the gap was
  retired with the rest.

So the claim is three facts (`ResolvesConflict`), and each closes one of those.
`change_key` says *which* conflict, so a client resolving a stale one it read
about earlier cannot retire whatever is blocked now. `remote_version_id` says
which version of the **other side** the change is declared against, validated
against the one this deck is stopped at. `local_version_id` says which version of
*this* side it was reviewed against, and it must be the version being committed
against: if somebody typed between the review and the commit, the merge did not
see it and the ordinary concurrency refusal is the right answer.

**And it rides on the transaction, not on a route of its own**, which is what
makes the boundary provable instead of arithmetic. Because the merge commits and
acknowledges as one operation, and because it committed against the head it was
reviewed against, nothing queued at that instant can postdate it — an edit made
after the review would have moved the head and the commit would have been refused
before reaching the retirement. "Everything pending except me" is then exactly
"everything the merge incorporated". `POST /sync/reconciled` is **deleted** rather
than deprecated: a separate acknowledgement cannot be atomic with the commit it
acknowledges, and leaving it beside the safe path would be leaving the bug behind
a second door.

**State the guarantee exactly: a resolution is explicitly declared against
validated versions.** It is tempting to describe supplying `remote_version_id` as
proving the author fetched and read the divergence — it does not. It proves the
client named the matching version, which it could have by any means. And it is
certainly not evidence the merged *content* is right: nothing server-side can
establish that, because a merge is a human judgement over two documents. Content
quality is a separate question this contract does not touch, and claiming
otherwise would be exactly the overclaim this codebase exists to avoid.

Assets are still never retired: bytes the server has never received are not a
change a merge could have incorporated, and retiring one leaves the reconciled
deck citing a picture that will never be uploaded. An upload for a picture the
merge removed is then sent needlessly, which costs bytes once; the other way costs
someone their image. The merge's own row is spared, which is the oldest subtlety:
retiring it would strand the reconciliation on this device, the exact failure the
person just did the work to avoid. Retiring a queue needs editor rights — reading
that a deck diverged is not deciding what happens to the work.

Two smaller decisions that decide how it reads. `state` is four values rather than
a boolean, because "not in sync" covers two situations and only one needs a
person: a `waiting` queue clears itself, a `diverged` one never will, and
conflating them either alarms people about nothing or hides a real conflict inside
a spinner. A deck that syncs nowhere answers `local` rather than `in_sync` —
"in sync with nothing" is a claim about a relationship that does not exist. And
the documents are **off by default**: an editor polls this, and three whole
documents per poll forever is a download loop, not a status endpoint.

The claim that the existing merge suits this shape is checked in its own language
(`editor-ui/tests/sync-reconcile.test.ts`) against a divergence rather than an
autosave conflict — several offline changes met by several remote ones, not one
against one. A merge that only coped with a single step would pass every test in
`reconcile.test.ts` and fail the first real plane journey. The other half — that
the API records *those* three documents and not the oldest version it can find —
is asserted on the Python side, because that is where the choice is made. A merge
run against the wrong base does not error; it asks a person to adjudicate their
own uncontested work.

**Not done, and not claimed:** there is still no transport and no panel. Nothing
writes `origin = "cloud"` outside a test, so a diverged deck is a state no user
can currently reach, and building a review screen for it would be UI for
somewhere nobody can stand — the same call as D5.1's move dialog. What exists is
the authority: detection, classification, the record, and the three documents a
review will need.

### A local membership cache is not authorization (D5.4)

`workspace_members` decides what every route in this product will do. Once a
device mirrors a workspace, some of those rows are copies of decisions made
somewhere else — and a copy of a decision is not the decision. Nothing in the
schema could tell the two apart, so a mirrored row would have authorized exactly
as a real one does, including long after the person it describes was removed
upstream.

`WorkspaceMember.confirmed_at` is what a role in a `cloud` workspace now rests
on, and `auth.membership_status()` is the single place a row becomes a decision.
Six states, and only three of them grant anything: `authoritative` (a `local`
workspace — the row *is* the authority, so there is nothing to confirm it
against), `confirmed`, `stale`, `lapsed`, `revoked`, `none`.

**Two windows rather than one**, because the alternatives are both wrong.
Expiring at the first missed confirmation makes a local-first product useless on
a plane, which is the thing it exists to be good at; never expiring makes "a
cache is not authorization" a sentence rather than a rule, and leaves a removed
colleague holding a working copy of the workspace for as long as the laptop stays
shut. So a **stale** cache (7 days) keeps working and says so, and a **lapsed**
one (30 days) stops. A *known* revocation is immediate — one still honoured while
a window runs down is not a revocation — and the row is kept rather than deleted,
for the reason a revoked share link is kept.

**`confirm_membership` is the only thing that sets `confirmed_at`**, and it
carries the role as well as the freshness: a mirror that refreshed one without
the other would keep honouring an editor since demoted to viewer — a cache that
is provably current and still wrong. Nothing stamps a local membership, and the
migration backfills nothing, because `confirmed_at` records that an authority
vouched for the row and for those rows nothing ever did. A stamp there would be
fail-open.

**The local singleton needs no special case, which is the part worth noticing.**
D5.1 promised that local mode's "owner of everything here" posture must not
extend over decks the server owns. It cannot, and not because anything checks for
local mode: nothing can confirm a membership for an identity this machine
invented, so a row someone inserted for it in a mirrored workspace carries no
confirmation and grants nothing. One rule, no exception to forget.

**`resolve_workspace_access` was the bypass.** It read the role straight off the
row with `parse_role`, and it is the entry point for themes, assets, usage and
the sweeper that deletes files — so the moment a device mirrored a workspace, all
of them would have honoured a cached role. It goes through `membership_status`
now. The regression test was checked against the old code and fails there, which
is the only way to know a regression test is one.

A workspace whose access no longer authorizes is **listed with no projects**
rather than hidden. The person knows it exists — it is on their machine — so
dropping it from the list looks like data loss, where naming it with a reason is
something they can act on. `access` and `confirmed_at` ride on `AccountWorkspace`
for that. The resource-level refusals are unchanged: still 404, still identical
to a stranger's, because that rule is about not confirming what exists to someone
probing for it.

None of this is a substitute for the server checking. A freshness window is an
**offline policy** — what this device may do while it cannot ask — and a remote
receiver must re-check current membership on every operation it accepts, because
the only thing that knows whether someone is still a member is the authority.

**Not done, and not claimed:** revoking a membership does not delete the decks.
Bytes already on a device are already on the device, and quietly destroying
someone's local copy of work they may have authored is a bigger decision than
this makes on its own. Nothing mirrors a workspace yet, so the enforcement is
tested against rows written the way a mirror would write them — which is
deliberate, because building the enforcement afterwards is how mirroring lands
with nothing checking it.

### A deck reaches other people whole (D5.5)

Two halves of one idea, and both were holes the earlier slices named and
deferred.

**Pictures travel with a deck that syncs.** A third outbox `kind`, queued
**ahead** of the change that names the file — that ordering is the entire point,
because a document arriving with an `assetId` the server never received is a deck
that is broken for everyone except the person who uploaded it, and broken in the
way that looks like the product losing their picture. The queue is diffed against
what the *document* cites (`referenced_ids`) rather than derived from the patch:
an operation can introduce a reference indirectly — a slide pasted whole, a group
moved in, an undo restoring a removed image — and a differ reading only operations
would miss every one. The file travels **by reference**: a transport handed a
20MB image inline would hold every queued picture in memory to send one, so
`Outgoing` carries the storage key and the transport reads the bytes, as the
exporter and the blob route already do. A reference to a file the workspace does
not hold is skipped rather than raised — the renderer already draws a labelled
gap for one, and refusing would let a single bad reference block every later edit
to the deck.

Rows are queued against the **deck**, which is not where an asset lives but is
where the ordering constraint lives: "before" only means anything inside one
deck's sequence. It also keeps the queue honest — an image uploaded and never used
in a deck that syncs is bandwidth nobody asked for.

**A deck takes its pictures when it moves** (`presentation_shares` aside, this
closes the refusal D5.1 wrote). `Asset.workspace_id` scopes an upload to the
workspace holding it, so a deck that moved without its files would arrive with
every image unreadable *and* its own history pointing at bytes it can no longer
see. The check is across the whole retained history on both sides, the same walk
the asset recount does and for the same reason: a third version citing an image
the fifth deleted is a reference that still has to resolve. A file two decks use
cannot travel with one of them and is refused by count — copying it would mean
minting a second asset id and rewriting the document to point at it, which turns
a move into an edit, and a move must not change the deck. Storage is recounted on
both sides afterwards rather than adjusted, because it is a level and not a flow.

**A share link can pin a version.** `presentation_shares.version_id`: the shared
read loads that version and keeps loading it. Presenting is the case — an
audience must not have a slide change under them because a colleague edited the
deck or an agent's proposal applied, and on a projector that is not an annoyance,
it is the talk going wrong in front of a room. A pinned link is a photograph of
the deck; an unpinned one is a window onto it, and **unpinned stays the default**
because "send this to a client while I fix the typos" is the other real use.
The version is checked against the deck at creation rather than trusted: the
token is the only credential, so whatever it resolves to is what the holder gets,
and a link naming another deck's version would be a link to that deck. The
response says `pinned`, because a presenter handing the link round needs to know
which kind they sent.

**And a shared deck can load its pictures** (`GET /v1/shared/{token}/assets/{id}`).
Without it a share link was half a link: the blob route needs a session and a
membership, so on any install storing files locally — every desktop one — an
audience opening a shared deck would get the text and a row of broken images.
Sharing exists to show a deck to people, and a deck with no pictures is not the
deck. The rule that keeps it from being a foothold is **only what this document
cites**, checked against the document the link actually serves — so a pinned link
reaches the pictures of the version it pinned and not whatever the deck cites now,
and a picture removed after pinning still loads while one added afterwards does
not. An unknown asset and one belonging to a different deck get the identical 404,
because "that file exists but is not in this deck" tells a probing holder what the
workspace contains. No signed URL: there is nothing to sign that the token does
not already say, and a second credential for the same access is a second thing to
get wrong. With a real object store it redirects to a presigned GET instead of
putting every shared deck's images through the application.

**Nothing in the product resolved an image, and the reason was not an oversight**
(found here, fixed 2026-09-17). `resolveAssetUrl` is a prop `SlideView` has taken
since the renderer was written and **no caller anywhere passed one**, so every
image drew the renderer's labelled gap. It stayed unwired because **the two
shells cannot authenticate an image the same way**, and there is no single URL
that works for both.

The desktop's base URL is a path on the renderer's own origin, and the main
process injects the bearer as the request passes through the proxy — so an
`<img src>` at the blob route works, and the page still never learns the token or
the loopback port. The web app's base URL is another origin and its credential is
an `Authorization` header, which an `<img>` cannot send: there the bytes have to
be fetched with the credential and handed over as an object URL.

So the split is `client.assets.directUrl()` — synchronous, answering only where
the browser can authenticate by itself — and `fetchBlob()` for the rest, with
`useAssetUrls` (`editor-ui/src/lib/asset-urls.ts`) turning the pair into the one
synchronous resolver the renderer's prop requires. A key that has not arrived yet
resolves to `undefined`, which is what the labelled gap already covers; the
re-render replaces it. It is threaded through the canvas, present mode, the
transition stages and both presenter previews, because a deck whose pictures
appear while editing and vanish on the projector is worse than one that never
showed them.

Three things there are load-bearing. **The effect depends on a string, not the
Map**: `document.assets` is a fresh array on every render for any caller that
replaces the document, so depending on its identity re-ran the effect, fetched,
set state and fetched again — an infinite loop, which a test caught by counting
1,109 object URLs created for one image. **Object URLs are revoked** on unmount,
or a deck of photographs opened all day pins every blob it ever loaded. And **a
failed fetch is remembered**, so one broken reference is one request rather than
one per render.

`blobPath` in the client mirrors `object_storage.blob_url` in Python, which is a
second description of one path — written wrongly the first time, with
`encodeURIComponent` over the whole key turning every `/` into `%2F` where
Python's `quote()` leaves them alone. It encodes segment by segment now.

**And a person can now put one there.** `client.assets.upload()` is the three
requests the API already had — ask where to put it, PUT the bytes, register the
row — behind one call, because the middle one carries a subtlety a caller should
not have to know: a **relative** upload URL is this API's own blob route and needs
our bearer, while an **absolute** one is a presigned object-store URL whose
signature *is* the credential, and attaching a second one is how a presigned PUT
gets rejected.

`insertImageOperations` emits **two writes in one patch**, and that is the point.
An image element cites an `assetId` while the storage key behind it lives only in
the document's asset manifest, so an element added without its manifest entry is
one nothing can resolve, and a manifest entry without its element is an asset the
reference counter will sweep. One patch means they arrive together, undo
together, and can never half-exist. The picture is fitted to half the viewport at
its own aspect ratio rather than dropped at native size — a 4000px photograph
placed at its own dimensions lands mostly off-canvas — and it carries the
filename as `altText`, because WCAG 1.1.1 is a gate this product checks and an
image without one fails it.

`complete_asset_upload` now returns the storage key, which `assets.describe`
deliberately withholds: a *list* has no reason to hand out paths into a bucket,
while the person who just uploaded one is about to cite it from a document, where
doc 02 stores the opaque key by design.

**The upload and insert live outside the component** (`lib/insert-image.ts`),
which is the same rule as the timeline's — operations are a pure module, the
surface only gestures — and here it is also what makes the refusal testable:
**nothing in this repository renders `EditorShell` in jsdom**, because the editor
measures text and jsdom has no layout. A failure path left inside the component
is one nothing can check, and the likeliest failure is the storage quota, charged
when the upload is registered.

**`technical-deck` has an image now**, which it should have had all along: it is
the fixture for "every MVP element type" and had no picture in it, so the scene
build's image payload, PPTX's degradation for one, the accessibility alt-text
rule and the renderer's unresolved-asset placeholder were between them exercised
by nothing. `shapes.ts` has routed `image` to `unsupported` since it was written
and no test ever reached that line; one asserts it now.

Two things about adding an element to a fixture are worth writing down, because
both were got wrong first.

**The id counter is shared across prefixes**, so a new `id()` call anywhere
renumbers everything after it — and a fixture whose ids churn makes every
visual-regression snapshot fail for no reason. The image is minted last, and the
document's own id is hoisted above it so it keeps the value it has always had.
The first attempt shifted `doc_…`; the diff is now a pure addition, 71 ids in and
73 out with none removed.

**"Inside the diagram's bounds" and "over the diagram" are not the same thing.**
Placed at `1180,620` the picture sat inside the diagram element's 1680×620 box
but clipped visually under the "Transaction service" node — and neither
`validateScene` nor the accessibility pass objected, because neither is looking
at that. Only the rendered PNG showed it. It sits in the clear band below the
diagram now, on the same 120px left margin the headline uses. That is what
"read the diff before regenerating" means for pixels: the digest said one line was
added and was right, and the line said nothing about the picture landing on top of
a box.

The pixel baselines record the **labelled placeholder** with its alt text, and
that is deliberate rather than a gap: a baseline render supplies no bytes, so the
placeholder is exactly what that render produces, and pinning a picture there
would pin something the gate never draws.

Both baselines are re-recorded. `linux-x64.json` had been **behind, not absent** — this
file previously said unrecorded, and that was wrong. The original was taken on
2026-09-06 and never caught up with D4.1 or this change, so CI's pixel job was
red. See "Recording a Linux pixel baseline on a Windows machine" below for
how it was brought current without deriving anything from the Windows hashes.

### An export gets the bytes, because it cannot go and get them (D5.7)

The editor drew pictures and **every export still drew the placeholder**: a PDF of
a deck of photographs arrived with dashed boxes in it, and nothing said so. The
job reported success, because from the job's point of view nothing failed.

The editor's fix does not carry over, and the reason is the whole design here.
`useAssetUrls` answers either a same-origin path the desktop proxy authenticates,
or an object URL fetched with a bearer. **The render host has neither, and cannot
be given either**: it has no session, no browser origin, and no network at all —
`render-page.ts` aborts every request that is not a `data:` URL, because a
document that could make the render host fetch a URL is an SSRF primitive as well
as a source of nondeterminism. That rule is not relaxed for images; the bytes are
handed *in*, as `data:` URLs, which is the one scheme already allowed.

**Authorization therefore happens on the API side, not the renderer's**
(`assets.inline_for_render`). It reads the deck's cited assets scoped to the
**presentation's own workspace**, so a document naming an id from somewhere else
resolves to nothing — the same answer a stranger's read gets, and the reason a
deck moved without its files (D5.5) cannot quietly keep reading them. Both callers
go through it: `run_job` for exports and the preview route for `slide_preview`,
because a preview that drew placeholders where the export draws pictures would be
a picture of a deck this product does not produce.

Four things there are load-bearing:

- **A reason travels instead of an omission.** An asset that is too large, stored
  as something other than an image, or whose bytes could not be read comes back as
  an entry carrying `problem` rather than being left out. "This file is too big to
  embed" and "this deck cites an asset that does not exist" are different things
  to tell a person and a missing entry cannot tell them apart. One unreadable file
  degrades one picture; it does not fail the export of the other thirty-nine
  slides.
- **The payload is bounded twice, and checked again downstream.** A data URL is
  base64 in an HTML string Chromium parses in one go, so it is memory in three
  places at once. The API refuses to *read* an oversized file at all, and
  `AssetLibrary` (`apps/worker/src/assets.ts`) re-checks type, encoding and size
  on arrival — the caller today is our own API, and a resolver that will build a
  `data:` URL out of whatever it is handed is one malformed row away from putting
  arbitrary content into a customer's PDF. The budget is charged at the larger of
  the row's recorded size and the bytes actually read, because a budget spent on
  whichever number happens to be smaller does not bound anything.
- **Decoding is awaited, and a failure is attributed.** `settle()` used to skip
  any image reporting `complete`, which is precisely what a broken `src` reports —
  so it waited on exactly the images that did not need waiting on. It now decodes
  every one and reads `data-asset-id` back off the element, so "this picture did
  not draw" names the picture. Supplied and accepted is not the same as drawn: a
  truncated upload passes every check on our side and produces a blank box.
- **Whatever is not drawn reaches the report.** Doc 04 §32.2 requires the user to
  see what was degraded before they download, so each undrawable asset is one
  warning under `asset:<id>` — per asset, because `DegradationLedger` deduplicates
  on feature and action and a single `image` feature would collapse four missing
  pictures into one line naming one of them. The PDF renderer hands warnings back
  with its bytes (`DocumentRenderResult`) for the same reason: whether a picture
  decoded is known only *after* the browser has tried, and a report that could not
  carry that finding would say an export succeeded while the file has a dashed box
  in it.

**The gate is pixels, not the absence of errors** — the one assertion that could
not be satisfied by a resolver returning `undefined` and a report staying quiet.
`apps/worker/tests/assets.browser.test.ts` renders the `technical` fixture's image
slide in real Chromium with a generated solid-colour PNG supplied, reads the
colour back out of the artifact through a canvas, and then renders the same slide
**without** the bytes as the control: the placeholder must not be that colour, and
the report must name the asset. Verified by breaking it — with the payload removed
the point reads 30, not 255.

Fixing this also turned up four browser tests that had not run since the editor
was extracted: `apps/worker/tests/editor-browser.js` still imported
`../../web/lib/measurer`, which moved to `packages/editor-ui` in D0.2, so every
digest-parity case in that suite was failing to *build* rather than to compare.
`test:browser` now runs every `*.browser.test.ts` rather than naming one file.

**Not done, and not claimed:** nothing streams — a deck whose images exceed the
per-render total gets the pictures that fit and a named warning for the rest.

### A picture in the PowerPoint, not a box where one was (D5.8)

PPTX routed every image to `unsupported()` from the day the adapter was written:
a dashed box with the element's name in it, and an honest line in the report. It
was honest and it was not a deck. Doc 04 §33.4's user story is "my client needs a
.pptx", and the worst outcome is the client finding the grey rectangle first.

**A picture in a `.pptx` is three things that have to agree**, which is why
`media.ts` allocates all three rather than letting whoever emits the shape do it:
bytes under `ppt/media/`, a content type for the extension, and a relationship
from the slide whose `r:embed` names it. Miss one and PowerPoint refuses the
**whole file** rather than the picture — so they are asserted together, and the
relationship id in the `.rels` part and the `r:embed` in the shape are literally
the same string rather than two counters that agree today.

PDF and PPTX need the same pictures in different shapes, and that is the reason
`ExportInput.images` carries **bytes** while the render page gets `data:` URLs:
PDF renders in a browser, and a `.pptx` is a zip where a picture is a part inside
it. One `AssetLibrary` answers both (`images()` beside `resolve`).

**DrawingML has no `object-fit`**, so `contain` and `cover` are geometry the
adapter computes: `contain` shrinks the *shape* to the picture's aspect ratio and
centres it, `cover` keeps the shape and crops the *source* with `srcRect` insets.
Both need the intrinsic size, which only the document's asset manifest records —
without it the picture stretches and the report says it was approximated rather
than pretending.

The fit test is measured against a **square** box on purpose. The fixture's own
image box is already 16:9, so a 16:9 asset fills it exactly whether the adapter
fitted it or simply stretched it: an assertion there passes against code that
does nothing, which is how a fit gets quietly lost. The first version of that
test did exactly that and was caught by reading the EMU it produced.

**The slide background was a silent drop and nobody would have found it.**
`scene.background.assetId` was read by nothing here, so a full-bleed photograph
became the theme's flat colour with no line in the report — and a flat background
looks deliberate. It is a `blipFill` now; one that cannot be embedded falls back
to the colour *and* says why, and an overlay or blur over it is reported as
dropped, because a background designed to sit under a scrim is usually too bright
to read text on without one.

Deduplicated by asset id: a logo on twelve slides is one part and twelve
relationships, not twelve copies of the bytes. Not by *content* hash — two assets
with identical bytes are two uploads and the document already treats them as two
things.

A format PowerPoint will not open is **refused rather than embedded**. A webp put
in the package because it is "an image" produces a file that opens with a broken
picture in it, which is worse than a labelled box: the recipient cannot tell
whether it is their machine.

**Checked by a reader that is not us.** `test_pptx_opens.py` now runs the real
exporter and asks `python-pptx` for the picture: it resolves the relationship
itself, reads the bytes back out of the media part, and reports the format, the
pixel size and the position. Verified load-bearing by withholding the image —
"the deck exported no picture at all". And end to end through the actual worker
CLI with an `assetsPath` payload, which is the path an export really takes:
5 slides, one `PICTURE` shape, 8×8 PNG read back, and `image` gone from the
report's dropped features.

### Pulling a workspace down, and why push could not come first (D5.6)

D5.2 built an outbox with no transport and D5.3 built divergence handling with
nothing to diverge against. The obvious next step was to send, and it does not
work: a `create` needs a **remote project id**, and a device that had only ever
pushed has no mapping for one. So the first slice of a transport is the direction
that establishes what the two sides call things.

**It turns out there is nothing to establish. Ids travel; version ids do not.**
That falls out of what already exists rather than being invented: a presentation
takes its id from `document["id"]` (D5.0), and a workspace or project created on
the server is created *by* the server, which mints the id. So a mirrored row holds
the server's id, `origin = "cloud"` means "this row mirrors a server row with the
same id", and there is no translation table anywhere to get wrong. The one
exception is the version chain, because `commit_transaction` mints its own and
takes none from a caller — which is what `Presentation.remote_version_id` is for,
and it is the fact a later push needs in order to say what its change is based on.

**There is no bootstrap endpoint, deliberately.** `bootstrap.adopt` reads
`/v1/account`, `/v1/projects/{id}/presentations` and `/v1/presentations/{id}` —
the routes a browser already reads, with the same bearer token through the same
`resolve_*` chain. A server with no code path that exists only for syncing has
none that can drift from the one people use. The remote is a **protocol** rather
than a client, for the same reason `drain` takes its sender as a callable: the
behaviour worth testing is what gets written locally, and it is tested against a
real second store rather than against canned JSON.

**The echo is the trap that would have made the first sync loop.** A deck in a
syncing workspace enqueues itself for upload (D5.2), so a mirrored one doing that
means the device immediately offering the server back the deck it just received —
arriving there as a brand-new deck carrying an id the server already has.
`create_presentation(from_server=True)` is the guard, and it is a named argument
rather than something inferred: inferring it means guessing, and the failure is
silent in both directions — guess wrong one way and a real deck never syncs, guess
wrong the other and every pull starts a push.

Four refusals, each a way a bootstrap could quietly take something:

- **A local workspace is never converted into a mirror.** A server answering with
  an id matching one of this machine's own workspaces would otherwise take it
  over, decks and all, and the person would have handed it over by signing in.
- **A project cannot change workspace by being mirrored.** Moving a deck between
  workspaces is an explicit act with its own route and its own refusals (D5.1); a
  pull is not one.
- **A document whose `id` disagrees with the row it arrived under** would create
  a deck under an id nothing else refers to, and one that does not validate
  against this build is refused **by name** — storing it would not make it
  openable, and a silent skip leaves someone hunting for a deck that is simply
  missing from the list.
- **A deck already held is left alone**, not refreshed. The local copy may carry
  edits that have not been uploaded, and replacing it with the server's would
  discard exactly what the outbox exists to protect. Catching a changed deck up
  is a merge (D5.3), not a pull.

**Losing access closes D5.4's loop.** A workspace the server stops listing has its
membership revoked here and now, rather than running down the thirty-day window —
that window is for a device that *cannot* ask, and this is a device that just did.
The decks stay on disk: bytes already on a machine are already on it, and quietly
destroying someone's local copy of work they may have authored is a bigger
decision than a reconnect should make. A read that *fails* raises rather than
returning nothing, because concluding "no workspaces" from a timeout would lock a
person out of their own decks because their network was down.

**Two bugs in the first cut of this, both found by review (2026-09-17) and both
the same shape — a refusal that was recorded and not acted on.**

`_adopt_project` refuses a project whose id this device already uses in another
workspace, and the loop pulled its decks anyway: the return value was appended to
the report and never read. So a server naming an id this machine already had
would have had its decks imported straight into a **local** project — the
takeover the workspace guard exists to prevent, one level down and through the
door beside it. The refusal is now returned and the caller skips the pull.

`HttpRemote.presentations` read the deck-list route's *default page* and stopped,
so a project with more than 200 decks mirrored its first 200 and looked complete.
That is the worst shape of bug this direction can have: the person sees a
workspace, sees decks in it, and has no reason to think anything is missing. The
route now takes an `after` cursor and answers `next_after` exactly when there may
be more, so a caller loops while there is a cursor rather than comparing a count
against a limit it has to remember — which is the comparison nobody makes.

**That cursor pages by `id`, and the ordering change is the point.** The default
listing is "most recently changed first", which is right for a picker reading one
page and unusable for a reader walking every deck: editing a deck moves it to the
front, so a walk in that order hands back the same deck twice and skips another.
Ids never change. The default is untouched, because changing it to suit a sync
reader would have made every deck list in the product answer in creation order.

**Not done, and not claimed:** `HttpRemote` has never run against a live server,
because there is no deployed Deckastra to point it at — what is tested is `adopt`,
against a real second store, which is where the decisions are. Push is still
unbuilt, so nothing this pulls can be sent back yet; assets are not pulled with
their decks; and a deck that changed on both sides has no reconcile path from a
bootstrap, only the local one D5.3 built.

### Three things an independent test run found (2026-09-17)

A review pass over `8c376bf` ran the suites, built a fresh package and drove the
installed app. Its automated gates were green; **everything it found, it found by
running things in parallel or by reading what a harness actually did** — which is
the pattern worth noting more than the three bugs.

**A first sign-in races itself.** Two concurrent `POST /v1/dev/session` calls for
one identity both read no user and both inserted one, and `users.email`'s unique
index refused the loser with an `IntegrityError` that reached the caller as a 500.
The tempting reading is "a dev route, under an unrealistic load"; it is neither.
`provision_personal_account` is what real sign-in provisions through, and a person
double-clicking a sign-in button is this case exactly.

The read is an optimisation and **the index is the authority**, so the insert is
now taken inside a savepoint and a collision loses the race rather than the
request: the savepoint rolls back, the winner's row is read, and the loser
continues down the existing-user path into the winner's workspace. The savepoint
is what makes that possible at all — once a statement fails, SQLAlchemy will not
run another on that connection until something rolls back, so catching the
violation around a plain flush would hand the caller a session nothing else can
use. Retrying the insert would have been the wrong repair: it satisfies every
assertion about status codes while giving one person two personal workspaces, and
they find out when a deck they made answers 404 from the other one.
`test_signin_race.py` forces the interleaving with a barrier and fails on the old
code with the reported error; `ensure_physical_transaction` (`db/session.py`) is
`store.commit_transaction`'s SQLite `BEGIN` rule, extracted so both savepoints
obey it.

**The morph gate had never seen a morph.** `runMorph` fired ArrowRight twice and
began sampling, on the reasoning that the morph is the fixture's last slide. In
present mode ArrowRight advances a **click segment** first, so both presses were
spent on slide 2's reveals and the gate then looked for movement on a slide that
has none. It failed rather than passing falsely, which is the one good thing about
it, and it verified nothing for the whole of D4.

A harness driving a UI through real key events has to be able to say **where it
arrived**, and this one could not: present mode exposed no slide identity at all.
It now carries `data-present-slide-id` / `-index` / `-count` / `-transition` on
its root, and the harness walks forward until the index actually reaches the slide
before the last, then asserts after the sampling press that the deck advanced
*and* that the slide it advanced into is entered by a `morph`. Watching the wrong
boundary is now an error with the boundary's name in it.

Measured on a fresh profile once it could reach the morph: both paired elements
translate from `-140px 210px` and `1300px -580px`, **37 sampled frames of
movement over 615ms**, settled during sampling, nothing displaced afterwards.
That is the first time this gate has observed the thing it is named after.

One more thing that run exposed, and it is not a product bug: the deck an install
opens is seeded from the animation fixture on **first launch only**, so a profile
created before D4.1 added the morph slide still has a three-slide copy. The
harness now says so by name instead of testing whatever it found.

**`app.exit()` skips the shutdown.** Electron does not emit `before-quit` or
`will-quit` for it, and `before-quit` is where the sidecar is stopped — so every
smoke step orphaned its Python child, which then held the database file, the port
and the single-instance lock, and the next step could not start. The step stops
the service itself before exiting now and records whether it managed to, because a
step that could not release its service is one whose result the next step should
not trust. Verified: `serviceStopped: true`, exit 0, and no Electron or service
process left behind.

**And one environment-dependent failure that was hiding a weak test.**
`test_launch.py`'s sweep case configured no asset backend, so
`object_storage.delete` reached for MinIO on `localhost:9000` and the test failed
on any machine without docker. Pointing it at a local directory is not just a way
to make the failure go away — the sweeper deletes *bytes*, and against an S3
endpoint with nothing listening it could never have checked they were gone. It
writes a real file now and asserts the file is missing afterwards. The S3 delete
path stays untested, as it always was.

### Running the gates that needed a service (2026-09-17)

`POSTGRES_TEST_URL` and MinIO had been "unavailable" for long enough that three
things had gone wrong behind them. The suite is **654 passed, 0 skipped** with
both services up, and 632 passed / 22 skipped without — the second number is the
honest one for a laptop, and the first is what CI has to be.

**The story checkpoint had been failing since D3's contract fix.**
`test_checkpoint.py` stubs an orchestrator answer, and that stub still said
`"clarification_needed": ""` — the string whose emptiness *was* the old "no".
Changing the field to a `bool` made `""` un-coercible, so the run failed at its
first contract and both pause/resume tests went red. Nobody saw it, because those
tests skip without PostgreSQL. The file's own docstring had predicted this
exactly: *"These tests only run with POSTGRES_TEST_URL set, which is how the
signature drifted without anything going red locally."*

The stub is corrected, and there is now a test in that file which **needs no
database**: it validates all four stub answers against the real contracts.
Checking a fixture against the thing it is pretending to be costs nothing and
runs everywhere, so the next contract change breaks on every push rather than in
whichever job happens to have a service container. Verified by putting `""` back
and watching it fail.

**A reachability guard that went through `object_storage` was not a guard.**
Every failure that module can have is one `ObjectStorageError` — "no such object"
and "nothing is listening" are indistinguishable — so the first version of the
skip reported an unreachable endpoint as available and spent 75 seconds in
boto3's retries before failing. It is a one-second socket probe now
(`conftest.object_store_available`), shared by both files that need it.

**The S3 lifecycle test had never run, and my own change had quietly disarmed
it.** `test_real_object_upload_delete_restore_and_eventual_cleanup` was gated
behind `RUN_OBJECT_STORAGE_TESTS=1`, which is an opt-in nobody sets — and when
the sweep fix gave the shared `client` fixture a `DECKASTRA_ASSET_DIR`, it
silently redirected this test to the *local* backend. It would have exercised a
directory while claiming to cover S3. It clears that variable itself now and
asserts `local_root() is None` before starting, so a future fixture cannot take
the backend away from it again; the gate is reachability rather than an opt-in.
Running it for the first time: upload intent, presigned PUT to MinIO, completion
verified against the object, presigned GET, delete, restore, sweep, and the bytes
gone from the bucket.

**`object_storage.read()`'s S3 half had never been executed at all.** It was added
so a headless render could be handed a deck's pictures (D5.7) and only the local
directory was ever tested — on a deployed install every export would have reached
for a function nobody had run. `test_object_storage.py` covers it, along with the
deployed shape of the whole picture path: asset rows in the database, bytes in the
bucket, `inline_for_render` returning base64 that matches what was uploaded.

### Recording a Linux pixel baseline on a Windows machine

CI's pixel job had been red because `linux-x64.json` was three slides out of step
— two changed and one new — and the standing advice was to commit
`linux-x64.json.computed` from a failing CI run. That is one way. The other is to run the gate **in the image CI pins**, which
is what happened on 2026-09-17:

```bash
docker pull mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30…
# the repository copied in, dependencies installed for linux-x64 beforehand,
# then PIXELS=1 npm run test:pixels inside the container
```

**Eight of the ten existing hashes reproduced byte for byte** against a baseline
recorded eleven days earlier on a different machine, and the container reported
the same Chromium `153.0.8010.12` the original review did. That is the part worth
keeping: three new numbers from a laptop are a guess, and three new numbers beside
eight that match are a measurement. Without that agreement the right answer would
still have been to wait for CI.

Two practical notes, because both cost time. `npm ci` inside the container could
not reach the registry from this host — Docker's DNS returned only an AAAA record
and there was no IPv6 route — so the dependencies were installed on the host with
`npm ci --os=linux --cpu=x64 --ignore-scripts` into a scratch copy and mounted in.
Nothing is cross-compiled by that; it fetches the Linux artefacts of packages that
ship per-platform binaries (`@esbuild/linux-x64`, `@rollup/rollup-linux-x64-gnu`).
And npm on Windows writes workspace links as junctions pointing at host paths, so
`node_modules/@deckastra/*` has to be relinked inside the container or every
workspace import fails to resolve.

All three changed slides were looked at before recording, and the review is in
`baselines/pixels/REVIEW.md` beside the older one. The re-run afterwards used
`REQUIRE_PIXEL_BASELINE=1` with no update mode — the exact command CI runs — and
was green, determinism properties and negative control included.

### Signing is configured, conditional, and checked against the artifact

Not done, and the distinction matters: **the configuration is reviewed, not
exercised.** No certificate exists here, so no signed artifact has ever been
produced and notarization has never run. What was closable without one is the
part that would otherwise fail silently later.

**electron-builder produces an unsigned artifact with a green log.** The build run
while writing this said it plainly — `no signing info identified, signing is
skipped` — and exited 0 with a working installer. An unsigned build is
byte-for-byte an ordinary build until a user's machine refuses it, and the line
that would have told you scrolled past among a thousand others. So
`scripts/check-signing.mjs` asks the **operating system about the file** rather
than believing the builder: `Get-AuthenticodeSignature` on Windows, `codesign
--verify` *and* `spctl --assess` on macOS. Two questions there rather than one,
because a bundle can be validly signed and still refused by Gatekeeper for not
being notarized, and only `spctl` tells those apart.

It reports by default and fails on demand: a developer with no certificate should
not be blocked, while an unsigned artifact in a release is the bug.
`DECKASTRA_RELEASE=1` is that line. Both refusals were checked — unsigned under
release mode exits 1, and so does finding no artifact at all, because a check that
looked at nothing and passed is how a gate comes to be believed about something it
never inspected.

macOS notarization needs the **hardened runtime**, and the hardened runtime
refuses precisely what this app is built out of, so `build/entitlements.mac.plist`
names each exception with the thing that breaks without it: JIT and unsigned
executable memory for V8, library validation disabled because the app runs a
separately built PyInstaller service carrying its own Python and dylibs, and dyld
environment variables plus `inherit` because the exporter starts the app's own
binary as a child with `ELECTRON_RUN_AS_NODE=1`. Nothing asks for network server,
camera or microphone: an entitlement the app does not use is one somebody has to
justify at review.

The trap written down rather than discovered: **every nested executable inside the
bundle has to be signed or notarization rejects the whole thing**, and this app
ships three that are not Electron's — the workspace service, the exporter and the
MCP server, all in `Contents/Resources` because `ELECTRON_RUN_AS_NODE` cannot read
an asar. The service is named in `mac.binaries` so it is signed deliberately
rather than by electron-builder's guess; the failure otherwise is a rejection days
later naming a path rather than a cause.

`mac.notarize` stays `false` in the file on purpose. A config that claims to
notarize on a machine with no Apple credentials produces an unnotarized build and
a green log, and the first person to learn otherwise is a user. A release turns it
on explicitly, with the credentials present, and then runs `verify:signing`.

### A missing capability is absent, not broken

A packaged-runtime check (2026-09-10) caught the editor showing a Share heading,
a live "Create view link" button and a red `Not found.` underneath. Nothing was
wrong: local mode refuses sharing wholesale, because a link that machine mints
leads nowhere. The panel listed links on mount, got the 404 that refusal gives,
and rendered it as an error — a feature that was never available presented as one
that had just failed.

`/v1/account` now reports `capabilities`, and `SharePanel` asks before it offers.
Two decisions in that:

**Deployment-wide, not per workspace.** The refusal keys on `local_mode.enabled()`,
and a cloud server's own workspaces are `local` in the D5.1 sense and share
perfectly well — so deriving the capability from `workspace.origin` would switch
sharing off for every deck in the product.

**Asked for explicitly, never inferred from a 404.** That is the whole fix rather
than a detail of it: a missing deck and a deck you may not see both answer 404
*by design*, because a 403 on something you cannot see confirms it exists. Reading
any of those as "sharing is unavailable here" would tell someone whose access was
just revoked that their workspace cannot share.

So the panel has four states, not two — and the third is the one my first attempt
got wrong by collapsing a failed read into "not supported". `asking` offers
nothing yet; `yes` behaves as before; `no` says *"This workspace is local. Online
sharing isn't available here. You can export a copy to share."*; and `unknown`
says only that it could not check, claiming nothing about the workspace. The test
that names this asserts the local-install explanation is **absent** when the
account read fails, which is the assertion my first version had backwards.

It also stops asking for links where links cannot exist — the request whose only
possible answer was the 404 people were being shown.

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

### The timeline is authored by dragging, and every drag is a patch

D4.2, `packages/animation-engine/src/timeline/` and
`editor-ui/src/components/TimelineLanes.tsx`. The panel had buttons and number
fields; it now has direct manipulation, and the split between the two halves is
the same one the rest of this codebase keeps — **operations are a pure module,
the surface only gestures.**

Five modules, split by what each can be wrong about: `view` (what to draw),
`edits` (what one gesture means), `split` (redistributing keyframes across a
cut), `ripple` (which clips "after" includes), `keyframes` (normalised offsets).
None mutates anything.

**Splitting is the one with substance**, because of a decision in doc 02 §24.5: a
keyframe's offset is 0–1 of its clip's duration, not a time. That normalisation
is what makes trimming one property change instead of N — and it means a split
cannot copy keyframes across. Each half re-expresses every offset against its own
duration, and both get an explicit keyframe at the seam carrying the value the
original had there. Without it the second half starts from its first surviving
keyframe and the element jumps at the join, which is the one artefact a split must
never introduce. A colour has no midpoint, so the nearer value is taken and the
caller is told.

**Ripple moves clips within one track, by start time rather than array
position.** A track's clips share a trigger; other tracks have their own reasons
for their timing, and rippling the slide would move things the author never
touched. Document order is something an author rearranges for themselves; what a
ripple is about is time.

**Opening a preset is a patch, not a mode.** The schema already says a clip
carrying both `preset` and `propertyTracks` uses the tracks and keeps the name as
provenance, so the panel still says what a clip started as after it has been
taken apart. Opening one that is already open returns nothing rather than
replacing the author's edits with the preset they began from.

The drag surface keeps the canvas's three rules for the canvas's reasons:
pointermove coalesced into one rAF callback, rounding **once** on pointer-up
(rounding each move walks the clip off the pointer and leaves a clip that will
not sit on a round number), and a cancelled gesture committing nothing. The
modifier lives in a ref rather than in the preview: the first pointermove happens
before any preview exists, so a flag written into one lands on nothing — and a
ref also respects Shift pressed or released partway through a drag.

`triggerStartMs` is **derived**, not threaded: the document stores `startMs` as an
offset from the trigger and the compiler reports it absolute, so the difference
between them is the trigger. A drag produces an absolute drop position, and
writing that straight into the document would move a clip on an `afterPrevious`
track by however long everything before it runs.

**Measured in the app** (`DECKASTRA_SMOKE_STEP=timeline`): adding a `fade` and
dragging its bar 80px moved the clip from 0–240ms to 46–286ms, with the label
re-derived from the document through the compiled view — the stored clip moving,
not a bar sliding. Three test-environment facts cost time and are worth knowing:
jsdom has no `PointerEvent` (Testing Library falls back to a plain `Event` that
carries no `clientX`, which looks exactly like a component ignoring the pointer),
`setPointerCapture` is not implemented there — so capture is now attempted *after*
the gesture exists and guarded, which is better anyway — and `vi.unstubAllGlobals`
inside one test removes a polyfill every later test needed.

**Keyframes are handles on the bar**, in a layer *over* the bars rather than
inside them. A bar clips its own content so a long label does not spill into the
next clip, which also clipped the handles at offset 0 and 1 — the two an author
reaches for most. As siblings they are outside the bar's own gesture too, so a
keyframe drag needs no propagation games to avoid starting a clip drag.

**The in-flight gesture lives in a ref, not in state**, and that distinction is
load-bearing. `setPreview` does not apply until React re-renders, so a
pointer-up landing in the same frame as the last move read a handler still closed
over the *previous* value — `null` on a quick drag — and committed nothing. A
short, fast nudge is the common gesture, and it was silently doing nothing while
every unit test passed, because a test flushes a frame before letting go and
React has re-rendered by then. State draws; the ref commits. The regression test
drives the frame *without* `act`, and was checked against the old component
before being trusted.

That bug is the argument for the acceptance step: nine tests over the drag
surface did not find it, and one drag in the app did.

### D4's gates run against the deck the product ships

D4.4, `animation-engine/tests/deck-acceptance.test.ts`. Every other test in that
package builds its input; these run the conformance fixture through the real
scene build, because a property that holds for a literal and fails for the deck
in the repository is a coincidence rather than a property. Three gates: seeking
equals playing across clips *and* transitions now that the two keep separate
clocks, reduced motion honoured all the way down, and the entrance budget
computed rather than requested.

**PowerPoint's Morph pairs by name, and until D4.4 the names could never pair.**
Shape names derive from element ids — stable across edits, which is why doc 04
§33.3 wanted them — but two paired elements are two *different* elements with two
different ids, so their names differed and Morph would have paired nothing. A
slide entered by a morph now names its paired shapes after their partners on the
previous slide (`nameOverrides`), which is the only thing that makes the pairing
real. The report used to say the names let PowerPoint "pair objects", which reads
as though the transition morphs; the file carries a **fade**, and it says so now.

Emitting PowerPoint's own Morph means `mc:AlternateContent` around a
vendor-namespaced element, and nothing here can check that PowerPoint accepts it
— only that a reader parses it. So the file does what certainly works, the names
make a manually applied Morph work, and the gap is written down rather than
guessed at. That is the same rule as macOS in D1.

**Four tests in this milestone asserted nothing, and each was caught by a
different thing.** `expect(applied.errors ?? []).toEqual([])` compared `[]` to
`[]` because `ApplyResult` has no `errors` — the typechecker. A parity loop
`for (t = 0; t <= at; t += 16)` never lands on `at` unless it divides by 16, so
it compared two different instants — the assertion failed. A reduced-motion check
read a `Map` with `Object.entries` and inspected zero elements — a counter added
at the end. And `compileTimeline(..., { motionLevel })` is not a `CompileOptions`
field, so every "reduced motion" assertion ran at **full** motion and passed —
the typechecker again, because vitest strips types and never saw it. The habit
worth keeping from this: a test that loops should prove it looped.

### An overlap is named, and has something to press

D4.3, `timeline/conflicts.ts`. The compiler already noticed two clips animating
one property at once — `W136`, "the later one wins for the overlap" — which is
true and not actionable: it does not say which other clip, by how much, or what
to do. Each one is now a finding with the shape the validator's catalog uses for
a `MECHANICALLY_FIXABLE` rule: the pair, the property, the overlap in
milliseconds, and two operations that resolve it.

**Not an error, deliberately.** Fading one property while another moves is
ordinary, and two clips overlapping the same property for a beat is something
authors do on purpose. A striped bar says *look*; a named fix says *or do this
instead*; neither takes the choice away. Both fixes are one patch each and undo
like any other edit — there is no conflict-resolution mode.

Two details that are easy to get wrong. A fix writes the later clip's start as an
**offset from its trigger**, because that is what the document stores — an
absolute time would move a clip on an `afterPrevious` track by however long
everything before it runs. And a shortening that would leave a clip under
`MIN_CLIP_MS` is not offered at all: a sliver beside a clip is a second thing to
find and delete, not a fix.

Findings are per property, because a pair colliding on two is two true findings —
but the panel **groups them by pair**, because it is one decision, and offering
the same two buttons twice makes an author read four things to learn one.

**Going back is not arriving** (doc 04 §26.3). A transition and an entrance both
describe *arriving*, so stepping back plays neither: the slide is simply there,
in its final state. A presenter stepping back is checking something they already
showed, and replaying the build makes them wait through a reveal the room has
seen. Both rules were implemented from D0 and neither was covered until D4;
`present-navigation.test.tsx` checks them by standing in for `SlideView` and
`SlideMotion` rather than adding attributes to production components for a test's
benefit, and each rule was verified by breaking it and watching its own case fail.

**`fitToDisplay`** (`editor-ui/src/lib/display-fit.ts`) names the letterbox rule
doc 04 §4.2 states: one factor for both axes, always. The deck is projected at
whatever aspect ratio the room has, and scaling each axis separately stretches
every glyph in a way nobody notices until it is six feet wide. Extracted because
it is a rule rather than an expression — present mode, the presenter's next-slide
preview and any future second-display path have to agree, and three `Math.min`
calls in three files are three places for one to become a `Math.max`.

**Measured in the app** (`DECKASTRA_SMOKE_STEP=timeline`): a clip dragged
0–252ms to 175–427ms, a keyframe handle dragged 0ms to 263ms with its sibling
untouched, and a deliberate overlap offering 8 fixes falling to 6 after one
click.

Two things that step taught, both about the harness rather than the product. It
edits the deck the app has open and **that deck keeps its changes between runs**,
so it targets the animation it just added rather than "the first bar", and it
asserts a fix leaves *fewer* conflicts rather than none — the absolute version
only held the first time. And a frame double whose `cancelAnimationFrame` did
nothing reported a late callback the browser would never have delivered; making
the double faithful was the fix, not a guard in the component.

### A transition is between two slides, so it keeps its own clock

D4.1, `packages/animation-engine/src/transition/`. The schema has carried slide
transitions, `morph` and `sharedElements` since v1 and nothing read them — the
`sharedElementMorph` preset said so itself, degrading to a crossfade because
"the transition engine supplies the delta" and there was no transition engine.

**Six modules, split along what each can be wrong about.** Pairing can be wrong
about *which* elements correspond, `delta` about *how far* one travels, a kind
about *what it looks like*, `compile` about *when*, `sample` about
*interpolation*, `css` about what a browser is told. Each is pure and knows
nothing of the others, so a test for one is a test for one thing. `from-scene`
is the only file that knows a renderer exists, which is what keeps the rest
testable with object literals. A new transition type is an entry in
`TRANSITION_KINDS` — the shape `presets.ts` already uses — rather than a branch
three other concerns also read.

**`t = 0` is when the incoming slide starts arriving.** Not a position in either
slide's timeline: both exist at once while it runs, so neither one's clock can be
the transition's. `entranceStartMs` holds the arriving slide's own entrances
until it ends, because an entrance that begins early animates relative to a
surface that is still moving.

**Two unrelated objects are never silently morphed** (doc 02 §26). Explicit
pairing wins; auto-pairing is **opt-in**, scored, and refuses below a threshold,
with every refusal kept and inspectable. A morph between things that are not the
same thing is an object visibly turning into an unrelated object in front of an
audience, which is worse than a cut. Deltas are centre-to-centre, because
corner-to-corner drifts exactly when the box resizes — the case a morph exists
for — and a pair that does not move emits no track at all.

**Present mode mounts both slides while one arrives** (`SlideTransition.tsx`).
The old arrangement rendered one slide with a CSS `animation` on it and could
never have drawn a morph: the element travels from where it was, and where it was
is on a slide that implementation had already unmounted. The renderer's own
`transitions.ts` is deleted rather than left beside the engine — it answered the
same questions differently, including "morph degrades to a fade".

Three bugs came out of building it, each the kind that fails silently:

- `easingAt` takes the easing **name** and answers `linear` for anything else, so
  compiling `easingToCss` into a track would have sampled every transition
  linearly with nothing failing anywhere. The compiled form carries the name.
- The scene build narrowed a transition to type, duration and easing, dropping
  `direction` and `sharedElements` — the two fields a push and a morph are made
  of. A fact the scene does not carry is one the engine cannot act on.
- The frame loop was keyed on the compiled object's *identity*: finishing set
  state, which re-rendered, which handed an unmemoized caller a fresh object,
  which restarted the transition that had just completed. Duration and type are
  what actually mean "a different transition".

The fixture earns its place the same way: adding the morph to `animation-test`
found a shape kind that does not exist, a headline that overflowed, and a
`style.radius` the round-trip silently dropped. Pixel baselines move with it —
`animation/2` rehashes and `animation/3` is new — and `linux-x64.json` needed
re-recording, which happened on 2026-09-17 (see "Recording a Linux pixel baseline
on a Windows machine").

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

### Cancelling an export stops the render

`request_cancel` set a flag and said the worker would "stop at the next
boundary". There was no boundary: `_invoke_worker` blocked in `subprocess.run`
until the renderer finished or the timeout expired, so a cancelled job went on
rendering — browser and all — and was marked cancelled once the work nobody
wanted was already done.

The exporter is now a `Popen` polled between short waits, and cancelling kills
the process **tree**, because the renderer starts the app's own Chromium and that
child outlives its parent otherwise.

That was `taskkill /F /T`, and it was **silently doing nothing on this machine**:
taskkill's tree walk goes through WMI, a damaged WMI repository answers "ERROR:
Provider not found" to every call, and `check=False` swallowed it. The caller
then waited out its ten-second grace and killed the parent alone — so a cancelled
export reported success while leaving a Chromium and its profile directory
running. A damaged WMI repository is an ordinary Windows state, not an exotic
one. `processes.terminate_tree` walks the tree with `CreateToolhelp32Snapshot`
instead, which is a kernel call with no service behind it, killing depth first so
a parent cannot outlive its children in the snapshot. The model supervisor uses
the same function. The half-written
artifact is deleted rather than published against a job that says "cancelled".

`cancellation_watcher` reads the flag on **its own connection**, and `run_job`
**commits** the "running" update rather than flushing it. The second half is the
one that mattered, and only a live cancellation found it: a flush left a write
transaction open for the whole render, and on SQLite that blocks every other
writer — so the cancel request could not commit its flag until the render had
finished. The poll was not wrong; the database was not allowed to answer it. The
row it produced said `cancel_requested = 1, status = completed`, which reads like
a broken poll and was actually a lock.

The unit tests could not have caught it: they call the invocation directly, with
no database in the picture, and passed throughout. The regression test that does
catch it drives `run_job` on a worker thread and cancels from another connection
— and was checked against the old behaviour before being trusted.

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
| `animation-test` | Every MVP trigger, preset shape and reduced-motion path — including click segments, a staggered group, a drawn path, and a shared-element morph with both `matchMode` permissions |

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

## Codex confirmation — 2026-09-12

Codex completed and verified the approved quiet-luxury redesign of the live
Deckastra deck **“My Life as a Rich Man”** (`doc_01M28YYBR38QF62927S6J5TMEB`).
The confirmed saved version is `ver_01M2947K198ZTJT7PG76H9C07E`, with no pending
proposals.

The six-slide 16:9 structure, narrative order, facts, prices, humor, stable IDs,
and editable elements were preserved. The final deck uses the **Quiet Luxury**
theme (Georgia display type, Inter body type), no more than three font sizes per
slide, 450 ms fade transitions, three click reveals on slide 4, and one click
reveal on slide 5. Full- and reduced-motion timeline compilation retain the same
click boundaries. A headless Chromium pixel pass found no remaining overlap or
clipping, the semantic validator reported no issues, and scoped accessibility
validation reported zero errors. Its five reading-order warnings were already
present before the redesign, so this work introduced no new accessibility
findings.
