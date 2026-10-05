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

### The Ask panel writes operations, like an external agent (2026-09-26)

With a real model configured, `agent/edit` runs `nodes/author.py` rather than the
four-verb `edit.py`. A person with a cloud key asked it to "add images and change
the theme to something light" and was refused: text, role, delete and reorder on
selected elements cannot add anything or touch a theme, however good the model.
An MCP client had no such ceiling, because it writes the patch and the product
holds it to account at the boundary. The built-in agent now does the same.

This is a deliberate exception to "nothing an agent emits carries geometry" for
**edits**, not for generation: a new deck is still planned in intent and
composed by code. What keeps an edit safe is everything after the node, which is
unchanged: `author_service.check` applies the operations to a copy and validates
the schema, a refusal goes back to the agent with the reason (three attempts in
all), and only a change that applies becomes a proposal, with risk computed from
the operations and a large change held for the person.

- **New ids are placeholders** (`el_new1`), minted by `author_service.materialise`
  the same way everywhere they appear. A model writing ULIDs gets the alphabet
  wrong.
- **Values travel as `value_json` text**: structured output cannot constrain a
  value that may be any JSON at all, so the server parses it.
- **Pictures come from the workspace**, listed to the agent by id and name, and
  their manifest entries are added server-side from the asset rows. The agent
  cannot download or make an image, and says so rather than drawing a frame.
- **Nothing selected is a request about the slide on screen**, or the deck when
  it says so. The panel no longer refuses to send one.
- The stub keeps the four verbs, because that is the path it exists to exercise
  without a key.

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
uses. Everything lives under one directory — which says where the bytes are and
**not** that copying them while the app runs is a backup (item 14, below).
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

# The Design tab: panels, a gradient background, a preset and its undo, an
# uploaded font, an equation, and both exports written beside the record.
DECKASTRA_SMOKE_DIR=<dir> DECKASTRA_SMOKE_STEP=design npx electron .

# Item 14: back up with a note still in its field, change the deck, restore, and
# find the earlier deck, the note and the recovery journal all back.
DECKASTRA_SMOKE_DIR=<dir> DECKASTRA_SMOKE_STEP=backup npx electron .

# Any step, on a profile of its own. Use this for every run on a machine where
# someone keeps real decks.
DECKASTRA_SMOKE_PROFILE=<empty dir> DECKASTRA_SMOKE_DIR=<dir> DECKASTRA_SMOKE_STEP=open npx electron .
```

**Give a smoke run its own profile (`DECKASTRA_SMOKE_PROFILE`).** Several steps
change the deck they find and leave the change there on purpose (`edit` adds a
shape for `verify` to find), so a run against someone's own profile edits their
work. That happened on 2026-09-19. The dev profile had been renamed aside to get
a "fresh" one, and `%APPDATA%\Deckastra` then resolved to the user's real data
instead: a session running inside a packaged host sees a private view of
`AppData` layered over the real one. The run added a rectangle to a real deck.
It was put back with a restore, which is itself a version, so the history shows
it. Renaming folders is not isolation. The variable sets `userData`, and with it
the service's data directory and the single-instance lock, before anything else
runs. It is honoured only when `DECKASTRA_SMOKE_DIR` is set.

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



**A named profile is the profile, and the gate on it was the bug** (item 25,
`main/profile.ts`). `DECKASTRA_SMOKE_PROFILE` was honoured only when
`DECKASTRA_SMOKE_DIR` was set too. That reads as defence in depth and is the
opposite: a process holding the profile and not the directory fell back to
Electron's own `userData`, which on Windows is `%APPDATA%\Deckastra` — a real
user's work. It is exactly the shape of the second instance this item has to
launch (the harness switched off, the profile kept), and on 2026-09-20 it duly
started a whole application against the real profile. Nothing was written,
because no step ran, and the real database's newest version was still the
previous day's; the point is that losing the override was **silent**, and it
pointed at the one directory the variable exists to keep runs away from. It is
one line in a file of its own now, with a test, because the failure mode is not
an error — the app starts, opens a deck, and the only sign it opened the wrong
person's deck is that it is the wrong deck.

**A backup is one moment, not one directory copy** (item 14, `backup.py`).
`local_server` has always said that everything lives under one directory, "so a
backup is a directory copy". That is true of where the bytes are and false of
*when* they agree. A live SQLite file copied by hand is whatever happened to be
flushed; the database, the checkpoints and the assets walked separately are
three different moments, and the seams between them are where a restored deck
comes to cite an image the backup does not carry.

The review's correction was to **define the boundary**, and each part of it is
one decision:

- The application database is taken with SQLite's **online backup API** — a
  consistent read of a database other connections are still writing — so nobody
  has to stop working to be backed up.
- The checkpoints database is taken **after** it. A run parked between the two
  leaves a checkpoint with no run row, which nothing reads; the other order
  leaves a run with no checkpoint, which is the paused outline someone was in
  the middle of, now unresumable.
- The assets copied are the ones the **snapshot** names, never the live
  database, so the rows and the files are one moment.
- Deleting asset bytes is **held** for the duration (`deletions_held`, taken by
  the sweeper), so a file the snapshot references cannot be swept out from under
  it. New uploads are not held: the snapshot does not name them.

**The two halves run in different processes, and that is the design.** The
*service* takes the backup, because it owns the writers. A *restore* cannot: it
replaces the database the service has open, so the app stops the service, runs
the service binary once (`--restore-from`), and starts it again. What the main
process contributes is the dialogs and the **recovery journals** — those live in
browser storage inside a renderer, outside the directory the service knows
about, so a backup taken by the service alone would carry every saved deck and
none of the work someone had typed and not saved. They are carried verbatim: the
format belongs to `editor-recovery.ts`, and a backup that parsed it would be a
second definition to drift.

**The renderer still names no path.** This is the feature that most wanted to
break that rule. The menu item is main's, the dialog is main's, and the one
place a path crosses a boundary is main to the service — where the route needs
`administer`, which no grant carries, so an agent cannot ask for every deck to be
written to a folder it chose.

A manifest records the counts and a SHA-256 of every file, and **names assets
whose bytes were already missing** rather than leaving them out: "40 assets" and
"40 assets, one of which was already gone" are different facts, and a missing
entry cannot tell them apart. `verify` refuses a damaged, incomplete,
wrong-format or merely-not-a-database backup **before** a restore touches
anything, and what a restore replaces is moved aside rather than deleted — a
restore is what someone reaches for when something has already gone wrong, which
is the worst moment to make the previous state unrecoverable.

**The acceptance step records which half of a backup holds the unsaved work,
and does not assert it.** Settling a window's drafts takes a note into the
document and the recovery journal; whether the *save* has also been acknowledged
by the time the snapshot is asked for is a race, and `journalled` is a
legitimate answer — it is the answer item 01's barrier exists to make honest.
The step's first version asserted the note was in the backed-up **database**,
which passed standalone and failed in the full sweep; the note was in the
backup the whole time, in the journal. What it asserts now is that the note is
in one of the two, because being in neither is the only outcome that would be
wrong. `noteCarriedBy` is in the record, so the run says which it was — on
2026-09-20, `journal`.

Two harness lessons, both already learned elsewhere in this file and both
re-learned here. A step that drives a UI has to be able to say **where it
arrived**: the first failure was indistinguishable from the typing never
landing, until the step read the field back (it had landed). And a step that
passes standalone and fails in a sweep is usually asserting a timing, not a
behaviour.

**Writing the documentation found a real gap**, which is the argument for
writing it. `docs/UPGRADING.md` says a restore "checks the whole backup before
it replaces anything", and checking that sentence showed it was true of the
files and not of the *schema*: a backup written by a newer build verified
cleanly, the data was replaced, and only the migration afterwards refused —
leaving the person's own decks in `replaced-…` and an install that would not
open. Nothing was lost, because nothing is deleted, but it is a recovery nobody
should be put through for a refusal that could have come first. `restore` now
runs the same check on the backup's own database before touching anything, and
the regression test re-hashes the manifest so the refusal has to come from the
schema rather than from a checksum that happens to disagree.

**Exports are not in a backup**, said in `docs/UPGRADING.md` rather than
discovered: an export is a derived file whose row records an absolute path, so
carrying the bytes to another profile would restore rows pointing where the file
is not.

**An older build refuses a database a newer one wrote** (item 15,
`check_schema_supported`). Manual upgrades make this real — someone reinstalls
the version they still have the installer for. Alembic already refused it by
accident, unable to find the recorded revision, but the message was about
revision identifiers and the person needs to be told which of the two things to
do: install the newer version again, or restore a backup. It is a **refusal, not
a repair**; there is no downgrade path, and running this build's migrations
against that file would be guessing with someone's decks. It classifies as a
`migration` failure, so item 17's rule holds over it — nothing offers to clear
the workspace to make the app start.

**A migration failure is fatal on purpose**, which is the other half of item 15:
a half-migrated database must not go on to `seed()`, because seeding an install
whose tables are in an unknown state is exactly how a partial upgrade comes to
open as an empty workspace while the decks are still on the disk.

**The rehearsal runs against a profile with work in it.** Every migration here
had only ever run against an empty file, where "the upgrade succeeded" and "the
upgrade kept anything" are the same sentence.
`apps/api/tests/test_migration_rehearsal.py` builds a profile at an older
revision — writing its rows by **introspecting the schema as it was**, because a
fixed INSERT would have to be edited every time the columns move, which is how a
rehearsal quietly stops rehearsing — and asserts the deck *and its version
chain* survive the upgrade.

**Measured in the app, 2026-09-20.** A real profile was created by the app,
rewound three revisions with Alembic, and relaunched: it migrated to head and
`open`, `edit` and `verify` were green with the deck intact. The same profile
marked as written by a later build is refused with the written message, and the
deck is still there afterwards — it does not open as an empty workspace, which
is the failure the item names.

**Upgrades are manual, and written down** (item 16, `docs/UPGRADING.md`). There
is no updater, and that is a decision: an updater that can replace the
application is a channel that has to be signed, signing is not done in
0.9.0-beta.1, and an unsigned update channel is worse than none. The policy is
only worth having if what survives the swap is stated and checked, so the
document says what is kept (decks, history, images, paused outlines, the cloud
key, the open deck) and what is not — **agent consent, on every version change,
including a downgrade**. Consent was given to a particular build to let
something else on the machine reach these decks; a permission that survives
every upgrade is one nobody revisits. `tests/upgrade.test.ts` drives one profile
across a version change and holds all of it, including that the *same* version is
not an upgrade — otherwise every launch would revoke the last one's consent.

Running the two real installers end to end is **item 26 and the user's run**. It
is not claimed here on development-build evidence.

**What a published credential may do, checked on the build that ships** (item
25, the `grants` acceptance step). The `consent` step covers the *decision* —
off until asked, on when asked, withdrawn and revoked when stopped. This covers
what the credential **is** once published, and every case in it is one a
development consent test cannot reach.

Measured against `release/win-unpacked` on 2026-09-20, `packaged: true`, with
nothing from this repository on the path:

| | |
| --- | --- |
| Published | attachment v2, scopes `read, write, export`, 12 hours |
| Read the account | 200 |
| Approve, share, delete a deck, back up, revoke grants | **403** each |
| Attachment permissions | one ACL entry: this account, full control |
| A real second instance | exits 0 in 3.6s; the first instance's grant still works |
| After a service restart | the old grant 401, the republished one 200 |

Those five refusals are the point, and they come from the **service's** scope
table rather than from which tools an adapter registered — the distinction the
D2 closure audit was about. Expiry is checked as the *published window* rather
than by sleeping twelve hours; the arithmetic is unit-tested and
`local_mode.scopes_for` refusing a lapsed claim is a Python test.

**A second instance cannot be checked from inside the first**, which is why
this one is spawned for real. The lock used to sit at the bottom of `index.ts`,
quitting the second instance correctly and then letting its startup run anyway
— withdrawing the first instance's attachment on the way out, so an attached
agent lost access because somebody double-clicked the icon.

**And the shipped MCP server drove the whole journey on a credential nobody
forged.** Consent was given through the packaged window in one run and left
there; an ordinary launch of the same build — no harness — honoured it and
republished the attachment, which is the product's own path rather than a file
a test wrote. `apps/mcp-server/scripts/acceptance.mjs`, pointed at
`resources/mcp/cli.mjs` inside the package and run by the app's own binary
under `ELECTRON_RUN_AS_NODE`, then passed **16/16**: attach, refuse to offer
approval or sharing at all, create a deck of its own, apply a low-risk change,
be refused a stale one, plan motion in roles, pair elements across slides,
refuse to carry them on a push, render a preview, leave a destructive change
pending as `mcp:acceptance`, cancel a running export, and finish one. Closing
the app withdrew the attachment and left no process behind.

**Open, and it is the user's run:** the installer asks for elevation (exit 1223
twice, unattended), so the candidate has not been driven from
`%LOCALAPPDATA%\Programs\Deckastra`. A packaged payload is the same files an
installer lays down, and running it is strong evidence — it is not evidence
about the installer, which is item 26.

**The candidate, with none of the things a developer has** (item 26). The run
that matters is the packaged payload copied **outside the checkout**, driven
with `python`, `node`, `npm`, `npx` and `tsx` removed from `PATH` and
`PLAYWRIGHT_BROWSERS_PATH` emptied — and the script proves the scrub before it
trusts anything the run reports, because a packaged app that quietly reached
back into a developer's machine would pass every run on that machine and fail
on the first real one.

Measured 2026-09-20, 947 files and 729MB copied to a directory of its own:
**20 acceptance steps green**, `packaged: true`, zero CSP violations — open,
edit, verify, slides, history, export, motion, presenter, decks, present,
timeline, morph, consent, menu, intelligence, windows, resilience, backup,
grants, with `a11y` **skipped by name** because axe-core is a development
dependency this build deliberately does not ship.

**A step that cannot apply must say so rather than go red.** Two reported
failures on the first clean run and both were the product working as designed:
axe-core absent, and generation refusing the stub because a distributed build
does (items 19 and 20). A packaged run failing on those is how everyone learns
to ignore a red step, so each now records why it did not apply. The second one
took three goes, and each failure is the same lesson: a skip must rest on
something that does not depend on rendering. The first keyed on a
`[role="alert"]`, which the drawer does not use; the second on the route
panel's words, which the step only reaches *after* asserting the Generate
button is enabled — and on a packaged build that button is **disabled**, which
is item 19 working. It asks `/v1/account` for `capabilities.generation` now,
before touching the deck list at all.

**The artifacts were read by things that are not us**, which is the gate's
point: `pypdf` 6.17 and `python-pptx` 1.0.2 are independent implementations of
the same specifications, and a package they refuse is one PowerPoint refuses.
The PDF came back as 4 pages at 1440×810pt with extractable text and a byte
count matching the export row exactly, stored inside the profile. The PPTX came
back as 4 slides at 13.33×7.5in with real text boxes and shapes — and its
speaker notes read back as the exact sentence the harness had typed into the
editor's notes field a moment before exporting.

**Which is how a real bug surfaced.** `python-pptx` did not disagree about the
notes; it **raised**. The part is `ppt/notesSlides/notesSlide1.xml` and the
element inside it is `<p:notes>`, not `<p:notesSlide>` — two different names for
one thing, and this wrote the wrong one. So every speaker note this product had
ever exported to PowerPoint sat in an element no conforming reader looks for.
Nothing failed while the only thing reading these files was the code that wrote
them.

The test that should have caught it could not: `test_speaker_notes_survive`
asserted the fixture's slides had **no** notes, which is true of a correct
exporter and equally true of a broken one. It injects a two-line note and reads
it back now, and the control fails with the old element restored. That is the
same shape as the four tests D4.4 found asserting nothing — a test that checks
an absence proves nothing about the presence.

**A failed save must not destroy the file it was replacing** (`main/save-file.ts`).
`writeFile(target, bytes)` truncates the target *before* it writes, so a disk
that filled, a network drive that went away or a permission revoked between the
dialog and the write left the person with **neither** the new export nor the one
they were overwriting. The bytes go to a sibling and are renamed over the target
only once they are all on disk — a sibling rather than the system temp
directory, because a rename is atomic only within a volume.

Two things about testing that are worth keeping. The first suite **passed
against the broken code**: it stood in for a full disk with an impossible path,
which fails *before* the target is touched. And **mocking `node:fs/promises`
does not work in this runner at all**, established with a throwaway diagnostic
rather than assumed — without checking, the failure path would have been
asserted by nothing while the suite stayed green. The operations are injected
now, the way `assets.sweep` takes its `remove`, and what is asserted is the
property that makes the damage impossible: **the target is never opened for
writing**. A genuinely full volume is not reproduced and is on the checklist.

**Open, and it is the user's run:** the installer wants elevation (`/S` exits
1223 twice, unattended), so nothing here was driven from
`%LOCALAPPDATA%\Programs\Deckastra`; a clean account or Windows Sandbox is a
machine rather than a command; images are not in this evidence, because the deck
an install opens carries none (the picture path is covered by
`test_pptx_opens.py` against `technical-deck`); and a real disk-full and a
denied destination are the user's to provoke.

**Sixty slides, not five** (item 30, the `performance` acceptance step). Every
performance number this project had recorded came from a five-slide fixture
that fits in a cache, and the register says why that is not enough: "a small
fixture's working-set sample is not a memory qualification". The deck is built
by repeating both seed fixtures' slides with fresh ids — known-valid content
rather than sixty slides of whatever a generator's author thought of — and
renumbered **a block at a time**, because a morph names elements on the slide
before it and renumbering slides in isolation breaks exactly the cross-slide
references this deck exists to exercise, silently, since the result still
validates as a deck with an unpaired morph.

The pictures are real, uploaded through the product's own begin/PUT/complete
path, and there is one on **every** slide: repeating the fixtures gives seven
across sixty, because only one fixture slide in ten carries an image, and seven
decodes measure almost none of the cost this deck is for.

**The budgets are judged by the product's own code** — `checkBudget` and
`checkFrameBudget` from `@deckastra/renderer/perf`, with the page collecting raw
frame intervals and the main process judging them. A harness with its own copy
of the thresholds is a second place for them to be wrong, and the frame budget
is exactly the kind that drifts: a drag is within budget when the work fits in
frames the compositor was going to paint anyway, which can only be judged
against the display's own cadence.

**Measured 2026-09-20**, Intel i5-9300H (8 threads), 12,140MB RAM with 1,376MB
free, development build. 60 slides, 323 elements, 41 groups, 67 images, 13
animated slides, 60 transitions:

| | | |
| --- | --- | --- |
| Cold open to an editable deck | 487ms | — |
| Thumbnail strip, 60 slides | 523ms | 1000ms |
| Slide switch, warm | 15ms median | 120ms |
| Drag | 0% dropped, 16.8ms p95 at ~60Hz | ≤5% dropped |
| Export, cold then warm | 30.8s then 12.7s, 1.87MB PDF | — |

**Memory across repeated navigation settles.** Six rounds of twenty slide
switches: 492MB after opening, then +38.0, +14.4, +16.6, +11.7, +5.8, +2.4MB —
a curve that flattens, which is a cache filling rather than a leak. Three rounds
could not have said so; the first three increments alone are a straight line,
and a leak and a cache look identical there. After two exports it falls to
412MB, below where it started, so the growth is reclaimed as well as bounded.

**The run found a real bug, and the retry had been hiding it.** `withPage`
wraps the *whole* export — the lease, the browser starting, every slide's text
measurement and the render — under `RENDER_TIMEOUT_MS`, a flat 20 seconds.
Ample for five slides; not enough for sixty with photographs. The first
measured export died on that deadline and succeeded only because
`export_service` retried it into a warm browser, leaving a row marked
`completed` carrying the failed attempt's error text — which reads like a
transient blip rather than a limit nobody had scaled since the fixtures were
written. The deadline exists to stop a **wedged** render holding the sole page
lease forever, and that purpose is served by a bound that grows with the work:
`renderDeadlineFor` is 20s plus 1.5s a slide. After it, both exports completed
with `attempts: 1` and no error.

**And three bugs in the harness, each of which reported something false.**
Importing `@deckastra/renderer` into the **main** process dragged in the schema
and its `ulid` dependency, whose PRNG detection throws at import time there —
an unhandled rejection that took the whole app down before it opened a window,
for every step, with the symptom "the step is taking a long time". The export
poll read `started.export_id` where the route returns `id`, so it asked for
`/exports/undefined` for five minutes and called that a timeout while both
exports had finished in under one. And the thumbnail strip read 13ms against a
1000ms budget, which is not sixty thumbnails rendering but sixty thumbnails
already being there, because the timer started after the canvas appeared.

All three are the same failure: a check that cannot tell "the product is slow"
from "I asked the wrong question". The poll now fails loudly on a bad response,
the strip is timed from the navigation and records how many thumbnails existed
when the canvas did, and the harness records the **machine** — total and free
memory, CPU, load — because the first attempt ran with 701MB free and took 65
seconds to open a four-slide deck. That number describes the machine, and a
number with no machine beside it is how such a figure gets quoted later as a
budget.

**Not measured:** a packaged build (these are development-build numbers), a
sustained session of hours rather than minutes, and the advertised minimum RAM —
this machine has 12GB and the run never went near a limit.

**A privileged request must come from a window this app opened** (item 34,
`main/ipc-guard.ts`). Every privileged operation arrives on a channel the
preload exposes — open a deck, write a file, store an API key, allow agents,
restart the service — and the handlers used to answer whoever asked and take
whatever arrived. Nothing was observed exploiting that; it is the structural gap
the review named. Now a request is answered only for the **main frame** of a
**window this app created**, on **its own origin**: a sub-frame is refused even
on our origin, because a frame is where embedded content would be, and an origin
that merely starts the same (`deckastra://app.evil.example`) is not our origin.

