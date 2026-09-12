import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";

import {
  IPC,
  type CurrentPresentation,
  type DesktopInfo,
  type OpenPresenterRequest,
  type SaveFileRequest,
  type SaveFileResult,
  type ServiceStatus,
} from "../shared/ipc";
import { publishAttachment, withdrawAttachment } from "./attachment";
import { registerAppScheme, serveRenderer } from "./protocol";
import { runSmoke, smokeDir } from "./smoke";
import { startSidecar, type Sidecar } from "./sidecar";
import { dataDir, ensurePresentation } from "./workspace-state";
import { createWindow } from "./windows";

/**
 * The desktop shell (milestone D1).
 *
 * D0 proved the editor could be driven by something other than the cloud API.
 * D1 replaces that stand-in with the API itself, running as a supervised child
 * process on SQLite — so the store, the version chain, the authorization ladder
 * and the agent graph are the code the cloud runs rather than a local
 * approximation of them.
 *
 * This file owns three things and delegates the rest: the windows, the child
 * process, and the secret that lets the renderer's proxy talk to it. The secret
 * never leaves this process.
 */

registerAppScheme();

/**
 * Refuse a second instance rather than racing it.
 *
 * Two processes on one SQLite database is the corruption case worth avoiding
 * outright, and focusing the existing window is also what a user means by
 * launching the app again.
 *
 * Decided *here*, before anything else, and the whole of startup is behind it.
 * It used to sit at the bottom of this file, which quit the second instance
 * correctly and then let its `whenReady` handler run anyway — starting a service,
 * broadcasting a status, and **withdrawing the first instance's attachment** on
 * the way out. An agent attached to the running app lost it because someone
 * double-clicked the icon.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

/**
 * Presenter windows this app opened, keyed by the id the renderer chose.
 *
 * Kept here rather than derived from `BrowserWindow.getAllWindows()` because the
 * renderer's handle has to answer "is it still open" without a round trip, and it
 * can only do that if closures are pushed back to it.
 */
const presenters = new Map<string, BrowserWindow>();

let sidecar: Sidecar | undefined;
let status: ServiceStatus = { state: "starting", attempt: 0 };
/** Resolved once the deck exists, so a second window does not create a second one. */
let presentation: Promise<string> | undefined;
/** The same id, once known, so the attachment can name the deck the user is in. */
let openPresentationId: string | undefined;

function broadcast(next: ServiceStatus): void {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(IPC.serviceStatus, next);
  }

  /*
    The attachment tracks the service, not the app (milestone D2.1).

    Published here rather than after `startSidecar` because a restart comes back
    on a *different port* — the same `ready` status the window renders is the
    only moment that knows the new one. And withdrawn on anything else, so an
    agent connecting during an outage is told the app is unavailable instead of
    being handed a port that stopped answering.
  */
  if (next.state === "ready" && sidecar) {
    void publishAttachment(sidecar, openPresentationId);
  } else {
    void withdrawAttachment();
  }
}

