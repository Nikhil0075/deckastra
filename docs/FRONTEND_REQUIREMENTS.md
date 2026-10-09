# Frontend requirements — for the layout rewrite

Written 2026-09-19, against `025fcb2`. For whoever rebuilds the editor's layout
from scratch. It says what the frontend has to **do**, what it must **not
break**, and which backend capabilities have **no UI yet**. It does not
prescribe a visual design.

The backend is complete for Windows and web: every gate that can run on this
machine is green (Python 654 passed / 0 skipped with Postgres + MinIO, `npm
test`, typecheck, both pixel platforms). A rewrite is free to change anything
visual. The rules in §2 are not visual and must survive it.

---

## 1. What exists today

**Where the frontend lives**

| Place | Role |
| --- | --- |
| `packages/editor-ui` | The whole editor: canvas, panels, present mode, `useEditor`. ~7,400 lines in 22 components + 12 lib modules. |
| `apps/web` | Four Next routes: `/` (home/create), `/edit/[id]`, `/shared/[token]`, plus `layout.tsx`. |
| `apps/desktop/src/renderer` | `App.tsx`, `main.tsx`, `client.ts`, `host.ts` — mounts the same editor inside Electron. |
| `packages/editor-ui/src/styles.css` | 88 lines: 11 CSS custom properties, resets, `.present-idle`, a reduced-motion backstop. |

**How it is styled today:** almost entirely **inline `style={{…}}` objects**
(EditorShell alone has 43), reading the 11 tokens in `styles.css`
(`--bg`, `--surface`, `--surface-alt`, `--border`, `--fg`, `--fg-muted`,
`--fg-subtle`, `--accent`, `--accent-fg`, `--danger`, `--warning`). One
`className` in the whole package (`present-idle`). There is no component
library, no design system, and no light theme. This is the main thing a
rewrite can improve freely.

**Current layout** (`EditorShell.tsx`, one 1,196-line file):

```
┌ Toolbar: Text · Rect · Ellipse · Insert▾ · Image · Undo · Redo · Group · Delete · SaveIndicator · Present · Close ┐
├ ConflictRecovery (modal when needed) · notice bar · "Last drag" frame-time bar                                    ┤
├ SlideStrip ─┬──────────── canvas (EditorCanvas, centred, max 1280px) ────────────┬ SidePanel (one long scroll) ─┤
│             │                                                                     │ Layers · Object inspector ·  │
│             ├──────────── MotionPanel + TimelineLanes (under canvas) ─────────────┤ History · Theme · Critic ·   │
│             │                                                                     │ Accessibility · Share ·      │
│             │                                                                     │ Export · Proposals · Ask     │
└─────────────┴─────────────────────────────────────────────────────────────────────┴──────────────────────────────┘
```

Everything in the side panel is stacked in one column; there are no tabs,
modes or collapsible sections. Doc 01 §10 asks for something closer to:

```
┌──────────────────────────────────────────────────────────────┐
│ Project / Undo / Redo / Present / Share / Export / GitHub    │
├──────────────┬───────────────────────────────┬───────────────┤
│ Slide strip  │            Canvas             │ Inspector     │
│              │                               │ / AI panel    │
├──────────────┴───────────────────────────────┴───────────────┤
│ Optional motion timeline                                     │
└──────────────────────────────────────────────────────────────┘
```

with five **modes** (doc 01 §6): Design, AI, Motion, Code (optional/read-only
in V1), Present.

---

## 2. Rules the rewrite must keep

These are behavioural, not visual. Each one was paid for with a bug; the reason
is in `CLAUDE.md`. Moving components around is fine; losing one of these is a
regression even if every screen looks right.

**Package boundaries** (checkable in a diff)

- **No `next/*` import in `packages/editor-ui`, ever.** Routing belongs to the
  shell. The one `useRouter` is in `apps/web/app/page.tsx`.
- **No `fetch` and no environment variable in `packages/editor-ui`.** Every
  request goes through `useWorkspaceClient()`. `apps/web/lib/client.ts` is the
  only reader of `NEXT_PUBLIC_API_URL`.
- Shell differences are **injected defaults**, not branches: `openPresenter`,
  the `BroadcastChannel` factory, `HostBridge`. Nothing on `HostBridge` takes a
  path from document content.