Payloads are checked at that boundary rather than in each handler: an id must be
one this product minted, a file name must be a name and not a path, bytes are
bounded because they are held in memory to write them, and a permission must be
a boolean. An invoke is **refused** with a message rather than ignored — the
caller is waiting, and "nothing happened" is indistinguishable from a bug — while
a fire-and-forget message is dropped.

**An installed launch leaves something behind** (item 18, `main/logs.ts`).
Two small rotating files in the profile — what the app did, and what its service
printed — because a packaged app has no terminal, and until now a failed start
left nothing to read. Help > Export diagnostics writes one JSON report: the
build manifest, the runtime, where the data is, why the service is not running,
which generation route is configured, whether a key is set, whether agents are
allowed, and the tail of both logs.

**What is written is chosen, not filtered.** The review's correction, and it is
the whole design: a pass that tries to recognise arbitrary document text in
arbitrary output cannot be relied on, so nothing here logs prompts, briefs,
slide text or deck titles in the first place. The app's own entries are an event
name and named fields; the one stream that is not ours — the service's stderr —
goes through `redact`, which removes the credentials whose *shape* is known: API
keys, bearer tokens, the launch secret, an agent grant. That is a narrow claim
and it is the only one made. The report says a key is *set*, never what it is.
Checked in the running app by the `menu` step, which writes a real report and
looks for the live secret in it.

**A service that will not start is something to act on** (item 17). It used to
show the reason and nothing else, which leaves a person with a sentence and the
task manager. `classifyFailure` tells the cases apart — a missing binary, a
permission refusal, a migration that could not run, a build mismatch, a crash —
and each gets its own advice, because the useful answer differs. **None of them
offers to clear the workspace**: a migration that failed is exactly the case
where the data matters more than the app starting, and a test asserts no advice
ever instructs anyone to delete anything. A retry is offered only where one
could work (not for a missing install or a mismatched pair), it is one attempt
per press, and it says "it still could not start" rather than appearing to do
nothing. The same control sits in the outage banner, so the editor stays mounted
and the person can bring the service back from where they are — which is what
the `resilience` step now does instead of reaching for the harness's own switch.

**CI builds the desktop app on Windows** (item 10). Until this job existed,
nothing in CI built the product at all: the suites run on Linux, and a broken
preload, a missing PyInstaller import or a failing acceptance step could not
turn the build red. The job runs on `windows-latest` — the platform the release
ships for, which is the only place those failures happen — and does the whole
sequence: bundles, the frozen service from the hashed lock, the SBOM, the
manifest, then the acceptance steps that need no second display. An unsigned
installer only on demand, because it costs minutes and 250MB. **It has not yet
run on a runner**; every command in it was run locally on this machine.

**The service is built from a lock, into a clean environment** (item 09).
`apps/desktop/sidecar-requirements.lock` pins 97 packages with hashes,
compiled from `sidecar-requirements.in` (the API's requirements plus
PyInstaller, which decides how the binary is laid out). `build-sidecar.mjs`
makes a virtual environment, installs with `--require-hashes` and freezes from
that — so the binary is built from bytes that are written down rather than from
whatever a developer's global site-packages holds, and a tampered package fails
the install rather than shipping. The environment is reused while a stamp says
it was made from this lock, because a venv built from an older one is the
silent mismatch this exists to prevent. `DECKASTRA_SIDECAR_PYTHON=system` skips
it for a quick development build and says the artifact is not reproducible.

The lock resolves for the platform it is compiled on: Windows x64 / CPython
3.13, which is this release. `scripts/sbom.mjs` writes CycloneDX from that same
lock — names, versions and the hashes pip verified — plus the npm packages the
bundles were built from, and both the lock and the SBOM are hashed into the
build manifest. It is an inventory, not a licence audit; what may be
redistributed is item 33.

**Everything the frozen service reads by path is required** (item 08). The
bundled data used to be filtered with `existsSync`, so a path that moved or a
checkout that had never run `schema:emit` produced a binary quietly missing its
migrations, its schema or the agent prompts — and the failure arrived on a
user's machine with nothing naming the cause. `scripts/sidecar-data.mjs` is the
list and the check; an empty directory counts as missing, because it ships
nothing.

**A build says what it is** (item 07, `apps/desktop/scripts/manifest.mjs`).
`dist/build-manifest.json` records the commit, a hash over every changed *and
untracked* source file (this tree is never clean, so the commit alone is not
identity), the build time, the runtime versions, and a hash of each payload:
the app bundle, the exporter, the MCP server and the frozen service.

**It is written after the payloads, never before.** `build.mjs` runs before the
sidecar is frozen, so a manifest written there would name a sidecar that did not
exist — the review's correction. It is its own step between `build:sidecar` and
`electron-builder`, and it records `complete: false` when something it expects
to hash is missing, which a release build refuses.

**And it is what catches a stale service beside a new window.** The manifest
hashes the migrations it bundled; `/health` reports the hash of the migrations
the service is actually running (`paths.tree_digest`); the app compares them
before it calls the service ready, and refuses a mismatched pair rather than
letting it migrate a database in a direction this build does not expect. Silence
on either side is not a mismatch — a checkout has no manifest and an older
service reports nothing — because refusing on silence would refuse every
development run. Two implementations of one definition, held to one answer by
`apps/api/tests/test_build_identity.py`, which runs both: the same rule as the
patch appliers.

