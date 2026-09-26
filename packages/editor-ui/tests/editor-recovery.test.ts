import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { openRecoveryJournal, recoveryKey, recoveryPointer, type EditorRecovery, type RecoveryJournal } from "../src/lib/editor-recovery";
import { recoveryLocks } from "./helpers/recovery-locks";

const journals: RecoveryJournal[] = [];
async function open() { const journal = await openRecoveryJournal("prs_test"); journals.push(journal); return journal; }
function record(title = "Unsaved") {
  const document = loadFixture("technical"); document.metadata.title = title;
  return { format: 1, versionId: "base", document, operations: [{ op: "replace", path: "/metadata/title", value: title }], labels: ["Retitle"] } as EditorRecovery;
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  Object.defineProperty(navigator, "locks", { configurable: true, value: recoveryLocks() });
});
afterEach(() => { journals.splice(0).forEach(journal => journal.close()); vi.restoreAllMocks(); });

describe("recovery journal ownership", () => {
  it("isolates a duplicate tab with a copied session pointer and cannot take its live journal", async () => {
    const first = await open(); first.write(record("First tab"));
    const second = await open(); second.write(record("Second tab"));
    expect(second.key).not.toBe(first.key);
    expect((await second.copies())[0]).toMatchObject({ key: first.key, active: true });
    await expect(second.take(first.key)).rejects.toThrow("another tab");
    second.write(null);
    expect(first.read()?.document.metadata.title).toBe("First tab");
  });

  it("reuses only a released session journal on reload", async () => {
    const first = await open(); first.write(record()); first.close();
    const reloaded = await open();
    expect(reloaded.key).toBe(first.key);
    expect(reloaded.read()?.operations).toEqual(record().operations);
  });

  it("after a relaunch, the desktop's pointer finds the journal the last session left", async () => {
    // Item 01: a close that could not save leaves a journal. A relaunch clears
    // session storage, so only a pointer that survives the process finds it again.
    const before = await openRecoveryJournal("prs_test", { pointer: "local" });
    before.write(record("Unsaved at quit"));
    before.close();
    sessionStorage.clear();

    const relaunched = await openRecoveryJournal("prs_test", { pointer: "local" });
    journals.push(relaunched);
    expect(relaunched.key).toBe(before.key);
    expect(relaunched.read()?.document.metadata.title).toBe("Unsaved at quit");
  });

  it("without it, the same relaunch leaves the journal as an anonymous copy", async () => {
    const before = await open();
    before.write(record("Unsaved at quit"));
    before.close();
    sessionStorage.clear();

    const relaunched = await open();
    expect(relaunched.key).not.toBe(before.key);
    expect((await relaunched.copies()).map((copy) => copy.key)).toEqual([before.key]);
  });

  it("a second live window still gets a journal of its own under the desktop's pointer", async () => {
    const first = await openRecoveryJournal("prs_test", { pointer: "local" });
    journals.push(first);
    const second = await openRecoveryJournal("prs_test", { pointer: "local" });
    journals.push(second);
    expect(second.key).not.toBe(first.key);
  });

  it("recovers a closed tab's copy into the current journal without touching other copies", async () => {
    const first = await open(); first.write(record("Closed"));
    const second = await open(); second.write(record("Still open"));
    const third = await open(); first.close();
    expect((await third.copies()).find(copy => copy.key === first.key)?.active).toBe(false);
    expect((await third.take(first.key)).document.metadata.title).toBe("Closed");
    expect(localStorage.getItem(first.key)).toBeNull();
    expect(third.read()?.document.metadata.title).toBe("Closed");
    expect(second.read()?.document.metadata.title).toBe("Still open");
  });

  it("retains the source when copying hits the storage quota", async () => {
    const first = await open(); first.write(record()); first.close();
    sessionStorage.removeItem(recoveryPointer("prs_test"));
    const target = await open();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await expect(target.take(first.key)).rejects.toThrow("quota");
    expect(localStorage.getItem(first.key)).not.toBeNull();
    expect(localStorage.getItem(target.key)).toBeNull();
  });

  it("does not overwrite a current journal or unreadable recovery data", async () => {
    const first = await open(); first.write(record()); first.close();
    sessionStorage.removeItem(recoveryPointer("prs_test"));
    const target = await open(); target.write(record("Current"));
    await expect(target.take(first.key)).rejects.toThrow("this tab's edits");
    localStorage.setItem(target.key, "broken json");
    expect(() => target.write(null)).toThrow();
    expect(localStorage.getItem(target.key)).toBe("broken json");
    expect((await target.copies()).find(copy => copy.key === target.key)?.error).toBeTruthy();
  });

  it("copies legacy data without deleting a journal an older editor may still use", async () => {
    localStorage.setItem(recoveryKey("prs_test"), JSON.stringify(record("Legacy")));
    const target = await open();
    expect((await target.take(recoveryKey("prs_test"))).document.metadata.title).toBe("Legacy");
    expect(localStorage.getItem(recoveryKey("prs_test"))).not.toBeNull();
  });

  it("without Web Locks uses unique keys and retains explicitly recovered sources", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const first = await open(); first.write(record());
    const second = await open();
    expect(second.key).not.toBe(first.key);
    await second.take(first.key);
    second.write(null);
    expect(first.read()).not.toBeNull();
  });
});
