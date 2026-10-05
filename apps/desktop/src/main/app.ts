import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog } from "electron";

import {
  IPC,
  type AgentAccess,
  type AgentAccessRequest,
  type CurrentPresentation,
  type DesktopInfo,
  type OpenPresentationRequest,
  type OpenPresenterRequest,
  type SaveFileRequest,
  type SaveFileResult,
  type MenuCommand,
  type ServiceStatus,
} from "../shared/ipc";
import { readAgentAccess, revokeIssuedGrants, setAgentAccess } from "./agent-access";
import { publishAttachment, withdrawAttachment } from "./attachment";
import { buildManifest } from "./build-manifest";
import { collectDiagnostics, diagnosticsFilename } from "./diagnostics";
import {
  asBoolean,
  asBytes,
  asFileName,
  asId,
  asRecord,
  asText,
  handleFromWindow,
  onFromWindow,
} from "./ipc-guard";
import { logEvent } from "./logs";
import { approveClose, settleClose } from "./close-guard";
import { accountState, signIn, signOut } from "./account";
import { ACCOUNT_IPC } from "../shared/account";
import type { RestoreResult } from "./backup";
import {
  chooseBackupFolder,
  chooseBackupToRestore,
  collectJournals,
  confirmRestore,
  isEmptyFolder,
  returnJournals,
  runRestore,
} from "./backup";
import { installMenu } from "./menu";
import { isAuxiliaryWindow, showNotices } from "./notices";
import { profileOverride } from "./profile";
import { writeFileSafely } from "./save-file";
import { registerAppScheme, serveRenderer } from "./protocol";
import { runSmoke, smokeDir } from "./smoke";
import { classifyFailure, serviceCommand, startSidecar, type Sidecar } from "./sidecar";
import { dataDir, ensurePresentation, rememberPresentation } from "./workspace-state";
import { createWindow } from "./windows";
import { importDeckFile } from "./deck-file";

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

// Which profile this launch uses, and why it is not gated on anything else:
// `main/profile.ts`. It is resolved before the single-instance lock, which is
// keyed on this directory — so a run on its own profile gets its own lock
// rather than quitting beside a running app.
const smokeProfile = profileOverride();
if (smokeProfile) {
  app.setPath("userData", smokeProfile);
  app.setPath("sessionData", smokeProfile);
}

registerAppScheme();

// The narration acceptance step records through a microphone. Chromium's fake
// device stands in for the hardware, and only for the harness: the app's own
// permission handler (`media-permission.ts`) still decides whether the editor
// may listen, which is the part worth checking.
if (process.env.DECKASTRA_SMOKE_DIR && process.env.DECKASTRA_SMOKE_STEP === "narration") {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

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
  logEvent("service.status", { state: next.state, kind: next.kind, attempt: next.attempt, detail: next.detail });
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(IPC.serviceStatus, next);
  }

  // The attachment tracks the service *and* the user's decision; see below.
  void refreshAttachment();
}

/**
 * Publish the way in, or take it away.
 *
 * Two things have to be true at once: the service must be answering, and the
 * user must have allowed agent access. The first is why this runs on every
 * status change — a restarted service comes back on a different port, and the
 * `ready` status is the only moment that knows it. The second is why publishing
 * is not automatic: a credential nobody asked for is not narrow, it is just
 * quiet.
 */
async function refreshAttachment(): Promise<void> {
  const access = await readAgentAccess();
  if (access.allowed && sidecar && status.state === "ready") {
    await publishAttachment(sidecar, openPresentationId);
  } else {
    await withdrawAttachment();
  }
}

/** What one save may write. Large enough for any export this product makes. */
const MAX_SAVE_BYTES = 512 * 1024 * 1024;
const MAX_CLIPBOARD_CHARACTERS = 8 * 1024 * 1024;