**The runtime is Electron 44** (item 05, 2026-09-20). Electron 33 left support
on 29 April 2025 — the policy is the latest three majors — so a product about to
be distributed was running eleven majors behind on a runtime nobody patches.
44.4.3 brings Chromium 152 and Node 24. Two things changed with it, and both
are the kind that fail quietly:

- **`printToPDF` dropped `marginType`.** Explicit zero margins are what "none"
  meant, and this path has always printed edge to edge — the slide is the page.
  A type error caught it; a JavaScript codebase would have shipped default
  margins into every exported PDF.
- **`console-message` passes an event object**, not positional arguments. The
  harness reads the console to fail on CSP violations, and positional arguments
  still worked while printing a deprecation warning — so the check would have
  gone on passing right up until the arguments were removed.

The gate that matters for a runtime change is parity: the `digest` step rebuilds
all three fixtures' scene digests **inside Electron's own Chromium** and
compares them byte for byte with the committed Node baselines. They match on
152 as they did on 130. `electron-builder` moved to 26.15.3 with it, since it is
what has to understand the new runtime when the installer is built.

Two environment notes that cost an hour each if unknown:

- **`electron`'s binary comes from GitHub releases.** Where that is unreachable,
  `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ npm install`
  works.
- **Packaging downloads Electron from GitHub unless told not to.** Where GitHub
  is unreachable (`EHOSTUNREACH`; npm still works), pass the copy npm already
  installed, which is the same pinned version:
  `npx electron-builder --publish never -c.electronDist=../../node_modules/electron/dist`
  from `apps/desktop`. Used for the 2026-09-26 installer.
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

**Withdrawing is not rejecting** (`proposal_withdraw`, 2026-09-26). Rejecting
needs `approve`, which no grant carries, so an agent that saw a mistake in its
own pending change could only ask the person to reject it. Withdrawing needs
`write`: nothing applies and nobody else's work is decided. It is refused for a
proposal the product's own agents made (the person's to decide) and for another
agent's by label — a label is not an authenticated identity, so that stops
accidents, not attacks; the grant is the boundary. It is recorded as `rejected`
with "Withdrawn by mcp:…" in the reason, because a status of its own would
rebuild the transactions table on every install for what the reason says.

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

### The editor chrome is Bauhaus, and the palette is enforced (UI rewrite, Phase 0)

The rewrite to the "DeckOS — Editor UI (Minimal)" Figma is phased; the plan and
`docs/FRONTEND_REQUIREMENTS.md` say what each phase delivers and which
behavioural rules it must not break. Phase 0 is the foundation, in
`packages/editor-ui`: tokens in `src/styles/tokens.css` (`--dk-*`), primitive
styles in `src/styles/components.css` (`.dk-*`), and the primitives themselves
in `src/ui` (Button, IconButton, NumberField, Menu, Select, Segmented, Tabs,
Section, StatusChip, Popover, Drawer, …). Their keyboard and number rules are
pure functions in `src/lib/ui-keys.ts`.

Each primary colour has one meaning: **blue** is the action, **yellow** is
"waiting on a human", **red** is danger or a finding. That only holds if screens
cannot choose colours, so status colour is reachable only through `StatusChip`
and `components.css` may not contain a colour literal. `tests/ui-tokens.test.ts`
reads the CSS files and fails on a literal, an undefined or legacy token, a
rounded corner (except the status dot), or any text/background pair below AA.
It was checked by restoring the first-draft red (#d52b1e, 4.36:1 on cream).
Yellow is never a text colour: it fails on cream.

Two editing rules the inspector will depend on. `NumberField` commits once per
intent (Enter, blur, arrow step), never per keystroke, and refuses invalid or
out-of-range text rather than clamping it. `Select` applies only the option
chosen, not every one arrowed past. Either mistake fills the undo history with
edits nobody made.

The fonts are Inter (UI) and Jost (geometric display), both OFL-1.1, bundled
from `@fontsource-variable` as local woff2. The desktop CSP allows no remote
fonts, and a CDN face would fall back to the system font offline. Both shells'
bundlers (Vite, Next) resolve the `@import`s in `styles.css`. The legacy
`--bg`/`--fg` tokens stay until the last pre-rewrite component is replaced;
the dark set from the Figma's Page 1 will be `[data-dk-theme="dark"]`. Slide
rendering is untouched: none of this reaches `SlideView` in export mode.

**Phase 1: the shell is the Figma main screen.** `EditorShell` now owns only
actions and the keyboard. The layout is in `components/shell/` (AppBar,
ToolRail, SlideStrip, CanvasStage, ModePanels) and `components/inspector/`.
Mode (Design/AI/Motion/Code) and zoom are editor state (`lib/editor-layout.ts`)
and never reach the document. Code mode edits canonical JSON, but remains a
second view rather than a second mutation path: strict JSON is parsed, locked
identity fields are checked, the complete candidate is validated and an
id-addressed patch is handed to `editor.apply`. Rules that are easy to undo:

- **The desktop harness finds controls by `data-testid`, not text.** The rail
  is icons, so exact-text lookups for "Rect", "Undo" or "+ Slide" find nothing.
  The ids are `tool-*`, `undo`, `redo`, `add-slide`, `slide-thumb` (one per
  slide, used for counts), `present`, `open-export`, `export-popover`,
  `agent-access-open`, `agent-access-toggle` and `save-status` (with
  `data-save-status`). Renaming one breaks `apps/desktop/src/main/smoke.ts`:
  change both in the same commit.
- **Save-status text stays sentence case.** The harness reads "Saved" and
  "Save changes" from `innerText`, which applies `text-transform`. An
  uppercased `Button` label would read "SAVE CHANGES", and the unwind step's
  refusal check would silently never match.
- **The global shortcut handler skips `defaultPrevented` events.** The mode
  switch, menus and selects handle arrows first. Without the skip, ArrowRight
  on the mode switch would also nudge the selected object.
- **`.dk-legacy-bridge` remaps the old `--bg`/`--fg` tokens onto the palette**
  inside the shell, so panels not yet rewritten (motion, share, export, AI,
  theme, accessibility) render light rather than as dark islands. Their own
  `h3` is hidden inside a `Section`, whose title already says it. Both rules go
  as each panel is rewritten.
- **Export's popover is `keepMounted`**: the panel polls a running job, and
  closing the popover must not forget it. `.dk-popover[hidden]` is forced to
  `display: none` so no panel class can show a closed popover. The agent-access
  popover did exactly that before the rule existed.
- Hosts put controls in the bar through `EditorShell`'s `barExtras` (the
  desktop's agent-access chip) and banners through `notices` (the service
  outage banner), drawn with the primitives from `@deckastra/editor-ui/ui`.
  An outage banner is still a banner inside the mounted editor, never a
  replacement.

Verified in the desktop app on a fresh profile (2026-09-19): `open`, `edit`,
`verify`, `present`, `export`, `timeline`, `morph` and `consent` all pass with
no CSP violations.

**Phase 2: slides are managed from the strip, and notes are written under the
canvas.** The logic is in `lib/slide-actions.ts` and the gestures in
`shell/SlideStrip.tsx` and `shell/SpeakerNotes.tsx`. Reorder has three routes,
because a drag is not available to everyone: drag the handle, press Alt+↑/↓ on
a focused thumbnail, or use Move up/down in the slide menu. Four rules:

- **A slide is deleted with everything that pointed into it, in one patch**
  (`deleteSlideOperations` in `presentation-core/references.ts`). `removeSlide`
  alone leaves the next slide's morph pairs (E104), jump-to-slide links (E105)
  and cross-slide animations (E101) dangling, and each is a validation error.
  The tests show the old path failing first. Morph mappings have no id, so a
  slide losing a pair's half gets its whole `sharedElements` array replaced by
  the survivors. That shape now has a case in `test_patch_conformance.py`. The
  last slide cannot be deleted.
- **A reorder that separates a morph is reported, not refused.** Both elements
  still exist, so nothing breaks a reference. The transition engine would drop
  the pair silently at playback. `misplacedMorphPairs` is compared before and
  after, and the editor names the separated pairs when the move happens.
- **Notes edit a draft and commit on blur or after 700ms idle**, never during
  an IME composition. A pending draft is committed to the slide it was written
  on before the slide changes, and it is one undo step per session (coalesce
  key). Plain notes stay a string. Rich notes stay rich text, one paragraph per
  line, reusing block ids. Clearing the field removes the property.
- **Deleting a slide other than the current one keeps the same slide on
  screen.** The index follows it rather than the position.

The `slides` smoke step drives all of this through the strip. It checks each
result against the stored document, read back through the page's own proxy
(`/__api`), then deletes its slides through the menu and asserts the deck ends
in its original order.

**Phase 3: present mode and the presenter view.** The audience view is black
with a bottom-left control cluster and reveal squares. The presenter view is
cream: display-face timer, Current and Next, "Step X of Y", notes, time
remaining against a session target, End and Black screen. The rules are in
`lib/presenter.ts` and the protocol in `lib/presentSync.ts`.

- **The audience window is the authority on the talk.** It alone plays the
  slide's motion, so it alone knows which reveal is showing. It broadcasts
  `state` (`{index, step, blacked}`) after every change. A presenter window
  sends `command`s (`advance` ±1, `black`) instead of moving itself, so Next on
  the laptop reveals the next bullet on the projector rather than skipping
  past it. Only those two commands are accepted, and anything else is ignored.
- **The audience acknowledges a command before acting on it.** The presenter
  window moves the slide itself if nothing answers within 500ms, so a closed
  projector window cannot strand a presenter. The real answer waits for an
  animation frame that a minimised window may throttle. Without the immediate
  acknowledgement, the laptop would skip the reveal it asked for.
- **Step counts come from the same compiled timeline the audience plays**
  (`clickSteps`, `SlideMotionHandle.step()`), so the two windows cannot
  disagree. A slide with no reveals has no step line: "Step 1 of 1" tells a
  presenter nothing.
- **The target length is session state and is never guessed.** Remaining time
  appears only once a presenter sets a target. Past it, the number reads as
  time *over*, in red and in words.
- **The blackout warning renders outside the preview's size gate.** Whether the
  room sees a black screen matters more than the preview, so it shows even
  before the preview has been measured.

