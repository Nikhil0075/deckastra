# Phase 2 preset format and gate — 2026-10-07

Phase 2 is complete. The preset catalog now has one typed, generated named-slot
contract; a deterministic review sheet; CI drift enforcement; and negative
controls that prove the validator fails when a preset is deliberately broken.

## Delivered

- Seven pattern definitions (`title`, `statement`, `bullets`, `metrics`,
  `quote`, `code`, `split`) publish slot kinds, required fields, item bounds,
  author guidance and representative content. Geometry remains exclusively in
  the composer.
- `generated/deck-presets.json` now carries `patternDefinitions`, so the API,
  editor and MCP clients read the same slot contract as the source package.
- `generated/contact-sheet.html` renders every pattern in Minimal Light, Neo
  Technical and Playful Pastel: 21 review cells. The generated sheet was
  visually inspected after capture to
  `.artifacts/phase-2-preset-contact-sheet.png`; no cell clips or overlaps.
- `npm run presets:check` validates the catalog, runs eleven negative controls,
  and checks both generated artifacts for drift. CI now runs that command.
- API tests compose every reviewed preset into a schema-valid document and run
  Design Check against W110 overlap, W104 safe area, W216 small text and A102
  contrast.
- Stress tests exercise all seven patterns with short and typical text, a
  forty-word paragraph, Hindi, Arabic and CJK content. All remain schema-valid
  and clear the same four Design Check codes.

## Negative controls

The gate deliberately injects and detects: duplicate preset IDs, unknown
purposes, unknown themes, empty decks, duplicate slide keys, unknown patterns,
unknown slots, missing required slots, wrong slot types, list cardinality
violations and blank content. A missed expected diagnostic fails the command.

## Verification

- `npm run presets:check`: 6 presets, 7 slot schemas, 11 controls and the review
  sheet passed.
- Full workspace TypeScript typecheck passed.
- Deck preset package: 4 tests passed.
- API generation suite: 30 tests passed.
- API generation plus route suite: 70 tests passed.
- MCP server: 35 tests passed.
- New-deck editor surface: 2 tests passed.

Phase 3 can now grow the catalog to the first product set without inventing a
new format: 20 patterns, six templates and three motion styles, with the gallery
and coarse agent tools consuming the generated contract.
