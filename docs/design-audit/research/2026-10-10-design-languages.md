# Design languages: research behind unit 5 (2026-10-10)

The UI audit found that templates which compose differently looked alike, and
templates which compose alike looked like a catalogue. Unit 2's real previews
showed why: 18 of the 24 templates came from one ten-pattern sequence, and the
composer had one geometry per layout. A new colour scheme over the same grid
is a recolour, not a design. This note records what was looked at before
deciding what a "design language" is in Deckastra, and how the two pilots,
Swiss Signal and Cinema Noir, came out of it.

## What other tools do

| Tool | What it separates | What we took | What we did not |
| --- | --- | --- | --- |
| Gamma | Themes (colour, fonts, card style, accent images) are separate from content; a card's layout can change without changing its words. ([custom themes](https://help.gamma.app/en/articles/7852253-how-to-create-a-custom-gamma-theme)) | Style and content as two inputs; a layout change never rewrites words. | A theme in Gamma is mostly surface. A language here also changes geometry. |
| Beautiful.ai | Constraint-based "smart slides": defined zones per slide that reflow as content is added. Reviewers name the rigidity as the cost. ([review](https://aumiqx.com/ai-tools/beautiful-ai-review-presentation-maker-2026/), [tutorial](https://aiindigo.com/tutorials/getting-started-with-beautiful-ai-automating-slide-design-with-smart-slides)) | Layout is code with rules, not free placement. That was already Deckastra's thesis. | Pre-empting every manual edit. The deck stays editable after composition. |
| Canva | A Brand Kit (colours, fonts, logos, templates) is applied over generated variety. ([on-brand designs](https://www.canva.com/help/create-on-brand-designs/)) | Brand stays the theme's job and sits *under* a language. A language is not a brand. | — |

The conclusion: none of the three lets a person pick a *design grammar* (grid,
type scale, alignment, motifs) separately from a palette. That is the gap a
language fills.

## How a language is specified

The [Design Tokens Format Module 2025.10](https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/)
(a final W3C Community Group report, not a W3C Standard) is the closest thing
to a shared vocabulary for design decisions. It is about values: colours,
dimensions, typography. Deckastra's theme already holds those, and keeps
holding them. What the format module does not describe, and a language must,
is *rules*: grid asymmetry, case, what is forbidden. So a language is a small
contract (`packages/deck-presets/src/languages.ts`) with three parts:

- **Axes and rules in words**, which a gallery can filter on and an agent can
  read and follow;
- **defaults** for theme, motion, transition and voice, which are the single
  source of truth (a template may override one, and an override equal to the
  default is refused because it is the copy that drifts);
- **geometry in the composer** (`apps/api/deckastra_api/languages.py`), which
  overrides individual layouts and falls back to neutral for the rest.

Agents still name layouts and never place pixels.

## Type scale

A modular scale multiplies one base size by a fixed ratio per step. Common
ratios run from the major third (1.25) through the perfect fourth (1.333) and
perfect fifth (1.5) to the golden ratio (1.618). Larger ratios give a more
dramatic hierarchy with fewer usable steps
([Creative Market](https://creativemarket.com/blog/typographic-scale),
[Cieden](https://cieden.com/book/sub-atomic/typography/different-type-scale-types)).
[Robin Rendle](https://www.robinrendle.com/adventures/typographic-scales/)
cautions that no ratio makes a layout beautiful on its own and sizes should be
judged by eye. Both pilots therefore record a ratio as intent and were then
checked on rendered slides:

- **Swiss Signal: 1.618.** It needs a display size several steps above body,
  with nothing in between.
- **Cinema Noir: 1.5.** Large title cards, but a serif body that still reads
  at a distance.
- **Neutral** keeps its existing sizes; its output is unchanged.

## Pilot 1: Swiss Signal

The International Typographic Style starts from a mathematical grid. It uses
asymmetric layouts, flush-left, ragged-right text and grotesque sans-serif
faces, and aims at objective, legible communication
([Wikipedia](https://en.wikipedia.org/wiki/International_Typographic_Style),
[Graphic Design and Print Production Fundamentals](https://opentextbc.ca/graphicdesign/chapter/1-6-its/)).

What that became in the composer:

- a 12-column grid, with content placed on column spans rather than centred;
- uppercase display type at weight 800 with tight tracking, and at most five
  words in a headline;
- one red accent: a red index rule above every headline, a large red disc on
  the title slide, and a red hero figure on the metrics slide;
- rules and a numbered list as structure, in place of cards;
- square corners, a cut transition and restrained motion;
- forbidden: centred text, rounded cards, gradients, more than one accent.

## Pilot 2: Cinema Noir

Film noir is defined visually by low-key lighting: most of the frame dark,
light concentrated on a subject, chiaroscuro contrast, with title cards that
set the mood ([Wikipedia: Film noir](https://en.wikipedia.org/wiki/Film_noir),
[Wikipedia: Low-key lighting](https://en.wikipedia.org/wiki/Low-key_lighting)).

What that became in the composer:

- near-black background with a radial "spotlight" behind the headline;
- black letterbox bars at top and bottom, as in a widescreen frame;
- a centred serif title card (Playfair Display over Source Serif 4), a
  hairline rule and a small spaced eyebrow;
- warm ivory text and one gold accent, with a deep red as the secondary;
- at most three bullets, set as centred lines rather than a list;
- an image frame on the split layout, waiting for unit 7's bundled media;
- forbidden: light backgrounds, bright saturated colour, dense bullet lists.

Both themes pass the theme presets' AA contrast test.

## Telling languages apart

Layout-generation research measures similarity between layouts structurally,
not by pixels. [LTSim](https://arxiv.org/abs/2407.12356) matches elements by
optimal transport, so it can compare layouts that share no element types.
[LayoutGMN](https://arxiv.org/abs/2012.06547) learns structural similarity by
graph matching. Both are heavier than a gallery check needs. Unit 5 uses three
cheap signals and leaves a learned measure for later:

1. a perceptual hash distance between covers (already in unit 2's preview
   sheet);
2. the headline's font size and alignment;
3. a grid signature: which shapes a slide is made of and where its headline
   sits.

`test_each_language_composes_the_same_plan_differently` asserts the
three-way difference on one plan. The preview sheet's distance report shows it
across every pilot cover. Unit 7 turns these into a hard gate across all eight
languages.

## Decision point

The plan said to revise the model before unit 7 if per-layout overrides did
not scale to two very different pilots. They did. Each pilot overrides six of
the seven layouts with shared helpers (`_cols`, `_swiss_display`,
`_noir_frame`). The code layout falls back to neutral. The neutral composer's
24 templates hash byte-identically to `main`
(`apps/api/tests/goldens/compose_neutral.json`).

Known weaknesses, carried to unit 7:

- Noir's split layout shows an empty frame until media ships.
- Some secondary text is small at thumbnail size.
- Neither pilot has its own chart or diagram treatment yet.
