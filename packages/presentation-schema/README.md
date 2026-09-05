# @deckastra/presentation-schema

The canonical `.mydeck` document model: types, runtime validators, generated JSON
Schema, and the seed fixtures every other package tests against.

Specification: `docs/02_MYDECK_PRESENTATION_SCHEMA.md`. Section references in the
source (`doc 02 §31.3`) point there.

**This package must not depend on React**, or on any renderer or animation
runtime. It is imported by the editor, the export adapters and the MCP server
alike; a dependency here becomes a dependency everywhere.

---

## Layout

```
src/
  version.ts        schema version constants and compatibility rules
  ids.ts            ULID identifiers, prefixes, minting
  primitives.ts     geometry, colour, paint, stroke, easing, open enums
  limits.ts         size limits (§0.9)
  semantic-roles.ts what makes agent targeting possible
  text.ts           RichTextDocument: blocks and spans
  layout.ts         constraints and container layouts
  theme.ts          the design contract agents read
  animation.ts      tracks, clips, triggers, transitions, interactions
  assets.ts         asset references (storageKey, never a signed URL)
  data.ts           data sources, bindings, provenance
  elements.ts       every element type and the union
  components.ts     components and variables (schema now, renderer later)
  document.ts       Slide and PresentationDocument
  patch.ts          PatchOperation -> Patch -> Transaction, risk tiering
  serialize.ts      canonical byte form and content hashing
  validate.ts       the rule catalog (§42) and the document validator

generated/          JSON Schema. Generated. Never edit by hand.
fixtures/           the three seed decks. Generated. Never edit by hand.
```

---

## Commands

```bash
npm test                     # unit tests
npm run typecheck
npm run schema:emit          # regenerate generated/
npm run schema:drift         # fail if generated/ is stale (CI)
npm run fixtures:build       # regenerate fixtures/
```

---

## Two things that look like implementation detail and are not

### Validation is not serialization

`PresentationDocumentSchema.parse()` returns a *reconstructed* object: keys come
back in schema-declaration order with unknown keys appended. Persisting that
result would reorder keys every time a deck is opened and saved, turning every
version diff into noise.

Parse to **check**. Write with `serializeDocument()`, which emits a canonical byte
form. Two deeply equal documents always produce identical bytes — which is what
makes content hashing, version diffing and byte-identical render tests mean
anything.

### Open enums are deliberate

Descriptive enums — transition types, semantic roles, chart and diagram kinds,
text block types — accept values they do not know, because §0.8 requires unknown
values to survive a round-trip. A v1 reader opening a v2 deck must not delete a
transition it has never heard of.

Structural enums stay closed: patch operation codes, paint variants, constraint
kinds. An unknown value there cannot be interpreted at all, and accepting it would
push the failure somewhere far less diagnosable.

Unknown values are preserved and reported as `W241`, never as an error.

---

## The rule catalog

Codes are stable so the editor, agents, exporters and the MCP surface all
reference the same rule. `RULES` in `validate.ts` is the registry.

Two codes extend doc 02 §42 and should be folded back into the spec at the next
revision:

| Code | Rule | Why it exists |
| --- | --- | --- |
| `W240` | Unknown element type; preserved and rendered as a placeholder | §0.8 needs a way to say "preserved but not understood" without failing the document |
| `W241` | Unknown enum value; preserved and degraded by the renderer | Same, for open enums |

Rules in `REQUIRES_RENDER_CONTEXT` need text metrics or resolved geometry and
therefore run in the semantic pass after a render, not in `validateDocument`. The
constant exists so the catalog stays honest about what a document-only validator
can see.

Rules in `MECHANICALLY_FIXABLE` must emit a `suggestedFix`. That is what turns
"this text overflows" into a one-click repair, and what lets an agent correct
itself without another model round-trip.

---

## Fixtures

| Fixture | Covers |
| --- | --- |
| `technical-deck` | Every MVP element type; container layouts; the general-purpose renderer and export fixture |
| `repository-context` | Repository-grounded content where every claim carries a provenance record |
| `animation-test` | Every MVP trigger, preset shape and reduced-motion path; seek/play parity |

Ids are deterministic, so regenerating produces a zero-line diff. That is what
keeps visual regression meaningful — a fixture whose ids churn makes every
snapshot fail for no reason.
