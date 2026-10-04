# 06 — A file manager and the `.mydeck` package

Status: plan, 2026-10-01. Nothing here is built.
Related: [03](03_ORGANIZATIONS_GROUPS_AND_SHARED_LIBRARY.md) (the tree the file
manager shows), [01](01_MULTILINGUAL_DECKS_NARRATION_AND_SOUND.md) (locales and
narration audio travel in the package).

## 1. What is being asked

- A **file manager**: projects work like folders, with `.mydeck` files inside.
- **Our own file format**, `.mydeck`: save a deck as a file, open a file, and
  send it to someone.
- The ability to share and open files.

## 2. Discovery

| Fact | Where |
| --- | --- |
| The deck list shows projects on the left and cards on the right (Open, Duplicate, Move to project…, Export, Delete); soft delete with Undo; a trash (`?deleted=true`) | `packages/editor-ui/src/components/DeckList.tsx`, `routes.py`, CLAUDE.md "Phase 4" |
| Projects exist; **folders inside projects do not** | `db/models.py` `Project` |
| Duplicate mints fresh ids and rewrites every reference (morph pairs, Critic issues); asset and theme ids are kept | `apps/api/deckastra_api/deck_copy.py` |
| Canonical bytes: `serializeDocument()` (identity keys first, then alphabetical); validation is not serialization | `packages/presentation-schema/src/serialize.ts` |
| A deterministic zip writer (no wall-clock timestamps) | `packages/export-pptx/src/zip.ts` |
| Unknown element types and enum values are preserved (W240/W241), never deleted | `validate.ts` |
| A document is meant to be safe to email: no expression language, binding allowlists, opaque `storageKey`, never signed URLs | CLAUDE.md "No expression language" |
| Backups use a manifest with the SHA-256 of every file, and verify before replacing anything | `apps/api/deckastra_api/backup.py` |
| Desktop IPC: **no path crosses it**; the renderer names no file; bytes, not URLs; `ipc-guard` checks sender and payload | `apps/desktop/src/shared/ipc.ts`, `main/ipc-guard.ts` |
| Atomic save: write a sibling, then rename | `apps/desktop/src/main/save-file.ts` |
| Export jobs: `POST …/exports` with formats PDF and PPTX, run by the worker | `export_service.py`, `apps/worker` |
| Asset upload: begin / PUT / complete, quota charged at completion | `assets.py`, `workspace-client` `assets.upload()` |
| 0.9.0-beta.1 states "no `.mydeck` files" | `docs/RELEASE_NOTES_0.9.0-beta.1.md` |
| The desktop remembers which deck is open in the main process | `main/workspace-state.ts` |

## 3. Decision: the library is the authority, `.mydeck` is how a deck travels

Two ways to read "a project folder with `.mydeck` files inside":

1. **Live files on disk** that the app edits in place (like Word).
2. **An in-app library** (projects → folders → decks) backed by the service,
   plus `.mydeck` as the **exchange format**: save as, open, attach to an email,
   drop into the app.

**Choose 2.** The product's guarantees live in the service: version history,
undo through the server, optimistic concurrency, proposals, the autosave queue,
sync, and reference-counted assets. A file on disk that the app also edits is a
second source of truth. Two sources of truth is exactly what this codebase
removes wherever it finds one (`Slide.order`, the second mutation path). The
file manager *looks* like folders and files; underneath, a deck is a row with a
version chain.

On the desktop, the person still double-clicks a `.mydeck` file in Explorer and
it opens (§6). It is imported into the library, or opens the existing copy if
the same deck is already there.

## 4. The `.mydeck` package format (v1)

A zip file with a fixed layout:

