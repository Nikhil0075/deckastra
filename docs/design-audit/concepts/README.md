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
