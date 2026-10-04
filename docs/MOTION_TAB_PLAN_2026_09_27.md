# Motion tab plan: easy motion, loops, vector animation and transitions

2026-09-27. Status: **proposal, nothing built**. Each phase below is its own
commit series, with the same shape of gate the Design tab work used: unit tests
for the pure module, a component test for the surface, and a real-app
acceptance step (`DECKASTRA_SMOKE_STEP=motion`, extended).

## 1. Goal

A presenter makes a deck move well in **under a minute without opening the
timeline**. Motion is also what lets a Deckastra deck stand in for a small
website or a product page: things that loop, respond to a hover or a click,
and move between states the way a well-built site does.

The design rules stay the same:

- Motion is document state, compiled once and sampled as a pure function of
  time. Playing to `t` and seeking to `t` must give the same frame, loops
  included.
- Intent in, numbers out. A person or an agent picks a style, a preset or a
  pacing word. `motion.py` and the presets compute the milliseconds.
- Every effect has a reduced-motion fallback, a PDF frame and a PPTX mapping
  or a reported degradation.
- Nothing new is an expression language. That applies to imported animation
  files too.

## 2. What exists today (read from the code, 2026-09-27)

| Area | State |
| --- | --- |
| Engine | `compileTimeline` → `sampleAt(t)`. Springs are pre-sampled. The engine is deterministic and has parity tests. |
| Presets | `fade, slide, scale, blurReveal, maskReveal, staggerReveal, drawPath, numberCount, springIn, sharedElementMorph`. All of them are **entrances**. There are no emphasis, exit or loop presets. |
| Clip fields | The schema has `repeat` (-1 = infinite) and `direction` (`alternate`). **The engine reads neither**, so a loop saved in a document plays once. |
| Triggers | `slideEnter, afterPrevious, withPrevious, click, timer` work. `hover` and `marker` compile as "wait" and never fire (`compile.ts` `resolveTriggerStart`). |
| Interactions | `slide.interactions` (goToSlide, openUrl, toggleVisibility, runAnimation, seekTimeline) is in the schema. Only the accessibility pass reads it. Present mode does not act on any of it. |
| Transitions | `cut, fade, slide, push, zoom, morph` are implemented. `mask` and `custom` are in the enum with no kind behind them. |
| Morph | Explicit and scored auto pairs, rigid travel, and a crossfade for everything else. Shapes do not change outline in flight, text does not morph by character, and a duplicated slide has new ids, so the pairs are **guessed** rather than known. |
| Editor | The Motion mode panel has the transition editor, a transition preview and Plan by roles. **Animating an object** is a `<select>` labelled "Add animation…" in the dock (`MotionPanel.tsx`), with no preview. |
| PPTX | Entrances are exported as fade. Transitions map to fade or push, and a morph is exported as a fade with named shapes. |

The ease-of-use problem is mainly the last two rows of the editor side.
Choosing an animation means reading preset names in a dropdown, with no way to
see what one does before applying it.

## 3. Research summary

### 3.1 Vector animation formats

| Option | What it is | Fit for Deckastra |
| --- | --- | --- |
| **Lottie / dotLottie** | JSON exported from After Effects. dotLottie is a zipped container. Since late 2025 it can carry state machines. There is a very large free library (LottieFiles), and the `dotlottie-web` player (a ThorVG WASM renderer) can **seek to an exact frame**. | **Yes, first.** An element whose frame is a pure function of our clock keeps seek/play parity. Import has to be restricted: AE *expressions* are JavaScript and are refused, the same way the `no-expression-language` rule refuses everything else. |
| **Rive** | A binary `.riv` file with state machines and data binding. Files are smaller and it responds to input. | **Later.** Its value is interactivity, and a state machine driven by input is not a pure function of time. It fits hover and click interactions (Phase 6), not the slide timeline. |
| **Native SVG in our scene** | Our shapes, icons and diagram edges are already paths. `drawPath` already animates `pathProgress`. | **Yes, and most of the value.** Stroke draw on icons, path **morphing** between shapes (the approach Flubber and GSAP MorphSVG use: resample both paths to matching cubic segments, then interpolate), and motion along a path. It is all computed at compile time and needs no runtime dependency. GSAP is free to use commercially since 3.13 (April 2025), but we should not adopt it: it owns interpolation, the same reason `sample.ts` rejected WAAPI. |
| **SMIL / animated SVG upload** | Animation inside an uploaded SVG. | **No.** Uploaded SVGs are already reduced to geometry (`svg-icon.ts`). SMIL timing would run outside our clock. |
| **Video (MP4/WebM)** | Real footage loops. | **Later, as its own element.** It can be sought by `currentTime`, but it is heavy and PDF can only hold a poster frame. |