```
deck.mydeck
├── mimetype                       "application/vnd.deckastra.mydeck+zip"
│                                  (first entry, stored, not compressed)
├── manifest.json
├── document.json                  serializeDocument(doc), canonical bytes
├── assets/
│   ├── ast_01….png                every asset the document cites (images, fonts,
│   ├── ast_01….ogg                audio takes, library sounds used, plates)
│   └── …
├── thumbnails/
│   ├── cover.png                  first slide, 640×360, for file browsers
│   └── slides/sld_….png           optional
└── extras/                        reserved; readers ignore unknown entries
```

`manifest.json`:

```json
{
  "format": "mydeck",
  "formatVersion": 1,
  "schemaVersion": "<document schema version>",
  "presentationId": "doc_…",
  "title": "…",
  "createdBy": { "app": "Deckastra", "version": "0.10.0" },
  "createdAt": "2026-10-01T10:00:00Z",
  "locales": ["en", "hi-IN"],
  "files": [
    { "path": "document.json", "sha256": "…", "bytes": 12345,
      "contentType": "application/json" },
    { "path": "assets/ast_….png", "sha256": "…", "bytes": 98765,
      "contentType": "image/png", "assetId": "ast_…",
      "width": 1600, "height": 900 }
  ]
}
```

Rules:

- **Deterministic.** The same deck gives the same bytes: entries are in a fixed
  order, timestamps come from the document (`updatedAt`), and the zip is written
  by `export-pptx/src/zip.ts`. Move it to a shared package
  (`packages/export-core` or a new `packages/package-zip`) rather than copying it.
- **Self-contained.** Every cited asset is inside. A deck opened on another
  machine never reaches back to a server for pictures.
- **No history by default.** Version history, provenance of agent runs, unresolved
  critic issues and share links are **not** included. A file is sent to other
  people, and history can hold text someone deleted on purpose.
  An explicit "Include version history" option can come later.
- **Future-proof.** Unknown entries under `extras/` and unknown document content
  survive import and re-export (W240/W241).
- **Size limits** (constants in `packages/presentation-schema/src/limits.ts`): at
  most 2,000 entries, 1 GB uncompressed total, 200 MB per asset, and a
  compression ratio of at most 100:1 per entry.

## 5. Export and import

### 5.1 Save as `.mydeck`

- Built by the **worker**, not Python, so there is one serializer
  (`serializeDocument`) and one zip writer. New worker CLI command
  `package` (JSON in on stdin, bytes to a file, JSON out; the existing contract).
- `POST /v1/presentations/{id}/exports` with `format: "mydeck"` (and optional
  `locale` pruning: "include only these languages"). It uses the existing export
  job table, progress, cancellation and the degradation report (for example
  "2 assets were missing and are not in the file").
- The save barrier from Phase 9 UI-01 applies: the editor drains its save queue
  and exports the acknowledged version.
- The asset bytes are read through `object_storage.read`, scoped to the deck's
  workspace (and org library items, 03).

### 5.2 Open a `.mydeck` (import)

`POST /v1/projects/{id}/imports` with the file uploaded through the asset-style
begin/PUT/complete (so large files do not pass through a JSON body), then an
import job:

1. **Container checks, before reading anything:**
   - `mimetype` first and equal to the expected value;
   - entry count, total size and per-entry ratio within limits (zip bomb);
   - every path is relative, has no `..`, no drive letter, no backslash, no
     symlink entries (path traversal);
   - no duplicate names.