**The document**

- **One mutation path.** UI produces `PatchOperation[]` and calls
  `editor.apply(operations, { label })`. Never mutate the document object.
- **The DOM is never the document** (`TextEditor.tsx`): read the editable back
  into blocks/spans on commit. **Defer commit during IME composition.** Paste is
  an **allowlist**.
- Camera, selection, hover, zoom, playhead are **editor state** and must never be
  written into the document.

**Autosave and recovery** (`lib/useEditor.ts`, `lib/editor-recovery.ts`)

- The queue is emptied by an **acknowledgement**, never an attempt. A failed
  batch returns to the **front**. A 409 is kept and **never re-sent** with a
  refreshed version. One drain at a time.
- Anything that lets the server replace the document (approve, revert, undo an
  external change) must **await `saveNow()` and stop on `false`**.
- **An outage must not unmount the editor.** Show a banner; keep the document,
  undo history and queue mounted. Open the deck **once** — a reconnect must not
  re-read it.
- The head watcher only adopts a server version when nothing is unsaved.

**Canvas interaction** (`EditorCanvas.tsx`, `packages/editor`)

- `transform` is **local to the parent group**; every editor surface is **world
  space**. Add `offset` going out, subtract it coming back.
- **Pointermove coalesced into one rAF callback**; scene nodes memoized on
  identity. **Round once, on pointer-up.** A cancelled gesture commits nothing.
- **The in-flight gesture lives in a ref, not state** (canvas and timeline) — a
  fast drag released in the same frame otherwise commits nothing.
- Renderer element boxes are `pointer-events: none` except in `mode="editor"`.

**Rendering and present**

- Pass **`resolveAssetUrl` (from `useAssetUrls`) to every `SlideView`** — canvas,
  present, transition stages, both presenter previews, thumbnails. A picture that
  shows while editing and vanishes on the projector is worse than none.
- **Letterbox with one factor** (`lib/display-fit.ts` `fitToDisplay`). Never
  scale axes separately.
- **Going back is not arriving**: stepping back plays no transition and no
  entrance.
- Present mode keeps **both slides mounted** during a transition
  (`SlideTransition.tsx`).
- Reduced motion must reach everything; keep the `styles.css` reduced-motion
  backstop and `.present-idle`.
- Use `useBrowserMeasurer()` for scene builds, not a one-off measurer.

**Capabilities, not guesses**

- Ask `/v1/account` `capabilities` before offering a feature; **never infer
  "unavailable" from a 404** (a missing deck and a forbidden one both 404).
  Share panel has four states: asking / yes / no / unknown.

---

## 3. DOM contracts other code depends on

Keep these attributes (or change their readers in the same commit). They are
read by the editor itself, the tests, and the desktop acceptance harness
(`apps/desktop/src/main/smoke.ts`).

