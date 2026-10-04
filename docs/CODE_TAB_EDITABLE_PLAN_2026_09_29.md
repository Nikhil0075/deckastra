# Code tab plan: an editable view of the deck and of the current slide

2026-09-29. Status: **implemented and desktop-verified**.

Implemented in `packages/editor-ui`: CodeMirror 6, Deck/Slide/Selection scopes, strict
untrusted-JSON parsing, locked fields, placeholder id minting, structural and
semantic validation, id-addressed slide/deck diffs, explicit one-transaction
Apply, zero-op round trips, stale-draft three-way merge, draft journalling, and
canonical deck copy with SHA-256. Generated-schema completion/hover, on-demand
before/after thumbnails, and portable-slide dependency copy/paste with a
scene-digest acceptance gate are also implemented. A valid draft-on-canvas
toggle remains a separate future enhancement; the thumbnails provide the safe
pre-Apply visual comparison promised by this plan.

## 1. Goal

The Code tab becomes a place where a person can **read and write** the deck as
JSON, in two scopes:

- **Deck** — the whole `.mydeck` document.
- **Slide** — the current slide only; every other slide is untouched.

It also becomes **reproducible**: what the tab shows can be copied out and put
back (into this deck or another one) and render the same slide, byte for byte.

## 2. The rule this must not break

CLAUDE.md says Code mode is read-only "because an editable view would be a
second mutation path". That reason stays true, and it shapes the whole design:

> **The Code tab is a second *view*, never a second *path*.**
> Text is parsed, validated and turned into `PatchOperation[]`, then handed to
> `editor.apply` — the same call the canvas, the inspector and the timeline
> use. Undo, autosave, the recovery journal, version history, provenance and
> the server's validation all apply without a line of new wiring.

The text never becomes the document. That is the same rule as in-place text
editing ("the DOM is never the document"). CLAUDE.md's Code mode paragraph is
rewritten in the same change that makes the tab editable.

## 3. What is wrong today (read from the code)

`ModePanels.CodePanel` shows `canonicalize(subject)` of the **selected element**
or **one slide**, in a `<pre>`, with Copy. Why that is "not reproducible":

1. **No deck scope.** The theme, metadata, named colours, object styles and the
   asset manifest are never shown, and a slide is meaningless without them.
2. **A slide does not carry its dependencies.** It cites
   `token:colors.custom.Brand red`, `styleRef`, `assetId`s and, on a morph,
   element ids on the *previous* slide. Pasting it into another deck gives
   E202 unknown tokens, missing pictures and dangling pairs.
3. **Ids collide.** Pasting a slide back into the same deck duplicates every id
   (E001).
4. **Nothing can be pasted in at all.** The view is a `<pre>`.

## 4. Research summary

| Question | Finding | Decision |
| --- | --- | --- |
| Which editor? | CodeMirror 6: modular, ~150–300 KB for what we need, virtualised for big documents, no web workers. Monaco: 2–5 MB and needs `blob:` workers. | **CodeMirror 6.** The desktop CSP (`script-src 'self'`, `style-src 'self' 'unsafe-inline'`, no `worker-src`) already fits it. Monaco would need a CSP change, which is a security decision, not a convenience. |
| Schema-aware editing | `codemirror-json-schema` gives completion, hover docs and lint from a JSON Schema. | Drive it from **`generated/mydeck-document.schema.json`**, the artefact we already emit. No second description of the schema. |
| Authoritative errors | A JSON Schema lint is a subset of our rules. | Our own `PresentationDocumentSchema` + `validateDocument` are the authority, with rule codes and `suggestedFix` quick-fixes. The schema lint is completion help only, the same "hint vs authority" split D3 uses for grammars. |
| Error positions | Zod reports paths, not offsets. | Map a path to a range with the Lezer JSON syntax tree CodeMirror already builds. No second parser. |
| Two views of one model | The VS Code Settings UI and `settings.json` edit one model. Invalid JSON never reaches the model, and the UI shows exactly what the file says. | Same contract: the canvas and the inspector are the UI, and the Code tab is the file. |
| Text-as-source decks | Slidev and Marp make Markdown the document. | Not for us. The schema is the product, and a text format beside it would be a second definition. We edit the real document. |