function registerHandlers(): void {
  handleFromWindow(IPC.info, async (): Promise<DesktopInfo> => ({
    appVersion: app.getVersion(),
    build: await buildManifest(),
    electronVersion: process.versions.electron ?? "unknown",
    chromeVersion: process.versions.chrome ?? "unknown",
    platform: `${process.platform}-${process.arch}`,
    dataDir: dataDir(),
  }));

  handleFromWindow(IPC.currentPresentation, async (): Promise<CurrentPresentation> => {
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
        void refreshAttachment();
      }
      return { presentationId };
    } catch (error) {
      presentation = undefined; // A failed attempt must not be cached.
      throw error;
    }
  });

  // The home's "Open .mydeck file": the same path as File › Open, dialog and
  // all. Nothing from the page is read; the person chooses the file.
  handleFromWindow(IPC.openDeckFile, () => openDeckFile());

  handleFromWindow(
    IPC.openPresentation,
    async (_window, payload): Promise<CurrentPresentation> => {
      if (!sidecar) throw new Error("The workspace service is not running.");
      // An id this product minted, never a path and never a guess.
      const asked = asId(asRecord(payload).presentationId, "doc");
      const presentationId = await rememberPresentation(sidecar, asked);
      // From now on both windows and the agent attachment agree on this deck:
      // the presenter window asks `currentPresentation`, and an attached agent
      // reads the attachment to learn what the user has open.
      presentation = Promise.resolve(presentationId);
      if (openPresentationId !== presentationId) {
        openPresentationId = presentationId;
        void refreshAttachment();
      }
      return { presentationId };
    },
  );

  handleFromWindow(IPC.restartService, async (): Promise<ServiceStatus> => {
    // One attempt per press, and the answer is the state it reached. The button
    // is for a problem someone has just fixed — the other copy closed, the drive
    // plugged back in — and a window that retried on its own would hide that
    // nothing had changed.
    try {
      await restartService();
    } catch (error) {
      broadcast({
        state: "failed",
        detail: error instanceof Error ? error.message : String(error),
        attempt: status.attempt,
        kind: classifyFailure(error),
      });
    }
    return status;
  });

  handleFromWindow(ACCOUNT_IPC.state, () => accountState());
  handleFromWindow(ACCOUNT_IPC.signIn, () => signIn());
  handleFromWindow(ACCOUNT_IPC.signOut, () => signOut());
  handleFromWindow(IPC.cloudKey, () => ({ set: false, updatedAt: null, storable: false }));

  handleFromWindow(IPC.cloudKeySet, async (_window, payload) => {
    throw new Error("API keys have been retired. Sign in to use Deckastra AI credits.");
  });

    handleFromWindow(IPC.agentAccess, (): Promise<AgentAccess> => readAgentAccess());

  handleFromWindow(IPC.agentAccessSet, async (_window, payload): Promise<AgentAccess> => {
    const request: AgentAccessRequest = { allow: asBoolean(asRecord(payload).allow, "allow") };
    const next = await setAgentAccess(request.allow);
    if (!request.allow && sidecar) {
      // Withdrawing the file only stops the *next* reader. A grant lasts hours,
      // so stopping has to reach the ones already handed out.
      await revokeIssuedGrants(sidecar);
    }
    await refreshAttachment();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(IPC.agentAccessChanged, next);
    }
    return next;
  });

  // Sent on request as well as on change, so a window that opened later is not
  // showing a default nobody chose.
  onFromWindow(IPC.agentAccessChanged, (_window, _payload, event) => {
    void readAgentAccess().then((access) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.agentAccessChanged, access);
    });
  });

  handleFromWindow(IPC.saveFile, async (window, payload): Promise<SaveFileResult> => {
    const request = asRecord(payload);
    // A name, never a path: the shell decides where files go, and a renderer
    // that could supply a path would decide where a deck someone emailed you
    // gets written. Bytes are bounded because they are held to write them.
    const suggestedName = asFileName(request.suggestedName, "The file name");
    const bytes = asBytes(request.bytes, "The file", MAX_SAVE_BYTES);
    const { canceled, filePath } = await dialog.showSaveDialog(window, { defaultPath: suggestedName });
    // Cancelling is a decision, not a failure, and the caller must be able to
    // tell the two apart.
    if (canceled || !filePath) return { saved: false };
    // Written to a sibling and renamed over the target, so a write that fails
    // halfway does not leave the person without the file they were replacing
    // (item 26). `writeFile` truncates first, and that is invisible until the
    // day it is not.
    await writeFileSafely(filePath, bytes);
    return { saved: true, path: filePath };
  });

  handleFromWindow(IPC.clipboardWriteText, async (_window, payload): Promise<void> => {
    const text = asText(asRecord(payload).text, "Clipboard text", MAX_CLIPBOARD_CHARACTERS);
    clipboard.writeText(text);
  });

  // A send rather than a handle: `HostBridge.openPresenterWindow` is synchronous
  // because a window-opening gesture only counts inside the task that handled the
  // click, and the desktop keeps that contract so one component works in both
  // shells.
  onFromWindow(IPC.openPresenter, (_window, payload, event) => {
    const asked = asRecord(payload);
    const request: OpenPresenterRequest = {
      id: asText(asked.id, "A presenter id", 128),
      channelName: asText(asked.channelName, "A channel name", 128),
    };
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

  onFromWindow(IPC.closePresenter, (_window, payload) => {
    const id = asText(payload, "A presenter id", 128);
    presenters.get(id)?.close();
  });

  // Sent on request rather than only on change, so a window that opened after the
  // service was already up still learns its state.
  onFromWindow(IPC.serviceStatus, (_window, _payload, event) => {
    event.sender.send(IPC.serviceStatus, status);
  });
}

/** Everything the primary instance does on startup. */
/**
 * A menu choice goes to the editor window the user is in. Never to a presenter
 * window: that one is a remote control for a talk, and "New deck" or "Undo"
 * arriving there would act on nothing the presenter can see. With no focused
 * editor window (the menu opened from the taskbar), the first one is meant.
 */
/**
 * Start the service again with a changed configuration (item 23: a key stored
 * or removed). The editor stays mounted through it, as it does through any
 * outage: its queue retries, and nothing is asked of it.
 */
/**
 * Write a report someone can send (item 18). Main's own dialog: the renderer
 * names no path here, as it names none anywhere.
 */
async function exportDiagnostics(): Promise<void> {
  const report = await collectDiagnostics({
    status,
    service: sidecar ? { port: sidecar.port, secret: sidecar.secret } : null,
    dataDir: dataDir(),
  });
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const { canceled, filePath } = await dialog.showSaveDialog(window ?? undefined!, {
    defaultPath: diagnosticsFilename(),
    filters: [{ name: "Diagnostics", extensions: ["json"] }],
  });
  if (canceled || !filePath) return;
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  logEvent("diagnostics.exported", { bytes: JSON.stringify(report).length });
}

/** Every window that is an editor rather than a presenter. */
function editorWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) =>
      ![...presenters.values()].includes(window) && !isAuxiliaryWindow(window) && !window.webContents.isDestroyed(),
  );
}

