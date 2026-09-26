import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { BrowserWindow, dialog, ipcMain } from "electron";

import { IPC, type JournalEntry, type JournalsCollected } from "../shared/ipc";

/**
 * Backing up and putting back (final package review, item 14).
 *
 * The register's complaint was that this product told people a backup was a
 * directory copy and gave them nothing to press. Both halves are answered here,
 * and they are answered in *different processes*, which is the design rather
 * than an accident of where the code fits:
 *
 * - **A backup is taken by the running service**, because the service owns the
 *   writers. SQLite's online backup API reads a database other connections are
 *   still writing, so nobody has to stop working to be backed up.
 * - **A restore is taken with the service stopped**, because the database it
 *   replaces is the one the service has open. The app stops it, runs the
 *   service binary as a one-shot (`--restore-from`), and starts it again.
 *
 * What this process contributes that neither of the others can: the **dialogs**
 * and the **recovery journals**. The journals live in browser storage inside a
 * renderer, which is outside the data directory the service knows about — a
 * backup taken by the service alone would carry every saved deck and none of
 * the work someone had typed and not yet saved, which is precisely the work a
 * backup is most needed for.
 *
 * **No path crosses the renderer boundary**, which is the rule `shared/ipc.ts`
 * states and this is the feature that most wanted to break it. The renderer
 * never names a folder and never asks for one: the menu item is main's, the
 * dialog is main's, and the only thing the page is asked for is its own
 * journals.
 */

/** How long a window gets to hand over its journals before it is left out. */
const COLLECT_TIMEOUT_MS = 5_000;

/**
 * Ask one window for its recovery journals.
 *
 * A window that does not answer costs its own unsaved work and not the backup.
 * The alternative — waiting indefinitely — means a crashed renderer can stop
 * someone backing up their decks, which is the wrong way round: the decks are
 * the part that is definitely worth keeping.
 */
export function askForJournals(window: BrowserWindow, timeoutMs = COLLECT_TIMEOUT_MS): Promise<JournalEntry[]> {
  if (window.isDestroyed() || window.webContents.isCrashed()) return Promise.resolve([]);
  const id = randomUUID();
  return new Promise((resolve) => {
    const finish = (entries: JournalEntry[]) => {
      clearTimeout(timer);
      ipcMain.off(IPC.journalsCollected, onCollected);
      resolve(entries);
    };
    const onCollected = (event: Electron.IpcMainEvent, reply: JournalsCollected) => {
      // This window's page, answering this request. Another window's answer to
      // its own ask must not be taken for this one's.
      if (window.isDestroyed() || event.sender !== window.webContents) return;
      if (!reply || reply.id !== id) return;
      finish(Array.isArray(reply.entries) ? reply.entries.filter(isEntry) : []);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    ipcMain.on(IPC.journalsCollected, onCollected);
    window.webContents.send(IPC.journalsCollect, id);
  });
}

function isEntry(value: unknown): value is JournalEntry {
  const entry = value as JournalEntry | null;
  return (
    !!entry &&
    typeof entry.key === "string" &&
    typeof entry.value === "string" &&
    // Journals are bounded because they are held in memory on the way through
    // and written into a file the user will be told is their backup.
    entry.key.length < 512 &&
    entry.value.length < 32 * 1024 * 1024
  );
}

/**
 * Every window's journals, with duplicates collapsed by key.
 *
 * Two editor windows can hold journals for different decks, and each owns its
 * own key (`editor-recovery.ts` puts the owner in the key), so collisions are
 * not expected — but browser storage is shared per origin, so two windows
 * reporting the same key are reporting the same record and writing it twice
 * would only make the backup bigger.
 */
export async function collectJournals(windows: Iterable<BrowserWindow>): Promise<JournalEntry[]> {
  const byKey = new Map<string, string>();
  for (const answer of await Promise.all([...windows].map((window) => askForJournals(window)))) {
    for (const entry of answer) byKey.set(entry.key, entry.value);
  }
  return [...byKey].map(([key, value]) => ({ key, value }));
}

/** Put journals back into the renderer's storage after a restore. */
export function returnJournals(windows: Iterable<BrowserWindow>, entries: JournalEntry[]): void {
  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send(IPC.journalsRestore, entries);
  }
}

// --------------------------------------------------------------- the one-shot

export interface RestoreResult {
  restored: boolean;
  migrated?: boolean;
  error?: string;
  replaced?: string;
  counts?: Record<string, number>;
  created_at?: string;
  journals?: JournalEntry[] | null;
}

/**
 * Run the service binary once, to put a backup back, and read its one JSON line.
 *
 * The same single-line contract the ready announcement uses, for the same
 * reason: a supervisor parsing a stream is a supervisor that hangs on a partial
 * line. Everything on stderr is log output and is kept only to explain a
 * failure.
 */
export function runRestore(
  service: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv },
  timeoutMs = 300_000,
): Promise<RestoreResult> {
  return new Promise((resolve) => {
    const child = spawn(service.file, service.args, { cwd: service.cwd, env: service.env, stdio: "pipe" });
    let out = "";
    let errors = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ restored: false, error: "The restore took too long and was stopped." });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString("utf8")).slice(-4_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ restored: false, error: String(error) });
    });
    child.once("exit", () => {
      clearTimeout(timer);
      const line = out.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (!line) {
        resolve({
          restored: false,
          // The tail of stderr rather than nothing: "it did not work" with no
          // reason is what item 18 exists to stop this product doing.
          error: errors.trim() || "The restore did not report what it did.",
        });
        return;
      }
      try {
        resolve(JSON.parse(line) as RestoreResult);
      } catch {
        resolve({ restored: false, error: "The restore's answer could not be read." });
      }
    });
  });
}

// ----------------------------------------------------------------- the dialogs

/** Where to write a backup, or null when the person cancelled. */
export async function chooseBackupFolder(window: BrowserWindow | undefined): Promise<string | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window!, {
    title: "Back up Deckastra",
    message: "Choose an empty folder for this backup",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Back up here",
  });
  return canceled || !filePaths[0] ? null : filePaths[0];
}

/** Which backup to put back, or null when the person cancelled. */
export async function chooseBackupToRestore(window: BrowserWindow | undefined): Promise<string | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window!, {
    title: "Restore Deckastra",
    message: "Choose a backup folder",
    properties: ["openDirectory"],
    buttonLabel: "Restore from here",
  });
  return canceled || !filePaths[0] ? null : filePaths[0];
}

/**
 * The confirmation before a restore, which is the only destructive thing on
 * this surface.
 *
 * It says what is about to be replaced *and* that the current data is kept,
 * because the second half is what makes the decision a reasonable one to take.
 * Under the acceptance harness there is nobody to answer a modal, so it answers
 * yes — the harness runs on a profile of its own.
 */
export async function confirmRestore(window: BrowserWindow | undefined, source: string): Promise<boolean> {
  if (process.env.DECKASTRA_SMOKE_DIR) return true;
  const { response } = await dialog.showMessageBox(window!, {
    type: "warning",
    buttons: ["Restore", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: "Replace everything on this computer with this backup?",
    detail:
      `Every deck, version and image here will be replaced with what is in ${source}. ` +
      "Deckastra keeps what it replaces in a folder beside the new data, so this can be undone.",
  });
  return response === 0;
}

/**
 * Whether a folder is empty enough to back up into.
 *
 * Asked here as well as in the service so the person is told before anything
 * else happens, rather than after the app has stopped to think about it. The
 * service checks too, and that is the one that matters: this is a courtesy.
 */
export async function isEmptyFolder(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}
