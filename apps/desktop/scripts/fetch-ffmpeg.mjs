import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { auditFfmpeg, probeFfmpeg } from "./check-ffmpeg.mjs";

/**
 * Put the audited ffmpeg in `dist/ffmpeg/` for the installer (`npm run ffmpeg`).
 *
 * The bytes are named by `ffmpeg.lock.json`, never by a download page: BtbN
 * rebuilds its `latest` builds daily and deletes old ones, and even our own
 * bucket path can be replaced or emptied (object versioning keeps the bytes,
 * but a path can stop pointing at them). So every file is fetched by its exact
 * object generation and accepted only when its size and SHA-256 match the
 * lock. Anything else is deleted, not shipped.
 *
 * Sources, in order:
 *  - files already in `dist/ffmpeg/` that verify (nothing to do);
 *  - `DECKASTRA_FFMPEG_FROM=<folder>`, a local copy of the same files (e.g. the
 *    audited download in `vendor/ffmpeg/n9.0`), verified exactly the same way;
 *  - Google Cloud Storage through `gcloud storage cp <object>#<generation>`.
 *
 * Outside a release a failure leaves no ffmpeg and says the package will not
 * export MP4; with `DECKASTRA_RELEASE=1` it stops the build.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = dirname(HERE);

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Whether a file is exactly the pinned one. Returns a reason when it is not. */
export function verifyPinned(path, pin) {
  if (!existsSync(path)) return "missing";
  const bytes = statSync(path).size;
  if (bytes !== pin.bytes) return `size ${bytes}, expected ${pin.bytes}`;
  const digest = sha256File(path);
  if (digest !== pin.sha256) return `SHA-256 ${digest}, expected ${pin.sha256}`;
  return null;
}

function gcloudCopy(gcloud, source, target) {
  const result = spawnSync(gcloud, ["storage", "cp", source, target], { encoding: "utf8", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || "gcloud storage cp failed").trim().split("\n").slice(-3).join(" "));
}

/**
 * Fetch and verify every pinned file into `destination`. `copy(name, pin, target)`
 * is injected so the verification can be tested without a network.
 */
export function fetchPinned({ lock, destination, copy }) {
  mkdirSync(destination, { recursive: true });
  const results = {};
  for (const [name, pin] of Object.entries(lock.files)) {
    const target = join(destination, name);
    if (verifyPinned(target, pin) === null) {
      results[name] = "verified";
      continue;
    }
    const partial = `${target}.partial`;
    rmSync(partial, { force: true });
    try {
      copy(name, pin, partial);
      const problem = verifyPinned(partial, pin);
      if (problem) throw new Error(`${name} does not match ffmpeg.lock.json (${problem}); refusing it.`);
      rmSync(target, { force: true });
      renameSync(partial, target);
      results[name] = "fetched";
    } finally {
      rmSync(partial, { force: true });
    }
  }
  return results;
}

export function copierFor({ from, gcloud = "gcloud" } = {}) {
  if (from) return (name, _pin, target) => copyFileSync(join(from, name), target);
  return (_name, pin, target) => gcloudCopy(gcloud, `${pin.object}#${pin.generation}`, target);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const release = process.env.DECKASTRA_RELEASE === "1";
  const lock = JSON.parse(readFileSync(join(DESKTOP, "ffmpeg.lock.json"), "utf8"));
  const destination = join(DESKTOP, "dist", "ffmpeg");
  try {
    const results = fetchPinned({ lock, destination, copy: copierFor({ from: process.env.DECKASTRA_FFMPEG_FROM, gcloud: process.env.DECKASTRA_GCLOUD }) });
    // The pinned bytes were audited once; the licence and capability check is
    // cheap enough to repeat on exactly what is about to be packaged.
    if (process.platform === "win32") {
      const { problems, warnings } = auditFfmpeg(probeFfmpeg(join(destination, "ffmpeg.exe")));
      for (const warning of warnings) console.log(`[ffmpeg] note: ${warning}`);
      if (problems.length) throw new Error(problems.join(" "));
    }
    console.log(`[ffmpeg] ${lock.version} (${lock.license}): ${Object.entries(results).map(([name, how]) => `${name} ${how}`).join(", ")}`);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true }); // empty: the package ships no ffmpeg
    const message = error instanceof Error ? error.message : String(error);
    if (release) {
      console.error(`[ffmpeg] ${message}`);
      console.error("[ffmpeg] A release ships the audited ffmpeg. Authenticate gcloud, or set DECKASTRA_FFMPEG_FROM to a folder holding the pinned files.");
      process.exit(1);
    }
    console.warn(`[ffmpeg] ${message}`);
    console.warn("[ffmpeg] Continuing without ffmpeg: this package will not export MP4.");
  }
}