**Fixed: the slide a talk started on never played its motion.** `SlideMotion`
looks up its elements under `[data-present-stage]` once, in its mount effect.
It used to mount in present mode's first render, before the container was
measured and the stage drawn, so it found nothing and never looked again. The
opening slide's entrances and click reveals did nothing. On a slide whose
elements rest invisible (the animation fixture's first slide), the room saw a
blank slide. The `morph` step never caught it, because it walks away from the
opening slide before looking. The new `presenter` step caught it: Next on the
laptop changed slide instead of revealing a bullet. SlideMotion now mounts only
once the stage exists. `present-navigation.test.tsx` has the regression test,
which was checked against the old behaviour.

The `presenter` smoke step drives two real windows over the real
BroadcastChannel. Next on the laptop must advance the projector's step without
changing its slide, and the laptop must follow ("Step 2 of 3"). Black screen on
the laptop must black out the projector, and the laptop must say so. Each claim
is read from the window it is about. The harness hit the text-transform trap
again here: an uppercase label reads uppercase through `innerText`, so it checks
`textContent`.

**Phase 4: the deck list.** `DeckList` (editor-ui) shows projects on the left
and cards on the right: a thumbnail, the name, "12 slides · edited 2h ago", a
yellow pending badge, and Open / Duplicate / Move to project… / Export /
Delete. It has no routing; the shell decides what opening means. The desktop
still opens the last deck on launch, and "All decks" in the editor's bar goes
to the list. Six rules:

- **The main process owns "which deck is open"**
  (`IPC.openPresentation`, `workspace-state.rememberPresentation`). The
  presenter window loads that deck, and the agent attachment names it, so a
  list that switched decks only in the renderer would leave both pointing at
  the old one. The id is shape-checked and confirmed through the service
  before it is remembered. If the remembered deck is gone on launch, the most
  recent remaining deck opens. The sample is seeded only when there are no
  decks at all.
- **Leaving a deck waits for its save queue** (`EditorShell`'s exit awaits
  `saveNow()`, and stays and says so on `false`). The editor unmounts on
  leaving, and with it the queue.
- **Delete is soft** (`presentations.deleted_at`, shown in the UI with Undo).
  `resolve_presentation_access` treats a deleted deck as missing everywhere.
  So does `sharing.resolve`: a deleted deck's share link stops working, and
  comes back on `restore`. The trash is `GET …/presentations?deleted=true`.
- **Duplicate mints fresh ids for everything the deck defines and rewrites
  every reference** (`deck_copy.duplicate_document`), including cross-slide
  morph pairs and the Critic's slide-keyed issues. Asset and theme ids are kept
  deliberately, because they name stored rows. The copy starts its own history.
- **Neither delete nor duplicate touches a deck in a synced workspace (409).**
  There is no sync for either yet, and a local-only act on a shared deck is the
  kind of quiet divergence D5 exists to prevent.
- **`presentations.slide_count` is maintained by every commit**, like `title`,
  so the list never replays a deck to count it. Rows from before the column
  existed are counted once, on first listing. The pending-changes badge is one
  grouped count.

**Thumbnails show the final frame** (`FinalFrameSlide`), in the deck list and
the slide strip. Drawing the resting document gave a black card for any slide
whose content fades in. The thumbnail uses the motion engine's own
`enterAtEnd`, scoped to itself, and is mounted after the slide so the
Phase 3 mount-order bug cannot recur. This closes the deferred Phase 2 item.

The local account's workspace is now "Your workspace", not "You's workspace"
(`auth.personal_workspace_name`). Existing installs are repaired only when the
name is exactly the old generated string.

The `decks` smoke step leaves the editor for the list and duplicates a deck from
its card. It opens the copy and asserts the **main process** now names the copy
as open. It then deletes the copy, checks that Undo restores it, deletes it
again, and reopens the original.

(Resolved in Phase 4: a slide whose elements rest at `opacity: 0` and fade in
used to show a blank thumbnail. Thumbnails now show the final frame; see
`FinalFrameSlide` above.)

**Phase 5: version history.** The inspector's "Version history" row
(`open-history`) opens a modal drawer (`VersionHistory.tsx`). Rows come from
`GET …/versions`, which now names each version's producing transaction:
`transaction_id`, `intent`, `agent_id`, `change_source`. They are joined in one
query on `result_version_id`. Rows show a black square for a person and a
yellow one for an agent. Picking a row reads that version (`readAt`) and
previews it read-only. "Compare with current" marks slides by **id**
(`lib/version-history.ts`) as differs, not in current deck, or added since. It
also says when the slide order or anything deck-wide (theme, metadata) differs,
because slide marks alone would hide a theme change. Rules:

- **A restore is an ordinary change, not a rewind**
  (`POST …/versions/{id}/restore`, `version_restore.py`). It commits top-level
  add, replace and remove operations that take the head to the chosen version,
  through the same applier, validation and concurrency check as any edit. The
  chain keeps every version, and the restore undoes like anything else. The
  operations are top-level on purpose: a structural diff would emit
  index-addressed operations whose correctness depends on every move being
  right, while replacing `/slides` whole is obviously correct. They are standard
  operations, so patch conformance is unaffected.
- **`expected_version_id` is required.** It is the head the person had open.
  Anything that arrived since is a 409 telling them to look again, never a
  restore over work they did not see. A version from another deck answers 404.
  So does `GET ?at_version=` for one: it used to escape as a 500.
- **`useEditor.restoreVersion` drains the save queue first and stops on
  `false`**, like every path that lets the server replace the document. On
  success it clears local undo, because those inverses describe a document no
  longer on screen. It keeps the restore's transaction so the banner's "Undo
  restore" can revert it through the server, where `disturbs()` refuses if a
  later edit would be touched.
- **Deleting, restoring and moving a deck, and restoring a version, need the
  `manage` scope, which no agent grant carries.** Before this, a grant with
  `write` could delete, move or rewind a deck. That is the same class of
  decision as approving a proposal, and it belongs to the person.
- **Server timestamps without a zone are UTC** (`parseServerTime`). SQLite
  returns a timezone-aware column without its zone, and `Date.parse` read that
  as local time, putting every desktop timestamp hours off. The deck list had
  the same bug.

The `history` smoke step edits the first slide's notes, then opens the drawer
and compares the earlier version: only slide 1 may be marked. It restores that
version and checks the **store**: the old content is back, it is a new version,
and the edit's version is still listed. It then undoes the restore, and finally
restores again, which leaves the deck as it found it. A screenshot is taken with
the drawer open (`history-drawer.png`).

**Phase 6: AI mode, and the story checkpoint.**

*The story checkpoint belongs to new-deck generation.* The graph could always
pause before the story stage; nothing asked it to, and no route resumed a run.
The desktop could not generate a deck at all. The editor's Ask runs one edit
node and never reaches a story. So the checkpoint lives with a deck that does not
exist yet: **Generate** in the deck list (`GenerateDeck.tsx`) writes the outline,
and the person Approves, Revises with a note, or Discards (`StoryCheckpoint.tsx`).
Approving builds the deck and the editor opens on it.

The routes (`main.py`):

- `POST /v1/generate/review` starts the run.
- `GET /v1/runs/{id}/checkpoint` reads the outline back from the checkpoint.
- `POST /v1/runs/{id}/resume` decides it.

Reviewing is its own route, not a flag on `/v1/generate`, because the answer is
a different thing. `generate` was split into `_prepare_generation`, `_run_graph`,
`_graph_deck` and `_store_generated`, so a resumed run stores its deck through
exactly the same code. Rules:

- **Revise sends the note back through the story stage and pauses again.**
  - `_after_checkpoint` routes `revise` to `STORY`. The story node puts the note
    and the previous outline in the user's turn, each enveloped, and clears the
    decision. Left set, a graph compiled without the interrupt would loop.
  - `resume_generation` compiles with the interrupt. A revised outline is one
    nobody has approved either.
  - It now refuses an id that is not parked: resuming one would start a fresh run
    from an empty state.
  - A revision needs a note (422). One with nothing said asks the model to guess.
- **A resume takes the request and the theme from the checkpoint, never from
  the caller** (`paused_run`, `resume_deck_generation`). A caller cannot swap the
  brief between the outline being approved and the deck being built.
- **One outline, one decision.** The claim is a conditional
  `awaiting_approval -> running` update, committed before any model runs. Two
  Approves, or Approve and Revise from two windows, would otherwise both resume
  one checkpoint and pay twice. A failed resume puts the run back at its
  checkpoint when the checkpoint still holds it. A discarded outline is recorded
  as `cancelled`, because the table has no separate word for it.
- **A run is its starter's.** A run id is not a capability. A stranger gets a
  404, and the starter must still be an editor where the deck would go.
  Answering the checkpoint needs `approve`, which no agent grant carries. It is
  the same act as approving a proposal.
- **Quotas:** tokens are charged at every pause (`quotas.record_tokens`), and a
  generation is counted once, when a deck exists. Revising checks only the token
  allowance (`check_tokens`); approving checks the generation limit.
- **`capabilities.checkpoints`** says whether a run can pause, from configuration
  and installed savers without opening anything. Where it cannot, the option is
  absent and `/generate/review` answers 409 rather than building a deck nobody
  approved.
- **The savers had been closed from the start.** `from_conn_string` is a
  generator context manager. `_open_checkpointer` entered it and dropped the
  manager, so the generator was collected and the connection closed. The first
  real use answered "Cannot operate on a closed database". Nothing had ever paused
  a run, so nothing noticed. The managers are kept now, and savers are cached per
  URL instead of one leaked connection per call.

An outline outlives the drawer. The server holds the run, and the drawer
remembers its id per project in `localStorage`. The server stays the authority:
an id it no longer knows is forgotten, not shown.

*AI mode's panel* (`ModePanels.AiPanel`) shows, in order:

- Pending changes, with a yellow "N waiting" chip.
- Ask, restyled.
- Critic issues.
- This slide's Sources.

Repositories moved into the Generate drawer. Choosing repositories grounds a
*new* deck, and in the editor the checkboxes would do nothing.

**A proposal card shows Before and After, drawn by the editor**
(`ProposalsPanel.tsx`, `lib/proposal-preview.ts`).
`GET .../proposals/{id}` returns one pending proposal with its operations and base
version. The editor applies those operations to a copy of the deck *on screen*,
through the ordinary applier, and renders both sides with `FinalFrameSlide`.
Three reasons for doing it there rather than through the server's preview route:

- "After" means this deck plus this change, which is what Apply means.
- It needs no browser render per slide.
- It works offline.

The preview route stays for agents, which have no renderer.

- The changed slides come from comparing the two decks by slide id, not from
  parsing paths, so a whole-array replace or a theme change is seen too.
- A change that no longer applies says so. Reject stays available.
- A change written against an earlier version says the pictures show it applied
  to the deck as it is now.
- The thumbnails are sized from the card's measured width, not a constant. Two
  136px frames overflowed the panel in the first desktop run.
- "Grounded in ..." lists only the provenance records the change itself adds. A
  run's whole research set would claim sources the change does not cite.

The `ai` smoke step runs two journeys:

- It creates a real pending proposal through the page's proxy. The card must
  appear with both pictures, and Reject must clear it in the store while leaving
  the deck's version unchanged.
- It generates through the checkpoint. Revise must be disabled until a note is
  written, and the run must come back to an outline. Approve must open a new
  deck that the main process names as open.

It then deletes that deck and reopens the original.

**Phase 7: Motion mode.** The right panel in Motion mode is
`shell/MotionModePanel.tsx`. It has two sections; the timeline stays in the dock
under the canvas.

*Transition into this slide* (`lib/transition-editing.ts`) edits kind (Cut,
Fade, Slide, Zoom, Morph), duration, easing and direction. Each edit is one
ordinary patch through `editor.apply`, with ordinary undo. Rules:

- **Cut is the absence of a transition.** Choosing it removes the property.
- **A kind the panel does not offer is shown, not dropped.** A `push`, or a type
  from a newer build, is named as it is. Choosing a kind replaces it.
- **Leaving a morph removes its pairs and says so.** Only a morph draws them,
  and a fade with hidden pairs would be a document saying more than the slide
  does. Undo brings them back.
- **Pairs are explicit in the document or not there at all.** Manual rows are the
  document's `sharedElements`. Auto rows are the engine's scored suggestions
  (`resolvePairing` with `auto: true`), shown with a yellow chip and their reason.
  One is written only when the person presses Keep. Two unrelated objects are
  never silently morphed (doc 02 §26). An object is in one pair at most on each
  side. Mappings have no id, so Break replaces the whole array, as slide delete
  does.
- The first slide cannot morph: there is nothing to come from.
- An unnamed object is called by its role ("decoration (shape)"). Two shapes
  named by their type and id prefix could not be told apart.

*Plan by roles* uses the product's own motion planner, the one agents reach over
MCP. It is asked for a **dry run**: `dry_run: true` on `POST .../motion` and
`.../transition`. A dry run returns the operations and the version they were
planned against, and writes nothing: no version, and no proposal.

That is the point. The routes file every write as a proposal labelled
`mcp:<client>`. A person planning in the editor would otherwise have seen their
own deterministic plan attributed to an agent "via MCP". Nothing here involves a
model: the planner computes durations from a pacing word. The person reviews the
plan and applies it as their own edit. Rules:

- **The total is measured, not quoted** (`lib/motion-plan.ts`). The plan is
  applied to a copy and compiled by `compileTimeline`, and the card reads back
  `budget.entranceMs` against the theme's limit, as present mode will play it:
  "Total 0.6s — within the 2.5s budget".
- **Unsaved edits are saved before asking.** The planner reads the stored deck
  and names element ids from it. If saving fails, nothing is asked.
- **A plan is for the slide it was planned against.** `planFingerprint` covers
  the slide without the property the plan replaces, plus the slide before for a
  transition, because a morph pairs with it. If anything changed before Apply,
  the plan is refused and the person is asked to plan again.
- The transition planner starts from the slide's own kind. Carry offers only
  roles present on both slides.

The dock's timeline and `MotionPanel` kept the pre-rewrite styling in this
phase. Phase 8 restyled them.

The `motion` smoke step runs two checks on the animation fixture:

- On the morph slide, the pairs are listed as manual. Fade removes them in the
  **store**, and Undo restores the morph exactly.
- On the first slide, a plan by roles comes back with a budget line. Apply
  changes the stored tracks, and Undo takes it back.

The step ends by asserting the stored deck is byte-for-byte the one it started
with, excluding `updatedAt`.

**Phase 8: dark theme, keyboard, Code mode, the application menu.**

*Dark theme.* The dark token set is `:root[data-dk-theme="dark"]` in
`tokens.css`, derived from the Figma's Page 1. `lib/chrome-theme.ts` resolves it:
follow the OS by default, or a stored override ("deckastra.chrome-theme", absent
for "system") chosen from `ThemeMenu` in the app bar and the deck list. It is
editor state and never reaches a document. `ui-tokens.test.ts` checks every
text/background pair in **both** sets against AA. Present mode's audience text
uses `--dk-on-backdrop`, white in both themes, because the backdrop is black in
both.

*Keyboard.* Three rules in `EditorShell`'s handler, each found by a person
trying to use the editor without a mouse:

- **Canvas commands act only when the canvas has focus** (`commandScope` in
  `packages/editor/src/keyboard.ts`). Caught on the whole window, Tab on any
  button selected the next object and focus could never leave anything. Undo,
  redo, AI undo and present stay global.
- **Tab leaves the canvas after the last object** (`cycleLeavesScope`). A cycle
  with no exit is a keyboard trap (WCAG 2.1.2).
- **F6 / Shift+F6 moves between regions** (`lib/regions.ts`): app bar, tools,
  slides, canvas, notes, timeline, panel. Order is the DOM's, from `data-region`
  on each region's root. It works while typing, because it is how a keyboard
  user gets out of a field.

The canvas is a focus target (`tabIndex=0`, `role="application"`, labelled with
its keys) and takes focus when clicked or when a tool inserts an object, so
Delete and the arrows act on what was just made.

*Focus rings.* The legacy rule in `styles.css` painted a cyan outline on every
focused control, and it beat the palette's blue because both are `:where()` and
it came later. It now excludes anything inside a `dk-` element, and the
palette's rule covers unclassed descendants too (a native checkbox in a panel).

*Code mode* (`shell/CodePanel`) edits canonical JSON in exactly two scopes: the
whole deck and the current slide. It is never a second mutation path: text is
strictly parsed, security-limited, checked for locked identity/asset fields,
validated as a complete document and diffed into id-addressed operations before
one `editor.apply` call. Apply is explicit (Ctrl/Cmd+Enter), is one undo step,
and a zero-change round trip emits no transaction. Dirty drafts are journalled;
if the deck changes underneath one, Apply pauses until a three-way merge or a
discard. Copy is available only for a clean canonical view and reports clipboard
failure rather than looking successful.

*The application menu* (`apps/desktop/src/main/menu.ts`): File (New deck,
Generate, All decks), Edit (Undo, Redo, Version history), View (modes, Theme,
full screen), Slide (Present). Rules:

- **An item sends a name, never a payload.** `IPC.menuCommand` carries one of
  `MENU_COMMANDS`; the preload drops anything else. The page decides whether it
  applies (Undo on the deck list is nothing). The names are `HostCommand` in
  `workspace-contracts`, so the editor compiles against the same list.
- **Keys the editor already owns stay the editor's.** Undo, Redo and Present
  have page shortcuts, and in a text field Ctrl+Z is the field's own undo
  (Phase 9 made that true; see below). A registered menu accelerator would take
  Ctrl+Z before the page saw it. Those items show their key with
  `registerAccelerator: false` (Windows and Linux). macOS always registers menu
  accelerators, so there they carry none until a Mac build can be measured.
  A test asserts the menu registers no key the editor binds.
- **Commands go to the editor window, never a presenter window.**
- **New deck from inside a deck leaves first.** The editor drains its save
  queue and passes the command to `onExit`; the shell hands it to `DeckList` as
  `startWith`, which runs it once the project has loaded. A refusal to leave
  never starts a deck behind the person's back.

The legacy panels (motion dock and timeline, export, share, sources,
accessibility, theme, critic, repositories, conflict recovery) are restyled onto
the primitives, and `.dk-legacy-bridge` is gone. The web home is the shared
`DeckList` now (roadmap 08 track 1), so `AccountPicker` and `EmptyState` are
deleted; only the web app's shared-link viewer and `EditorPage`'s status
message still use the old tokens.

The `a11y` smoke step loads axe-core 4.13 (a dev dependency, read from
`node_modules` and never bundled) into the real window. It first drives the
keyboard with real key events: Tab from a button moves focus and selects
nothing, the F6 walk visits every region in order, and Tab on the canvas
selects and then leaves. It then audits eight views (design, a selection, AI,
Motion, Code, history, deck list, generate) in light and then dark against WCAG
2.1 A/AA, excluding slide content, which is the deck's accessibility and not the
editor's. It fails on any violation and leaves the theme as it found it.

The `menu` step presses the real menu items by id (`getMenuItemById`, the id is
the command): the modes, both theme overrides, Version history, All decks, and
New deck from inside a deck, where the main process must end up naming the new
deck. It deletes that deck and reopens the original.

**Phase 9: the acceptance audit's gaps**
(`docs/DESKTOP_UI_PHASE_0_TO_6_ACCEPTANCE_AUDIT_2026_09_19.md`). Two P1 defects
and one reduced requirement, each fixed with the audit's reproducer promoted into
the normal suite, and each regression test checked by breaking the fix.

*UI-01: an export is of the deck on screen, or of nothing.* The editor saves on
a 900ms debounce and the service exported whatever it had stored, so PDF
pressed right after an edit rendered the version before it and reported
success. Now:

- **`ExportPanel` takes the editor as a save barrier** (`editor` prop, passed by
  `AppBar`). It commits a draft still in a focused field (`lib/drafts.ts`), drains
  the save queue, and exports **the version the drain was acknowledged at**.
- **The service checks that version.** `expected_version_id` on
  `POST …/exports` is optional (an agent exporting "the deck as it stands" means
  the head) and a mismatch is a 409, before any job exists: an agent's change
  landing between the save and the click would otherwise be in a file nobody
  looked at.
- **A save that cannot drain starts nothing.** A failed save or a conflict under
  review says the latest changes would be missing, and offers **Export the last
  saved version** as an explicit, separately labelled choice.
- **Retry says "Retry this version"**, because a retry re-renders the version the
  job pinned, which may be older than the deck now.
- The deck list's export has no editor and exports what is stored, which there
  is the deck.

*UI-02: a project's cards are only ever that project's.* `DeckList` wrote any
list answer that arrived, so a slow answer for project A replaced B's cards
while B stayed selected. So did a slow error, and a refresh after a duplicate,
delete, undo or move that finished after the person switched. The undo button's
closure even captured the old project's loader. Every load now reads the
project selected **now**, takes a ticket (`lib/latest-request.ts`), and writes
only if it is still the newest request *and* still for the selected project.
The second half is not implied by the first: a refresh can be the newest
request and still be for a project the person has left. A project switch starts
from "loading", never from the last project's cards or error.

*Speaker notes are rich text* (the plan's contract, not the textarea's warning).
The field is a contenteditable on the canvas text editor's model
(`lib/notes-rich.ts`, `shell/SpeakerNotes.tsx`):

- **Rendering and reading are inverses.** `renderNotes` builds exactly the
  elements `readEditable` reads back, so opening a note and leaving it changes
  nothing. Text goes in as text nodes. A link survives only with a permitted
  scheme.
- **Plain stays plain.** Notes without formatting are still a string. Bold or a
  list makes them rich. Rich notes keep surviving block ids and paragraph
  styles, and an empty field removes the property.
- **Paste is the allowlist** (`sanitizePastedHtml`), and it now keeps marks.
  The canvas editor's paste still flattens to text.
- **IME defers the commit; one undo step per session; a draft commits to the
  slide it was written on.** It also commits when the panel is **collapsed**:
  the draft is kept as a read taken on every edit, because the element is gone
  by the time a collapse's cleanup runs.
- **The field does not rebuild itself after its own commit.** Its commit
  changes the stored notes, and re-seeding then would throw the caret to the
  start every 700ms. It re-seeds only when what is stored differs from what it
  shows.
- The toolbar (Bold, Italic, Underline, bullets, numbers) uses the browser's
  editing commands. Whatever markup they produce is read back through
  `readEditable`, never stored. Formatting the field cannot show (a colour,
  superscript) is still warned about, now for exactly those cases.
- **The presenter sees the structure.** The scene carries `speakerNotesRich`
  beside the flattened `speakerNotes` (the digest does not include either), and
  `RichNotes` draws it as React elements. A link is underlined text, never an
  anchor: a click during a talk must not leave the presenter view.

Two model bugs came out of that, both shared with the canvas editor:

- **Every blank line read back as two.** An empty line is `<div><br></div>`, and
  that `<br>` only holds the line open. `readEditable` treated it as a break. A
  `<br>` that is its parent's last child now draws no line, which is the HTML
  rule.
- **Every `<li>` read back as a bullet**, so a numbered list became bullets on
  the first edit. An item in an `<ol>` is `numbered`.

*Ctrl+Z in a text field is the field's.* `SAFE_WHILE_TYPING` allowed undo, redo
and the clipboard while typing. So Ctrl+Z in the notes or an inspector field
undid the deck's last change, somewhere the person was not looking, and the
handler's `preventDefault` stopped the field's own undo. Only Escape is global
while typing now. Once a field commits, its edit is an ordinary deck step.

Leaving a deck (`EditorShell`'s exit) commits a focused field's draft first. A
menu shortcut pressed while typing does not blur the field, and the draft would
otherwise unmount after the save it should have been part of.

The smoke steps type into the notes with the browser's editing engine
(`execCommand("insertText")`). `slides` also presses Bold and Numbered list in
the real window and checks the store holds rich text with both. `export` types
a note, leaves it in the focused field, presses PDF from script (which moves no
focus) and checks the file's version (`data-export-version`) is the head holding
the note. UI-02 has no real-app step: it is a timing race, and the component
tests control the timing where a real service cannot.

**The final package fix register** (`docs/DESKTOP_FINAL_PACKAGE_FIX_REGISTER.md`)
is delivered one item at a time. Its "Delivery status" table is the running
record. Release scope agreed 2026-09-20: Windows x64, local-only, generation by
MCP agent or cloud API key, 0.9.0-beta.1, manual upgrades.

*Closing waits for the words on screen (item 01).* A note typed a moment before
the window closed was lost on both the window's close and the app's quit,
measured with the new `close` / `close-verify` smoke steps. The note had not
reached the save queue, `beforeunload` looked only at the queue, and
`before-quit` stopped the service without asking the window anything. Now:

- **Drafts register with the editor** (`useEditor.registerDraft`). `saveNow`
  and `beforeunload` run them first, so "save" and "close" mean the words on
  screen. The debounced autosave does not run them, so a timer never commits a
  half-typed sentence. During an IME composition a close commits the text from
  before it began, never half a character.
- **Every desktop window holds its close until its page answers**
  (`main/close-guard.ts`, `lib/close-barrier.ts`, IPC `prepareToClose` /
  `closeReady`). The page saves, or at least journals, and says which. Quit asks
  every window first and stops the service after. The wait is bounded: a page
  that never answers is closed anyway, because its journal was written before it
  tried the network.
- **Electron cancels a close whose `beforeunload` objects, with no dialog.** So
  once the close is prepared, `closeApproved()` stops the handler objecting. A
  browser still gets its prompt.
- **On the desktop the journal pointer survives a restart**
  (`recoveryPointer="local"`). Without it, a journal left by a close that could
  not save came back only as an anonymous copy in a collapsed list. Same-base
  recovered work now **autosaves**. It used to sit "pending" until the next edit.
- OS shutdown and sign-out get a best-effort `session-end` ask only, and are on
  the manual checklist.

*Closing is approved only when the work is somewhere (recheck of item 01).*
Readiness is three-valued. `journalled` is claimed only when the journal took
the work: with storage full **and** the save failing, the queue is in memory and
nowhere else, and the first version of this reported "journalled" and closed the
window. A participant that throws or never answers is `blocked` too — a promise
that did not answer is not evidence anything was written — and so is a draft a
field could not hand over. A blocked window is not closed behind the person's
back: they are told what is at risk and choose (try again, close and lose it,
keep the window). A quit stops if anyone keeps their work.

*One project's run never shows under another (items 02, 03).* In
`GenerateDeck`, the phase records its project, and every async path captures
where it started. A late answer updates that project's remembered run and nothing
on screen: it never shows A's outline under B and never opens A's deck from B.
**And only the newest request may write that pointer** (recheck of item 02): the
sequence lives outside the component, because closing and reopening the drawer
remounts it, and an older generation answering last used to overwrite the
remembered run with its own — handing back an abandoned outline and losing the
way to the newer one.
Only a 404, the server's "no such run", forgets a paused run, and only the run
asked about. A 401, a 5xx or being offline keeps it and offers Try again.

*A mistyped intelligence mode is refused (item 04).* An unknown
`DECKASTRA_INTELLIGENCE` used to read as unset, which means "the cloud if a key
exists". So `locla`, written by someone who wanted nothing to leave the machine,
selected the cloud — the probe showed the selection, and the next generation is
what would have sent the brief. `intelligence()` now raises
`IntelligenceMisconfigured`, `/health` reports it, and the API warns at startup
without refusing to start: decks need no model. An app-wide handler makes every
`ModelUnavailable` a 503. Before it, Ask answered a missing model pack with a 500.

*The installed product does not generate with the stub (item 20).* Unset means
the stub in a checkout, which is what keeps the vertical slice runnable with no
key and no money — and the stub writes a template deck that reads like a model
wrote it badly. On an installed product that is a deck someone believes was
generated, so `DECKASTRA_DISTRIBUTION=1` (set by `sidecar.ts` from
`app.isPackaged`) answers `PROVIDER_NONE` instead, and the refusal names what to
do. It also **will not take an inherited `ANTHROPIC_API_KEY` as consent**: the
cloud is a choice someone makes, not an environment variable they happened to
have. Local models are not in this release and say so by name. Development, CI
and the smoke steps are unchanged, which is what the flag is for.

*Where decks are written is visible before anyone writes a brief (item 19).*
`router.generation_status()` answers `/health` and `/v1/account`'s
`capabilities.generation` — provider, whether it can work, and why not.
`lib/generation-route.ts` turns that into the words a person reads, and every
route says what leaves the machine: the cloud one names Anthropic, the local one
says nothing is sent, the stub says it is a template. The Generate drawer shows
it, disables Generate when it cannot work, and offers the host's set-up screen.
The desktop's is the **Intelligence** drawer (bar button, View menu), which is
also where agent access lives, and it names what this release does not include.
An older server reports nothing, and then the drawer claims nothing rather than
guessing.

*A cloud key is the user's, and the operating system keeps it (item 23).*
`main/cloud-key.ts` encrypts it with Electron's `safeStorage` (DPAPI on
Windows) in `userData`, with the ownership the agent attachment uses. **It never
goes back to the renderer** — the page asks whether a key is set and when, and
nothing else, because a window that could read it is a window that could send
it. Where `safeStorage` is unavailable the answer is "this machine cannot keep
it safely", never a plaintext file. A key is checked before it becomes a child
process's environment: no spaces, no newlines, no nulls, a plausible length.
Saving or removing one **restarts the service**, because the service reads it
from its environment at startup; the editor stays mounted through that, as it
does through any outage. Consent sits beside the field rather than in a document
nobody opens. And Anthropic refusing a key is now `ModelUnavailable` with its own
sentence — it used to read "Claude API error 401", which is the same message a
network problem got, and retrying neither helps.

*What the release is not, said once* (`FirstRunNotice`,
`docs/RELEASE_NOTES_0.9.0-beta.1.md`): local-only, no cloud workspace, no
sharing, no sync, no `.mydeck` files, no local models, Windows only. On first
launch, because the alternative is someone spending an afternoon looking for a
share button. The acceptance harness dismisses it the way a person does and
records that it appeared — a step that did not meet it on a fresh profile is a
step whose profile was not fresh.

### Manual authoring (gap plan MA-01 to MA-35, 2026-09-25)

Status per item is in `docs/MANUAL_AUTHORING_AND_PRE_RELEASE_GAP_PLAN_2026_09_21.md`. Rules that are easy to undo:

- **Both contenteditables render rich text with `lib/rich-dom.ts`**, the exact inverse of `readEditable`. The canvas editor used to seed every block as a `<div>`, so a bulleted list became paragraphs on the first edit. Paste goes through `insertRichText` (`insertHTML` first, for native Undo).
- **Canvas text is a draft and registers with `registerDraft`.** Blur mid-composition waits for `compositionend`; save, close and unmount commit the pre-composition text. The unmount commit fires only on a real change, because React's development double-mount runs it with nothing typed.
- **A click is not a drag.** A move gesture under the 4px threshold commits nothing, or selecting an object dirties the deck.
- **Inspector text edits splice** (`applyPlainTextEdit`), never `plainText(value)`. **Inspector W/H use `resizeOperations`**, like the canvas handles.
- **Nested optional properties are written with `setPropertyDeep`** (presentation-core): it adds the outermost missing object, and `undefined` removes.
- **Uploads measure the picture first** (`imageSize`). The upload records a size only when told one; without it every picture got the 16:9 fallback box and PPTX stretched what it could not fit. Only the `authoring` acceptance step caught this, because unit tests supplied sizes by hand.
- **Copy, cut and paste are the browser's native events**, not keydown handlers. Handling the keys meant preventing the default, which cut the editor off from the system clipboard. The payload (`CLIPBOARD_MIME`) carries the asset entries its pictures cite.
- **The transition preview is present mode's code**: `compileTransition` plus `SlideTransition` with its controlled `timeMs`. Do not approximate it with entrance clips.
- **PPTX cover crops follow `focalPoint`** (`fitPicture`), the same split CSS `object-position` makes.
- **The `authoring` acceptance step is trusted input end to end**: the no-AI journey, a real double-click, a real image drag, and a system-clipboard paste. Harness helpers scroll a control into view before the hit-test, then still refuse one under a modal.
- **A release is `npm run release:win`, and nothing else.** It refuses without a certificate and a publisher name, empties `release/`, builds, and runs `scripts/verify-release.mjs` strictly on that output. The gate measures "current" against `dist` and the source tree *now* — `dist/build-manifest.json` is only rewritten by the manifest step, so comparing against it let a stale release pass after a plain rebuild. Payload files are hashed exactly as shipped (no skip list: the service folder ships `__pycache__`).
- **Notices come from what the bundlers read** (`dist/bundled-packages.json`), not `npm ls`, and the SBOM uses the same list. A dependency with no licence text needs a recorded decision in `notices-review.json` or a release build fails.
- **PowerPoint: tables are native `a:tbl`; charts and diagrams are drawn** from the scene's resolved geometry as shapes with editable text (`export-pptx/src/drawn.ts`), reported `approximated`. SVG paths become `custGeom`; arcs are flattened.
- **Subprocess pipes are UTF-8 by declaration.** `text=True` alone is the locale code page on Windows (cp1252), which turned every em dash from the exporter into "â€”".
- **Windows that are not editors** (the notices window) are excluded by `isAuxiliaryWindow` from menu-command targets and the close barrier.
- **Test isolation:** several test files install a fake `navigator.locks` that outlives them in a single-process run. A test that depends on lock behaviour must declare it.

### The Design tab (2026-09-26)

Panels, backgrounds, fills and effects, a theme gallery, theme import, fonts
and equations. Rules that are easy to undo:

- **Which panels are showing is editor state** (`lib/panels.ts`,
  `localStorage` key `deckastra.panels`). It never reaches a document. Focus
  mode is "all hidden", not a separate mode. The desktop View menu sends
  `panel-*` command names, like every other menu item.
- **A slide with no background draws the theme's background**, not
  transparent. Transparent showed black in present mode and the chrome in the
  editor, so a light theme never reached such a slide.
- **A gradient is carried structured as well as CSS** (`ResolvedGradient` on a
  node's style, `gradientStops` on a slide background). PowerPoint writes a
  native `a:gradFill` and cannot read CSS. A background that had only the CSS
  string arrived in PowerPoint flat. The `design` step found this through
  `python-pptx`.
- **Theme presets are one definition** (`presentation-schema/src/theme-presets.ts`).
  They are emitted to `generated/theme-presets.json` under the drift gate, and
  that file is what Python reads. Each preset passes AA contrast in both
  languages. A preset's style kit (card fill, stroke, shadow, blur, background)
  is applied only when "restyle" is ticked, in the same patch as the theme, so
  one Undo takes both.
- **PowerPoint theme import reads one part and executes nothing**
  (`office_theme.py`). Size, entry count and part size are capped, and a
  `DOCTYPE` is refused. `lt1` is always the background and `dk1` the text,
  regardless of which is darker. Guessing roles from luminance swapped them on
  dark templates.
- **Sixteen OFL families ship with the app** (`renderer/src/font-library.ts`).
  That one list is read by the editor stylesheet, the font picker, the curated
  metrics and the exporter. A test holds all of them to it. Fontsource
  registers faces as "X Variable", so `resolveFontStack` inserts the face name
  after the family. A stack that named only the family fell through to the
  fallback.
- **An uploaded font is declared in the deck's asset manifest and used in one
  patch.** The family is read from the file's `name` table where the file is an
  uncompressed sfnt, and from the file name otherwise. `SlideView` declares
  uploaded faces through `resolveAssetUrl`, exactly like pictures.
- **The export page declares every face once, as `data:` URLs**
  (`apps/worker/src/fonts.ts`). This covers the bundled families the deck
  names (Latin subsets), its uploaded faces, and KaTeX's when there is an
  equation. Every declared face is loaded before measuring and before
  capture: a face loads only when used, and `fonts.ready` resolves before the
  first layout. A packaged app reads the copied stylesheets from
  `DECKASTRA_FONTS_DIR`. PowerPoint names fonts without carrying them, and the
  report says so per family.
- **An equation stores LaTeX, never markup.** KaTeX typesets it in the scene
  build with `trust: false` and bounded expansion, and emits MathML for screen
  readers. The React layer only inserts the result. PowerPoint cannot read
  LaTeX, so the exporter captures each equation alone as a transparent PNG
  (`omitBackground`, which both render backends now support). It is embedded
  with the LaTeX as its description and reported `rasterized`. The starter
  carries no alt text: a description written at insertion goes stale when the
  formula is retyped.

The `design` smoke step works on a deck of its own:

- It hides and shows every panel through the menu, and uses focus mode.
- It sets a gradient background.
- It applies Glassmorphism with restyle, then undoes it.
- It uploads one of the app's own font files and uses it.
- It inserts an equation and retypes it.
- It exports both formats and writes `design.pdf` and `design.pptx` beside the
  record, for `pypdf` and `python-pptx`.

Measured 2026-09-26, development build:

- **The steps:** `design` and `authoring` are green with no console errors.
- **The PDF:** 1 page at 1440×810pt, with the title and the equation as
  extractable text and KaTeX's face embedded.
- **The PPTX:** the uploaded family named on the title, a gradient `p:bg`, and
  the equation as a PNG picture described by its LaTeX.

### Colours are managed, named and referenced (2026-09-26)

A person could not change a theme colour, make a colour of their own or name
one, although the schema had a slot for it all along (`theme.colors.custom`).
Now:

- **The Colours panel** (`ColorStudioPanel.tsx`) is a non-modal drawer, so the
  slide stays live beside it. Open it from any colour picker ("Edit colours…"),
  from the inspector's Colours section, or from the View > Colours… menu item.
  It has four tabs:
  - **Theme:** the roles, with contrast against what each is read on.
  - **Named:** the person's own colours.
  - **In deck:** loose hex values, each with a use count, "Name it" and
    "replace everywhere".
  - **Charts:** the series palette.
- **One colour field, everywhere** (`ColorField` in `inspector/controls.tsx`).
  It is a picker, not a dropdown: theme swatches, named colours, the deck's
  own colours, a hex field, the system picker and an eyedropper. "Save as a
  named colour" is on the spot. Text, fills, outlines, backgrounds, gradient
  stops, icons, equations, chart series, table fills and diagram colours all
  use it. Its accessible name is still "`<label>`: `<colour name>`", and
  colours are still `option`s named by colour, so tests and the harness select
  by name.
- **A named colour's name is its token key**: `token:colors.custom.Brand red`.
  Everything that uses it follows it, including exports, because the scene
  resolves tokens before any adapter sees a colour. Names may not contain a
  dot, since that would split the token path.
- **Renaming and deleting rewrite every reference in the same patch**
  (`lib/colors.ts`). A reference left behind is an E202, and worse, a slide
  that silently draws the fallback. Deleting gives each use the colour it had,
  as a hex, so nothing changes appearance. Naming a loose colour turns every
  use of it into the reference, so one Undo reverses it.
- **A colour is found by where it sits, not what it looks like**: a `color`
  property, or an item of `palette`, `chartSeries` or `series`. A slide whose
  text says "#1E4BD2" is words, and replacing it would edit what someone
  wrote.
- **A run of text can have its own colour.** The canvas editor's toolbar has
  a text-colour button. The run travels through the DOM as `data-color`, read
  back by `readEditable` and never from computed CSS, so a named colour stays
  a reference. An empty `data-color` means "the box's colour". Paste admits
  only a hex or a `token:colors.*` value. `textChanged` counts a colour-only
  edit as a change; before this, recolouring words committed nothing.
- **Charts** can take their own palette ("Own colours" copies the theme's
  series as `token:colors.chartSeries.N` references, so nothing changes until
  an entry does). **Tables** colour the heading and a whole row or column.
  **Diagrams** colour a box's fill and border, every box at once, and a
  connection. `lib/nested.ts` writes paths through id-addressed and index-only
  arrays.
- **A diagram box with its own fill gets a readable label**
  (`renderer/diagram.ts` `readableOn`). A themed box draws exactly as before,
  so no baseline moved.
- **The agents know named colours.** The Ask agent's prompt says to refer to
  one by name, and the MCP outline lists them. The prompt had also been
  describing tokens as `{"token": …}` objects, which the schema refuses; it now
  gives the string form.

The `design` smoke step makes a named colour in the panel, colours the title
with it and changes the colour once. It then checks, from the store, that the
title still holds the reference. `python-pptx` reads the title's run in the
changed colour.

### Adding is separate from styling (design review, 2026-09-26)

An audit found the Design tab capable but hard to find things in. The product
had 11 shapes and 42 icons, yet the rail showed two shapes, and an icon was
chosen by typing its name. So people concluded there were none. The layout
follows two concepts generated with OpenArt from the real screen; they are
kept under `.artifacts/concepts/` (ignored by git).

- **The rail is labelled, and Add comes first** (`shell/ToolRail.tsx`).
  - **Add** opens the library.
  - **Text** and **Image** insert in one click, because slides are mostly
    made of them.
  - **Shapes** and **Icons** open the library at their tab.
  - The object kinds (chart, table, diagram, equation, code) insert directly.
  - **Layers** and **Check** (accessibility) sit at the bottom as side panels.
    They are about the slide, not about adding to it.
- **The Add library** (`shell/AddLibrary.tsx`) sits between the rail and the
  slide strip. The slide stays in view and the styling panel stays usable.
  - Each shape is drawn by the renderer's own `shapeGeometry`, including a
    pill's radius, so the tile is exactly what arrives.
  - Each icon is drawn from its paths. Search matches names and keywords,
    and categories are Basic, Arrows, Flowchart and Callouts.
  - Recent and favourites are editor state in `localStorage`
    (`deckastra.library`) and never reach a document.
- **The right panel says what it is styling.** "Selected object" comes first
  when something is selected. Then comes "Slide design": Theme → Colours →
  Slide background, from the broadest choice to the narrowest.
  - Layers and Accessibility moved to the left side panels.
  - "This session" moved to Code mode.
  - Version history moved to an icon in the top bar, keeping the
    `open-history` id.
  - A shape is changed with a visual `ShapePicker`, and an icon with a
    searchable `IconPicker`, instead of a dropdown and a text field.
- **The Colours view is docked, not floating.** It replaces the right panel
  while open, with a back arrow, so nothing on the slide is covered. It shows
  only in Design mode; opening it from elsewhere switches to Design. Each tab
  shows the chosen colour's editor at the top and the list below.
- **Colours are picked by eye** (`inspector/ColorRamp.tsx`,
  `lib/color-math.ts`).
  - A saturation/brightness square, a hue strip, an opacity strip (8-digit
    hex), and a nine-step tint-to-shade ramp. The hex field stays for anyone
    who has one.
  - Dragging previews locally and commits once on release, so a drag is one
    Undo step. Arrow keys move the square's handle and commit each step.
  - Its gradients are inline styles: the palette gate forbids colour literals
    in CSS, and these are pictures of the colour, not chrome.
- **The top bar's end group drops button words below 1500 px**, keeping each
  button's accessible name and tooltip. A labelled History button had pushed
  the group across the mode switch. The `a11y` step's hit test found it, as
  "cannot press mode-motion". Present and the agent-access chip keep their
  words: the chip's words are its status.
- **The harness adds a rectangle through the library** (`ADD_RECTANGLE` in
  `smoke.ts`), the way a person now does. `tool-rect` no longer exists.

### The Design tab, round 2 (design review, 2026-09-27)

A second review scored the tab 8/10 and found it a good property editor and
a weak design assistant. Each part below is one commit. Concepts are in
`.artifacts/concepts/design-tab-next/` (git-ignored).

- **Pop-ups float above everything** (`ui/floating.ts`). `Popover`, `Menu`
  and `Select` used to be absolutely positioned inside their trigger. The
  scrolling inspector clipped them, so the colour, shape and icon pickers
  looked as though they went under the slide. They are now portalled to
  `<body>` and placed from the trigger's rectangle: below or above, clamped to
  the window, capped to the room there is. Tab past either end closes the
  panel and returns to the trigger, because a portalled panel sits at the end
  of `<body>`. No CSS may target a pop-up through an ancestor any more.
- **Design Check** (`renderer/src/layout-check.ts`, `lib/design-check.ts`,
  `DesignCheckPanel.tsx`) replaced the Check panel.
  - **What it finds:** collisions between siblings (W110), objects outside
    the safe area (W104), text below a readable size (W216), diagrams using a
    corner of their frame (W217), contrast against the fill actually painted
    behind the text (A102), overflow (W103), alt text and reading order.
  - **Why it is separate from `validateScene`:** it is canvas advice, and the
    Critic and export reports should not carry it.
  - **Fixes are changes, not operations,** so several combine into one patch.
    Fix all repeats until nothing moves: three boxes on one spot are moved
    pair by pair and can land on each other on the first pass. It then judges
    colour on the moved slide.
  - **"It's intended"** is recorded on the object (`metadata.designCheckIgnore`).
- **Several objects at once** (`MultiSection.tsx`, `lib/multi-edit.ts`). The
  shared value, or "Mixed", and one patch for every selected object that has
  the property. A control says when it reaches only some of the selection.
  `ColorField` and `NumberField` take `mixed`: a typed value is committed
  even when it equals `value`, because it equals only some of them.
- **Object styles** (`theme.objectStyles`, `element.styleRef`,
  `lib/object-styles.ts`).
  - **Applied by copying:** the style's values are written onto the element,
    so no renderer or exporter changed and the document is complete without
    the definition. A text box keeps its own family and size when a style
    sets neither, because the schema requires both.
  - **Every action is one patch:** update rewrites every user of the style,
    and rename and delete rewrite every `styleRef`.
  - **A theme change keeps the deck's own named colours and styles.**
    `applyThemeOperations` used to replace `/theme` whole, which left every
    `token:colors.custom.*` pointing at nothing.
- **Rows, columns and grids** (`lib/layout-actions.ts`, `LayoutSection.tsx`)
  are editor surface over `containerLayout`.
  - A grid divides its own width into equal columns, so its width is decided
    from the widest child before it is placed.
  - Removing a layout writes each child where it was drawn.
- **The theme editor** (`ThemeCustomise.tsx`, `lib/theme-customise.ts`)
  writes the theme, and the viewport's safe area, in one patch per change. It
  covers fonts, a modular type scale, spacing and corners, charts, diagrams,
  a new `theme.table` that the scene build reads beneath a table's own style,
  and a logo.
  - **The logo** is a locked picture on every slide, marked
    `metadata.brandLogo`, so every exporter carries it.
  - **The first chart write brings `series`,** which `ChartThemeSchema`
    requires.
  - **The gallery previews** the current slide in the chosen preset, but only
    for a preset other than the deck's: previewing what is already on screen
    says nothing.
- **Icons are native in PowerPoint** (`export-pptx/src/drawn.ts` `iconShape`).
  They are freeform outlines and ellipses grouped under the element's name.
  Arcs are flattened and reported as `approximated`; an unknown icon is still
  the reported placeholder. `lib/export-fidelity.ts` says what each kind of
  object becomes in PowerPoint; change a row there when the exporter changes.
- **Colour roles and modes.**
  - **Roles:** a named colour can hold a token (`"token:colors.accent"`), and
    `resolveValue` follows a chain of up to 8 references. A loop falls back
    rather than drawing a token string.
  - **Modes:** `theme.modes` holds colour overrides by name, and
    `slide.colorMode` picks one. The scene build resolves one theme per mode,
    so canvas, thumbnails, present mode, Design Check and exports all agree.
    Deleting a mode clears its slides in the same patch.
- **The icon library** is 200 icons in 10 categories.
  - **Source:** the curated set plus Lucide, generated into
    `renderer/src/icon-library.ts` by `scripts/build-icon-library.mjs` from the
    `lucide-static` development dependency. The curated drawing wins a shared
    name.
  - **Licence:** Lucide is copied content rather than a bundled package, so
    `notices.mjs` lists it under `VENDORED` and its licence text ships.
- **Brand icons** (`theme.icons`, `icon.set: "brand"`, `lib/svg-icon.ts`).
  - **What survives an SVG:** only its geometry, as an allowlist. Transforms,
    gradients, pictures, text, scripts and DOCTYPEs are refused with the
    reason.
  - **Filled shapes** draw filled on the slide and in PowerPoint.
  - **They travel with the theme** into every deck that uses it and into a
    saved workspace theme.
- **Recent and favourites follow the person.** They are kept by the service
  at `GET/PUT /v1/me/preferences/library`, with an allowlisted key, a 16 KB
  cap and the `user_preferences` table. The browser's copy is the offline
  cache. `readPreference` and `writePreference` are optional on
  `WorkspaceClient`, so a surface without a service keeps them locally.
- **The `design` acceptance step checks five things in the window:**
  - the pop-up is on top and inside the window;
  - three stacked rectangles give three W110s, and Fix all clears them;
  - a style saved, applied and updated carries to the second rectangle in
    the store;
  - the row is made, then undone.

  Objects are picked from the Layers panel (`data-layer-id`), because after
  Fix all they are wherever the fixes put them.
- **Contrast is measured against every layer under the text** (the review's
  gaps, 2026-09-27). `layout-check.ts` composites the slide background and
  each filled object beneath the text's centre, bottom up: a translucent fill
  blends, an opaque one replaces, a gradient counts at its **weakest stop**.
  Table headings, cells and banding, and chart labels on their bars, are
  judged the same way. A picture beneath text is **W218**, "cannot be
  measured", never a guessed ratio. Its fix, a card behind the text, is
  offered and never applied by Fix all, because it changes how the slide
  looks.
- **A finding carries a fix where one exists.** An object larger than the
  safe area is shrunk to fit inside it (a move alone returned 0 and the check
  said nothing). A diagram using a corner of its frame gets "Fit the frame".
  Missing alt text asks for the words in place ("Describe it…").
- **An overlap fix never trades one finding for another.** When moving an
  object clear would take it outside the safe area, the fix makes it narrower
  (or shorter) on the overlapping side instead. Otherwise Fix all moved a
  too-wide title out of the margin, moved the picture back into it, and never
  settled. Found building a real slide, not by a test.
- **PowerPoint draws a custom path, a pill, a polygon and a speech bubble by
  their outline** (`pathGeometry`, `a:custGeom` from the scene's resolved
  path). They used to arrive as rectangles, so a coral blob became a coral
  box. An unknown kind from a newer schema is still a reported rectangle.
- **An uploaded SVG is checked whole, including `<defs>`.** A gradient,
  pattern, mask, clip path, filter or script anywhere is refused, and so is
  any `url(...)` paint. Skipping `<defs>` let the commonest gradient through.
- **A checkout run can refuse to start its service** with "built from
  different migrations" when `dist/build-manifest.json` is left over from an
  earlier packaging. After adding a migration, run `npm run manifest` in
  `apps/desktop`.

### Interface clean-up toward launch (roadmap 08 track 1, 2026-10-04)

`packages/editor-ui/DESIGN.md` holds the seven design rules and names the test
that enforces each one, or says that nothing enforces it yet. Rules that are
easy to undo:

- **Notes and the timeline are tabs of one dock** (`shell/Dock.tsx`,
  `lib/dock.ts`).
  - Each mode remembers its own dock in `deckastra.dock`. It is closed in
    Design and Code, and open on the timeline in Motion.
  - `deckastra.panels` now holds only the tool rail, the slide strip and the
    side panel. Old `notes` and `dock` keys there are ignored.
  - The dock is one F6 region (`dock`), whichever tab is showing.
  - A smoke step that types a note or drags a clip in Design calls
    `needDockTab` first.
- **One assistant, beside any mode** (`AssistantPanel.tsx`). AI mode,
  `AskPanel` and the task form are gone.
  - It opens from the bar's Assistant button, View › Assistant and the
    command palette (host command `assistant`, which replaced `mode-ai`). The modes are now
    Design, Motion and Code, on Ctrl+1 to 3.
  - The prompt box still calls `agent/edit`. A change the server holds back
    shows under "Waiting for you" (`ProposalsPanel`) rather than as a second
    card.
  - Its words go through `lib/assistant-words.ts`. `plain()` replaces any
    service sentence that carries engineering words or a setting name.
  - The prompt textarea lets Ctrl+K through to the shell, so the palette opens
    from inside it too.
- **Ctrl+K is the command palette** (`CommandPalette.tsx`, `lib/commands.ts`),
  not the assistant. Each entry is a `HostCommand`, run through `onCommand`,
  the same dispatcher as the desktop menu, so the two cannot drift. "Ask the
  assistant" fills the assistant's prompt and sends nothing.
- **Settings replaced the Intelligence drawer** (`SettingsShell.tsx`, desktop
  `DesktopSettings.tsx`, host command `open-settings`, which replaced
  `open-intelligence`; View › Settings…, Ctrl+,). A section the host does not
  pass is absent; Plans and billing appears with track 3. The own-key section
  stays until track 2 replaces it. The agent chip is still in the bar, because
  it shows a live grant at a glance and the `consent` smoke step drives it.
- **Share and Export are one menu** (`open-share`, `export-popover`).
- **One home for both shells** (`DeckList`). `apps/web/app/page.tsx` is only
  the route now; `AccountPicker` and `EmptyState` are deleted.
  - Its prompt bar is `GenerateDeck`, rendered inline: `generate-instruction`,
    `generate-submit` (Create), `new-deck` (Blank deck), and audience, slides,
    outline review and repositories under Options. The drawer
    (`generate-drawer`) opens only after Create, for progress and the outline.
    There is no `generate-deck` button; File › Generate focuses the prompt.
  - **Create is refused while an outline waits.** The prompt is always on
    screen, and a second run would replace the project's remembered run
    (item 02), abandoning an outline nobody decided on.
  - The web editor's exit carries New deck and Generate as `/?start=…`.
- **Credits are read, never computed** (`CreditsMeter`, `lib/credits.ts`).
  On the desktop `GET /v1/account/credits` on the local service answers from
  the cloud account through the gateway (`gateway_routes.balance`, local mode
  only), never from the local ledger, and a signed-out desktop gets 503 "Sign
  in…", which the meter turns into a Sign in action. No purchase or
  subscription is shown before track 3.
- **Desktop sign-in lives in Settings › Account** (`DesktopSettings.tsx`,
  `window.deckastraAccount`): state and email only, never a token. The own-key
  field is gone; `product-words.test.ts`'s `STILL_TO_REMOVE` is empty.
- **`.mydeck` from the interface**: Share › "Deckastra file" is an export of
  kind `mydeck`; the home's "Open .mydeck file" (`open-deck-file`) is IPC
  `openDeckFile` with no payload, so the main process shows the dialog, as
  File › Open does. Absent on the web until its client can import.
- **One caller's abort never cancels the shared session bootstrap**
  (`workspace-client/src/http.ts` `ensureSession`). The bootstrap runs with no
  caller's signal; each caller stops waiting on its own. A signal used to go
  into it, so the first component to mount owned it, and React's development
  double mount aborted the deck list's account read on every fresh load.
- **The SQLite store waits for locks instead of failing** (`db/session.py`):
  a 30-second busy timeout, and `ensure_physical_transaction` opens
  `BEGIN IMMEDIATE`. A deferred `BEGIN` let two writers that each read first
  deadlock, and SQLite refuses one of them at once whatever the timeout; the
  `languages` smoke step lost its translation one run in three to it.
- **The web app signs in to a hosted Deckastra when told which**
  (`NEXT_PUBLIC_DECKASTRA_CLOUD=deckastra|deckastra-prod`, read from
  `infrastructure/deployment/public-auth.json`; `apps/web/lib/auth.ts`).
  Unset is the development sign-in against `NEXT_PUBLIC_API_URL`. Named, the
  hosted API wins over `NEXT_PUBLIC_API_URL`, because its tokens are good
  nowhere else and `.env.local` points at a local API.
  - The session store answers with the token Firebase last handed over and
    keeps workspace ids in memory only; a 401 makes the client re-bootstrap
    once with `refresh` (a forced renewal), never more.
  - `SignInGate` renders "Checking" on the server and the first browser render
    alike, so the page hydrates; the SDK is created in an effect.
  - Settings opens over the editor rather than leaving it. `AccountSettings`
    takes `online`, because a server calls its own workspaces `local`.
  - Deleting the account signs out and keeps the receipt in `localStorage`;
    the signed-out page polls its status without a session.
  - `.mydeck` opens through `client.imports` (begin, PUT to the signed URL with
    exactly its headers, complete, poll); the home shows a file input only when
    the host gives no `onOpenFile`. Locally, imports need the worker
    (`python -m deckastra_api.export_worker`); plain uvicorn leaves them queued.
- **The bars end in an account menu** (`shell/AccountMenu.tsx`, `account-menu`):
  initials, light/dark/system, Settings…, Sign out where the host has one.
  It replaced the contrast and Panels buttons and the desktop's gear; panels
  are in the View menu and the command palette. The desktop's agent chip shows
  only while access is on; consent is given in Settings › Agents
  (`settings-agent-toggle`), which is what the `consent` step drives.
- **The home has views** (`lib/deck-views.ts`): All decks, Recent (12) and
  Trash are one request per project, merged, and a project that cannot be read
  fails the view rather than vanishing from it. Trash cards have no thumbnail
  (a deleted deck reads as missing) and a Restore button. `projectId` stays the
  project new decks go to whatever view is showing.
- **Ctrl+K works on the home too**, with `place="home"`: only commands marked
  `home`, and words typed fill the prompt bar (never sent).
- **Assistant › Sources attaches files** (`lib/assistant-sources.ts`): PDF, CSV
  or text uploaded as `document` assets and sent as `source_asset_ids` by
  Research files and Add slides. Repositories still ground only a new deck: the
  assistant request has no repository field.
- **Quick actions show their credit hold** ("Up to 3 credits") from
  `minimum_reservation_usd` at US$0.005 a credit, only for paid, available tasks.
- **A share link is outside the sign-in gate** (`app/providers.tsx`): it is its
  own credential and is opened by people without an account.
- **Tokens v1 are frozen** (`src/styles/tokens.v1.json`). A token may be added
  or change its value. It may not be renamed or removed.
- **No engineering words in the product** (`tests/product-words.test.ts`).
  `STILL_TO_REMOVE` is a ratchet: the test fails when a listed file has gone
  clean, so the list can only get shorter.

### One deck, many languages, narrated by step (integration plan 01, 2026-10-02)

The plan is `docs/integrations/01_MULTILINGUAL_DECKS_NARRATION_AND_SOUND.md`.
Rules that are easy to undo:

- **A language is an overlay, not a copy** (`presentation-schema/src/locales.ts`).
  `document.locales[tag].entries` maps a text slot's id-addressed path to the
  words in that language, with `sourceHash` (FNV-1a 64 of the source's plain
  text) so a changed source reads as *outdated*. The allowlist of slot paths is
  a regex list; an entry outside it is E320, one whose target has gone is kept
  and warned (W320). Codes are E320–E322 and W320–W326, not E31x: the API
  already answers `E310` for a version conflict.
- **Showing a language is `localeOperations` applied to a copy**
  (`presentation-core/src/locales.ts`). Which language is showing is editor
  state (`useEditor.locale`, remembered per deck in localStorage) and an export
  parameter (`options.locale`); never document state. The copy's
  `metadata.language` names the locale, which is how the scene picks the
  script's font fallback, typography rules and direction.
- **The editor writes through a lens** (`editor-ui/src/lib/locale-lens.ts`).
  `editor.document` is the copy; `apply` rewrites what surfaces author against
  it: an edit in a text slot becomes that language's entry, everything else is
  shared geometry. A whole-object write (duplicate, replace) is applied, then
  every slot whose *source* words it changed is repaired: the slot's own
  translation is put back to its source, another slot's translation is carried
  over as a new entry. `/metadata/language` is never written back.
- **Python reads slots too, and is held to TypeScript** by
  `tests/test_locale_conformance.py` (runs `scripts/locale_slots_reference.ts`
  over every fixture). Patterns and hash samples come down
  `generated/locale-rules.json` under the drift gate.
- **Risk counts the slides a translation rewords** (`computeRiskTier` and
  `risk.py`, kept identical). Overlay entries live under `/locales`, and without
  this a forty-slide translation counted as touching no slide.
- **Translation and voicing are proposals** (`language_routes.py`). Providers
  are chosen, never fallen back to: `DECKASTRA_TRANSLATION` = stub | model |
  google, `DECKASTRA_SPEECH` = stub | google. Unset in a checkout is the stub
  (visibly `[hi-IN] …` and soft tones); in an installed product it refuses.
  Protected spans (numbers, links, `{{placeholders}}`, kept words) are masked;
  a translator that loses one is refused for that slot. An agent's own
  translation is stamped with the real `sourceHash` by `author_service`.
- **Narration belongs to a click step** (`slide.narration.cues[].step`); a take
  per locale records the hash of the script it says (stale is W322). The
  schedule is compiled (`animation-engine/src/narration.ts`): a step advances at
  max(motion, voice) + gap, and positions are *set* from it on seek.
- **The audience window plays narration** (`NarrationDirector`), like motion.
  Presenter windows send `mute`; the audience reports the line being spoken.
  Entering a slide backwards plays nothing.
- **Durations are read from the file** (`audio.py`: WAV, Ogg, MP3 headers).
  Browser recordings are re-encoded to 24kHz WAV, because MediaRecorder's WebM
  has no duration. The desktop grants the microphone to an editor window's main
  frame only (`main/media-permission.ts`), and the CSP allows `media-src 'self'
  blob:`.
- **Library sounds are synthesis recipes** (`renderer/src/sound-library.ts`),
  deterministic and self-written, so no notices and byte-stable PPTX audio.
- **PowerPoint carries narration**: media parts, `p:pic` audio objects off the
  slide, `mediacall` play commands in each click step, media nodes beside the
  sequence. Only the exported language's takes are sent (`audio_for_export`).
  PDF reports that sound was dropped.
- **Script faces ship with the app** (Noto for Indic, Arabic, Hebrew; Mukta,
  Hind, Baloo 2), embedded in exports by their script subset. Found while
  testing: the export page's `*{font-family: Inter}` overrode every paragraph's
  own family, so all PDFs drew text in Inter; it is now on `body`.
- **Google is held to its documented contract without being called**
  (`tests/test_google_providers.py`, a stand-in transport). Deck tags become
  the codes Cloud Translation lists (`google_language`: `hi-IN` → `hi`, only
  `zh-CN`/`zh-TW`/`pt-PT`/`fr-CA` and a few scripts keep a suffix); a user
  token carries `x-goog-user-project`; voices match by language, the deck's
  region first, and a request speaks in its voice's own tag. Verified live on
  2026-10-03 against project `deckastra`; the live run found that masking a
  digit inside a word ("Q3" → "Q⟦1⟧") let Google translate it away, so a word
  containing a digit is now protected whole.
- **Adding an empty language has two doors and one operation**: the editor's
  Add language and the MCP `locale_add` tool both build `addLocaleOperations`;
  there is deliberately no HTTP route of its own.
- **A recording's waveform is decoded from the file** (`lib/audio-peaks.ts`),
  not read from the peaks the service stored at upload, so a replaced take can
  never keep an old drawing. Cached per asset id; a failure is asked once.
- **Google credentials are named, never inherited** (`google_credentials.py`):
  a token, a credentials file (`DECKASTRA_GOOGLE_CREDENTIALS`, tokens minted
  and renewed from it) or a key. The machine's default gcloud login is not
  consulted, because it is usually for some other project.
  `scripts/setup-google-cloud.ps1` signs in inside a gcloud configuration of
  Deckastra's own (`%APPDATA%\Deckastra\gcloud`), enables the two APIs and
  sets the variables; `scripts/check-google-cloud.py` is the live check.
- **Google voices are MP3**, because PowerPoint cannot carry Ogg Opus; the
  voicing cache's file names follow the provider's format.
- **Pronunciations ("Say names as") are a per-person preference** sent with
  each Voice request; only the pairs a line uses enter its cache key, so editing
  the list does not re-voice the deck. Google gets SSML `<sub>`, every other
  piece escaped; the stand-in substitutes the words.
- **A take can be trimmed (0 to −30 dB) and swapped** for any audio file in the
  deck (`takeChoices`), each one ordinary patch.
- **A share link takes `?lang=`** and the page applies the overlay to a copy;
  pictures and recordings load through `/v1/shared/{token}/assets/{id}`
  (`client.shares.assetUrl`).
- **The `narration` step records through Chromium's fake microphone**
  (switches set in `app.ts` only for that step), through the app's own
  permission handler.
- **A voiced take records which pronunciations it used** (`take.sayAs`,
  `sayAsFingerprint` in `presentation-schema/src/pronunciation.ts`, twin
  `speech.say_as_fingerprint`). A changed "Say names as" list makes exactly the
  voiced lines that say a changed name due, in the panel's count
  (`lib/narration-due.ts`) and in the service's selection alike; recordings and
  uploaded files never are. Matching is a code-point scan in both languages
  (letters, **marks**, digits and `_` are word characters), because Python's
  `re` has no property classes and a vowel sign read as a word boundary found
  "डेक" inside "डेकास्ट्रा". Both are pinned to the same fixed vectors.
- **Speech controls are text and a preference, not new schema** (2026-10-03).
  A pause is a marker in the script — `[pause]`, `[pause 1.5s]`, `[pause 800ms]`
  (`PAUSE_PATTERN`, twin `speech.PAUSE`) — sent as SSML `<break>`, kept by the
  translator like a number, hidden by `scriptForDisplay` wherever a person
  reads a script, and counted by the timeline's estimate and the stand-in
  voice. A name written `Nguyễn = /ŋwiən/` is sent as `<phoneme alphabet="ipa">`.
  The speaking rate is the person's (`speech` preference) and enters `sayAs`
  when it is not 1, so a new rate makes voiced takes due. All three were
  checked live on Chirp 3 HD and Neural2 voices. **`tests/conftest.py` clears
  the live provider variables for every test**: after the setup script's
  `-Persist` they are in every new shell, and a test that inherited them
  called Google.
- **W323 is judged in `validateDocument`** (`clickStepCount`), not only by the
  editor's Design Check, so the Critic, exports and agents see an orphaned
  line. `animation-engine/tests/click-steps.test.ts` holds the count to the
  compiler's segments on every fixture.
- **Italic is decided by the words** (`italicAllowed`, applied in the scene):
  a span or quote in a script with no italic is drawn upright on the canvas,
  in the PDF and in PowerPoint; a Latin word beside it keeps its slant.
- **The export page uses static font files**, declared under the variable
  face's name (`apps/worker/src/fonts.ts` `bundledFontCss`, `@fontsource/*` in
  the worker). Chromium embeds a variable font as Type3, whose character map
  is the cmap alone: shaped glyphs copied out as U+0000 and Latin lost its
  spaces. **`repairPdfText`** (`pdf-unicode.ts`) then names the glyphs the cmap
  does not, by walking the full font's GSUB backwards, and fills Chromium's
  `<glyph> <0000>` entries in place; a font whose existing map disagrees with
  the walk is left alone. Glyphs that are only half of a pair (Noto Arabic's
  dot marks: ض is ص's glyph plus a dot) stay blank on purpose: per-glyph
  mapping cannot say which letter, and Chromium already writes the exact text
  as `/ActualText`, which Poppler, Acrobat and pdf.js read. The desktop build
  copies the static weights and, now, each script face's own subset files.
- **The motion timeline follows the 2026-10-03 concept**: the ruler is the
  scrubber (a range input over it, its thumb the playhead knob), ticks are
  recomputed across the whole timeline including narration (`rulerTicks`), lanes
  are named by icon, kind and words (`LaneName`), and every surface measures
  from the `--dk-lane-gutter` token. Sounds stay neutral, not the concept's
  amber: yellow means "waiting on a human".
- **Narration is the first section of the Motion panel**, above whatever motion
  panel the host supplies: below it, it was a scroll away.
- Desktop acceptance steps `languages` and `narration` drive all of it.

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

**The first morph was wrong in three ways that each looked right in the
engine's own tests** (fixed 2026-09-26, after a person used it and called it
"very buggy"):

- **Every element is drawn from the slide origin.** `positionStyle` emits the
  whole world matrix with `transform-origin: 0 0`, so the `scale` longhand
  scales about the slide's corner and also *moves* the element. A pair that
  resized started in the wrong place and swooped in. `kinds.ts` `placement()`
  solves `target = t + R·S·own` for `t`; because `t` is then linear in the
  scale, the matching point travels in a straight line. The tests measure where
  the box lands, composed as CSS composes it, not the numbers the kind emits —
  those were right, and the origin they assumed was not.
- **The travelling element was inside the slide that was fading in**, so it
  faded in from nothing, while its original on the outgoing slide sat still at
  full opacity: a ghost sliding over a copy. A pair is now two copies above both
  slides (`pair:out:` and `pair:in:`), on one path, crossing on a linear clock
  so one is always fully drawn — two identical copies at half opacity each read
  as a flicker. The originals are hidden by an attribute and a `!important`
  rule, so the motion adapter's inline styles on them are never touched.
- **Text was scaled by its box.** A text box made wider with the same type drew
  every glyph stretched. Text scales uniformly by `appliedFontSize` and pivots on
  its alignment edge, which is what stays put when a box is resized around words.

Because every element carries its full world transform, one translate and scale
on a wrapper moves a group and all its descendants rigidly; a pair nested inside
a paired group is dropped with a warning, or it would be drawn twice. The slide
being left is shown at its **final frame** (`SlideMotion` with `autoPlay` off on
the outgoing stage and on the leaving copies): at rest, an element authored to
fade in is invisible, and it vanished the instant the transition began.

Measured in real present mode at 1920 wide: the fixture's headline travels
(120,440) → (200,120) and its badge (1500,180) → (201,759), both copies on one
path every frame, `max(opacity) = 1` throughout, originals hidden for exactly the
flight. Rotation in `full` match mode is exact only at the two ends — the
midpoint can arc slightly, because a rotation about the slide origin is not
linear in the angle.

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
- Durable checkpoints are PostgreSQL's saver on a server and SQLite's on the
  desktop, in a file beside the database (`<db>.checkpoints`). An in-memory
  SQLite cannot hold one across connections, so `agent_service._checkpointer`
  returns None there and `checkpoints_available()` answers no.
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