## 5. Scopes and what is editable

| Scope | Shows | Editable | Locked |
| --- | --- | --- | --- |
| **Deck** | The whole document in canonical form (`serializeDocument` bytes, pretty-printed) | Everything below | `id`, `schemaVersion`, `createdAt`/`updatedAt`, `assets` manifest |
| **Slide** | The current slide object | The slide's content, transition, animations, notes, interactions | The slide `id` |
| **Selection** | The selected element | No. It has an **Edit in slide** button that opens Slide scope with the cursor on that element. | — |

Why these fields are locked:

- **`id` / `schemaVersion`:** the identity and format of the deck.
  `version_restore.py` already refuses to replace `id` for the same reason.
- **The asset manifest:** a `storageKey` is a path into storage. Letting typed
  text add one would let a pasted document point at bytes it never uploaded.
  Pictures arrive through upload, as they do today. The manifest is shown
  read-only, and removing an entry that is still cited is an error the
  validator already reports.

## 6. The apply pipeline (a pure module, `lib/code-edit.ts`)

The surface only gestures. Every step below is a pure function with its own
tests, the same split as the timeline and `insert-image.ts`.

1. **Parse.**
   - Strict JSON only: no comments, no JSON5, nothing evaluated.
   - Caps: 8 MB of text, depth 64.
   - Keys named `__proto__`, `constructor` or `prototype` are refused anywhere
     in the tree.
2. **Scope merge.** Slide scope puts the parsed slide into a copy of the current
   document at that slide's id. Deck scope takes the parsed document as the
   candidate.
3. **Locked-field check.** A changed locked field is an error that names the
   field. Nothing is silently restored.
4. **Id handling.**
   - An element, slide, clip or track with no `id`, or a placeholder id
     (`el_new1`), gets a fresh one. The placeholder is minted the same way
     everywhere it appears, the rule `author_service.materialise` uses.
   - A **duplicate** id is an error (E001), naming both places.
   - **Changing** an existing id means remove + add, and the preview says so,
     because every reference to the old id breaks.
5. **Validate.**
   - Structural: `PresentationDocumentSchema.parse`.
   - Semantic: `validateDocument`.
   - Errors block Apply. Warnings are shown and do not block.
   - Unknown element types and enum values survive as W240/W241, never
     stripped.
6. **Diff to operations.** Id-addressed, never index-addressed:
   - **Deck scope:** a top-level `replace` for each changed key except
     `slides` (the `version_restore` approach). Slides are matched by id:
     add, remove and `move` for order, and the per-slide diff below for a
     changed slide.
   - **Slide scope:** per element by id. `replace` a changed element (a
     changed group recurses into its children), `add`/`remove` for new and
     deleted ones, `move` for z-order. `replace` or `add`/`remove` for each
     changed slide-level key: `transition`, `animations`, `notes` and so on.
   - Why not replace the whole slide: an agent or a second window editing a
     *different* element of the same slide would then conflict with this
     change for no reason. History labels would also read "slide replaced"
     when one word changed.
7. **Round-trip property.** Opening the tab and pressing Apply without typing
   produces **zero operations and no transaction**. It is tested on every
   fixture, the way "opening a note and leaving it changes nothing" is.
8. **Preview.** The panel shows:
   - an operation summary ("Slide 3 · 2 changed, 1 added, 1 removed");
   - Before/After thumbnails of each changed slide (`FinalFrameSlide`, reusing
     `proposal-preview.ts`);
   - for deck scope, whether the theme or metadata changed.
