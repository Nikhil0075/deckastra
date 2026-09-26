import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

/**
 * What this build is, read back at runtime (final package review, item 07).
 *
 * Written by `scripts/manifest.mjs` after every payload exists, and shipped
 * beside them. Two things use it: diagnostics, so a report names the build it
 * came from rather than a version string anyone could guess, and the pairing
 * check below.
 */

export interface BuildManifest {
  format: number;
  app: { name: string; version: string };
  builtAt: string;
  source: { commit: string | null; dirty: boolean | null; changedFiles: number | null; treeSha256: string | null };
  runtime: { electron: string | null; electronBuilder: string | null; node: string; python: string | null };
  payloads: Record<string, { sha256: string; files: number } | null>;
  migrations: { sha256: string; files: number } | null;
  dependencies?: { lockSha256: string | null; sbomSha256: string | null };
  complete: boolean;
}

let cached: BuildManifest | null | undefined;

/** The manifest, or null where there is none (a checkout that skipped the step). */
export async function buildManifest(): Promise<BuildManifest | null> {
  if (cached !== undefined) return cached;
  const file = app.isPackaged
    ? join(process.resourcesPath, "build-manifest.json")
    : join(import.meta.dirname, "..", "build-manifest.json");
  try {
    cached = JSON.parse(await readFile(file, "utf8")) as BuildManifest;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Whether the service that just started was built from the same migrations as
 * this app.
 *
 * The failure this exists for is a stale service beside a new window: the
 * renderer's own version says nothing about the binary in `resources`, and a
 * mismatched pair can migrate a database in a direction the app does not expect.
 * Unknown on either side is not a mismatch — a checkout has no manifest, and an
 * older service does not report its migrations — and guessing there would refuse
 * to start on every development run.
 */
export function mismatchedMigrations(
  manifest: BuildManifest | null,
  reported: unknown,
): { expected: string; found: string } | null {
  const expected = manifest?.migrations?.sha256;
  if (!expected || typeof reported !== "string" || !reported) return null;
  return reported === expected ? null : { expected, found: reported };
}
