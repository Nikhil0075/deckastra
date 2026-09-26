/**
 * The editor surface, as a package.
 *
 * Everything a shell needs to put a deck in front of someone and let them change
 * it: the canvas and its chrome, present mode, the panels, and the editor state
 * hook underneath them. What it deliberately does not contain is the two things
 * a shell owns — **routing** and **transport**. There is no `next/*` import in
 * this package and no `fetch`; requests go through the `WorkspaceClient` in
 * context, which is what lets the same tree mount in a browser tab and in a
 * desktop window.
 *
 * The export list is the seam, so it is narrow on purpose. A component that only
 * `EditorShell` composes is not exported: the moment a second surface imports one
 * of the inner panels directly, the shell's layout stops being changeable in one
 * place. What is here is what a *route* legitimately mounts.
 */

// --- Surfaces a route mounts ------------------------------------------------
export { EditorShell } from "./components/EditorShell";
export type { EditorShellProps } from "./components/EditorShell";
export { PresentMode } from "./components/PresentMode";
export { GenerationFailed, QuotaReached } from "./components/EmptyState";
export { AccountPicker } from "./components/AccountPicker";
export { DeckList } from "./components/DeckList";
export type { DeckListProps } from "./components/DeckList";
export type { DeckListCommand, HostCommand, SubscribeHostCommands } from "./lib/host-commands";
export { RepositoryPanel } from "./components/RepositoryPanel";
export { SourcesPanel } from "./components/SourcesPanel";

// --- Editor state ------------------------------------------------------------
// Exported because a shell may want to own the tree above the canvas — the
// desktop's presenter window is the first case — and because the save contract
// (`saveNow`, `adoptDocument`) is what a host must respect before it lets the
// server replace the document.
export { useEditor } from "./lib/useEditor";
export { prepareToClose, type CloseReadiness } from "./lib/close-barrier";
export { generationRoute, type GenerationRoute } from "./lib/generation-route";
export type { ApplyOptions, EditorApi, SaveState, UseEditorInput } from "./lib/useEditor";

// --- Text measurement --------------------------------------------------------
// A route builds scenes for its own previews, and a scene built with a different
// measurer than the editor's is a scene that disagrees with what the user sees.
export { useBrowserMeasurer } from "./lib/measurer";
export { useAssetUrls, assetKeysOf } from "./lib/asset-urls";

// --- Host seams --------------------------------------------------------------
// The two browser assumptions the desktop replaces. Both default to the browser
// behaviour, so a web route passes neither.
export { browserPresenterWindow } from "./lib/presenter-window";
export { PresentChannel } from "./lib/presentSync";
export type { PresentChannelHandlers, SyncMessage } from "./lib/presentSync";

// --- Recovery ----------------------------------------------------------------
// A shell has to be able to ask "is there unsaved work from a previous session",
// and answer it before it opens a document.
export type { RecoveryCopy, RecoveryEntry } from "./lib/editor-recovery";
// A shell backing this install up carries the unsaved work too (desktop item 14).
export { allRecoveryEntries, writeRecoveryEntries } from "./lib/editor-recovery";
export { settleWork } from "./lib/close-barrier";
export type { ConflictChoice, ConflictReview } from "./lib/reconcile";