### 3.2 Continuous and loop animation

What good product sites and Keynote-style decks actually use:

- **Ambient emphasis**: float or bob, a slow pulse or breathe, a glow, a
  shimmer or sheen passing over text or a card, a slow spin (logo, loader), a
  gentle wiggle to draw attention.
- **Ambient backgrounds**: a slowly drifting gradient or mesh, a Ken Burns
  pan and zoom on a photo, and parallax layers. These make a slide feel alive
  and cost nothing to read.
- **Kinetic type**: text revealed by word or letter, a typewriter, a rotating
  word ("We build *fast / safe / simple*"), and a marquee or ticker of logos.
- **Data**: a counter (exists), a chart that builds by series or point, and a
  diagram that draws its edges and then pulses a flow along them.

Rules the research agrees on, and which we should enforce rather than suggest:

- **WCAG 2.2.2 (Pause, Stop, Hide).** Anything that moves on its own for
  more than 5 seconds must be pausable. Present mode needs a pause-motion key,
  and an exported HTML deck needs a visible control.
- Loop only `transform` and `opacity`. A looping `blur` or `filter` keeps the
  GPU busy and drains laptop batteries. Warn, don't refuse.
- **Restraint.** One or two loops per slide. A slide where everything moves
  says nothing is important. The existing element cap (`MAX_SIMULTANEOUS_ELEMENTS`)
  gets a loop counterpart.
- Under reduced motion, loops **stop at their rest frame**. They do not fall
  back to a fade.

### 3.3 Transitions worth having

What people point to as the best: Keynote **Magic Move** (including *match by
characters*), PowerPoint **Morph** (which pairs by object name, and uses the
`!!name` convention to force a pair), Prezi-style **zoom into an object**, and
the cinematic set: wipe, iris, split, dissolve, blur-through, dip to colour and
3D cube or flip. On the web, the View Transitions API made shared-element page
changes the norm, and scroll-driven animations (`animation-timeline: view()`)
are in Chrome and Safari 26, with Firefox behind a flag as an Interop 2026 item.

In priority order for us:

1. **Magic Move done properly.** Duplicate-and-morph with known pairs, shape
   outline morph, colour and corner morph, and text morph by word or
   character.
2. **Zoom-through**: the camera flies into an element on this slide, and that
   element becomes the next slide. This is the one Prezi-like move people ask
   for.
3. **Wipe / mask** (the enum already reserves `mask`), **iris** (circle
   reveal from a point or an element), **split**, **dissolve** (a seeded noise
   mask), **blur-through** and **dip to colour**.
4. **Cube / flip** (3D, uses `perspective`). Keep it tasteful and off by
   default in the style presets.

Leave out page curl, vortex, glitter and similar effects. They date a deck
instantly and cannot be exported faithfully.

## 4. The Motion tab, as a person uses it

The main principle is **pick, see and apply, with the timeline as the advanced
view**.

### 4.1 Right panel, top to bottom

1. **Motion style (deck).** Five cards: *Calm, Crisp, Playful, Cinematic,
   Keynote*. Each is a named bundle of a transition family, entrance presets
   per role, pacing and at most one ambient loop per slide. **Apply to deck**
   is one patch and one undo. It runs the existing role planner per slide, so
   agents and people get the same result. *Remove all motion* sits next to it.