/**
 * Back up this install (item 14). Main's dialog, main's path, the service's
 * snapshot.
 *
 * The order is the point. The journals are collected **before** the snapshot is
 * asked for, so a person who has just typed something and not saved it has that
 * text in the backup; asking afterwards would carry a journal from a moment
 * later than the database, which is the seam this item exists to close.
 */
interface BackupManifest {
  counts?: Record<string, number>;
  missing_assets?: unknown[];
}

/**
 * Ask the running service for a snapshot, with this window's unsaved work in it.
 *
 * Separated from the dialogs so the acceptance harness can drive the real thing
 * — a native folder picker is not answerable from a test, and the part worth
 * checking is the backup, not the picker.
 *
 * The journals are collected **before** the snapshot is asked for, so a person
 * who has just typed something and not saved it has that text in the backup.
 * Asking afterwards would carry a journal from a later moment than the
 * database, which is the seam this item exists to close.
 */
async function takeBackup(destination: string): Promise<BackupManifest> {
  if (!sidecar) throw new Error("The workspace service is not running.");
  const journals = await collectJournals(editorWindows());
  const response = await fetch(`http://127.0.0.1:${sidecar.port}/v1/local/backup`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sidecar.secret}` },
    body: JSON.stringify({ path: destination, journals, app_version: app.getVersion() }),
  });
  const body = (await response.json().catch(() => ({}))) as BackupManifest & { detail?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.detail === "string" ? body.detail : "The backup could not be written.");
  }
  return body;
}

/** Stop the service, put a backup back, start again. The harness drives this too. */
async function putBackBackup(source: string): Promise<RestoreResult> {
  const running = sidecar;
  sidecar = undefined;
  broadcast({ state: "restarting", attempt: 0, detail: "Restoring a backup" });
  await running?.stop();

  const result = await runRestore(serviceCommand(dataDir(), ["--restore-from", source]));

  // Started again regardless: refusing a backup must not also leave the person
  // without the app. Nothing was replaced unless `restored` is true.
  sidecar = await startSidecar({ dataDir: dataDir(), onStatus: broadcast });
  await refreshAttachment().catch(() => {});
  if (result.restored && result.migrated !== false) {
    if (result.journals?.length) returnJournals(editorWindows(), result.journals);
    for (const open of editorWindows()) open.webContents.reload();
  }
  return result;
}

async function backUpNow(): Promise<void> {
  const window = BrowserWindow.getFocusedWindow() ?? editorWindows()[0];
  if (!sidecar) {
    await dialog.showMessageBox(window ?? undefined!, {
      type: "error",
      message: "Deckastra cannot back up right now",
      detail: "The workspace service is not running, so there is nothing to take a consistent copy of.",
    });
    return;
  }

  const destination = await chooseBackupFolder(window ?? undefined);
  if (!destination) return;
  if (!(await isEmptyFolder(destination))) {
    await dialog.showMessageBox(window ?? undefined!, {
      type: "warning",
      message: "That folder already has something in it",
      detail: "Choose an empty folder, so a backup is never mixed up with anything else.",
    });
    return;
  }

  try {
    const body = await takeBackup(destination);
    const counts = body.counts ?? {};
    const missing = Array.isArray(body.missing_assets) ? body.missing_assets.length : 0;
    logEvent("backup.taken", { decks: counts.presentations ?? 0, assets: counts.assets ?? 0, missing });
    await dialog.showMessageBox(window ?? undefined!, {
      type: "info",
      message: "Backup complete",
      detail:
        `${counts.presentations ?? 0} decks, ${counts.versions ?? 0} versions and ${counts.assets ?? 0} images ` +
        `were copied to ${destination}.` +
        // Named rather than swallowed: a backup that is complete except for
        // something is not the same as one that is complete.
        (missing ? ` ${missing} image file(s) were already missing and could not be copied.` : "") +
        " Exports are not included; they can be made again.",
    });
  } catch (error) {
    logEvent("backup.failed", { reason: String(error).slice(0, 200) });
    await dialog.showMessageBox(window ?? undefined!, {
      type: "error",
      message: "Deckastra could not finish the backup",
      detail: String(error instanceof Error ? error.message : error),
    });
  }
}

/**
 * Put a backup back (item 14).
 *
 * Every window is settled first — the same close barrier a quit uses (item 01)
 * — because the data under an open editor is about to be replaced, and a window
 * still holding unsaved work would be holding it against a deck that no longer
 * exists. A person who says "keep the window open" cancels the restore, which
 * is the right answer: they still have work they have not decided about.
 */
async function restoreNow(): Promise<void> {
  const window = BrowserWindow.getFocusedWindow() ?? editorWindows()[0];
  const source = await chooseBackupToRestore(window ?? undefined);
  if (!source) return;
  if (!(await confirmRestore(window ?? undefined, source))) return;

  for (const open of editorWindows()) {
    if (!(await settleClose(open))) return;
  }

  const result = await putBackBackup(source);

  if (!result.restored || result.migrated === false) {
    logEvent("backup.restore-failed", { reason: (result.error ?? "").slice(0, 200) });
    await dialog.showMessageBox(window ?? undefined!, {
      type: "error",
      message: result.restored ? "The backup was restored but could not be opened" : "Nothing was restored",
      detail: result.error ?? "The restore did not say what went wrong.",
    });
    return;
  }

  logEvent("backup.restored", { decks: result.counts?.presentations ?? 0 });
  await dialog.showMessageBox(window ?? undefined!, {
    type: "info",
    message: "Backup restored",
    detail:
      `${result.counts?.presentations ?? 0} decks from ${result.created_at ?? "that backup"} are back. ` +
      `What was here has been kept in ${result.replaced}.`,
  });
}

async function restartService(): Promise<void> {
  const running = sidecar;
  sidecar = undefined;
  await running?.stop();
  sidecar = await startSidecar({ dataDir: dataDir(), onStatus: broadcast });
  await refreshAttachment();
}

function sendMenuCommand(command: MenuCommand): void {
  // Editors only: not a presenter window, and not the notices window, which has
  // no page to answer (a command sent there was lost).
  const editors = editorWindows();
  const focused = BrowserWindow.getFocusedWindow();
  const target = focused && editors.includes(focused) ? focused : editors[0];
  target?.webContents.send(IPC.menuCommand, command);
}

async function startup(): Promise<void> {
  // The proxy reads this each request rather than capturing a port, because a
  // restarted service comes back on a different one.
  serveRenderer(join(import.meta.dirname, "renderer"), {
    service: () => (sidecar ? { port: sidecar.port, secret: sidecar.secret } : null),
  });
  registerHandlers();
  installMenu(sendMenuCommand, { exportDiagnostics, backUp: backUpNow, restore: restoreNow, showNotices, openDeckFile: () => openDeckFile() });

  const smoke = smokeDir();
  // `?smoke=1` is what lets the harness reach the renderer's scene builder. Set
  // here and nowhere else, so an ordinary launch cannot carry it.
  const window = createWindow(smoke ? { search: "?smoke=1" } : {});

  try {
    sidecar = await startSidecar({ dataDir: dataDir(), onStatus: broadcast });
    // Refreshed here as well as in `broadcast`, and this is the one that fires on
    // a first launch: the supervisor reports `ready` from inside `startSidecar`,
    // while this assignment is still pending, so the broadcast at that moment
    // sees no sidecar and withdraws. Restarts go the other way — the variable is
    // set and only the broadcast knows the new port.
    await refreshAttachment();
    for (const path of process.argv.filter(argument => argument.toLowerCase().endsWith(".mydeck"))) void openDeckFile(path);
    for (const path of pendingDeckFiles.splice(0)) void openDeckFile(path);
  } catch (error) {
    // The window is already open, so the failure is reported into a surface the
    // user can read instead of a process that exits with nothing on screen.
    broadcast({
      state: "failed",
      detail: error instanceof Error ? error.message : String(error),
      attempt: 0,
      kind: classifyFailure(error),
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
      launchSecondInstance: async () => {
        // This same executable, on this same profile, with the harness switched
        // off for the child — otherwise it would try to run a smoke step of its
        // own instead of doing the one thing being checked: finding the lock
        // held and quitting without disturbing anything.
        const { spawn } = await import("node:child_process");
        // The harness switched off for the child, but **the profile kept**: it
        // has to meet the same single-instance lock, and the lock is keyed on
        // the profile directory. Dropping it is how this probe came to start a
        // second app against the user's real data (2026-09-20).
        const environment = { ...process.env };
        delete environment.DECKASTRA_SMOKE_DIR;
        delete environment.DECKASTRA_SMOKE_STEP;
        if (!environment.DECKASTRA_SMOKE_PROFILE) {
          throw new Error("a second-instance probe needs DECKASTRA_SMOKE_PROFILE, or it would use the real profile");
        }
        const started = Date.now();
        const args = app.isPackaged ? [] : [app.getAppPath()];
        const child = spawn(process.execPath, args, { env: environment, stdio: "ignore" });
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill();
            resolve({ exitCode: null, ms: Date.now() - started });
          }, 30_000);
          child.once("exit", (code) => {
            clearTimeout(timer);
            resolve({ exitCode: code, ms: Date.now() - started });
          });
        });
      },
      backUpTo: (destination: string) => takeBackup(destination),
      restoreFrom: (source: string) => putBackBackup(source),
      writeDiagnostics: async (file: string) => {
        const report = await collectDiagnostics({
          status,
          service: sidecar ? { port: sidecar.port, secret: sidecar.secret } : null,
          dataDir: dataDir(),
        });
        const text = `${JSON.stringify(report, null, 2)}\n`;
        await writeFile(file, text, "utf8");
        return text.length;
      },
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
//
// **And ask every window first** (final package review, item 01). The service
// used to stop the moment quitting began, while a window could still hold a note
// that had not reached its save queue; now each page saves or journals its work
// while the service is still there to receive it, and only then does it stop.
let quitPrepared = false;
let quitting = false;
app.on("before-quit", (event) => {
  if (quitPrepared) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    // Every window first, and a window that cannot make its work safe stops the
    // quit until the person decides (recheck of item 01). Quitting used to
    // ignore what a window answered.
    for (const window of BrowserWindow.getAllWindows()) {
      if (await settleClose(window)) {
        approveClose(window);
        continue;
      }
      // Someone chose to keep their work. The app stays up, and so does the
      // service: nothing about this quit was safe to carry out.
      quitting = false;
      return;
    }
    // Withdrawn before the service goes, so there is no window in which the file
    // names a port that has already stopped answering.
    await withdrawAttachment();
    const running = sidecar;
    sidecar = undefined;
    await running?.stop();
    quitPrepared = true;
    app.quit();
  })();
});

const pendingDeckFiles: string[] = [];
async function openDeckFile(path?: string): Promise<void> {
  if (!sidecar) { if (path) pendingDeckFiles.push(path); return; }
  try {
    const id = await importDeckFile(sidecar, path);
    if (!id) return;
    await rememberPresentation(sidecar, id);
    presentation = Promise.resolve(id);
    openPresentationId = id;
    await refreshAttachment();
    createWindow();
  } catch (error) {
    await dialog.showMessageBox({ type: "error", title: "Could not open deck file", message: error instanceof Error ? error.message : "The deck file could not be opened." });
  }
}
app.on("open-file", (event, path) => { event.preventDefault(); void openDeckFile(path); });
app.on("second-instance", (_event, argv) => {
  for (const path of argv.filter(argument => argument.toLowerCase().endsWith(".mydeck"))) void openDeckFile(path);
  const [existing] = BrowserWindow.getAllWindows();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  }
});
