# Redesign concepts

These are the concepts selected for each unit of the 2026-10-10 redesign plan.
They are generated pictures of a direction, not specifications: where a concept
and the implementation differ, the implementation and its tests are the
authority. Raw generations stay in `.artifacts/concepts/redesign-2026-10/`,
which git ignores.

| Unit | File | Model | Date | Notes |
| --- | --- | --- | --- | --- |
| 1 · Home | `unit1-home/templates-destination.webp` (concept), `unit1-home/implemented-dark.webp` (the built screen, captured by the desktop `a11y` smoke step) | OpenArt `gpt-image-2`, text-to-image, 2304×1296, downscaled to 1600px WebP | 2026-10-10 | Selected over a second variant. It shows Projects and Templates as separate destinations, a featured row, purpose filters with the current one in blue, and a detail drawer with three actions. Its design-language chips and real covers are units 2, 5 and 7. |

Prompt (unit 1): a Bauhaus-minimal Deckastra home on the Templates destination,
with a cream ground, square corners, Inter and Jost, blue only for actions and
the current selection, purpose chips and design-language chips, featured and
all-template grids of real and visibly different covers, and a detail drawer
offering Use template, Start with my content and Ask your agent.

## Unit 2 · Real previews: the baseline

`unit2-previews/baseline-covers-2026-10-10.webp` shows all 24 reviewed
templates' first slides, composed by the real composer and rendered through the
export worker (`packages/deck-presets/scripts/preview-sheet.py`). They are one
title layout in different colours and type: 9 cover pairs fall within 24 of 256
difference-hash bits of each other, and no text is clipped. This is the catalog
as it is, shown honestly; units 5 and 7 (design languages) have to beat it, and
unit 7 turns the report into a CI gate.

## Unit 3 · Resizable workspace

`unit3-layout/editor-1366x768.webp` is the editor at 1366×768 with every pane
at its default, captured by the desktop `layout` smoke step. The panes leave
the canvas 61% of the width and the slide is 772px (56% of the window). No
concept was generated for this unit: it adds controls to the existing layout
rather than changing it.

The plan's target of a 60% *slide* share at 1366px was tested and dropped. Even
with both panes at their minimums the slide reaches 59%, so meeting it would
mean putting a pane away. Trimming unsized panes toward it shrank the strip at
the desktop's own 1440px window for nothing. The step asserts the canvas share
instead.

## Unit 4 · Review

`unit4-review/review-concept.webp` is the selected OpenArt concept (`gpt-image-2`,
2026-10-10): changed slides on the left, Before and After side by side in the
centre, the queue with Approve, Reject and Undo for what was applied this
session. The built view follows it. In the desktop `ai` step at a 1426px window,
the Review picture was 407px wide against the Assistant column's 150px.

## Unit 5 · Design languages (two pilots)

`unit5-languages/*.webp` are contact sheets of the four pilot templates, each
composed by the real composer and rendered through the export worker:
`swiss-strategy-brief` and `swiss-launch-signal` in Swiss Signal, and
`noir-case-file` and `noir-night-story` in Cinema Noir. No OpenArt concept was
generated for this unit. The languages are taken from the design movements
named in `../research/2026-10-10-design-languages.md`, and the evidence is the
composer's own output rather than a picture of what it might become.

The preview sheet's new language-distance report compares each pilot cover with
the nearest neutral cover. Pilot covers sit 73 to 76 of 256 difference-hash bits
away, against the 24-bit near-duplicate threshold. None shares a neutral
cover's grammar (headline size, alignment, position and shapes). The two Noir
covers are 24 bits apart, so they are a near-duplicate pair. That is expected for two
title cards in one language, and unit 7's gate will compare across languages
rather than within one.

## Unit 7a · The six remaining languages

`unit7a-languages/<language>--<template>.webp` shows every slide of one
template per new language, composed by the real composer and rendered by the
export worker: Play Lab, System Terminal, Quiet Luxe, Data Desk, Earth Story
and Spatial Future. No OpenArt concepts were generated for this unit. Each
language is drawn from its described grammar (`../research/2026-10-10-design-languages.md`),
and these sheets are what it actually composes.

## Unit 7b · The language gate

`unit7b-gate/language-covers.webp` shows the gate's fixed outline composed in
all eight languages. The words are the same on every cover; the grammar
differs. The closest pair is 71 of 256 bits apart, against a floor of 40. Each
run is recorded in `../LANGUAGE_REVIEW.md`.