2. **Selected object.** This section appears when something is selected.
   - An **effect gallery** in four tabs: *Entrance · Emphasis · Loop · Exit*,
     plus *Path* for shapes. Each tile is a small looping preview of the
     effect on a generic box. Hovering a tile previews it **on the real
     object on the canvas**, and clicking applies it.
   - **When:** a segmented control with *On slide start · On click · With
     previous · After previous*, written as words.
   - **Speed:** *Quick · Normal · Slow* (the pacing words), with an optional
     "Exact…" field that opens a millisecond input.
   - **Smart default per element type.** Text gets *By line*, a chart gets
     *Build by series*, a diagram gets *Draw connections*, an icon gets *Draw*,
     and a picture gets a *Ken Burns* loop. The tile that matches is shown
     first.
   - **Copy motion / Paste motion** (an animation painter), and **Apply to all
     similar** (the same role across the deck).
3. **Transition into this slide.** The existing editor, restyled as a tile
   gallery with live previews. It adds **Duplicate and Magic Move** (see 5.4),
   which is the fastest way anyone builds motion.
4. **Motion check.** Findings in Design Check's style, each with a fix: over
   the entrance budget, too many loops, a loop longer than 5s with no pause,
   a looping blur, a morph with unpaired objects, reduced-motion behaviour,
   and what PowerPoint will do with each effect (from `export-fidelity.ts`).
5. **Plan by roles.** This stays, under "Suggest motion for this slide".

### 4.2 Canvas and dock

- A **Play slide** button and a scrubber over the canvas in Motion mode. It
  uses the same `SlideMotion` path present mode uses, never an approximation.
- **Motion badges** on animated objects show an order number and a loop
  glyph. Clicking a badge selects that animation.
- **Motion paths are drawn on the canvas.** Choose *Path → Custom*, drag a
  handle, and bend it with the pen tool the shapes already use.
- The dock timeline stays as the advanced view. Loops draw as a hatched bar
  that runs to the end of the lane.

### 4.3 Present mode

- **P** pauses and resumes all ambient motion. The presenter view gets a
  button for the same thing, and the audience window broadcasts the state,
  following the same authority rule as `blacked`.
- Hover and click interactions work (Phase 6).

## 5. Implementation phases

Each phase lands with a PPTX mapping or a reported degradation, a PDF frame
rule, a reduced-motion fallback and an MCP/agent surface. None of those is
left for later.

### Phase M1: loops in the engine (foundation)

- `compile.ts` honours `repeat` and `direction`. A clip with `repeat: -1`
  compiles with `endMs = Infinity` and a `periodMs`, and `sample.ts` maps `t`
  to `(t - start) mod period`, mirrored for `alternate`. It is still a pure
  function of `t`, so the parity test extends to 10 minutes into a loop.
- A new clip field, **`restOffset`** (0–1, default 0), says which frame a loop
  shows under reduced motion, in thumbnails (`FinalFrameSlide`) and in PDF.
  The schema change goes through Zod, `schema:emit`, fixtures and
  `validate_fixtures.py`.
- A slide's **settled time** is the end of its finite content. Loops do not
  count toward the entrance budget and do not hold a click segment open.
- New rules: **W140** (more than N loops on a slide), **W141** (a looping
  filter), **W142** (auto-moving content longer than 5s; informational, since
  present mode provides the pause).
- The present-mode clock keeps running after the last segment settles, and a
  hidden window does not run it.
- **PPTX:** `repeatCount="indefinite"` and `autoRev="1"` on the effect's
  `cTn`.
- **Gate:** seek equals play at t = 0, 1 period, 7.5 periods and 600s. Under
  reduced motion the sampled styles equal the rest frame exactly.

### Phase M2: emphasis, loop and exit presets

- **Emphasis** (runs once): `pulse, wiggle, pop, colorShift, underlineDraw,
  highlightSweep`.