| Attribute | Read by |
| --- | --- |
| `data-element-id` | Canvas hit-testing/selection; motion adapter; smoke steps |
| `data-editor-canvas` | Every smoke step waits for it |
| `data-present-stage` | Present mode motion root; smoke `present`/`morph` |
| `data-present-slide-id` / `-index` / `-count` / `-transition` | Smoke `morph` navigation (added 2026-09-17) |
| `data-testid` `deck-list`, `deck-card` (+ `data-deck-id`), `deck-menu`, `deck-search`, `new-deck`, `undo-delete`, `open-deck-list` | Smoke `decks` (Phase 4) |
| `data-testid` `mode-motion`, `motion-panel`, `transition-kind-*`, `transition-duration`, `transition-easing`, `pair-row` (+ `data-origin`), `pair-break`, `pair-keep`, `pair-add`, `plan-tab-entrances`, `plan-tab-transition`, `plan-role`, `plan-carry`, `plan-submit`, `plan-card`, `plan-budget`, `plan-apply`, `plan-discard`, `plan-refused` | Smoke `motion` (Phase 7) |
| `data-testid` `mode-ai`, `ai-pending`, `proposal-card` (+ `data-proposal-id`), `proposal-before`, `proposal-after`, `proposal-apply`, `proposal-reject`, `generate-deck`, `generate-drawer`, `generate-instruction`, `generate-review`, `generate-submit`, `story-checkpoint`, `checkpoint-note`, `checkpoint-revise`, `checkpoint-approve`, `checkpoint-discard`, `ask-input`, `ask-submit` | Smoke `ai` (Phase 6) |
| `data-testid` `open-history`, `history-drawer`, `history-row` (+ `data-version-id`), `history-preview`, `history-compare`, `history-comparison` (rows carry `data-change`), `history-restore`, `restore-banner`, `undo-restore` | Smoke `history` (Phase 5) |
| `data-present-step` / `-steps` / `-blacked`; `data-testid` `presenter-view`, `presenter-step`, `presenter-next`, `presenter-prev`, `presenter-black`, `presenter-end` | Smoke `presenter` (Phase 3) |
| `data-asset-id` | Export `settle()` attributes image decode failures |
| `data-layer="background"`, `data-deckastra-chrome` | Renderer layering; export must exclude chrome |
| `data-testid`: `tool-*`, `undo`, `redo`, `add-slide`, `slide-thumb`, `slide-menu`, `speaker-notes`, `present`, `open-export`, `export-popover` | Smoke `edit`/`timeline`/`present`/`morph`/`export`/`resilience`/`windows` (Phase 1, replaced exact-text matching) |
| `data-region` (`app bar`, `tools`, `slides`, `canvas`, `notes`, `timeline`, `panel`); `data-testid` `theme-menu`, `mode-design`, `mode-code`, `code-copy`, `code-json`; `data-dk-theme` on `<html>` | F6 region cycling; smoke `a11y` and `menu` (Phase 8) |
| `data-testid` `speaker-notes` (a contenteditable since Phase 9, typed into with `execCommand("insertText")`), `notes-bold`, `notes-insertOrderedList` (and the other `notes-<command>` toolbar buttons) | Smoke `slides`, `history`, `export` |
| `data-export-version` on a finished export; `data-testid` `export-unsaved` | Smoke `export` (Phase 9, audit UI-01) |
| Application menu item ids = `MENU_COMMANDS` (`apps/desktop/src/shared/ipc.ts`) | Smoke `menu` (Phase 8) |
| `data-testid`: `agent-access-open`, `agent-access-toggle`; `.dk-agent-access [role=status]` | Smoke `consent`, which also asserts the switch's words: "Allow agent access" / "Stop agent access" |
| Page text **"Saved"**, **"Save changes"**, **"Saving"** (sentence case); `data-save-status` | Smoke `edit`/`verify`/`timeline`/`resilience` |
| Button text **"Second screen"**, **"PDF"**, **"Open keyframes"**, **"Duplicate clip"**, a `<select>` with a "fade" option | Smoke `present`/`export`/`timeline`, inside panels not yet rewritten; move to test ids when those panels are |

---

## 4. Required surfaces

Status: **Built** = exists and works; **Partial** = exists but incomplete or
unpolished; **Missing** = backend supports it, no UI.

### App shell / navigation

| Surface | Status | Backend |
| --- | --- | --- |
| Home: prompt → generate, blank deck | Built (`EmptyState`) | `generation.run`, `documents.create` |
| Workspace/project picker | Built (`AccountPicker`) | `session.account`, `createWorkspace`, `createProject` |
| Deck list per project (search, sort, final-frame thumbnails, pending badge) | Built (Phase 4) | `documents.list` + `slide_count`, `pending_proposals` |
| Version history browser (preview, compare, restore, undo restore) | Built (Phase 5) | `documents.versions` (+ intent/agent), `documents.readAt`, `documents.restoreVersion` |
| Move deck to another project/workspace | Built (Phase 4) — from the card menu; the API's refusals are shown as written | `documents.move` |
| Duplicate / delete (soft, with Undo) / restore a deck | Built (Phase 4) | `documents.duplicate`, `.delete`, `.restore`, `.trash` |
| **Sync status / divergence review** | **Missing** | `GET /presentations/{id}/sync` exists; **no client method** yet |
| Sign-in (cloud) | Missing | not needed until a cloud deployment exists |
| Settings (incl. local model pack) | Missing | model packs are env-configured only |
| Menus + keyboard shortcuts + file associations | Missing | desktop D6 |

### Design mode

