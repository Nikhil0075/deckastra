/**
 * The deck-design skill (2026-10-11). A review of agent-built decks found them
 * correct and monotonous: card rows and bullet lists throughout, one
 * transition, no chart where the numbers were, a translation called done with
 * slots missing. The tools could already do better; nothing told an agent to.
 *
 * One text, two doors: the `deckastra://guides/deck-design` resource every
 * connected agent can read, and `skills/deckastra-deck-design/SKILL.md` for
 * clients that install skills. A test holds the file to this constant, so the
 * two cannot drift.
 */
export const DECK_DESIGN_GUIDE = `# Designing a deck in Deckastra

Deckastra composes geometry; you decide what each slide is *for* and which
structure carries it. Correct and monotonous is the failure to avoid.

## 1. Art direction first

Before writing any slide:

1. Pick a design language with \`design_language_get\` (or a template's own).
   Follow its rules, forbid list and density limits.
2. Set the palette and faces if the person has a brand: \`theme_propose\` with
   background, foreground, accent and two bundled faces. It refuses text below
   4.5:1, so fix the colours rather than retrying.
3. Plan the deck as a list of slides, each with **one claim** and **one
   visual** that proves it: a number, a chart, a diagram, a dated sequence, a
   photograph or a quotation. Words alone are the last resort, not the default.

## 2. Choose the structure from the content

| The slide has | Use |
| --- | --- |
| Values compared side by side | \`chart\` (column or bar), the takeaway in \`body\` |
| A measure over time | \`chart\` with \`line\` or \`area\` |
| A start, changes and an end total | \`chart\` with \`waterfall\` |
| Where several things started and ended | \`chart\` with \`slope\` |
| Parts of a whole (at most five) | \`chart\` with \`donut\` |
| Parts of a system and how they connect | \`diagram\` (\`architecture\`) |
| Steps something goes through | \`diagram\` (\`flow\`) or \`timeline\` |
| Dated milestones | \`timeline\` |
| One or two headline numbers | \`metrics\` |
| A moment, a place, a person | \`image\`, described in \`picture\` |
| A sentence to remember | \`statement\` or \`quote\` |
| Two to five parallel points | \`bullets\` or \`split\` |

The headline states the conclusion ("Revenue grew every quarter"), never a
label ("Revenue"). A chart's \`unit\` and a \`caption\` naming the source go
with every number. Never invent a number or a source: ask, or leave the slide
as words.

## 3. Variety rules

- No structure three slides running. \`deck_compose\` warns when you do; fix
  it before you answer.
- A deck of six slides or more has evidence on at least a third of them
  (chart, diagram, timeline, photograph or table).
- Transitions come from the language, with accents by slide kind. Change one
  with \`transition_propose\` only when the moment asks for it; never set every
  slide to the same showy kind.
- Motion is by role and pacing (\`motion_propose\`), never in milliseconds.

## 4. Pictures

For an \`image\` slide, write \`picture\` as what the photograph shows, in
plain words: it is the alt text and the prompt. Generate it with
\`image_quote\` then \`image_generate\` for that slide; the picture fills the
slide's frame, under the headline. The person approves the cost.

## 5. Check before you answer

1. \`slide_preview\` every slide you made or changed, and look at it: clipped
   words, a chart whose labels collide, a picture covering text.
2. \`design_check\`, and fix what it names.
3. Numbers on a slide agree with the labels and the speaker notes.
4. Narration runs about 130 words a minute: a 10-minute talk is about 1,300
   words across the deck. Count before you voice it.
5. Translation: \`locale_propose\` returns \`coverage\`. A language is done only
   when nothing is missing or outdated; say how many remain otherwise. Only a
   person marks a language reviewed.

Say what you checked and what you could not. Risky changes wait for the person
in Deckastra; you cannot approve them.
`;
