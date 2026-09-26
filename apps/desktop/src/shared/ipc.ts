/**
 * The only way the renderer can reach the machine.
 *
 * This file is the allowlist, and it is deliberately small. Everything the
 * renderer can ask the main process to do is named here; anything not named here
 * is unreachable, because the preload bridge exposes exactly these channels and
 * `nodeIntegration` is off. That matters more than it looks: a `.mydeck` file is
 * a document other people send you, and an imported deck must not be able to
 * gain filesystem access by being opened.
 *
 * **Documents are not on this surface.** They travel over the workspace service
 * proxy on the renderer's own origin (`main/protocol.ts`), which is the same
 * HTTP the web app speaks — so `useEditor`, autosave, conflict review and the
 * agent panels are the code the cloud runs, not a local variant of it. What is
 * left here is the handful of things HTTP genuinely cannot express.
 *
 * Three rules the surface encodes:
 *
 * - **No paths cross it.** The renderer names no file. The main process decides
 *   where things live, so document content cannot steer a read or a write.
 * - **No generic "open".** There is no `openExternal`, no `shell`, no `exec`.
 * - **Bytes, not URLs.** A file reaches the user through a native dialog the main
 *   process owns, because a packaged renderer cannot start a download.
 *
 * Both sides import these types, so a change to a payload is a compile error in
 * the process that did not get the memo rather than an `undefined` at runtime.
 */

import type { HostCommand } from "@deckastra/workspace-contracts";

export const IPC = {
  /** Build and environment facts, for diagnostics the user can read back to us. */
  info: "deckastra:info",
  /** Which deck this install opens, created on first launch. */
  currentPresentation: "deckastra:workspace:current",
  /**
   * Open a different deck from the deck list (editor Phase 4). The main process
   * owns "which deck is open" because two other things read it: the presenter
   * window loads that deck, and the agent attachment names it — an agent told
   * the wrong deck edits one nobody is looking at.
   */
  openPresentation: "deckastra:workspace:open",
  /** Hand the user a file through a native save dialog. */
  saveFile: "deckastra:file:save",
  /** Open the presenter window. Fire-and-forget; see `OpenPresenterWindow`. */
  openPresenter: "deckastra:presenter:open",
  /** Close a presenter window this renderer opened. */
  closePresenter: "deckastra:presenter:close",
  /** Main → renderer: a presenter window went away, by whatever means. */
  presenterClosed: "deckastra:presenter:closed",
  /** Main → renderer: the workspace service started, stopped or failed. */
  serviceStatus: "deckastra:service:status",
  /** Whether agents may reach this install, and until when. */
  agentAccess: "deckastra:agents:get",
  /** Allow agents, or stop them. The user's decision, made in the window. */
  agentAccessSet: "deckastra:agents:set",
  /** Main → renderer: that decision changed, including when it lapses. */
  agentAccessChanged: "deckastra:agents:changed",
  /**
   * Main → renderer: an application-menu item was chosen. Carries one name from
   * `MENU_COMMANDS` and nothing else, so the menu cannot become a way to hand
   * the page arbitrary data.
   */
  menuCommand: "deckastra:menu:command",
  /**
   * Main → renderer: this window is about to close; put the work somewhere safe
   * and answer on `closeReady` with the same id (final package review, item 01).
   */
  prepareToClose: "deckastra:close:prepare",
  /** Renderer → main: the answer to `prepareToClose`. */
  closeReady: "deckastra:close:ready",
  /** Whether a cloud API key is stored here — never the key itself. */
  cloudKey: "deckastra:cloud-key:get",
  /** Store a cloud API key, or remove it. Restarts the service with the change. */
  cloudKeySet: "deckastra:cloud-key:set",
  /** Start the workspace service again after it failed (item 17). */
  restartService: "deckastra:service:restart",
  /**
   * Main → renderer: hand over this window's recovery journals so a backup can
   * carry them (item 14). They live in browser storage, which is inside the
   * renderer and outside the data directory, so a backup taken by the service
   * alone cannot see them.
   */
  journalsCollect: "deckastra:journals:collect",
  /** Renderer → main: the answer to `journalsCollect`. */
  journalsCollected: "deckastra:journals:collected",
  /** Main → renderer: put these journals back after a restore. */
  journalsRestore: "deckastra:journals:restore",
} as const;

