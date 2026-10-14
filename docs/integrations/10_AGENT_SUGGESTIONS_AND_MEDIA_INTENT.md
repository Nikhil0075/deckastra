# 10 — Agent suggestions, a rough canvas, and pictures that match the deck

Status: planned, 2026-10-14. Nothing here is built yet.

This plan covers two things a person asked for:

1. **An agent that suggests, not only proposes.** Over MCP, a coding agent
   should be able to offer styles, themes, palettes and content as choices.
   It should also be able to lay out a rough canvas of slides that the person
   organises (reorder, add, remove) before anything is built. And the person
   should be able to select an object and say, in words, what is wrong with
   it ("this motion is not good, I want another effect") and have that reach
   the agent.
2. **A switch on image and video generation.** It decides whether the prompt
   takes its intent from the deck (the slide's colours, the design language,
   the picture treatment) or follows the person's prompt alone.

Both keep the product's thesis: **agents propose, deterministic engines
compose, humans stay in control.** Nothing here gives an agent geometry, a
risk tier or a way to approve its own work. Nothing here adds an in-app text
model.

---

## 1. Where the code is today

### 1.1 MCP can propose but cannot suggest

`apps/mcp-server/src/tools.ts` registers about 45 tools. Every write tool
(`document_propose`, `deck_compose`, `deck_from_template`,
`slide_insert_pattern`, `motion_propose`, `transition_propose`,
`theme_propose`, `locale_propose`, `narration_propose`) produces a **finished
change**. That change becomes a proposal, and it either applies at low risk
or waits for approval.

Four things are missing:

- **Choices.** An agent cannot say "here are three directions, pick one".
  `theme_propose` makes one theme, and a person either takes it or rejects
  it.
- **A cheap working surface.** Every structural idea ("swap slides 3 and 4",
  "drop the agenda", "split this slide in two") costs a full proposal,
  validation and a version. Rough work cannot be rough.
