# Deckastra design system

The rules the editor's chrome keeps until launch (roadmap
`docs/integrations/08_ROADMAP_TO_LAUNCH.md` §1.2). Each rule names what enforces
it. A rule that nothing checks is marked as such, so nobody believes a test is
holding it when none is.

Slide content is not covered here. A deck's look belongs to its theme and is
checked by the renderer's semantic and accessibility passes.

## 1. The canvas comes first

Every region around the slide can be put away, and the default leaves the slide
most of the window.

- **Side regions.** The tool rail, the slide strip and the side panel are toggled
  from the Panels menu, with Ctrl+Alt+1 to 3, or all at once with focus mode
  (Ctrl+.). See `src/lib/panels.ts`.
- **The dock.** Notes and the timeline are two tabs of one dock under the canvas
  (`src/components/shell/Dock.tsx`, `src/lib/dock.ts`). Each mode remembers its
  own dock. It is closed in Design and Code, and opens on the timeline in
  Motion. Ctrl+Alt+4 and 5 show or put away each tab.
- **Enforced by** `tests/dock.test.ts` and `tests/panels.test.ts`.

## 2. One assistant

There is one prompt box with quick actions (`src/components/AssistantPanel.tsx`).
It opens beside any mode from the Assistant button in the top bar, from View ›
Assistant, or from the command palette, where typing a sentence offers "Ask the
assistant" with the words put in the prompt (never sent until Run). AI is no
longer a mode: the mode switch is Design, Motion, Code.

- **The prompt box keeps Ask's contract.** It never applies anything itself. The
  server decides from the operations: a small change comes back applied, with
  Undo; a larger one waits under "Waiting for you" as Before and After pictures.
- **Quick actions run the existing assistant tasks:** Fix layout, Write alt
  text, Translate (opens Languages), Write narration, Plan motion, Add slides.
  Add slides needs words in the prompt box and adds after the existing slides
  unless Options says otherwise.
- **Also in the panel:** what is waiting, languages, review issues, sources and
  history.
- **Enforced by** `tests/assistant-panel.test.tsx`.

A new deck starts in the home's prompt bar ("Describe a deck and we'll draft
it…", `GenerateDeck.tsx`), shared by the web and desktop homes. Create writes
the outline, which is reviewed in a drawer (`StoryCheckpoint`); Blank deck sits
beside it. One deck at a time per project: while an outline waits, Create says
to decide on it first, because a second run would silently replace it.

### The command palette and Settings

- **Ctrl+K opens the command palette** (`shell/CommandPalette.tsx`,
  `src/lib/commands.ts`). Every entry names a host command and runs through the
  same dispatcher as the desktop menu. A new feature adds a command there, not a
  button. **Enforced by** `tests/command-palette.test.tsx`.
- **Settings** (`SettingsShell.tsx`) is shared by both shells. Its sections are
  Account, Plans and billing, AI and privacy, Agents and Languages. A section
  the host does not pass is absent. The desktop passes Account, AI and privacy,
  and Agents (`apps/desktop/src/renderer/DesktopSettings.tsx`); it replaced the
  Intelligence drawer. **Enforced by** `tests/settings-shell.test.tsx`.
- **One Share menu** holds Export (PDF, PowerPoint) above the share link. It
  stays mounted while closed, so a running export is not forgotten.

## 3. Colour has meaning

- **Blue** is the action. **Yellow** is "waiting for you". **Red** is danger or
  a finding.
- Corners are square. The palette is cream and black, and the type is Jost for
  display and Inter for the interface.
- Status colour is reached only through `StatusChip`. Stylesheets contain no
  colour literals.
- **Enforced by** `tests/ui-tokens.test.ts`. It checks:
  - that stylesheets use no colour literals and no rounded corners;
  - that every text and background pair passes AA in light and in dark;
  - that yellow is never used as a text colour.

### Tokens v1 (frozen 2026-10-04)

