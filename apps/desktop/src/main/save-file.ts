import { rename as renameFile, rm as removeFile, writeFile as writeFileNow } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Writing a file the user chose, without destroying the one already there
 * (final package review, item 26).
 *
 * `writeFile(target, bytes)` truncates the target *before* it writes. That is
 * invisible while every write succeeds, and it means a save that fails halfway
 * — a disk that filled, a network drive that went away, a permission revoked
 * between the dialog and the write — leaves the person with **neither** file:
 * the export they were making and the one they were overwriting are both gone.
 * The register names that case directly, because overwriting last week's PDF
 * with nothing is a worse outcome than not saving at all.
 *
 * So the bytes go to a sibling first and are renamed over the target only once
 * they are all on disk. A sibling rather than the system temp directory,
 * because a rename is only atomic within a volume — across one it degrades to a
 * copy, which is the truncating write again with extra steps.
 *
 * What this is not: durability. It does not `fsync`, so a machine that loses
 * power during the rename can still leave either file. It bounds the failure it
 * can bound — a *failed write* never damages what was there — and claiming more
 * than that would be the overclaim this codebase exists to avoid.
 */

/**
 * The three file operations this needs, injected rather than imported.
 *
 * The same reason `assets.sweep` takes its `remove`: the interesting property
 * here is what happens when a write **fails**, and a disk that is genuinely
 * full is the user's machine rather than a test's. Mocking the builtin was
 * tried first and does not apply in this runner at all — which would have left
 * the failure path asserted by nothing while the suite stayed green.
 */
export interface FileOperations {
  writeFile: (path: string, data: Buffer) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string, options: { force: boolean }) => Promise<void>;
}

const REAL: FileOperations = {
  writeFile: (path, data) => writeFileNow(path, data),
  rename: (from, to) => renameFile(from, to),
  rm: (path, options) => removeFile(path, options),
};

export async function writeFileSafely(
  target: string,
  bytes: Uint8Array,
  operations: FileOperations = REAL,
): Promise<void> {
  const staging = join(dirname(target), `.${basename(target)}.${process.pid}.partial`);
  try {
    await operations.writeFile(staging, Buffer.from(bytes));
    // Node's rename replaces an existing file on Windows as it does elsewhere.
    await operations.rename(staging, target);
  } catch (error) {
    // The half-written sibling is ours and nobody asked for it. A failure to
    // clean it up is not worth reporting over the failure that caused it.
    await operations.rm(staging, { force: true }).catch(() => {});
    throw error;
  }
}