9. **Apply** = `editor.apply(ops, { label: "Code edit · slide 3" })`. It is one
   transaction and one undo step, recorded as "You" in history. The server
   validates the transaction again on commit, as it does for every edit.

## 7. Concurrency: the deck can move while you type

The draft remembers its **base**: the document and the version it was opened
against.

- **Clean draft** (nothing typed): it follows the document live. Canvas edits,
  Undo and an adopted agent change all update the text.
- **Dirty draft** and the document changed underneath: a banner says so, with
  three choices:
  - **Merge.** A three-way merge of base, draft and current document, using
    `reconcile.ts`, the merge the autosave conflict and sync already use.
    Independent edits merge. A conflicting field asks.
  - **Discard mine.**
  - **Keep editing.** Apply is then refused until the person merges.
- **Never last-write-wins.** Applying a draft built on an old base over a newer
  document is exactly what this product exists to refuse.

## 8. Drafts, closing and keys

- **Apply is explicit:** Ctrl+Enter, or the Apply button. Blur does **not**
  apply, because a half-typed JSON document is usually invalid, and
  auto-applying valid-but-unfinished text fills the undo history with edits
  nobody meant.
- **A dirty Code draft is unsaved work.** It is written to the recovery journal
  as text, and the close barrier reports it as at-risk ("You have an
  unapplied code edit"), the same three-valued close as item 01. It is never
  auto-applied on close.
- **Keys inside the editor:**
  - Ctrl+Z / Ctrl+Y are the editor's own text undo; the deck's undo is not
    touched ("Ctrl+Z in a text field is the field's").
  - Tab is not captured: CodeMirror's `indentWithTab` stays off, so there is
    no keyboard trap (WCAG 2.1.2). Indenting uses Ctrl+] / Ctrl+[.
  - F6 still leaves the region.
- **Preview on canvas** (a toggle): while the draft is valid, the canvas draws
  the draft document as editor state, never committed. This is the same
  mechanism as the motion hover preview.

## 9. Making it reproducible

1. **Deck: Copy deck JSON.** This copies the canonical bytes from
   `serializeDocument`, with a short SHA-256 shown beside the button. The same
   bytes in give the same deck out, and the hash says so.
2. **Slide: Copy portable slide.** This copies an envelope:

   ```json
   { "format": "deckastra-slide", "schemaVersion": "…",
     "slide": { … },
     "dependencies": { "colors": {…}, "objectStyles": {…},
                       "fonts": […], "assets": [ {assetId, name, sha256} ] } }
   ```

   The dependencies are exactly what the slide cites: named colours, object
   styles, uploaded fonts and pictures. Theme role tokens stay as
   references, because the target deck's theme should apply.
3. **Paste a slide (into Slide scope, or "Paste as new slide").**
   - Ids are re-minted with `withFreshIds`.
   - Missing named colours and styles are added in the same patch.
   - An asset is reused only if **this workspace** already holds that asset
     (same id, or same `sha256`). Otherwise the image stays as a labelled
     placeholder, and the preview names what is missing.
   - Morph pairs that point off the slide are dropped **and reported**.
4. **The reproducibility gate.** Copy a portable slide from `technical-deck`,
   paste it into a blank deck with the same theme, and require the **same
   scene digest**. The digest is what the renderer baseline gate already
   compares, so "reproducible" is measured, not claimed.
5. **Import deck JSON as a new deck** is technically the same pipeline.
   Release 0.9.0-beta.1 says "no `.mydeck` files", so it is listed as a
   decision (§12), not assumed.

## 10. Security: pasted JSON is untrusted input

Pasted JSON is treated as a `.mydeck` that someone emailed you:

- No expression language anywhere. The schema's binding and transform
  allowlists still apply, because the schema is what validates it.
- Links keep the permitted-scheme rule. `openUrl` interactions go through the
  same scheme check.
- No new `storageKey`s (§5). Assets resolve only within this workspace.
- Size and depth caps, and prototype-key refusal (§6.1).
- The server validates every committed transaction again, so a modified
  client cannot bypass any of this.

## 11. Phases

| Phase | Delivers | Size |
| --- | --- | --- |
| **C1 Editor** | CodeMirror 6 in the tab, themed from `--dk-*` tokens (no colour literals), read-only still. Scopes Deck / Slide / Selection, folding with element names in the fold marker, search, and canvas ↔ text jump (the cursor in an element selects it; a selection scrolls to its range). | M |
| **C2 Diagnostics** | Schema completion and hover from the generated artefact. Our validator's errors mapped to ranges, with codes, a clickable error list and `suggestedFix` quick-fixes. | M |
| **C3 Apply (slide scope)** | The pipeline in §6: element-level diff, id minting, locked fields, preview, one-transaction Apply, the zero-op round trip. **This is the first phase a person can use.** | L |
| **C4 Apply (deck scope)** | Top-level diff plus slide add, remove and reorder, with the theme/metadata preview. Performance checked on the 60-slide deck from the `performance` step. | M |
| **C5 Concurrency and drafts** | Base tracking, the Merge / Discard / Keep banner, journal and close-barrier integration, preview on canvas. | M |
| **C6 Reproducibility** | Copy deck JSON with a hash, portable slide copy and paste, and the scene-digest gate. | M |

## 12. Tests and acceptance

- **Unit:**
  - round trip is zero ops for every fixture, both scopes;
  - each operation kind;
  - move vs remove+add;
  - locked fields, id minting, duplicate ids;
  - prototype keys and the size cap;
  - diff → apply → equals the parsed candidate, for random edits (property
    test).
- **Conformance:** every operation shape the differ emits gets a case in
  `test_patch_conformance.py`, because the Python applier replays it on read.
- **Component:**
  - invalid JSON disables Apply and names the line;
  - Ctrl+Z in the editor does not touch the deck;
  - the banner appears on an outside change.
- **Desktop acceptance step `code`**, on its own profile (`DECKASTRA_SMOKE_PROFILE`):
  1. Open Code, Slide scope. Change a title in JSON, Apply, and read the store.
  2. Add an element with `el_new1`, Apply, and check that a real id was minted.
  3. Break the JSON: Apply is disabled and the error names the line.
  4. Deck scope: reorder two slides, Apply, and check the order in the store.
  5. Have an agent change another element meanwhile: the banner shows, and
     Merge keeps both changes.
  6. Copy a portable slide, paste it into a new deck, and check the digests
     are equal.
  7. Undo everything and confirm the deck is byte-identical, then reopen.
  8. Zero console or CSP errors.

## 13. Decisions for you

1. **Desktop only, or both shells?** Nothing here is desktop-specific; it lives
   in `editor-ui`. The Motion Studio was kept desktop-only by choice. The
   recommendation is both shells, since they share one mutation path.
2. **Import a whole deck from JSON?** It is effectively `.mydeck` import, which
   the 0.9.0-beta.1 release notes rule out. Recommendation: ship Copy/Paste
   slide now, and deck import with the file format.
3. **Should the asset manifest stay locked?** Recommendation: yes; pictures
   arrive by upload.
4. **Should agents get a "deck JSON" tool?** Recommendation: no. MCP agents
   already write patches, and whole-document writes would lose the element-level
   risk scoring.

## Sources

- [codemirror-json-schema](https://github.com/jsonnext/codemirror-json-schema)
- [Monaco vs CodeMirror 6 (PkgPulse, 2026)](https://www.pkgpulse.com/guides/monaco-editor-vs-codemirror-6-vs-sandpack-in-browser-2026)
- [Sourcegraph: migrating from Monaco to CodeMirror](https://sourcegraph.com/blog/migrating-monaco-codemirror)
- [CodeMirror 6 and strict CSP](https://github.com/codemirror/dev/issues/395)
- [MDN: CSP worker-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src)