- **A channel back to the agent.** A person can select an object and edit it,
  but nothing carries "I don't like this" to the agent that made it. The
  in-app Ask agent was removed on purpose (CLAUDE.md, "Connected agents write
  operations"). So a complaint has nowhere to go except the terminal, and
  there it carries no element ids.
- **Quick alternatives without an agent.** The motion planner already offers
  a dry run (`dry_run: true` on `POST …/motion`, used by Motion mode's "Plan
  by roles"). Nothing offers "try another" on one selected object.

### 1.2 Picture prompts go to the model exactly as typed

- `assistant_tasks.py:120` (image) and `:134` (video) send
  `request["instruction"]` to the model unchanged.
- `mediaSlotBrief` (`presentation-core/src/media-slots.ts`) already writes a
  good **composition** brief from a frame's `mediaSlot`: kind, focal side,
  text-safe area, mask, orientation, and treatment words. But:
  - it says nothing about the deck's **palette** or **design language**;
  - only the editor's Generate panel calls it, and only to pre-fill the
    description box;
  - the server never adds anything, so MCP `image_generate` and
    `media_generate` get none of it.
- The quote token is bound to the exact prompt (`verify_service_quote`,
  `verify_video_quote`). Anything the server adds therefore has to be decided
  **before** the quote, so that what is priced is what runs.

---

## 2. Part B: "Match the deck" for images and video

B comes first: it is the smallest part, self-contained, and built on code
that already exists.

### 2.1 The switch

A new field, `style_source: "deck" | "prompt"`, goes on:

- `AssistantRequest` (`assistant_routes.py`) for tasks `image` and `video`;
- the image and video quote requests;
- MCP `image_quote`, `image_generate`, `media_quote` and `media_generate`;
- the editor's `GenerateMedia` panel, as a two-option segmented control:
  **Match the deck** and **Follow my prompt**.

The default is `deck` when the slide has a picture frame (`mediaSlot`) or the
deck records a design language (`metadata.designLanguage`), and `prompt`
otherwise. The choice is session state. It never reaches the document, except
as provenance on the generated asset (§2.5).

### 2.2 The brief is built by code, on the server

A new module, `apps/api/deckastra_api/media_style.py`, provides:

```
compose_media_prompt(document, slide_id, subject, *, kind, style_source)
  -> { prompt, parts: [{source, text}], aspect_ratio, checks }
```

It is deterministic, calls no model, and returns the same answer for the same
document.

In **deck** mode it joins these parts in order. Each part is tagged with
where it came from, so the panel can show it.

| Part | Source |
| --- | --- |
| Subject | The person's words, verbatim. |
| Composition | The frame's slot brief: the same rules as `mediaSlotBrief`, ported (see §2.3). |
| Palette | The slide's resolved theme colours (with `slide.colorMode` applied): background, accent and text, as colour words with the hex beside them ("deep navy #14213D, warm coral #E76F51"). Plain-language names come from a fixed nearest-name table, not a model. |
| Light and mood | From the design language: its imagery rules and its axes. For example, Cinema Noir gives "low-key light, deep shadows, film grain", and Earth Story gives "natural daylight, matte textures". These are written once per language in `deck-presets/src/languages.ts` as a new `imagery.promptWords` field, so they are data and not code. |
| Treatment | The frame's `treatmentPreset`, in the existing `TREATMENT_WORDS`. |
| Always | "No text, letters or logos." |

In **prompt** mode only the parts that keep the picture *usable* remain:
subject, aspect ratio, the area words will sit over, the mask, and "no
text". The palette, the language and the treatment are left out. The picture
still fits its frame; it just does not borrow the deck's look.

On a slide with no frame, the composition part falls back to the slide's
aspect ratio and the area the slide's text covers, measured from the scene in
the same way `media_slots.annotate` measures `textSafeArea`.

**Video** gets the same parts, plus camera pace from the language's
calm–kinetic axis: "slow, steady camera" or "quick handheld movement". It
never asks for cuts, which a single clip cannot honour.

### 2.3 One brief, held to one answer

`mediaSlotBrief` is TypeScript, and the server needs the same composition
rules in Python. That is a second definition, and this project tolerates one
only with a conformance test, as with the patch appliers.

- Either the TypeScript function moves behind the server (the editor asks the
  server for the brief), **or**
- both implementations are kept and held together by
  `tests/test_media_brief_conformance.py`, which runs the TypeScript version
  through `tsx` over every pattern's frames and compares the strings.

**Recommendation: the first.** The editor already makes a network round trip
to quote a price. A new `POST /v1/assistant/media-prompt` route returns
`compose_media_prompt`'s answer, and `mediaSlotBrief` stays only as the
offline fallback the panel shows before the answer arrives.

### 2.4 The person sees exactly what will be sent

The Generate panel shows the composed prompt, one part per line, each line
labelled with its source ("From the deck: palette"), before **Price**.

- A part can be switched off for this one request.
- The whole text can be edited.
- The quote is issued for the **final** text and the mode (the quote payload
  gains `style_source` and the composed `prompt`). The priced prompt and the
  run prompt are then the same string by construction, and `verify_*_quote`
  is unchanged.

MCP gets the same thing. `image_quote` and `media_quote` return the composed
prompt and its parts, and the agent passes the returned prompt to
`image_generate` and `media_generate`. An agent that wants none of it sends
`style_source: "prompt"`.

### 2.5 Recorded on the asset

The generated asset's manifest entry records `generation: { styleSource,
prompt, model, at }`. Regenerating ("Make another like this") reuses the
record. Version history shows how a picture was asked for. Nothing here is
user text in telemetry: the record lives in the document, like `altText`.

### 2.6 The most reliable lever: apply the deck's treatment afterwards

A model asked for "warm coral and deep navy" will often comply loosely.
Picture treatments (`image.treatment`, 2026-10-13) are reversible, follow the
theme, and work identically on the canvas, in the PDF and in PowerPoint.

- In deck mode, the panel offers **Apply the deck's look** (on by default
  when the frame has a `treatmentPreset`, or the language names one). The
  placed image gets that treatment in the same proposal.
- Because it is a treatment and not a change to the pixels, **Original**
  takes it off.

This works however the model behaved, so it is the part to rely on. The
prompt is the part to hope for.

### 2.7 Later, and opt-in

- **Palette distance.** Measure the generated picture's main colours (k-means
  over a 64×64 thumbnail, done once, server-side) against the deck's palette
  in ΔE. Report "close to the deck" or "far from the deck" beside the result.
  Report only; never refuse.
- **Reference images.** Some image models accept a reference picture. Sending
  a render of the slide would align the style more strongly, but it sends the
  person's slide to a provider. That is a consent question, so it would be a
  separate, labelled option and never folded into "Match the deck".

### 2.8 Tests

- **`media_style` is deterministic:** the same document gives byte-identical
  prompts. Changing `colorMode` changes the palette part. Prompt mode carries
  no palette or language words. A slide with no frame still gets an aspect
  ratio and a text-safe area.
- **The quote binds the composed prompt:** running with a different text
  under the same token is refused.
- **Every language has `imagery.promptWords`**, checked by the preset drift
  gate. No language's words contain a colour name, because colour comes from
  the theme only.
- **MCP:** `image_quote` returns the parts, and `image_generate` with
  `style_source: "prompt"` sends no palette.
- **Editor:** the switch defaults as in §2.1. Turning a part off removes
  exactly that line. Asking for a price sends the text on screen.

---

## 3. Part A3 and A4: select an object and say what is wrong

### 3.1 A4: "Try another", with no agent involved

The quickest answer to "this motion is not good" does not need an agent.

- **Where it appears:** a selected object in Motion mode (and its context
  menu) gets **Try another**.
- **What it does:**
  - It asks the motion planner for a **dry run** with the next entrance
    preset suited to the object's role. The candidates are the planner's own
    list for that role (`motion_capabilities`), in a fixed order, skipping
    the one in use.
  - It previews the result in place with the measured budget line ("Total
    0.8s — within the 2.5s budget").
  - Pressing again cycles. **Keep** applies it as the person's own edit, one
    undo step, as "Plan by roles" already does.
- **Pacing:** two companion chips, **Calmer** and **More energy**, re-plan
  with the neighbouring pacing word.
- **Never changes the document while previewing.** The preview is the
  existing transition and motion preview path.
- **Tests:** the cycle never repeats until it wraps, never offers a preset
  the planner refuses for that role, and Keep produces exactly one
  transaction.

### 3.2 A3: Ask the agent about this

For anything open-ended, the person's words go to the agent, attached to the
objects they are about.

**Data.** A new table, `agent_requests`, with an additive migration:

| Column | Meaning |
| --- | --- |
| `id` | `req_…` |
| `presentation_id` | The deck. Authorised through `resolve_presentation_access`. |
| `target` | JSON: `{slide_ids, element_ids}` or `{draft_id, card_ids}` (§4). |
| `kind` | `motion`, `style`, `content`, `image`, `layout` or `other` (open). |
| `message` | The person's words, at most 2,000 characters. |
| `based_on_version_id` | The version the person was looking at. |
| `status` | `open`, `answered` or `closed`. |
| `created_by`, `created_at`, `closed_at` | |

**Routes.**

- `POST /v1/presentations/{id}/requests` needs editor access. Agents get no
  grant scope for it: requests are the person's.
- `GET /v1/presentations/{id}/requests?status=open` is a read.
- `POST /v1/requests/{id}/close` is the person's.

**MCP tools.**

- **`request_list`** returns open requests with their targets resolved to the
  outline's ids and names, and the target objects' current text and motion.
  The request text is **enveloped** as untrusted, because it is the person's
  free text arriving in the agent's context (the registry rule:
  `untrusted_fields: ["message"]`).
- **`request_answer`** takes `request_id` plus one to three
  `proposal_id`s the agent has already created with the ordinary write tools.
  It marks the request `answered`. It cannot approve anything.
- Write tools gain an optional `in_reply_to: request_id`, stored on the
  transaction, so Review can group the answers.

**Editor.**

- A selected object (or several, or a slide) gets **Ask agent…**. A small
  popover offers chips for the request kind ("Different entrance",
  "Calmer", "Simpler", "Another picture", "Tighter words") and a text field.
- Open requests show as a count beside Review, in yellow, which already means
  "waiting on a person".
- In **Review**, the proposals answering one request are shown together as
  options A, B and C, each with its before and after. **Approving one
  withdraws the rest** (`proposal_withdraw` on the siblings, recorded as
  "superseded by …") and closes the request.

**How the agent finds out.** A first version relies on the agent calling
`request_list`. The deck-design guide
(`apps/mcp-server/src/deck-design.ts`) tells agents to check it at the start
of every turn. Pushing a notification (MCP `notifications/resources/updated`
on a `deckastra://requests` resource) is the better experience, but whether
Claude Code and Codex act on resource notifications has to be **measured with
a real session before it is relied on**, the same way the D2 tools were.

**What this does not do.**

- **It does not call a model.** The person's words wait for an agent that is
  connected. If none is, the request says "No agent is connected" rather than
  appearing to be worked on.
  - The desktop can tell from whether agent access is on and the attachment
    has been read.
  - The web cannot tell, and says "Waiting for your agent".
- **It is not chat.** One request is one set of objects and one message. A
  follow-up is a new request that names the earlier one.

**Tests.**

- **Requests and grants:** an agent grant can list requests and cannot create
  or close them.
- **Envelope:** `request_list` envelopes `message`.
- **Answering:** `request_answer` refuses a proposal from another deck and a
  proposal that is already decided.
- **Siblings:** approving one answer withdraws its siblings and closes the
  request.
- **Stale targets:** a request whose target element has since been deleted
  is listed with that said, not dropped.
- **Smoke:** a desktop `requests` smoke step creates a request from the
  canvas, answers it through the MCP acceptance script with two proposals,
  approves one in Review and checks the other is withdrawn in the store.

---

## 4. Part A1: style options

**MCP tool `style_suggest`.** It takes 2–4 options. Each option is:

```
{ label, design_language?, theme_key? | palette?: {background, text, accent, …},
  fonts?: {display, body}, motion_style?, rationale }
```

The server does the following:

- **Checks each option:**
  - The design language and theme must be known.
  - A palette goes through `office_theme.theme_from_palette`, which already
    refuses text below 4.5:1.
  - Fonts must be bundled.
- **Draws each option as a real cover** of *this* deck. It composes the
  deck's first slide (or the slide asked about) in that option through the
  template-preview path (`template_compose`), storing nothing.
- **Stores the set** in a `style_options` table, keyed to the deck and the
  version it was suggested against, for 24 hours, like a proposal.

**Editor.** The options appear in Review as a row of covers with their labels
and rationales. **Use this** turns the chosen option into an ordinary theme
change through `applyThemeOperations` (and a language change when one is
named), one undo step. Options that were not chosen expire.

**Why not just several `theme_propose` calls?** Three pending proposals look
like three changes to approve, and approving two would apply both. A set of
options is one decision with one answer, which is what the person is being
asked.

**Tests.**

- **Refusals:** an option below AA is refused with the pair named.
- **Pictures:** the covers are drawn by the same composer as `from-template`.
- **Choosing:** choosing one creates exactly one transaction and expires the
  rest.
- **Staleness:** an option set against a version that has since moved is
  shown with that said, the same rule as proposals.

---

## 5. Part A2: the draft board, a rough canvas that is not the deck

### 5.1 Why it lives outside the deck

A rough canvas has to be cheap to change. A deck change goes through the
applier, validation, risk, a version row and possibly approval, and that cost
is right for a deck. It is wrong for "drop that card, move this one up". A
draft is also not a fact about the presentation: nothing renders it,
exports it or presents it. So by CLAUDE.md's own rule ("if a fact is in the
document but no one can agree on it, it does not belong there") it is a
working object stored beside decks, not inside one.

### 5.2 Shape

A new table, `drafts`, with an additive migration. It holds
`{id, project_id, presentation_id?, title, body, created_by, updated_at,
revision}`. `body` is JSON validated by a Pydantic model:

```
Draft
  brief?: str
  style?: style option id or inline option (§4)
  cards: [Card]                      # order is the slide order
Card
  id: crd_…
  layout: SlideLayout | pattern key  # the same closed set StoryPlan uses
  blocks: [Block]
  alternatives?: [[Block]]           # the agent's other versions of this card
  motion?: { pacing, emphasis_roles } # words, never milliseconds
  notes?: str
  locked?: bool                      # the person has settled this card
Block
  role: headline | subtitle | body | bullet | metric | quote | chart | diagram | timeline | image
  text?: str
  data?: the same chart, diagram or timeline data StoryPlan accepts
  image?: { subject, style_source }  # becomes a picture request on build (§2)
```

There are no coordinates anywhere. A card is drawn on the board as a
**wireframe**: the layout's regions in grey with the blocks' words in them,
drawn by the composer's layout names. It is not a rendered slide; that is
what "rough" means here.

Optimistic concurrency is by `revision`. A stale write is a 409, and the
agent and the person can both edit, as with the deck itself.

### 5.3 What a person does on the board

- **Reorder** by dragging cards (and Alt+↑/↓, as the slide strip does).
- **Add** a card from the pattern list, **delete**, **duplicate**, **split**
  a card in two (bullets halve), and **merge** two cards.
- **Edit words inline.** Choose between a card's **alternatives** with
  arrows on the card.
- **Lock** a card, so the agent's later edits leave it alone. The server
  refuses an agent write to a locked card's blocks.
- **Ask agent…** on a card or a block: §3.2, with a draft target.
- **See density warnings live:** `apply_density`'s limits per language,
  shown on the card, not applied silently.

### 5.4 Build

**Build** turns the board, or the selected cards, into a deck:

- **A new deck:** the draft becomes a `StoryPlan` and goes through
  `deck_compose`. The result opens in the editor, as `from-template` does.
- **A linked deck:**
  - Each new card becomes `slide_insert_pattern`.
  - Each changed card becomes a replacement of that slide's composed
    elements.
  - All of it is **one proposal**, which opens in Review.
- **Image blocks** become frames with `mediaSlot.subject` set. Generating the
  pictures is a separate, priced step (§2), never part of Build, because
  Build must not spend credits.
- **Motion words** go through the motion planner after composition, as
  `deck_compose` already plans transitions.

The draft keeps a `built_version_id`. After a build, editing the deck does
not change the draft, and editing the draft shows "changed since built".
There is deliberately no two-way sync. A draft is where you think; the deck
is what you made.

### 5.5 MCP tools

- `draft_create`, `draft_read`, `draft_update` (whole-body with `revision`,
  or card-level operations: add, remove, move, set blocks, add an
  alternative) and `draft_list`.
- There is no `draft_build` for agents. Building creates or changes a deck,
  and that is the person's press. An agent can say a draft is ready by
  answering a request.

### 5.6 Where the board lives

- From the home screen, as **New draft**, before any deck exists.
- From inside a deck, as **Draft changes** (a draft linked to that deck,
  seeded from its current slides' text and layouts).

### 5.7 Tests

- **Validation:** a draft body with any coordinate, size or colour literal is
  refused.
- **Locked cards:** an agent write to a locked card is refused, and an agent
  write elsewhere in the same draft is not.
- **Build into a new deck:** produces exactly what `deck_compose` produces
  for the equivalent `StoryPlan`, byte for byte, with fixed ids.
- **Build into a linked deck:** produces one proposal, and spends nothing
  (no quota or credit rows).
- **Concurrency:** a stale `revision` is a 409, and the person's later write
  is not overwritten.
- **Smoke:** a desktop `draft` smoke step drags a card, deletes one, picks an
  alternative, builds, and finds the deck's slides in the board's order.

---

## 6. Order and size

| Step | What | Rough size |
| --- | --- | --- |
| 1 | §2 Match the deck: `media_style.py`, the prompt route, the switch, quote binding, `imagery.promptWords` per language, treatment-on-generate | One PR |
| 2 | §3.1 Try another, Calmer and More energy | One small PR |
| 3 | §3.2 Requests: table, routes, MCP tools, Ask agent…, grouped answers in Review | One PR, plus a real-session check of notifications |
| 4 | §4 Style options | One PR |
| 5 | §5 Draft board: table, model, board view, build, MCP tools | Two PRs: the model, routes and MCP tools first, then the board and build |

Each step stands on its own, and none depends on a later one. Step 5 reuses
step 3's requests and step 4's options, so it goes last.

## 7. Decisions still open

- **The switch's default.** Recommended: "Match the deck" when the slide has
  a frame or the deck has a language, and "Follow my prompt" otherwise
  (§2.1).
- **Where the media brief is defined.** Recommended: on the server only, with
  the editor's copy as an offline fallback (§2.3).
- **Notifications to agents.** Polling with `request_list` first.
  Notifications only after a real Claude Code and Codex session shows they
  are acted on (§3.2).
- **Drafts without a deck.** Recommended: yes, from the home screen, so the
  rough stage can come before any deck exists (§5.6).
- **Reference images for generation.** Not in this plan. It would be a
  separate, consented option (§2.7).

## 8. What does not change

- **Agents never write geometry:** a draft has none, a style option names
  tokens and presets, and requests carry ids and words.
- **Agents never approve:** not proposals, not style options, not builds.
- **Risk is computed server-side** for everything a build or an answer
  proposes.
- **Credits are spent only behind a quote** the person accepted, for the
  exact text that runs.
- **No in-app text model.** Every new composition here (media prompts, motion
  alternatives, wireframes, builds) is deterministic code.
