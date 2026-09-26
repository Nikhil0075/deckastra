import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog } from "electron";

/**
 * Help > Third-party notices (register item 33).
 *
 * The licences of what ships have to be reachable from the installed product,
 * not only present in its folder. The file is plain text written at build time
 * (`scripts/notices.mjs`), shown in a window that can do nothing else: no
 * preload, no Node, no JavaScript, no navigation and no pop-ups — a licence
 * text is content other people wrote, and a link in one must not become a way
 * out of the app.
 */

const auxiliary = new Set<BrowserWindow>();

/** Windows that are not editors: menu commands and the close barrier skip them. */
export function isAuxiliaryWindow(window: BrowserWindow): boolean {
  return auxiliary.has(window);
}

export function noticesPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "THIRD_PARTY_NOTICES.txt")
    : join(import.meta.dirname, "..", "THIRD_PARTY_NOTICES.txt");
}

export async function showNotices(): Promise<void> {
  const file = noticesPath();
  if (!existsSync(file)) {
    await dialog.showMessageBox({
      type: "warning",
      message: "The third-party notices are missing from this build.",
      detail: app.isPackaged
        ? "Reinstall Deckastra. A build without its notices should not have been released."
        : "Run `npm run notices --workspace @deckastra/desktop` to write them for a development build.",
    });
    return;
  }
  const window = new BrowserWindow({
    width: 760,
    height: 820,
    title: "Deckastra — third-party notices",
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  auxiliary.add(window);
  window.on("closed", () => auxiliary.delete(window));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadFile(file);
}
