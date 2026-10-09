# Deck presets

This package is the source of truth for reviewed deck templates and their
author-facing named slots. Presets contain content and intent, never geometry.

## Commands

- `npm run presets:emit` writes `generated/deck-presets.json` and the human
  review page at `generated/contact-sheet.html`.
- `npm run presets:check` validates the catalog, runs every deliberate negative
  control, refuses generated-file drift, motion-checks all 24 templates, and
  exports and reopens each template as PDF and PowerPoint.
- `npm test --workspace @deckastra/deck-presets` tests the slot schemas,
  controls, contact-sheet coverage and HTML escaping.

The launch catalog contains sixty semantic patterns, twenty themes, twenty-four
reviewed ten-slide templates (four per purpose group) and seven motion styles.
The API test suite composes every reviewed template, validates the resulting
presentation document, runs the preset Design Check codes, and stress-fills
every geometry family with short, typical, forty-word, Hindi, Arabic and CJK
content.

## Adding a pattern or preset

1. Define the pattern's named slots and representative content in
   `src/schema.ts`. Use a slot kind already understood by the deterministic
   composer; do not add coordinates.
2. Add or update preset data in `src/index.ts`.
3. Run `npm run presets:emit`, then `npm run presets:check` and the package/API
   tests.
4. Open `generated/contact-sheet.html`. Only mark a preset `reviewed` after a
   person has inspected the sheet.