| Surface | Status |
| --- | --- |
| Toolbar insert: text, rect, ellipse, line, icon, chart, diagram, table, code, image | Built (the object menu is a native `<select>`) |
| Select, move, resize, group, delete, snapping (align + equal-gap), undo/redo | Built |
| Rotate, align/distribute buttons, lock/hide | Partial — lock/hide via Layers toggles; no align/distribute UI |
| Layers list, reorder | Built (in side panel) |
| Object inspector | Partial — number fields per property; no rich editors |
| Chart / diagram / table data editing | **Missing** (only rendered) |
| Image crop, alt-text editing | Partial — alt text set to filename on upload; no editor |
| Slide strip: add, select, thumbnails, reorder (drag, Alt+↑/↓, menu), duplicate, delete | Built (Phase 2) — delete cleans up references into the slide; a reorder that separates a morph is reported |
| Theme apply/save/set default | Built (`ThemePanel`) — controls unstyled |
| Accessibility findings | Built (`AccessibilityPanel`) |

### AI mode

| Surface | Status | Backend |
| --- | --- | --- |
| Ask / edit with a scope | Removed by plan 09; connected agents author through proposals | MCP `proposals` route |
| Pending proposals: approve/reject with version | Built (`ProposalsPanel`) | `agent.proposals/approve/reject` |
| Undo an AI / external change | Built | `agent.revert`, `undoExternalChange` |
| Proposal Before/After images | Built (Phase 6) — drawn in the editor from the proposal's operations applied to the deck on screen | `agent.proposal` (operations + base version) |
| Critic issues | Built (`CriticIssues`) — minimal |
| Sources / provenance | Built (`SourcesPanel`) |
| Repository grounding | Removed — connected coding agents already have the repository open and attach evidence through proposals |
| Motion by roles, transition by roles | Built (Phase 7) — a dry run of the same planner, measured against the entrance budget, applied as the person's own edit | `motion.propose` / `motion.proposeTransition` with `dry_run` |
| Story checkpoint approval (human pause) | Built (Phase 6) — Generate in the deck list: Approve / Revise with a note / Discard | `generation.review`, `.checkpoint`, `.decide`; `capabilities.checkpoints` |
| Explainability (what / why / which agent / sources) | Partial | proposal label + agent id only |

### Motion mode

| Surface | Status |
| --- | --- |
| Timeline lanes: drag, trim, split, ripple, keyframe handles | Built (`TimelineLanes`) |
| Clip timing fields, duplicate, reorder track | Built (`MotionPanel`) |
| Overlap conflicts with one-click fixes | Built |
| Scrub / play preview on canvas | Built (`MotionPreview`) |
| Transition editor (kind, duration, easing, direction, shared-element pairs with Manual/Auto) | Built (Phase 7, `MotionModePanel`) |
| Easing editor | Partial — named easings only |

### Present mode

| Surface | Status |
| --- | --- |
| Full-screen, keyboard nav, click reveals, transitions, morph | Built |
| Presenter window: current, next, notes, timer, step X of Y, remaining vs target, black screen from the laptop | Built (Phase 3) — presenter sends commands, the audience window owns the motion |
| Black-out, idle cursor hide | Built |
| Speaker notes editing | Built (Phase 2); rich text since Phase 9 — bold, italic, underline, lists, allowlisted paste, IME-safe draft, speaking-time estimate, formatted in the presenter view |
| Remote control | Later (doc 01) |

### Share / export

| Surface | Status |
| --- | --- |
| Share links, pinned version, capability-aware copy | Built (`SharePanel`) |
| Export PDF/PPTX with progress, cancel, retry, degradation report | Built (`ExportPanel`) |
| Shared-deck viewer (`/shared/[token]`) | Built — images resolve through `/v1/shared/{token}/assets/{id}` |

### Code mode

Built (Phase 8): read-only canonical JSON of the selection or the slide, with
Copy. Doc 01 §6.4 allows read-only in V1, and an editable view would be a
second mutation path.

---

## 5. Known open UI defects

From `docs/INDEPENDENT_APPLICATION_TEST_2026_09_17.md` and code search:

1. **Theme inputs/buttons and native scrollbars** are unstyled and clash with
   the dark shell.
2. **Native controls throughout**: the insert menu is a `<select>`, inspector
   fields are bare `<input>`s.
