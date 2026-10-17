import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The render host's throwaway profiles, and the ones nobody came back for.
 *
 * Each host makes a `deckastra-render-*` profile and the exporter deletes it
 * once the host has exited, because Chromium holds it open until then
 * (`electron-backend.ts`). Cancelling an export kills the exporter's whole
 * process tree (`processes.terminate_tree`), so that clean-up never runs and the
 * folder stays in the temp directory — one per cancelled export, found by the
 * MCP acceptance run on the first macOS build (2026-10-17).
 *
 * So a host writes its pid into its profile, and every new host first removes
 * the profiles whose host is no longer running. A profile with a live host is
 * left alone — an export may be running beside this one — and so is a profile
 * with no pid file: it predates this, or its host has not written one yet, and
 * guessing would delete something in use.
 */

export const PROFILE_PREFIX = "deckastra-render-";
const PID_FILE = "host.pid";

/** Whether a process is running. A signal of 0 checks without sending anything. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else, so it is running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function recordHost(profile: string, pid: number = process.pid): void {
  writeFileSync(join(profile, PID_FILE), String(pid), "utf8");
}

/** Remove abandoned render profiles under `dir`; returns the ones removed. */
export function sweepAbandonedProfiles(dir: string, running: (pid: number) => boolean = isRunning): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.startsWith(PROFILE_PREFIX));
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    const profile = join(dir, name);
    const pidFile = join(profile, PID_FILE);
    if (!existsSync(pidFile)) continue;
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || running(pid)) continue;
    try {
      rmSync(profile, { recursive: true, force: true });
      removed.push(profile);
    } catch {
      // Still locked (Windows) or already gone: the next host tries again.
    }
  }
  return removed;
}