- **Loop:** `float, breathe, spin, glow, shimmer, orbit, kenBurns,
  gradientDrift, marquee`. `shimmer` and `highlightSweep` use `clip` with a
  gradient mask. `kenBurns` and `gradientDrift` target the slide background
  (a new `subTarget: "background"`).
- **Exit:** the mirror of every entrance, with `fill: forwards`. An exit on a
  click segment hides the element for the rest of the slide.
- Every preset declares a **category**, `entrance | emphasis | loop | exit | path`,
  in `PresetDefinition`. That is what feeds the gallery tabs and the budget
  rule, rather than a second list in the UI.
- **Kinetic text:** `byWord`, `byLetter`, `typewriter` and `rotatingWord`,
  using the same `subTarget` idea as `line/12-18`. The scene build already
  knows line boxes, and it adds word and glyph boxes for text that animates.
- **Gate:** every preset has a reduced-motion fallback (the existing
  build-time test), and a golden sample per preset.

### Phase M3: the easy panel (the main UX work)

- `EffectGallery.tsx` renders its tiles with the **real engine** on a tiny
  stage, so a tile is exactly what gets applied.
- Hover-to-preview on the canvas is **editor state only**: a preview clip is
  sampled over the scene and never reaches the document.
- `lib/motion-styles.ts` holds the five deck styles as data, and "apply"
  produces **one patch**. Python's `motion.py` gets the same table through a
  generated JSON, the way `theme-presets.json` is shared. That is one
  definition, and agents can say "make it Cinematic".
- Smart defaults per element type, *When* and *Speed* as words, copy and paste
  motion, and apply to all similar.
- Motion check panel, Play slide with a scrubber, and badges.
- The dock's "Add animation…" `<select>` goes. The dock keeps the timeline.
- **Harness:** `data-testid`s `motion-style-*`, `effect-tile-*`, `motion-when`,
  `motion-speed`, `motion-play`. The `motion` smoke step applies a style, then
  a loop, checks the store, and undoes back to a byte-identical deck.

### Phase M4: vector motion (native SVG)

- **Shape morph:** `pathMorph` resamples source and target outlines to equal
  cubic counts at compile time (a rotation search for the best start point,
  the way Flubber does it) and interpolates. It is used by Morph when a paired
  object changes kind (circle to rounded rectangle, arrow to check) and as an
  emphasis preset.
- **Icon draw:** `drawPath` extended to icons and brand icons (stroke first,
  then fill fades in).
- **Motion along a path:** a `motionPath` property (the path plus
  `autoRotate`). It is sampled to x, y and rotation at compile time, drawn on
  the canvas, and exported to PPTX as `p:animMotion`.
- **Diagram flow:** a looping dash offset along edges (`flow` preset) to show
  data moving.
- **PPTX:** morph becomes a fade with an outline swap, reported as
  `approximated`. Paths map natively.

### Phase M5: transitions

- **Magic Move that knows its pairs.** `duplicateSlideAction` records each
  copy's origin (`metadata.morphOrigin` on the new element), and the next
  slide's transition becomes a morph whose pairs are **explicit**. Pairing is
  exact rather than guessed, and nothing is silently paired, because the
  person asked for it by pressing the button. A new rule, Morph also honours
  PowerPoint's `!!name` convention on import and export.
- **Morph adds:** colour, corner radius and outline (from M4), and text by
  word or character (`matchText: "words" | "characters"`, using the M2 glyph
  boxes: glyphs that exist on both sides travel, others fade).
- **New kinds** in `TRANSITION_KINDS`, each a pure `plan()`:
  - `wipe` (fills the reserved `mask` type) and `iris` (from a point or from
    an element);
  - `split`, `dissolve` (a seeded noise mask) and `blurThrough`;
  - `dipToColor` (a theme token, never a literal);
  - `zoomThrough` (targets an element, scales the camera into its box, and
    crossfades to the next slide at the moment the element fills the frame);
  - `cube` and `flip`.
- **PPTX mapping:** `wipe, split, dissolve, zoom, cube, flip` exist natively
  (`p:wipe`, `p:split`, `p:dissolve`, `p14:*`). Emit Morph as
  `mc:AlternateContent` with a fade fallback **only after** a PowerPoint
  round trip has been checked by a person, since D4.4 left that gap written
  down.