3. **Several recovery copies** appeared after repeated forced exits — reproduce
   with a normal close before treating it as a journal-cleanup bug.
4. The side panel is one long column; nothing collapses; no modes.
5. `EditorShell.tsx` is 1,196 lines containing Toolbar, SaveIndicator,
   SlideStrip, SidePanel and InspectorFields — split it during the rewrite.
6. The canvas width is measured in a `ref` callback during render
   (`EditorShell.tsx`, ~line 480) — replace with a `ResizeObserver`.

---

## 6. Performance budgets (must hold after the rewrite)

`packages/renderer/src/perf.ts` `BUDGETS` — transcribed from doc 04 §31.1.
Changing a number means changing the spec.

| Budget | Target |
| --- | --- |
| Typical slide (≤120 objects) first paint | 250 ms |
| Heavy slide (300 objects) first paint | 700 ms |
| Drag/resize frame | 16 ms (p99 24 ms) — judged as **dropped frames** vs display cadence (`checkFrameBudget`) |
| Slide switch warm / cold | 120 / 400 ms |
| Timeline scrub frame | 16 ms |
| Thumbnail strip, 60 slides | 1000 ms |

Object warning at 400, flatten at 800. Last measured: 16.7 ms p95 at ~60 Hz,
0.0% dropped, on a 120-object slide. Keep the frame-time readout visible (or
behind a debug toggle).

---

## 7. Accessibility

- Target is **WCAG 2.1 AA**. Deck content is checked by
  `packages/renderer/src/accessibility.ts` (1.1.1 alt text, 1.4.3 contrast,
  1.3.1 reading order) and shown in `AccessibilityPanel`.
- **The editor chrome is checked (Phase 8).** The desktop `a11y` smoke step
  runs axe-core against WCAG 2.1 A/AA on eight views in both themes, and drives
  the keyboard with real key events: canvas commands need canvas focus, Tab
  leaves the canvas after the last object, F6 cycles the regions (`data-region`),
  and every focused control shows the palette's blue ring. The token test holds
  both themes to AA.
- **Still open:** a screen-reader pass on the editor (axe checks structure, not
  what NVDA or VoiceOver announce), and tagged PDF.
- Present mode already has keyboard navigation and reduced motion.

---

## 8. Tests that must stay green

- `packages/editor-ui/tests` — 26 files. The behavioural ones matter most:
  `useEditor`, `editor-recovery`, `reconcile`, `sync-reconcile`,
  `external-change`, `canvas-gesture`, `timeline-lanes`, `present-navigation`,
  `slide-transition`, `share-panel`, `asset-urls`, `insert-image`,
  `resize-operations`, `display-fit`.
- `apps/web` E2E (`E2E=1`): drag budget + three recovery journeys.
- Desktop smoke steps: `open`, `edit`, `verify`, `present`, `export`,
  `timeline`, `morph`, `slides`, `presenter`, `decks`, `windows`, `resilience`, `consent`, `digest` — rerun on a
  **fresh profile** (`--user-data-dir`), since the seeded deck is only created on
  first launch.
- Renderer scene digests and pixel baselines are **unaffected** by editor layout
  (they render `SlideView` in `mode="export"`), and should stay unchanged.

Note: nothing renders `EditorShell` in jsdom (text measurement needs layout).
Keep logic in pure modules (`lib/`, `packages/editor`) so it stays testable;
components should only gesture.

---

## 9. Suggested order

1. **Design tokens + primitives** (button, input, select, panel, tabs, scroll
   area) replacing inline styles. Fixes §5.1–5.2 everywhere at once.
2. **Split `EditorShell`** into shell / toolbar / slide strip / inspector /
   right-panel tabs, keeping `useEditor` and every §2 rule untouched.
3. **Mode switcher** (Design / AI / Motion / Present), grouping existing panels.
4. **Replace text-matched smoke hooks with `data-testid`** and update `smoke.ts`.
5. Fill the **missing surfaces** in §4, highest value first: deck list, version
   history, proposal preview image, speaker notes, slide reorder/duplicate,
   transition editor, then sync status (needs a `sync` client method first).
6. Editor keyboard/focus accessibility (§7).
7. Desktop polish: menus and shortcuts are built (Phase 8). File
   associations (D6) and macOS remain.
