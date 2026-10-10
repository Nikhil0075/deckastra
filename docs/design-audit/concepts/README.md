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
