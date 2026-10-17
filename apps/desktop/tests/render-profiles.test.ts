import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isRunning, recordHost, sweepAbandonedProfiles } from "../src/main/render-profiles";

/**
 * A cancelled export kills the exporter before it can delete the render host's
 * profile, so the next host removes the profiles whose host has gone — and
 * nothing a running host might still be using.
 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function profile(name: string, pid?: string): string {
  const path = join(dir, name);
  mkdirSync(path);
  writeFileSync(join(path, "Cookies"), "chromium was here");
  if (pid !== undefined) writeFileSync(join(path, "host.pid"), pid);
  return path;
}

describe("abandoned render profiles", () => {
  it("removes a profile whose host is gone, and leaves a running host's alone", () => {
    dir = mkdtempSync(join(tmpdir(), "render-sweep-"));
    const dead = profile("deckastra-render-dead", "101");
    const live = profile("deckastra-render-live", "202");
    const removed = sweepAbandonedProfiles(dir, (pid) => pid === 202);
    expect(removed).toEqual([dead]);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it("leaves a profile with no pid, a malformed pid, or a name that is not ours", () => {
    dir = mkdtempSync(join(tmpdir(), "render-sweep-"));
    const unknown = profile("deckastra-render-old");
    const garbled = profile("deckastra-render-garbled", "not a pid");
    const other = profile("something-else", "101");
    expect(sweepAbandonedProfiles(dir, () => false)).toEqual([]);
    for (const path of [unknown, garbled, other]) expect(existsSync(path)).toBe(true);
  });

  it("records this process as the host, which a sweep then sees as running", () => {
    dir = mkdtempSync(join(tmpdir(), "render-sweep-"));
    const mine = profile("deckastra-render-mine");
    recordHost(mine);
    expect(isRunning(process.pid)).toBe(true);
    expect(sweepAbandonedProfiles(dir)).toEqual([]);
    expect(existsSync(mine)).toBe(true);
  });

  it("answers nothing for a directory that does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "render-sweep-"));
    expect(sweepAbandonedProfiles(join(dir, "missing"))).toEqual([]);
  });
});
