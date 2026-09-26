import { randomUUID } from "node:crypto";
import { dialog, ipcMain, type BrowserWindow } from "electron";

import { IPC, type CloseReady } from "../shared/ipc";

/**
 * A window closes only after its page has put its work somewhere safe (final
 * package review, item 01).
 *
 * The page is asked (`IPC.prepareToClose`), takes drafts into its document,
 * writes the recovery journal and tries to save, and answers (`IPC.closeReady`).
 * Only then does the window close, and — when the application is quitting —
 * only then does the service stop. Before this, a note typed a moment before
 * closing was lost on both paths, measured in the app: the window closed, the
 * service stopped, and the note had never left its field.
 *
 * Bounded, but a bound is not an answer: a page that does not answer, or answers
 * `blocked`, does **not** close silently (recheck of item 01). The person is
 * told what is at risk and chooses. A window nobody can close would be its own
 * failure, so "close and lose the changes" is one of the choices.
 */

const approved = new WeakSet<BrowserWindow>();
const asking = new WeakMap<BrowserWindow, Promise<CloseAnswer>>();

/** What the page said, or what happened instead. */
export type CloseAnswer = "clean" | "journalled" | "blocked" | "timeout" | "gone";

/** Whether an answer means this window's work is somewhere it survives closing. */
export function isSafeToClose(answer: CloseAnswer): boolean {
  return answer === "clean" || answer === "journalled" || answer === "gone";
}

/**
 * A window that cannot make its work safe is not closed behind the person's
 * back (recheck of item 01, 2026-09-20). They are told what is at risk and
 * choose: try again, close and lose it, or stay.
 *
 * Under the acceptance harness there is nobody to answer a modal, so it stays
 * open — which is what the harness then asserts.
 */
export type UnsafeChoice = "retry" | "discard" | "cancel";

export async function askWhatToDo(window: BrowserWindow, answer: CloseAnswer): Promise<UnsafeChoice> {
  if (process.env.DECKASTRA_SMOKE_DIR) return "cancel";
  const detail =
    answer === "timeout"
      ? "This window did not answer, so Deckastra cannot tell whether your latest changes were saved."
      : "Your latest changes could not be saved, and this computer could not keep a local copy of them either.";
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Try again", "Close and lose the changes", "Keep the window open"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: "Closing now would lose unsaved work",
    detail: `${detail} Closing will discard them.`,
  });
  return response === 0 ? "retry" : response === 1 ? "discard" : "cancel";
}

/** Ask one window's page to prepare. Resolves with its answer, or "timeout". */
export function askToClose(window: BrowserWindow, timeoutMs = 10_000): Promise<CloseAnswer> {
  if (window.isDestroyed() || window.webContents.isCrashed()) return Promise.resolve("gone");
  const existing = asking.get(window);
  if (existing) return existing;

  const id = randomUUID();
  const answer = new Promise<CloseAnswer>((resolve) => {
    const finish = (value: CloseAnswer) => {
      clearTimeout(timer);
      ipcMain.off(IPC.closeReady, onReady);
      asking.delete(window);
      resolve(value);
    };
    const onReady = (event: Electron.IpcMainEvent, reply: CloseReady) => {
      // Only this window's page, answering this request.
      if (window.isDestroyed() || event.sender !== window.webContents) return;
      if (!reply || reply.id !== id) return;
      // Only the three the page can say, and anything else is not an answer.
      finish(
        reply.readiness === "clean" ? "clean" : reply.readiness === "journalled" ? "journalled" : "blocked",
      );
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    ipcMain.on(IPC.closeReady, onReady);
    window.webContents.send(IPC.prepareToClose, id);
  });
  asking.set(window, answer);
  return answer;
}

/**
 * Prepare a window, and where it cannot, put the choice to the person. Returns
 * whether closing may now go ahead.
 */
export async function settleClose(window: BrowserWindow): Promise<boolean> {
  for (;;) {
    const answer = await askToClose(window);
    if (isSafeToClose(answer)) return true;
    const choice = await askWhatToDo(window, answer);
    if (choice === "discard") return true;
    if (choice === "cancel") return false;
  }
}

/** Mark a window as prepared, so its next close goes straight through. */
export function approveClose(window: BrowserWindow): void {
  approved.add(window);
}

/**
 * Hold a window's close until its page has answered. Attached to every app
 * window, the presenter's included — a page with no editor answers at once.
 */
export function guardClose(window: BrowserWindow, onAnswer?: (answer: string) => void): void {
  window.on("close", (event) => {
    if (approved.has(window)) return;
    event.preventDefault();
    void settleClose(window).then((mayClose) => {
      onAnswer?.(mayClose ? "closing" : "kept open");
      if (!mayClose) return;
      approved.add(window);
      if (!window.isDestroyed()) window.close();
    });
  });
  // Windows only: the session is ending (shutdown, restart, sign-out). There is
  // no waiting for an answer here, so this asks and lets the page write its
  // journal as fast as it can — best effort, and part of the manual checklist.
  window.on("session-end", () => {
    void askToClose(window, 2_000);
  });
}
