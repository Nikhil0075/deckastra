import { beforeEach, describe, expect, it, vi } from "vitest";

import { allRecoveryEntries, recoveryKey, recoveryPointer, writeRecoveryEntries } from "../src/lib/editor-recovery";

/**
 * The journals a shell's backup carries (desktop item 14).
 *
 * The property worth having: these two are inverses, and neither understands
 * the record format. A backup that parsed a journal would be a second
 * description of `EditorRecovery` to drift, and this one has already been
 * through a version bump.
 */

beforeEach(() => {
  localStorage.clear();
});

describe("handing the journals over", () => {
  it("takes this module's records, and nothing else in storage", () => {
    localStorage.setItem(recoveryKey("doc_1"), '{"format":1}');
    localStorage.setItem(recoveryPointer("doc_1"), "owner-a");
    localStorage.setItem("deckastra.chrome-theme", "dark");
    localStorage.setItem("something.else", "no");

    expect(allRecoveryEntries().map((entry) => entry.key).sort()).toEqual([
      recoveryPointer("doc_1"),
      recoveryKey("doc_1"),
    ].sort());
  });

  it("carries the owner pointer as well as the journal", () => {
    // Without it a restored journal comes back as an anonymous copy in a
    // collapsed list rather than as the work someone was in the middle of.
    localStorage.setItem(recoveryKey("doc_1", "window-a"), "{}");
    localStorage.setItem(recoveryPointer("doc_1"), "window-a");

    expect(allRecoveryEntries()).toHaveLength(2);
  });

  it("does not parse what it carries", () => {
    // A record written by a newer build survives a backup taken by an older
    // one, because nothing here reads past the string.
    localStorage.setItem(recoveryKey("doc_1"), '{"format":99,"whatever":true}');

    expect(allRecoveryEntries()[0]?.value).toBe('{"format":99,"whatever":true}');
  });

  it("answers empty when storage refuses to be read", () => {
    // Backing up the decks is worth more than failing over the unsaved edits.
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("access denied");
    });
    localStorage.setItem(recoveryKey("doc_1"), "{}");

    expect(allRecoveryEntries()).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("putting the journals back", () => {
  it("round-trips whatever was collected", () => {
    localStorage.setItem(recoveryKey("doc_1"), '{"format":1}');
    localStorage.setItem(recoveryPointer("doc_1"), "window-a");
    const collected = allRecoveryEntries();
    localStorage.clear();

    expect(writeRecoveryEntries(collected)).toBe(2);
    expect(allRecoveryEntries().sort((a, b) => a.key.localeCompare(b.key))).toEqual(
      collected.sort((a, b) => a.key.localeCompare(b.key)),
    );
  });

  it("writes only this module's own keys, whatever arrived", () => {
    // The entries have crossed two process boundaries. "It came from our own
    // backup" is a claim about where a file has been, not about what is in it.
    const written = writeRecoveryEntries([
      { key: recoveryKey("doc_1"), value: "kept" },
      { key: "deckastra.chrome-theme", value: "dark" },
      { key: "../../evil", value: "no" },
    ]);

    expect(written).toBe(1);
    expect(localStorage.getItem("deckastra.chrome-theme")).toBeNull();
    expect(localStorage.getItem("../../evil")).toBeNull();
  });

  it("a record that will not fit costs that record, not the rest", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("quota exceeded");
    });

    expect(
      writeRecoveryEntries([
        { key: recoveryKey("doc_1"), value: "too big" },
        { key: recoveryKey("doc_2"), value: "fits" },
      ]),
    ).toBe(1);
    setItem.mockRestore();
    expect(localStorage.getItem(recoveryKey("doc_2"))).toBe("fits");
  });
});