/**
 * Whether this install has a cloud API key, and whether it could keep one.
 * Deliberately says nothing about the key itself: a renderer that could read it
 * is a renderer that could send it somewhere.
 */
export interface CloudKeyState {
  set: boolean;
  updatedAt: string | null;
  storable: boolean;
}

export interface CloudKeyRequest {
  /** The key to store, or null to remove the stored one. */
  key: string | null;
}

/**
 * One recovery-journal entry, carried verbatim.
 *
 * A key and its string value, and deliberately nothing more: the journal format
 * belongs to `editor-recovery.ts`, and a backup that parsed it would be a second
 * description of it to drift. The main process moves bytes it does not read.
 */
export interface JournalEntry {
  key: string;
  value: string;
}

export interface JournalsCollected {
  id: string;
  entries: JournalEntry[];
}

/** The page's answer before its window closes. */
export interface CloseReady {
  id: string;
  /**
   * `clean`: everything saved. `journalled`: not all of it, and the recovery
   * journal holds it. `blocked`: neither — the work exists only in that window,
   * so closing it would lose it (recheck of item 01).
   */
  readiness: "clean" | "journalled" | "blocked";
}

/**
 * Every command the application menu can send. The preload drops anything not
 * listed, so a name added on one side only is inert rather than half-wired.
 */
export const MENU_COMMANDS = [
  "new-deck",
  "generate-deck",
  "all-decks",
  "undo",
  "redo",
  "present",
  "version-history",
  "mode-design",
  "mode-ai",
  "mode-motion",
  "mode-code",
  "theme-system",
  "theme-light",
  "theme-dark",
  "open-intelligence",
] as const satisfies readonly HostCommand[];

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === "string" && (MENU_COMMANDS as readonly string[]).includes(value);
}

/**
 * Whether an agent may reach this install.
 *
 * Off until the user says otherwise. The credential an agent holds is already
 * narrow — read, write and export, never approve or share — but "narrow" is not
 * "asked for", and an app that published one the moment it started would have
 * decided on the user's behalf.
 */
export interface AgentAccess {
  allowed: boolean;
  /** What an attached agent may do while this is on. */
  scopes: string[];
  /** When it lapses, ISO 8601. Null when nothing is allowed. */
  expiresAt: string | null;
  /** When the user last decided, ISO 8601. */
  decidedAt: string | null;
}

export interface AgentAccessRequest {
  allow: boolean;
}

export interface DesktopInfo {
  appVersion: string;
  /**
   * What this build is (item 07): the commit it came from, whether the tree was
   * dirty, and the hashes of the payloads that shipped. Null in a checkout that
   * never wrote one. Shown in diagnostics; it is how an installed app is traced
   * back to its source.
   */
  build: unknown;
  electronVersion: string;
  chromeVersion: string;
  platform: string;
  /** Where this install keeps its data. Shown, never used to build a request. */
  dataDir: string;
}

/**
 * How the workspace service is doing.
 *
 * Pushed rather than polled, and surfaced in the editor, because a packaged app
 * whose backend died should say so — a blank window with no explanation is the
 * worst thing it can do.
 */
export interface ServiceStatus {
  state: "starting" | "ready" | "restarting" | "failed";
  detail?: string;
  attempt: number;
  /**
   * What kind of failure, so the window can say something a person can act on
   * (item 17). "It stopped" is true of all of them and useful for none.
   */
  kind?: ServiceFailureKind;
}

/**
 * Why the workspace service is not running.
 *
 * - `missing`: the service binary is not where this build expects it. A broken
 *   install; reinstalling is the answer and retrying is not.
 * - `permission`: something on this machine refused access to the data
 *   directory or the executable — antivirus, a locked profile, a policy.
 * - `migration`: the database could not be brought to this build's schema. The
 *   data is still there and must not be thrown away to make the app start.
 * - `mismatch`: the app and the service were built from different migrations
 *   (item 07).
 * - `crashed`: it started and then stopped, or stopped answering.
 * - `unknown`: anything else, reported with whatever it said.
 */
