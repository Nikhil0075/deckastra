# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Deckastra — an AI-native presentation studio. The product thesis, applied consistently across every design document: **agents propose, deterministic engines compose, humans stay in control.**

**Phase 8 of a 10-phase plan.** Built so far: `packages/presentation-schema`, `packages/presentation-core`, `packages/transactions`, `packages/renderer`, `packages/layout-engine`, `packages/editor`, `packages/animation-engine`, `packages/export-core`, `packages/export-pdf`, `packages/export-pptx`, `agents/`, `integrations/`, `apps/api`, `apps/web`, `apps/worker`. The remaining `packages/*` directories are empty placeholders reserved by `docs/05_MVP_SYSTEM_REPOSITORY_ARCHITECTURE.md` §4 — do not treat an empty directory as a missing implementation to fill in unless the current phase calls for it.

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

### The proposal lifecycle

An agent change becomes a *pending* transaction unless the risk tier says it can
apply now. Low risk applies immediately on purpose: making someone approve a typo
fix trains them to approve without reading, which is worse than not asking.

A proposal expires after 24 hours and is **re-validated on approval** against the
document as it stands. Between proposing and approving the deck may have moved,
and applying blind would apply a patch to something the approver never saw.

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

### Text is measured in the browser and estimated in Node

`buildDocumentScene` takes a `TextMeasurer`. The app passes `browserMeasurer()`,
which puts the real string in a real off-screen element and reads the line boxes
back; Node has no DOM, so it falls back to the estimator and flags
`metricsEstimated: true` so an export knows it is looking at a guess.

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
`apps/web/components/TextEditor.tsx`. Three rules there are not negotiable:

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
carries a negative control (a 1px nudge must change the hash) so the gate cannot
quietly stop being able to see anything.

Pixel baselines are **per platform**, because font rasterisation is. A platform
with no recorded baseline reports that and still enforces the determinism
properties; failing for a reason nobody on that OS can act on is how a gate gets
switched off.

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
back transforms; `apps/web/components/EditorCanvas.tsx` turns them into patches.

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

Text metrics are still estimated there — the scene is built in Node, where there
is no DOM — so every export reports `metricsEstimated: true`. The visual result
currently matches the editor because of the Phase 4 estimator calibration, but a
warning that fires every time is a warning nobody reads; closing it means the
batch text-measurement service doc 04 §31.2 describes.

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
- Content an agent did not write goes through `envelope()` — and the envelope
  escapes the delimiter, because content that can close its own tag continues
  outside it, where the model reads it as the operator talking. Detection of an
  injection attempt **warns and never filters**: the envelope is what makes it
  safe, and a filter would block a legitimate deck about prompt injection.
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