`src/styles/tokens.css` defines the tokens. `src/styles/tokens.v1.json` records
every name that existed when the set was frozen.

- **Allowed:** adding a token, or changing a token's value. A changed value
  still has to pass the contrast checks.
- **Not allowed:** removing or renaming a token. A renamed token is missed
  somewhere and draws in the browser's default colour, and nothing fails when
  that happens.
- **Enforced by** the "tokens v1 are frozen" tests in `tests/ui-tokens.test.ts`.
  Never regenerate the JSON to make those tests pass.

## 4. No engineering words in the product

People see credits, what is sent and what changed. They never see:

- the words "model", "provider", "token", "reservation", "qualification" or
  "local-only";
- a setting name such as `DECKASTRA_VERTEX_PROJECT`;
- which model or engine answered;
- a budget in dollars.

Where the request goes is the one exception, because it is a privacy fact and
rule 6 requires it. "Sent to Google Cloud" is a disclosure, not engineering.

`src/lib/assistant-words.ts` is the boundary: service sentences pass through
`plain()`, which replaces any that carry these words.

**Enforced by** `tests/product-words.test.ts`. It reads the shipped source of
the editor and both shells, ignoring comments. Its `STILL_TO_REMOVE` list names
the surfaces the roadmap is retiring. The list can only get shorter: the test
fails when a listed file is already clean. The rule is fully met when that list
is empty.

## 5. Every surface has four states

Every surface has an empty state, a loading state, an error state and a done
state. Each one is written and tested.

An error says what to do next. A capability that is missing is absent from the
screen, not shown as broken (CLAUDE.md, "A missing capability is absent, not
broken").

**Partly enforced**, by each surface's own tests. Nothing yet checks this
across all surfaces.

## 6. Show the cost before the click

Every AI action shows two things at the button, before it is pressed:

- what it costs, in credits;
- what leaves the computer.

**Partly true.** What leaves the computer is said at every AI button (the
assistant's prompt, the home's prompt bar). The balance is shown by
`CreditsMeter` (`src/components/CreditsMeter.tsx`, `src/lib/credits.ts`): in
the assistant's header, on the home's plan card, and in Settings › Plans and
billing. It reads `GET /v1/account/credits` and never computes a number; on the
desktop the local service passes that request to the cloud account through the
main process's gateway. A per-action cost is not shown yet: the service reports
reservations only once AI tasks are switched on. **Enforced by**
`tests/credits.test.tsx`.

## 7. Keyboard and accessibility parity

- **Regions.** F6 and Shift+F6 move between regions, in this order: app bar,
  tools, slides, canvas, dock, panel. The dock is one region whichever tab is
  showing.
- **Canvas keys.** Canvas commands act only when the canvas has focus. Tab
  leaves the canvas after its last object.
- **Typing.** In a text field, Ctrl+Z belongs to the field, not to the deck.
- **Audit.** The `a11y` desktop smoke step runs axe against WCAG 2.1 A and AA in
  light and in dark.

## Things that are easy to break

- **Test ids.** The desktop harness (`apps/desktop/src/main/smoke.ts`) finds
  controls by `data-testid`. If you rename one, change the harness in the same
  commit. The dock's ids are `dock`, `dock-tab-notes`, `dock-tab-timeline` and
  `dock-toggle`. The notes field is `speaker-notes`. The assistant's are
  `open-assistant`, `close-assistant`, `assistant-panel`, `assistant-input`,
  `assistant-run`, `assistant-scope` and `assistant-action-<id>`. The share
  menu opens from `open-share` and is `export-popover` (there is no
  `open-export` any more). The palette is `command-palette`, with
  `command-palette-input` and `command-<host command>` rows. Settings opens from
  `open-settings`, is `settings`, and its tabs are `settings-tab-<section>`.
- **Uppercase labels.** Button and tab labels are styled uppercase. `innerText`
  returns them uppercased, so a harness that matches words should read
  `textContent`.
