# Design-language review

The record the plan asks for beside the automated gate (UI audit 2026-10-10,
unit 7b). The gate checks what can be measured. This file records what a
person saw, and when.

## How the gate works

`python packages/deck-presets/scripts/preview-sheet.py --languages --strict`
composes one fixed six-slide outline (`GATE_OUTLINE`) in every language that
has templates, renders each cover through the export worker, and fails when
any of these holds:

- **Too close.** Two covers differ by 40 or fewer of the 256 difference-hash
  bits.
- **Shared grammar.** Two title slides have the same headline size, alignment,
  position and set of shapes.
- **Clipped or overlapping.** Any slide in any language's outline has clipped
  text (W103) or one object on another (W110, Design Check's collision rule).

CI runs it in the Export job and uploads the covers with the template cover
report.

## Runs

### 2026-10-10: the first run

- **Languages:** eight (cinema-noir, data-desk, earth-story, play-lab,
  quiet-luxe, spatial-future, swiss-signal, system-terminal).
- **Closest pair:** data-desk and swiss-signal, **71 bits** apart. The floor
  is 40.
- **Shared grammars:** none.
- **Clipped or overlapping:** on the first run, two clipped boxes in System
  Terminal's quote layout (the `/*` and `*/` marks). They were fixed, and on
  the second run there were none.
- **Result:** passed.

Covers: `concepts/unit7b-gate/language-covers.webp`.

**Reviewed by Claude (the implementing agent).** Each cover reads as its own
language, with the same words: noir's letterbox and serif title card, the
dashboard's spark bars, the earth block and arch, Play Lab's sticker and
bubbles, Quiet Luxe's margins and portrait frame, Spatial Future's orbit and
glow, Swiss Signal's capitals and red disc, and the terminal's window and
prompt.

**Reviewed by a person:** not yet. The plan asks for a person's sign-off on
this sheet, and an agent's review does not count as one. Add a line here with
a name and date when it is done.