- **Gate:** transition parity (seek equals play) per kind, a pixel baseline
  for each new kind at its midpoint, and the fixture `animation-test` gains
  one slide per new kind.

### Phase M6: interactive decks (the "replaces a website" part)

- Hover and click triggers fire in present mode and in HTML export. A click on
  an element with a `click` trigger that targets it runs that track.
  `marker` triggers seek.
- Interactions are implemented, following the precedence doc 02 §27 already
  defines: `goToSlide, next, previous, toggleVisibility, runAnimation,
  seekTimeline`. `openUrl` is present-mode only, is allowlisted to
  `https:`/`mailto:`, and asks before opening in the desktop app.
- In the editor, **Interactions** is a section of Selected object: *When
  clicked → Go to slide…* and similar, with plain choices and no scripting.
- **dotLottie element** (`vectorAnimation`): uploaded as an asset and
  validated server-side. Files with AE expressions, images that point to
  URLs, or anything over the size cap are refused. It is rendered by
  `dotlottie-web` with `setFrame(frameAt(t))` from our clock, never its own
  loop. PDF gets the rest frame, and PPTX gets a poster image reported as
  `rasterized`. This needs a licence check (MIT) and `notices.mjs`.
- **Rive** is evaluated here for hover and click-driven micro-interactions
  only, behind the same asset rules. Its state machine is input-driven, so it
  stays out of the time-sampled timeline.

### Phase M7: web output

- **Standalone HTML export**: one self-contained file with the same renderer
  and engine, bundled fonts and `data:` images, and no network. It has two
  modes. *Slides* uses keys, clicks and swipes. *Scroll* stacks slides as
  sections: entrances run when a section enters view, and slide transitions
  become scroll-linked. That uses CSS `animation-timeline: view()` where
  supported, with an IntersectionObserver fallback for Firefox. It includes a
  visible pause-motion control (WCAG 2.2.2) and honours
  `prefers-reduced-motion`.
- This fits the local-only release, since it is an export, not hosting. Sharing
  a hosted page waits for the cloud work in D5.
- **Video export** (doc 04 §35) uses the same virtual clock and becomes cheap
  once loops are pure. It is scheduled after this plan, not in it.

## 6. Order and size

| Phase | Depends on | Rough size | Why this position |
| --- | --- | --- | --- |
| M1 Loops in the engine | none | S–M | Everything continuous rests on it, and it fixes a schema field that silently does nothing today. |
| M2 Presets | M1 | M | Gives the gallery something worth choosing. |
| M3 Easy panel | M2 | L | The user-visible payoff: the "under a minute" goal. |
| M5 Transitions (Magic Move first) | M3 for the UI | L | The highest perceived quality per hour is duplicate-and-morph. |
| M4 Vector motion | M1 | M–L | Shape morph also feeds M5's morph. It can run in parallel with M5. |
| M6 Interactions and Lottie | M1, M3 | L | Turns a deck into something that behaves like a site. |
| M7 HTML export | M6 | L | Delivers the website claim. |

A reasonable first milestone to demo is **M1 + M2 + M3 + Magic Move from M5**.

## 7. Risks and decisions to make

- **Lottie runtime size.** `dotlottie-web` ships WASM of roughly 1 MB, and it
  is loaded lazily only when a deck has a Lottie. It needs a WASM
  `script-src` in the desktop CSP (`'wasm-unsafe-eval'`), which is a security
  decision to write down, not slip in.
- **Glyph-level text morph** depends on browser measurement of glyph boxes.
  The estimator path must degrade to word-level and say so.
- **PPTX Morph emission** is still unverified against real PowerPoint. Keep
  the fade fallback until a person checks it.
- **Too much motion is the most common way a deck looks cheap.** The style
  presets and Motion check are how the product keeps motion tasteful by
  default. Treat those limits as product decisions, not preferences.
