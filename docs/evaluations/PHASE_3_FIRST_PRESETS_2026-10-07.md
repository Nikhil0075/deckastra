# Phase 3 first presets — 2026-10-07

Phase 3 is complete. Its local exit control and the official GitHub Copilot CLI
acceptance both pass.

## Delivered

- Twenty author-facing semantic patterns. The patterns refine seven deterministic
  geometry families, so agents choose narrative structure without coordinates.
- Six reviewed purpose templates, each with ten slides. Together they exercise
  all twenty patterns.
- Three defined motion styles: `restrained`, `dynamic` and `cinematic`. Template
  creation now resolves the selected style into role-based animation plans,
  applies the template transition style and records the motion style in document
  metadata.
- The template gallery now searches names, summaries and tags, shows real opening
  content, reports the number of patterns in each template and uses the generated
  motion-style label.
- `preset_list` publishes the pattern and motion contracts. `deck_from_template`
  produces a ten-slide, animated deck in one write call. `document_read` reports
  the semantic pattern, motion style and per-slide animation count without
  returning the full document.
- A repeatable `acceptance:phase3` MCP script enforces the five-request budget.

## Gate results

- `presets:check`: 6 templates, 20 slot schemas, 12 negative controls and the
  generated contact sheet passed.
- The contact sheet contains 60 review cells: 20 patterns across Minimal Light,
  Neo Technical and Playful Pastel. It was captured to
  `.artifacts/phase-3-preset-contact-sheet.png` and visually inspected.
- Full workspace TypeScript typecheck passed.
- API generation, route and motion suites: 90 tests passed.
- MCP server: 36 tests passed.
- Template gallery: 3 tests passed.
- Deck preset package: 4 tests passed.

## Five-request exit control

The real stdio MCP transport created and reread presentation
`doc_01M4B69FM1VDK1BGMJNSDXJ9MQ` in **3 Deckastra calls**:

1. `preset_list` for technical templates;
2. `deck_from_template` for `technical-architecture`;
3. `document_read` to verify the result.

The result has 10 slides, the `restrained` motion style, motion tracks on every
slide, and ten distinct semantic patterns: title, bullets, code, metrics,
decision, agenda, comparison, process, roadmap and closing.

The authenticated official GitHub Copilot CLI then completed the identical
bounded journey in **3 Deckastra calls**. It created and reread presentation
`doc_01M4BFM0GPRA3JADC6A1JE94ED`, version
`ver_01M4BFM0K5QT0HB1SQ2EKSR7ZQ`. Copilot verified 10 slides, animation tracks
on every slide, the `restrained` motion style and the same ten distinct semantic
patterns: title, bullets, code, metrics, decision, agenda, comparison, process,
roadmap and closing. This satisfies the literal Phase 3 exit sentence.
