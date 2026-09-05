# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Deckastra — an AI-native presentation studio. The product thesis, applied consistently across every design document: **agents propose, deterministic engines compose, humans stay in control.**

**Phase 1 of a 10-phase plan.** Built so far: `packages/presentation-schema`, `packages/renderer`, `apps/api`, `apps/web`. `agents/`, `integrations/` and the other `packages/*` directories are empty placeholders reserved by `docs/05_MVP_SYSTEM_REPOSITORY_ARCHITECTURE.md` §4 — do not treat an empty directory as a missing implementation to fill in unless the current phase calls for it.

The build order is a **walking skeleton first**, not doc 05's layering: Phase 1 is prompt → story → 5 rendered slides → present, deliberately shallow, to find out early how reliably an LLM emits valid documents against this schema. Every later phase deepens one layer.

## Commands

```bash
npm install
pip install -r requirements-dev.txt -r apps/api/requirements.txt

npm test                # all workspaces
npm run typecheck
npm run schema:emit     # regenerate generated/
npm run schema:drift    # CI gate: fail if generated/ is stale
npm run fixtures:build

npm run dev:api         # FastAPI on :8000
npm run dev:web         # Next on :3000
python -m pytest apps/api/tests -q
```

Single test file or single test, from `packages/presentation-schema/` or `packages/renderer/`:

```bash
npx vitest run tests/validation.test.ts
npx vitest run -t "rejects a duplicate id"
npx vitest                                            # watch mode
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
prompt → StoryPlan (model, JSON-schema constrained) → composer → .mydeck → renderer
```

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

**Container layout is not resolved yet** (pipeline stage 6, Phase 3). Until it is,
a child's advisory `x`/`y` is what positions it, so the composer bakes container
padding into those coordinates — correct now, and still correct once the container
starts laying out.

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

Text measurement is estimated in Phase 1 and flagged `metricsEstimated: true`;
real measurement drops in behind `TextMeasurer` in Phase 3 without the scene
builder changing.

### Validation is a product surface

`RULES` in `src/validate.ts` is the catalog (doc 02 §42). Codes are stable because the editor, agents, exporters and the MCP surface all reference the same rule. Messages must be actionable and name the offending id.

- `MECHANICALLY_FIXABLE` rules must emit a `suggestedFix` — that turns "this text overflows" into a one-click repair and lets an agent self-correct without another model round-trip.
- `REQUIRES_RENDER_CONTEXT` rules need text metrics or resolved geometry, so they run in the semantic pass after a render, not in `validateDocument`.
- `W240`/`W241` extend doc 02 §42 and should be folded back into the spec at its next revision.

Union parse failures are expanded via `ELEMENT_SCHEMA_BY_TYPE` before being reported: a raw `z.union` failure collapses to "Invalid input" at the element and loses the real reason.

### No expression language, anywhere

A `.mydeck` file must be safe to email. Data bindings use a fixed transform allowlist (`BindingTransformSchema`), binding targets use a path allowlist (`isAllowedBindingTarget` — unrestricted paths would let a binding rewrite `id`, `type` or `children`), and component parameters wire to concrete template paths rather than substituting into strings. Assets carry an opaque `storageKey`, never a signed URL; signed URLs are minted at render time.

## Fixtures

Three seed decks in `packages/presentation-schema/fixtures/`, generated by `scripts/build-fixtures.ts`:

| Fixture | Covers |
| --- | --- |
| `technical-deck` | Every MVP element type; container layouts; the general renderer and export fixture |
| `repository-context` | Repository-grounded content where every claim carries a provenance record |
| `animation-test` | Every MVP trigger, preset shape and reduced-motion path |

Fixture ids are **deterministic** so regeneration produces a zero-line diff — a fixture whose ids churn makes every visual-regression snapshot fail for no reason. Do not use hand-written ULIDs in tests; call `newId()`.

## Conventions

- All lengths and coordinates are **logical presentation pixels** as bare numbers — never `"12px"` strings. Durations are integer milliseconds. Angles are degrees, clockwise positive. Timestamps are ISO 8601 UTC.
- Ids are `{prefix}_{ULID}`, stable forever, never reused, never parsed for meaning beyond the prefix.
- `packages/presentation-schema` must not depend on React or on any renderer or animation runtime.
- Source comments explain *why*, citing the spec section. Match that when adding code — the reasoning is the part that stops a future change from silently undoing a decision.
- Relative imports inside packages are **extensionless** (`from "./scene"`), matching `moduleResolution: "Bundler"`. Turbopack does not map `.js` → `.ts`, so extensions break the web build.
- `.gitattributes` forces LF. Both drift gates compare generated files against their committed form, and the generators emit LF; a CRLF checkout fails them on a clean tree.

## Tooling deviations from doc 05

- **npm workspaces**, not pnpm + Turborepo — pnpm is not installed in the dev environment and npm workspaces cover a single-track solo build with no setup step.
- **Zod-first**, though doc 02 §34.4 calls TypeScript normative. Types are `z.infer`red, so there is one definition rather than two hand-synced ones. Recursive types (`GroupElement.children`, `Slide.elements`, `ComponentDefinition.template`) need an explicit interface plus a `z.ZodType<T>` annotation on the schema.