2. **Manifest checks:** every file listed exists, sizes match, and SHA-256
   matches. Unlisted files outside `extras/` are refused. `formatVersion` newer
   than supported is refused *by name* ("made by a newer Deckastra; update to
   open it"), the same shape as `check_schema_supported`.
3. **Document checks:** parse, then validate against the generated JSON Schema
   (`schema.py`). Errors refuse the import with rule codes; warnings are shown.
   Interactions, links and embeds pass the same allowlists as any document.
4. **Assets:** each asset is sniffed by its bytes (not its name), checked against
   the allowed content types, then registered in the **target workspace**
   through `assets.register`, charging the storage quota. Asset ids in the
   document are rewritten to the new ids in one pass.
5. **Identity:**
   - if the presentation id does not exist in this installation, keep it (so
     re-exporting and re-importing is stable);
   - if it exists and the caller can see it, offer **Open existing / Import as a
     copy**;
   - if it exists and the caller cannot see it, always import as a copy (never
     reveal it exists: the 404 rule);
   - a copy uses `deck_copy.duplicate_document`, which already rewrites every
     reference.
6. **Commit** through `create_presentation`: one initial version, a user-attributed
   transaction ("Imported from deck.mydeck"). It is not an agent run.

The import route needs editor rights on the target project. No agent grant can
import (a file from the outside world is the person's decision), and an MCP test
asserts the absence.

### 5.3 Tests

- Round trip: export → import (same install, as a copy) → export gives identical
  `document.json` bytes apart from the rewritten ids. The fixture decks
  round-trip.
- Hostile archives in `apps/api/tests/fixtures/mydeck/`: zip bomb, `../evil`,
  absolute path, symlink, a duplicate entry, a manifest hash mismatch, a missing
  asset, an unknown `formatVersion`, a disguised executable as `.png`. Each must
  be refused with a named reason **and leave nothing behind** (no rows, no
  objects).
- A future element type inside the document survives the round trip.

## 6. Desktop integration

- **File association** (`apps/desktop/electron-builder.yml`):
  ```yaml
  fileAssociations:
    - ext: mydeck
      name: Deckastra presentation
      mimeType: application/vnd.deckastra.mydeck+zip
      role: Editor
      icon: build/mydeck.ico
  ```
- **Opening from Explorer:** Windows passes the path in `argv` to the first
  instance, or through `second-instance` when the app is already running (the
  single-instance lock already guards startup). macOS uses `open-file`. The
  **main process** reads the file; the path never reaches the renderer. It
  uploads the bytes to the service's import route through the same proxy the
  renderer uses, then opens the resulting deck
  (`IPC.openPresentation`, `workspace-state.rememberPresentation`).
- **File > Open…** (`main/menu.ts`, new command `open-file`): a native dialog in
  main, filtered to `.mydeck`.
- **File > Save a copy as `.mydeck`…** runs the export, then writes with
  `save-file.ts` (atomic sibling and rename).
- **Drag and drop** onto the deck list: the renderer receives a `File` object
  (bytes, not a path) and uploads it like any file. This works the same on web.
- **IPC additions** (`src/shared/ipc.ts`): `openDeckFile` (no arguments; main
  shows the dialog), `menuCommand: "open-file"`. `ipc-guard.ts` rules apply:
  main frame, own origin, no payload path.
- A new smoke step `mydeck`: save as `.mydeck`, open it from a path given to a
  second launch (the `second-instance` path), and check the imported deck
  against the store.

## 7. The file manager (in-app)

### 7.1 Folders

- Table `folders(id, project_id, parent_id nullable, name, created_by,
  deleted_at)`, unique `(project_id, parent_id, name)` among non-deleted rows,
  and a maximum depth of 8.
- `presentations.folder_id` (nullable = project root).
- Routes: create, rename, move and delete a folder
  (`/v1/projects/{id}/folders…`). Delete is soft and cascades to the view, not
  the decks: deleting a folder moves its decks to the trash with it, and Undo
  restores both.
- Moving a deck **within** a workspace changes `folder_id` or `project_id` (editor
  role). Moving **across** workspaces uses the existing move route and its
  refusals (pending proposals, shared assets).

### 7.2 The screen

`DeckList.tsx` becomes a file manager. Keep the component name, or rename it to
`Library.tsx` with a re-export.

- **Left tree:** Recent · Personal → projects → folders · organization → shared
  spaces → projects → folders (03) · Library (03) · Trash.
- **Main area:** breadcrumbs, a grid (thumbnails from `FinalFrameSlide`) or list
  (name, slides, languages, edited, by, size), sort and filter, search by title
  (server-side `q`), multi-select.
- **Actions:**
  - Open, Rename, Duplicate, Move to…, Save as `.mydeck`, Export PDF/PPTX,
    Share, Delete;
  - new folder, new deck, Import `.mydeck`, "Generate" (existing drawer).
- **Drag** a deck onto a folder to move it; drop `.mydeck` files anywhere to
  import them.
- **Keyboard:** arrows move through the grid, Enter opens, F2 renames, Delete
  deletes, Ctrl/Cmd+A selects all. Menus use the `Menu` primitive
  (`src/ui`). The `a11y` smoke step covers the new view.
- The UI-02 rule stays: every load takes a ticket (`lib/latest-request.ts`) and
  writes only if it is still the newest request for the selected folder.

### 7.3 Sharing a file

- **Send the file:** Save as `.mydeck` and attach it anywhere. Anyone with
  Deckastra can open it; anyone without it can be sent a PDF instead.
- **Share a link** (cloud only): the existing share links (view, pinned
  version). An organization member can also be granted the project (03).
- **Web viewer for `.mydeck` (later):** drop a file on a public page that renders
  it client-side and never uploads it. The renderer is a pure function of the
  document, so this is feasible.

## 8. Contracts and client

- `workspace-contracts/src/files.ts`: `Folder`, `ImportJob`,
  `MydeckManifest`, and export `format: "mydeck"`.
- `workspace-client`: `client.folders.*`, `client.imports.start(file)`
  (upload + job), plus `format` on exports.
- `HostBridge` (`workspace-contracts/src/host.ts`): `openDeckFile?()` for shells
  that have native dialogs. Web uses a file input.

## 9. Work breakdown

| # | Task | Files |
| --- | --- | --- |
| 1 | Shared deterministic zip writer and reader | move `export-pptx/src/zip.ts` to a shared package; add a reader with the limits |
| 2 | Worker `package` command | `apps/worker/src/cli.ts`, `package.ts` (new) |
| 3 | Export format `mydeck` | `export_service.py`, `export_routes.py`, `ExportPanel.tsx` |
| 4 | Import job and route | `apps/api/deckastra_api/mydeck_import.py` (new), `routes.py`, migration (`import_jobs`) |
| 5 | Folders | migration, `routes.py`, `workspace-contracts`, `workspace-client` |
| 6 | File manager UI | `components/DeckList.tsx` (or `Library.tsx`), `lib/deck-list.ts` |
| 7 | Desktop association, open-file, menu, IPC | `electron-builder.yml`, `main/app.ts`, `main/menu.ts`, `shared/ipc.ts`, `preload/index.ts`, `main/ipc-guard.ts` |
| 8 | Tests and hostile fixtures, smoke step | `apps/api/tests/test_mydeck_import.py`, `apps/worker/tests/package.test.ts`, `main/smoke.ts` |
| 9 | Docs | `docs/MYDECK_FORMAT.md` (the format spec, versioned), `RELEASE_NOTES` |

## 10. Phasing

| Phase | Scope | Estimate |
| --- | --- | --- |
| A | Format spec + worker packaging + import with every container check | 3–4 days |
| B | Folders + file manager UI | 3–4 days |
| C | Desktop file association, open-file, menu, drag and drop | 2 days |
| D | Hostile-archive suite, smoke step, docs | 2 days |

**For the hackathon:** A plus drag-and-drop import is enough to show "a deck is a
file you can send". Folders can follow.

## 11. Risks

- **A malicious file** is the main risk, because a `.mydeck` is a document other
  people send you. All container, manifest and schema checks run before any row
  or object is written, and the hostile suite is part of CI.
- **Private content leaking through a file:** no history, no share tokens, no
  agent run data, no workspace names in the package. A test lists the entries of
  an exported fixture and fails on anything unexpected.
- **Format drift:** `formatVersion` is checked on import, and the format document
  is the source of truth, like doc 02 is for the schema.
