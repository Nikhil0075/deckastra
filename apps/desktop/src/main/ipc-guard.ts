import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import { APP_ORIGIN } from "./protocol";

/**
 * Who is allowed to ask (final package review, item 34).
 *
 * Every privileged operation — opening a deck, writing a file, storing an API
 * key, allowing agents, restarting the service — arrives on a channel the
 * preload exposes. The channels were reachable by anything that could run in a
 * renderer this app owns, and the handlers took whatever arrived. Nothing
 * observed was exploiting that; it is the structural gap the review named, and
 * the answer is that a request must come from **the main frame of a window this
 * app created, on its own origin**.
 *
 * A sub-frame is refused even on our origin, because a frame is where embedded
 * content would be. A destroyed sender is refused because the window it would
 * act for is gone.
 *
 * Payloads are checked here too, at the boundary rather than in each handler:
 * a string that becomes a file name, a number that becomes a buffer length, a
 * boolean that becomes a permission.
 */

const appWindows = new WeakSet<BrowserWindow>();

/** Called by `createWindow`: the windows this app itself opened. */
export function registerAppWindow(window: BrowserWindow): void {
  appWindows.add(window);
}

/** The window behind a request, or null when it is not one of ours. */
export function senderWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  const frame = event.senderFrame;
  // A frame that has gone (navigated away, window closed) cannot be acted for.
  if (!frame || frame.parent !== null) return null;
  if (!frame.url.startsWith(`${APP_ORIGIN}/`)) return null;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || !appWindows.has(window)) return null;
  return window;
}

export class RefusedRequest extends Error {}

/** `ipcMain.handle`, for a request only an app window may make. */
export function handleFromWindow<T>(
  channel: string,
  handler: (window: BrowserWindow, payload: unknown, event: IpcMainInvokeEvent) => Promise<T> | T,
): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    const window = senderWindow(event);
    if (!window) {
      // Refused rather than ignored: the caller is waiting for an answer, and
      // "nothing happened" is indistinguishable from a bug in the app.
      throw new RefusedRequest(`${channel} is only available to this app's own windows.`);
    }
    return handler(window, payload, event);
  });
}

/** `ipcMain.on`, for a message only an app window may send. Silently dropped otherwise. */
export function onFromWindow(
  channel: string,
  handler: (window: BrowserWindow, payload: unknown, event: IpcMainEvent) => void,
): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    const window = senderWindow(event);
    if (!window) return;
    handler(window, payload, event);
  });
}

// ------------------------------------------------------------------ payloads

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new RefusedRequest("That request is not an object.");
  return value as Record<string, unknown>;
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new RefusedRequest(`${field} must be true or false.`);
  return value;
}

export function asText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new RefusedRequest(`${field} must be text of up to ${max} characters.`);
  }
  // A null byte truncates a path or a command wherever it is later used.
  if (value.includes("\0")) throw new RefusedRequest(`${field} must not contain a null character.`);
  return value;
}

/** An id this product mints: a known prefix and a ULID. Never a path. */
export function asId(value: unknown, prefix: string): string {
  const text = asText(value, `${prefix} id`, 64);
  if (!new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`).test(text)) {
    throw new RefusedRequest(`That is not a ${prefix} id.`);
  }
  return text;
}

/**
 * A name for a file the user is about to be shown in a save dialog. Not a path:
 * the shell decides where things go, and a renderer that could supply a path
 * would decide where a deck someone emailed you gets written.
 */
export function asFileName(value: unknown, field: string): string {
  const text = asText(value, field, 200);
  if (/[\\/:*?"<>|]/.test(text) || text === "." || text === "..") {
    throw new RefusedRequest(`${field} must be a plain file name.`);
  }
  return text;
}

/** Bytes to write. Bounded, because the buffer is held in memory to write it. */
export function asBytes(value: unknown, field: string, maxBytes: number): Uint8Array {
  const bytes =
    value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : null;
  if (!bytes) throw new RefusedRequest(`${field} must be bytes.`);
  if (bytes.byteLength > maxBytes) {
    throw new RefusedRequest(`${field} is larger than this can write (${maxBytes} bytes).`);
  }
  return bytes;
}
