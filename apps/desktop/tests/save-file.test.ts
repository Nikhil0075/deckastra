import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { writeFileSafely, type FileOperations } from "../src/main/save-file";

/**
 * A failed save must not destroy the file it was replacing (item 26).
 *
 * The register asks for download cancellation, a denied destination and a full
 * disk to be tested "without damaging an existing target file", and all three
 * share one failure: `writeFile` truncates the target *before* it writes, so
 * any of them can leave the person with neither the new file nor the old one.
 *
 * **A genuinely full volume is not reproduced here**, and saying so matters:
 * that is the user's machine and belongs on the release checklist. What is
 * reproduced is the *shape* every one of those failures has — the write fails
 * after the target already exists — and the property that makes the damage
 * impossible, which is narrower and fully checkable: **the target is never
 * opened for writing.**
 *
 * The first version of this suite stood in for a full disk with an impossible
 * path. That fails *before* the target is touched, so the truncating
 * implementation passed every case; the control caught it. Hence the seam.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "deckastra-save-"));
}

/** The real operations, with what they were asked to do written down. */
function watched(): FileOperations & { writes: string[]; renames: [string, string][] } {
  const writes: string[] = [];
  const renames: [string, string][] = [];
  return {
    writes,
    renames,
    writeFile: (path, data) => {
      writes.push(path);
      return writeFile(path, data);
    },
    rename: (from, to) => {
      renames.push([from, to]);
      return rename(from, to);
    },
    rm: (path, options) => rm(path, options),
  };
}

/** A volume that has run out, failing where a real one fails: on the bytes. */
function fullDisk(): FileOperations {
  return {
    writeFile: () => Promise.reject(Object.assign(new Error("no space left on device"), { code: "ENOSPC" })),
    rename: (from, to) => rename(from, to),
    rm: (path, options) => rm(path, options),
  };
}

describe("saving a file the user chose", () => {
  it("writes the bytes", async () => {
    const dir = scratch();
    await writeFileSafely(join(dir, "deck.pdf"), new Uint8Array([1, 2, 3]));

    expect([...readFileSync(join(dir, "deck.pdf"))]).toEqual([1, 2, 3]);
  });

  it("replaces an existing file", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "deck.pdf"), "last week's export");

    await writeFileSafely(join(dir, "deck.pdf"), new Uint8Array([9, 9]));

    expect([...readFileSync(join(dir, "deck.pdf"))]).toEqual([9, 9]);
  });

  it("never opens the target for writing, which is what makes a failed save harmless", async () => {
    // The discriminating case. A truncating `writeFile(target, bytes)` passes
    // every behavioural test above and fails this one, because it names the
    // target as the thing it writes — and naming it is what truncates it.
    const dir = scratch();
    const target = join(dir, "deck.pdf");
    writeFileSync(target, "last week's export");
    const operations = watched();

    await writeFileSafely(target, new Uint8Array([4, 4]), operations);

    expect(operations.writes).toHaveLength(1);
    expect(operations.writes[0]).not.toBe(target);
    expect(operations.renames).toEqual([[operations.writes[0], target]]);
  });

  it("stages beside the target, because a rename is only atomic within a volume", async () => {
    // Staging in the system temp directory would degrade the rename to a copy,
    // which is the truncating write again with extra steps.
    const dir = scratch();
    const operations = watched();

    await writeFileSafely(join(dir, "deck.pdf"), new Uint8Array([7]), operations);

    expect(operations.writes[0]?.startsWith(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual(["deck.pdf"]);
  });

  it("leaves the existing file alone when the disk fills", async () => {
    const dir = scratch();
    const target = join(dir, "deck.pdf");
    writeFileSync(target, "last week's export");

    await expect(writeFileSafely(target, new Uint8Array([1, 2]), fullDisk())).rejects.toThrow(/no space/);

    expect(readFileSync(target, "utf8")).toBe("last week's export");
  });

  it("leaves nothing behind when it fails", async () => {
    // A half-written sibling is ours and nobody asked for it, so a failure must
    // not litter the folder the person picked with partial exports.
    const dir = scratch();

    await expect(writeFileSafely(join(dir, "deck.pdf"), new Uint8Array([1]), fullDisk())).rejects.toThrow();

    expect(readdirSync(dir)).toEqual([]);
  });

  it("cleans up the sibling when the rename is the thing that fails", async () => {
    // A denied destination can refuse the replace rather than the write, and a
    // `.partial` left in someone's Documents folder is litter with our name on it.
    const dir = scratch();
    const operations: FileOperations = {
      writeFile: (path, data) => writeFile(path, data),
      rename: () => Promise.reject(Object.assign(new Error("access is denied"), { code: "EPERM" })),
      rm: (path, options) => rm(path, options),
    };

    await expect(writeFileSafely(join(dir, "deck.pdf"), new Uint8Array([1]), operations)).rejects.toThrow(
      /denied/,
    );

    expect(readdirSync(dir)).toEqual([]);
  });
});
