import { join } from "node:path";
import { BrowserWindow, shell } from "electron";

import { APP_ORIGIN } from "./protocol";
import { guardClose } from "./close-guard";
import { registerAppWindow } from "./ipc-guard";
import { allowsMedia } from "./media-permission";

/** Editor windows, by webContents id: the only ones that may use the microphone. */
const editors = new Set<number>();

/**
 * Window creation, and the security posture that goes with it.
 *
 * Every window in this app is created here so the posture is stated once. The
 * three `webPreferences` are the ones that decide whether a `.mydeck` file
 * someone emailed you is a document or a program:
 *
 * - `contextIsolation` keeps the preload bridge in its own world, so page script
 *   cannot reach in and rewrite it.
 * - `nodeIntegration: false` means `require` does not exist in the page.
 * - `sandbox: true` puts the renderer in the OS sandbox and restricts the preload
 *   to the small polyfill set — which is all `ipcRenderer.invoke` needs.
 *
 * The handlers below close the two remaining doors. Chromium will happily
 * navigate a window or open a new one if the page asks; here neither is allowed,
 * so a link in slide content cannot move the app off its own origin.
 */

const PRELOAD = join(import.meta.dirname, "preload.cjs");

interface WindowOptions {
  /** Query appended to the renderer entry, e.g. the presenter's channel. */
  search?: string;
  width?: number;
  height?: number;
  show?: boolean;
}

export function createWindow(options: WindowOptions = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: options.width ?? 1440,
    height: options.height ?? 900,
    minWidth: 960,
    minHeight: 600,
    show: options.show ?? true,
    backgroundColor: "#0b0d10",
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // No `webSecurity: false`, ever. It is the single flag that turns the
      // renderer back into a general-purpose HTTP client.
    },
  });

  // A presenter window is a view of a talk; only an editor records narration.
  const editor = !(options.search ?? "").includes("presenter=1");
  if (editor) {
    const id = window.webContents.id;
    editors.add(id);
    window.on("closed", () => editors.delete(id));
  }
  harden(window);
  // Privileged requests are answered only for windows this app opened (item 34).
  registerAppWindow(window);
  void window.loadURL(`${APP_ORIGIN}/index.html${options.search ?? ""}`);
  // Every app window holds its close until its page has saved or journalled
  // its work (item 01). A presenter page answers at once.
  guardClose(window);
  return window;
}

function harden(window: BrowserWindow): void {
  const { webContents } = window;

  // Nothing in this app opens a window by asking Chromium. The presenter window
  // is created by the main process on an explicit IPC message, which is the only
  // path that gets to decide what a second window is allowed to load.
  webContents.setWindowOpenHandler(({ url }) => {
    // An external link is a real thing a user may click in slide content, and the
    // right answer is their browser, not a window inside the app that has our
    // preload attached. Restricted to schemes that cannot name a local program.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // A document cannot move the app off its own origin. Without this, one
  // `window.location` assignment in page script and the preload bridge is
  // attached to somebody else's page.
  webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });

  // Camera, geolocation, notifications: none of them. The microphone, only to
  // record narration in an editor's own main frame (integration plan 01 §3.5,
  // `media-permission.ts`); everything else a page asks for is refused.
  webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const media = details as { mediaTypes?: string[]; requestingUrl?: string; isMainFrame?: boolean };
    callback(
      allowsMedia(
        {
          permission,
          mediaTypes: media.mediaTypes,
          requestingUrl: media.requestingUrl,
          isMainFrame: media.isMainFrame,
          fromEditorWindow: editors.has(contents.id),
        },
        APP_ORIGIN,
      ),
    );
  });
  webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    allowsMedia(
      {
        permission,
        mediaTypes: (details as { mediaType?: string }).mediaType === "audio" ? ["audio"] : [],
        requestingUrl: requestingOrigin,
        isMainFrame: (details as { isMainFrame?: boolean }).isMainFrame,
        fromEditorWindow: contents ? editors.has(contents.id) : false,
      },
      APP_ORIGIN,
    ),
  );
}