export type ServiceFailureKind = "missing" | "permission" | "migration" | "mismatch" | "crashed" | "unknown";

export interface CurrentPresentation {
  /** The deck to open. Created through the service on first launch. */
  presentationId: string;
}

export interface OpenPresentationRequest {
  /**
   * A presentation id — never a path. The main process checks its shape and
   * asks the service whether the deck exists and this install may read it
   * before it becomes "the open deck".
   */
  presentationId: string;
}

export interface SaveFileRequest {
  /** Raw bytes. Structured-cloned across the bridge, never a blob URL. */
  bytes: Uint8Array;
  suggestedName: string;
  contentType: string;
}

export interface SaveFileResult {
  saved: boolean;
  /** Absent when the user cancelled, which is not an error. */
  path?: string;
}

export interface OpenPresenterRequest {
  /**
   * Chosen by the renderer, not the main process.
   *
   * `HostBridge.openPresenterWindow` is synchronous — a browser only honours a
   * window-opening gesture inside the task that handled the click, and the
   * desktop keeps the same contract so one component works in both shells. That
   * rules out awaiting an id from main, so the renderer allocates one and sends
   * it along.
   */
  id: string;
  channelName: string;
}

/**
 * The bridge, as the renderer sees it on `window.deckastra`.
 *
 * `openPresenter` and `closePresenter` return nothing on purpose: they are sends
 * rather than invokes, so the call completes inside the click's own task.
 */
export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  currentPresentation(): Promise<CurrentPresentation>;
  /** Make another deck the open one. Rejects if it does not exist or cannot be read. */
  openPresentation(request: OpenPresentationRequest): Promise<CurrentPresentation>;
  saveFile(request: SaveFileRequest): Promise<SaveFileResult>;
  openPresenter(request: OpenPresenterRequest): void;
  closePresenter(id: string): void;
  /** Returns an unsubscribe function. */
  onPresenterClosed(listener: (id: string) => void): () => void;
  /** Returns an unsubscribe function. Fires immediately with the current state. */
  onServiceStatus(listener: (status: ServiceStatus) => void): () => void;
  agentAccess(): Promise<AgentAccess>;
  /**
   * Allow agents, or stop them.
   *
   * Stopping withdraws the attachment *and* tells the service to refuse every
   * grant it has already issued — one lasts hours, so withdrawing the file alone
   * would leave whoever holds one working for the rest of the day.
   */
  setAgentAccess(request: AgentAccessRequest): Promise<AgentAccess>;
  /** Returns an unsubscribe function. Fires immediately with the current state. */
  onAgentAccess(listener: (access: AgentAccess) => void): () => void;
  /**
   * Start the workspace service again. Answers when the attempt has finished,
   * with the state it reached — so a window can say "still not working" rather
   * than leaving someone pressing a button that appears to do nothing.
   */
  restartService(): Promise<ServiceStatus>;
  /** Application-menu choices for this window. Returns an unsubscribe function. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  /**
   * Answer the main process before this window closes. `prepare` does the work
   * and says how it went; the bridge sends the answer. Returns an unsubscribe.
   */
  onPrepareToClose(prepare: () => Promise<CloseReady["readiness"]>): () => void;
  /**
   * Hand the main process this window's recovery journals when it asks, so a
   * backup can carry unsaved work (item 14). Returns an unsubscribe.
   */
  onCollectJournals(collect: () => Promise<JournalEntry[]>): () => void;
  /**
   * Put journals back after a restore. The page writes them to its own storage;
   * main never parses them. Returns an unsubscribe.
   */
  onRestoreJournals(apply: (entries: JournalEntry[]) => void): () => void;
  /** Whether a cloud API key is stored (item 23). Never returns the key. */
  cloudKey(): Promise<CloudKeyState>;
  /**
   * Store a cloud API key, or remove it with `null`. The service restarts with
   * the change, so generation uses it — or stops using it — at once.
   */
  setCloudKey(request: CloudKeyRequest): Promise<CloudKeyState>;
}

declare global {
  interface Window {
    /** Absent in a browser. Every consumer must handle that. */
    deckastra?: DesktopBridge;
  }
}
