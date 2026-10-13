---
name: deckastra-deck-design
description: Direct a presentation in Deckastra over MCP — select reviewed structural patterns and a design language, enforce real layout variety, use quoted media safely, and inspect every slide before completion. Use when building, restyling or translating a Deckastra deck.
---

# Deck Director: designing in Deckastra

Deckastra composes geometry; you decide what each slide is *for* and which
structure carries it. Correct and monotonous is the failure to avoid.

## 1. Read the system before composing

Before writing any slide:

1. Call `preset_list`. Read each pattern's `family`, `contentKinds`, named
   slots and example; choose patterns for the content, not for their names.
2. Pick a design language with `design_language_get` (or a template's own).
   Follow its rules, forbid list, density limits and default motion.
3. Set the palette and faces if the person has a brand: `theme_propose` with
   background, foreground, accent and two bundled faces. It refuses text below
   4.5:1, so fix the colours rather than retrying.
4. Plan the deck as a list of slides, each with **one claim** and **one
   visual** that proves it: a number, a chart, a diagram, a dated sequence, a
   photograph or a quotation. Words alone are the last resort, not the default.

## 2. Choose the structure from the content

| The slide has | Use |
| --- | --- |
| Values compared side by side | `bar-chart` or `comparison` |
| A measure over time | `trend-chart` |
| A start, changes and an end total | `waterfall-chart` |
| Where several things started and ended | `slope-chart` |
| Parts of a whole (at most five) | `share-chart` |
| Two measures for many items, or three with size | `chart` layout, `type` `scatter` or `bubble`, with `points` |
| Values by place | `chart` layout, `type` `bubbleMap`, with `points` carrying latitude and longitude |
| Parts of a system and how they connect | `system-diagram` or `architecture` |
| Steps something goes through | `process-flow` or `process` |
| Dated milestones | `milestones`, `timeline` or `roadmap` |
| One decisive number | `big-number` |
| A moment, place or person | `full-bleed-photo`, `profile` or `gallery` |
| A choice or contrast | `comparison`, `pros-cons` or `decision` |
| A sentence to remember | `statement`, `quote` or `reflection` |

With `deck_compose`, put the selected pattern in `pattern_id` and its
legacy geometry in `layout`. When revising a deck, prefer
`slide_insert_pattern`; it uses the same reviewed slot contract as the editor.

The headline states the conclusion ("Revenue grew every quarter"), never a
label ("Revenue"). A chart's `unit` and a `caption` naming the source go
with every number. Never invent a number or a source: ask, or leave the slide
as words.

## 3. Variety and pacing

- Never repeat a structural family on adjacent slides.
- A ten-slide deck uses at least eight structural families. A shorter deck uses
  as many families as its story reasonably supports.
- A deck of six slides or more has evidence on at least a third of them
  (chart, diagram, timeline, photograph or table).
- Use a full-slide composition at the opening or chapter turn; do not make every
  slide a bordered card grid.
- Transitions come from the language, with accents by slide kind. Change one
  with `transition_propose` only when the moment asks for it; never set every
  slide to the same showy kind.
- Motion is by role and pacing (`motion_propose`), never in milliseconds.

## 4. Media

For a media pattern, write `picture` as what the photograph shows in plain
words: it is both alt text and generation direction. Use `image_quote` then
`image_generate` for a still, or `media_quote` then `media_generate` for a
clip. Do not generate until the exact quote is accepted. The result remains a
proposal for the person to approve.

## 5. Check before you answer

1. `slide_preview` every slide you made or changed and look at it: clipped
   words, a chart whose labels collide, a picture covering text.
2. `design_check`, and fix what it names.
3. Re-read the deck: adjacent families differ, claims agree with evidence, and
   numbers agree with labels and speaker notes.
4. Narration runs about 130 words a minute: a 10-minute talk is about 1,300
   words across the deck. Count before you voice it.
5. Translation: `locale_propose` returns `coverage`. A language is done only
   when nothing is missing or outdated; say how many remain otherwise. Only a
   person marks a language reviewed.

Say what you checked and what you could not. Risky changes wait for the person
in Deckastra; you cannot approve them.
