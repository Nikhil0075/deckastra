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

export const IPC = {
  /** Build and environment facts, for diagnostics the user can read back to us. */
  info: "deckastra:info",
  /** Which deck this install opens, created on first launch. */
  currentPresentation: "deckastra:workspace:current",
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
} as const;

export interface DesktopInfo {
  appVersion: string;
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
}

export interface CurrentPresentation {
  /** The deck to open. Created through the service on first launch. */
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
  saveFile(request: SaveFileRequest): Promise<SaveFileResult>;
  openPresenter(request: OpenPresenterRequest): void;
  closePresenter(id: string): void;
  /** Returns an unsubscribe function. */
  onPresenterClosed(listener: (id: string) => void): () => void;
  /** Returns an unsubscribe function. Fires immediately with the current state. */
  onServiceStatus(listener: (status: ServiceStatus) => void): () => void;
}

declare global {
  interface Window {
    /** Absent in a browser. Every consumer must handle that. */
    deckastra?: DesktopBridge;
  }
}
