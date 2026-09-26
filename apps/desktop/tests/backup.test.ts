import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

/**
 * What the main process contributes to a backup (final package review, item 14).
 *
 * The snapshot itself is the service's (`apps/api/tests/test_backup.py`); what is
 * checked here is the half only this process can do — collecting the recovery
 * journals out of the windows, and reading the one-shot restore's single line.
 */

const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

vi.mock("electron", () => ({
  BrowserWindow: {},
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(handler);
    },
    off: (channel: string, handler: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(handler);
    },
  },
}));

const { askForJournals, collectJournals, runRestore } = await import("../src/main/backup");
const { IPC } = await import("../src/shared/ipc");

/** A window that answers `journalsCollect` however the test wants it to. */
function fakeWindow(answer: (id: string) => unknown, { crashed = false } = {}) {
  const webContents = {
    isCrashed: () => crashed,
    isDestroyed: () => false,
    send: (channel: string, id: string) => {
      if (channel !== IPC.journalsCollect) return;
      const reply = answer(id);
      if (reply === undefined) return;
      for (const handler of listeners.get(IPC.journalsCollected) ?? []) {
        handler({ sender: webContents } as never, reply);
      }
    },
  };
  return { isDestroyed: () => false, webContents } as never;
}

describe("collecting the journals a backup has to carry", () => {
  it("takes what a window hands over", async () => {
    const entries = [{ key: "deckastra.editor-recovery.v1:doc_1", value: '{"format":1}' }];
    expect(await askForJournals(fakeWindow((id) => ({ id, entries })))).toEqual(entries);
  });

  it("ignores an answer to a different ask", async () => {
    // Two windows are asked at once, and each has its own request id. An answer
    // taken for the wrong ask would put one window's unsaved work in the
    // backup twice and the other's not at all.
    const answered = askForJournals(
      fakeWindow((id) => ({ id: `${id}-not-this-one`, entries: [{ key: "a", value: "b" }] })),
      80,
    );
    expect(await answered).toEqual([]);
  });

  it("does not wait out a window that will never answer", async () => {
    // A crashed renderer must cost its own unsaved work and not the backup:
    // the decks are the part that is definitely worth keeping.
    expect(await askForJournals(fakeWindow(() => undefined, { crashed: true }), 50)).toEqual([]);
  });

  it("refuses an entry that is not a key and a string", async () => {
    const entries = [
      { key: "deckastra.editor-recovery.v1:doc_1", value: "kept" },
      { key: 7, value: "not a key" },
      { key: "no value" },
      { key: "too long", value: "x".repeat(33 * 1024 * 1024) },
    ];
    expect(await askForJournals(fakeWindow((id) => ({ id, entries })))).toEqual([
      { key: "deckastra.editor-recovery.v1:doc_1", value: "kept" },
    ]);
  });

  it("collapses the same record reported by two windows", async () => {
    // Browser storage is per origin, so two windows see one another's records.
    // Writing it twice would only make the backup bigger.
    const shared = { key: "deckastra.editor-recovery.v1:doc_1", value: "one" };
    const collected = await collectJournals([
      fakeWindow((id) => ({ id, entries: [shared] })),
      fakeWindow((id) => ({ id, entries: [shared, { key: "deckastra.editor-recovery.v1:doc_2", value: "two" }] })),
    ]);
    expect(collected).toHaveLength(2);
    expect(collected.map((entry) => entry.key).sort()).toEqual([
      "deckastra.editor-recovery.v1:doc_1",
      "deckastra.editor-recovery.v1:doc_2",
    ]);
  });
});

describe("reading what the one-shot restore did", () => {
  /** Run node itself, which is the same narrow contract the service answers on. */
  const node = (script: string) => ({ file: process.execPath, args: ["-e", script], cwd: process.cwd(), env: process.env });

  it("takes the JSON line and ignores the log output around it", async () => {
    const result = await runRestore(
      node(
        'console.error("migrating"); console.log(JSON.stringify({restored:true,migrated:true,counts:{presentations:3}}));',
      ),
    );
    expect(result).toMatchObject({ restored: true, migrated: true, counts: { presentations: 3 } });
  });

  it("keeps what the service said when it printed no answer at all", async () => {
    // "It did not work" with no reason is exactly what item 18 exists to stop
    // this product doing.
    const result = await runRestore(node('console.error("could not open the database"); process.exit(1);'));
    expect(result.restored).toBe(false);
    expect(result.error).toContain("could not open the database");
  });

  it("reports a service that cannot be run at all", async () => {
    const result = await runRestore({
      file: "deckastra-service-that-is-not-here",
      args: [],
      cwd: process.cwd(),
      env: process.env,
    });
    expect(result.restored).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("stops a restore that will not finish, rather than hanging the app", async () => {
    const result = await runRestore(node("setTimeout(() => {}, 60_000);"), 150);
    expect(result).toMatchObject({ restored: false });
    expect(result.error).toContain("too long");
  });
});