function registerHandlers(): void {
  ipcMain.handle(IPC.info, (): DesktopInfo => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? "unknown",
    chromeVersion: process.versions.chrome ?? "unknown",
    platform: `${process.platform}-${process.arch}`,
    dataDir: dataDir(),
  }));

  ipcMain.handle(IPC.currentPresentation, async (): Promise<CurrentPresentation> => {
    if (!sidecar) throw new Error("The workspace service is not running.");
    // Memoized: both windows ask, and two concurrent first launches would
    // otherwise create two sample decks and disagree about which one is open.
    presentation ??= ensurePresentation(sidecar);
    try {
      const presentationId = await presentation;
      // Republished now that there is a deck to name. An agent that attached
      // during startup would otherwise have to guess which one the user has
      // open, and guessing wrong means editing a deck nobody is looking at.
      if (openPresentationId !== presentationId) {
        openPresentationId = presentationId;
        void publishAttachment(sidecar, presentationId);
      }
      return { presentationId };
    } catch (error) {
      presentation = undefined; // A failed attempt must not be cached.
      throw error;
    }
  });

  ipcMain.handle(IPC.saveFile, async (event, request: SaveFileRequest): Promise<SaveFileResult> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(window ?? undefined!, {
      defaultPath: request.suggestedName,
    });
    // Cancelling is a decision, not a failure, and the caller must be able to
    // tell the two apart.
    if (canceled || !filePath) return { saved: false };
    await writeFile(filePath, Buffer.from(request.bytes));
    return { saved: true, path: filePath };
  });

  // A send rather than a handle: `HostBridge.openPresenterWindow` is synchronous
  // because a window-opening gesture only counts inside the task that handled the
  // click, and the desktop keeps that contract so one component works in both
  // shells.
  ipcMain.on(IPC.openPresenter, (event, request: OpenPresenterRequest) => {
    if (presenters.has(request.id)) return;

    const search = `?presenter=1&channel=${encodeURIComponent(request.channelName)}`;
    const window = createWindow({ search, width: 1200, height: 800 });
    presenters.set(request.id, window);

    // Closed by the user, by the app, or by a crash — the renderer hears about it
    // the same way, because a handle that only knows about polite closures lies.
    window.on("closed", () => {
      presenters.delete(request.id);
      if (!event.sender.isDestroyed()) event.sender.send(IPC.presenterClosed, request.id);
    });
  });

  ipcMain.on(IPC.closePresenter, (_event, id: string) => {
    presenters.get(id)?.close();
  });

  // Sent on request rather than only on change, so a window that opened after the
  // service was already up still learns its state.
  ipcMain.on(IPC.serviceStatus, (event) => {
    event.sender.send(IPC.serviceStatus, status);
  });
}

/** Everything the primary instance does on startup. */
async function startup(): Promise<void> {
  // The proxy reads this each request rather than capturing a port, because a
  // restarted service comes back on a different one.
  serveRenderer(join(import.meta.dirname, "renderer"), {
    service: () => (sidecar ? { port: sidecar.port, secret: sidecar.secret } : null),
  });
  registerHandlers();

  const smoke = smokeDir();
  // `?smoke=1` is what lets the harness reach the renderer's scene builder. Set
  // here and nowhere else, so an ordinary launch cannot carry it.
  const window = createWindow(smoke ? { search: "?smoke=1" } : {});

  try {
    sidecar = await startSidecar({ dataDir: dataDir(), onStatus: broadcast });
    // Published here as well as in `broadcast`, and this is the one that fires on
    // a first launch: the supervisor reports `ready` from inside `startSidecar`,
    // while this assignment is still pending, so the broadcast at that moment
    // sees no sidecar and withdraws. Restarts go the other way — the variable is
    // set and only the broadcast knows the new port.
    await publishAttachment(sidecar, openPresentationId);
  } catch (error) {
    // The window is already open, so the failure is reported into a surface the
    // user can read instead of a process that exits with nothing on screen.
    broadcast({
      state: "failed",
      detail: error instanceof Error ? error.message : String(error),
      attempt: 0,
    });
  }

  // The harness runs after the service is up or has definitively failed, so a
  // smoke result describes the app rather than a race with its own startup. The
  // controls are the two things a crash test needs and the page cannot do: stop
  // the service, and start it again.
  if (smoke) {
    void runSmoke(window, smoke, {
      stopService: async () => {
        const running = sidecar;
        sidecar = undefined;
        await running?.stop();
        broadcast({ state: "failed", detail: "Stopped by the acceptance harness.", attempt: 0 });
      },
      startService: async () => {
        sidecar = await startSidecar({ dataDir: dataDir(), onStatus: broadcast });
      },
      openEditorWindow: () => createWindow(),
    });
  }

  app.on("activate", () => {
    // macOS keeps the app alive with no windows; clicking the dock icon is how a
    // user asks for one back.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

if (isPrimaryInstance) app.whenReady().then(startup);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Stop the child before the process goes. An orphaned service holds the database
// and the port, and the next launch would find both taken.
app.on("before-quit", async (event) => {
  if (!sidecar) return;
  const running = sidecar;
  sidecar = undefined;
  event.preventDefault();
  // Withdrawn before the service goes, so there is no window in which the file
  // names a port that has already stopped answering.
  await withdrawAttachment();
  await running.stop();
  app.quit();
});

app.on("second-instance", () => {
  const [existing] = BrowserWindow.getAllWindows();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  }
});

