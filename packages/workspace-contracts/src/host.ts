/**
 * What the shell around the editor can do, as the editor sees it.
 *
 * Deliberately separate from `WorkspaceClient` and deliberately tiny. These are
 * the operations HTTP cannot express — a native save dialog, a second window on a
 * second display, telling the user which build they are running — and every one
 * of them is a privileged desktop capability. The interface is the allowlist: an
 * imported deck must not gain filesystem access by being opened, so nothing here
 * takes a path from document content, and there is no general "run" or "open URL".
 *
 * The web implementation satisfies the same interface with browser equivalents
 * (an object URL for `saveFile`, `window.open` for a presenter window), which is
 * why the editor can be written against it without knowing where it is mounted.
 */
export interface HostBridge {
  /** Which shell is running. Surfaced in diagnostics, never used to branch on features. */
  readonly kind: "web" | "desktop";

  /**
   * Hand the user a file.
   *
   * Takes bytes, not a URL. A packaged renderer cannot start a download and a
   * blob URL is inert there, so the shell decides how the file reaches the disk —
   * a native dialog on the desktop, an anchor click in a browser.
   */
  saveFile(file: { bytes: Blob; suggestedName: string; contentType: string }): Promise<void>;

  /**
   * Open the presenter view for a channel.
   *
   * The shell decides where the presenter surface lives, because that is routing
   * and routing is the shell's. What it must not decide is *how* the two halves
   * talk: the channel name comes from the caller so the presenter window joins
   * the same bus the audience window is already posting on.
   *
   * The presenter surface loads the deck itself rather than being handed one, so
   * it survives a reload and does not depend on the audience window staying open.
   */
  readonly openPresenterWindow: OpenPresenterWindow;
}

/**
 * Deliberately synchronous, and deliberately allowed to fail quietly.
 *
 * Synchronous because a browser only honours `window.open` inside the task that
 * handled the click; one `await` first and the pop-up blocker eats it. `null`
 * rather than a throw because a blocked pop-up is a thing the user did, not an
 * error — the audience window keeps presenting either way.
 */
export type OpenPresenterWindow = (request: { channelName: string }) => PresenterWindow | null;

export interface PresenterWindow {
  readonly closed: boolean;
  close(): void;
}

/**
 * A command from the shell's own chrome — the desktop's application menu — to
 * the editor or the deck list (editor Phase 8).
 *
 * A closed set of names, never a payload: the menu says *what* was chosen and the
 * page decides whether it applies here (Undo on the deck list is nothing). The
 * editor still owns every keyboard shortcut it already had, so a menu item and
 * its key reach one handler rather than two.
 */
export type HostCommand =
  | "new-deck"
  | "generate-deck"
  | "all-decks"
  | "undo"
  | "redo"
  | "present"
  | "version-history"
  | "mode-design"
  | "mode-ai"
  | "mode-motion"
  | "mode-code"
  | "theme-system"
  | "theme-light"
  | "theme-dark"
  | "open-intelligence"
  | "panel-tools"
  | "panel-slides"
  | "panel-inspector"
  | "panel-notes"
  | "panel-dock"
  | "panels-focus"
  | "panels-all";

/** Subscribe to host commands; returns the unsubscribe function. */
export type SubscribeHostCommands = (listener: (command: HostCommand) => void) => () => void;
