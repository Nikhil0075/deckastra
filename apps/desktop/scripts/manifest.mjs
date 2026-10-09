import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What this build is, written down (final package review, item 07).
 *
 * An installed app has to be traceable back to the source and the payloads it
 * was made from. HEAD alone is not that: this repository is developed with a
 * working tree full of uncommitted work, so the manifest hashes what is
 * actually there — every tracked change *and* every untracked source file —
 * beside the commit.
 *
 * **Written after the payloads, never before.** `build.mjs` runs before the
 * sidecar is frozen, so a manifest written there would name a sidecar that did
 * not exist yet (the review's correction). This is its own step, and it records
 * `complete: false` when something it expects to hash is missing, so a release
 * cannot be cut from a half-built tree.
 *
 * It excludes itself: a file cannot contain its own hash.
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktop = dirname(here);
const root = dirname(dirname(desktop));
const dist = join(desktop, "dist");
const OUT = join(dist, "build-manifest.json");

/** Source files a dirty tree can affect the product through. */
const SOURCE = /\.(ts|tsx|js|mjs|cjs|jsx|py|css|json|ya?ml|html|sql|mako|ini)$/i;
/** Never part of an identity: caches, build output, other people's code. */
const SKIP = new Set(["node_modules", "dist", "release", ".git", "__pycache__", ".next", ".venv", ".pyinstaller"]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * One hash for a directory tree: every file's path and content, in a fixed
 * order. Paths are posix and relative, so a tree hashes the same wherever it
 * sits — which is what lets the service compute the same number for the
 * migrations it is running from.
 */
export function hashTree(directory, { exclude = () => false } = {}) {
  if (!existsSync(directory)) return null;
  const files = [...walk(directory)]
    .filter((file) => !exclude(file))
    .map((file) => [relative(directory, file).split(sep).join("/"), file])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash("sha256");
  for (const [name, file] of files) digest.update(`${name}\0${sha256(readFileSync(file))}\n`);
  return { sha256: digest.digest("hex"), files: files.length };
}

/**
 * Every file of a payload that ships beside the archive, with its hash, keyed
 * by its path *as installed* (relative to the resources folder it lands in).
 * The tree hash says whether anything changed; this says what — which is what
 * lets `verify-release.mjs` check an installed payload file by file, and tell a
 * native file that was signed after the build from one that was swapped.
 */
export function fileHashes(directory) {
  if (!existsSync(directory)) return null;
  const out = {};
  // Every file, exactly as shipped — no skip list. `walk` skips caches such as
  // `__pycache__` because they are not *source*; a payload is not source, and
  // the service folder does ship compiled migrations (the first release gate run
  // found sixteen files the manifest had not named).
  const everything = function* (dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* everything(full);
      else if (entry.isFile()) yield full;
    }
  };
  for (const file of everything(directory)) out[relative(directory, file).split(sep).join("/")] = sha256(readFileSync(file));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * The source this was built from: the commit, and — because the tree is rarely
 * clean — a hash over everything changed or untracked beneath it.
 */
function source() {
  const commit = git("rev-parse", "HEAD");
  const status = git("status", "--porcelain", "--untracked-files=all");
  if (status === null) return { commit, dirty: null, changedFiles: null, treeSha256: null };

  const changed = status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((path) => path && SOURCE.test(path))
    // A rename reads as "old -> new"; the new one is what is in the tree.
    .map((path) => (path.includes(" -> ") ? path.split(" -> ")[1] : path))
    .map((path) => path.replaceAll('"', ""))
    .sort();

  const digest = createHash("sha256");
  for (const path of changed) {
    const full = join(root, path);
    // A deleted file still changes what was built; record it as absent.
    digest.update(`${path}\0${existsSync(full) ? sha256(readFileSync(full)) : "deleted"}\n`);
  }
  return {
    commit,
    dirty: changed.length > 0,
    changedFiles: changed.length,
    treeSha256: changed.length > 0 ? digest.digest("hex") : null,
  };
}

function pythonVersion() {
  for (const exe of [process.env.DECKASTRA_PYTHON, "python", "python3"].filter(Boolean)) {
    try {
      return execFileSync(exe, ["--version"], { encoding: "utf8" }).trim();
    } catch {
      /* try the next one */
    }
  }
  return null;
}

export function buildManifest() {
  const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  const payloads = {
    // `dist/main` is the whole app bundle: the main process, the sandboxed
    // preload beside it and the renderer's own build under it.
    app: hashTree(join(dist, "main")),
    worker: hashTree(join(dist, "worker")),
    mcp: hashTree(join(dist, "mcp")),
    sidecar: hashTree(join(dist, "sidecar")),
  };
  // The migrations as they were bundled. The service computes this same number
  // from the files it is actually running, so a new window paired with an old
  // service is caught rather than trusted.
  // The dependency lock and the SBOM are part of what this build is.
  const lockFile = join(desktop, "sidecar-requirements.lock");
  const sbomFile = join(dist, "sbom.json");
  const migrations = hashTree(join(root, "infrastructure", "database", "migrations"), {
    exclude: (file) => file.endsWith(".pyc"),
  });

  return {
    format: 1,
    app: { name: pkg.name, version: pkg.version },
    builtAt: new Date().toISOString(),
    source: source(),
    runtime: {
      electron: pkg.devDependencies?.electron ?? null,
      electronBuilder: pkg.devDependencies?.["electron-builder"] ?? null,
      node: process.versions.node,
      python: pythonVersion(),
    },
    payloads,
    // Where each shipped-beside-the-archive payload lands under `resources/`,
    // and every file in it. `electron-builder.yml` copies `dist/sidecar/
    // deckastra-service` to `sidecar`, so that is the folder hashed here.
    installed: {
      worker: fileHashes(join(dist, "worker")),
      mcp: fileHashes(join(dist, "mcp")),
      sidecar: fileHashes(join(dist, "sidecar", "deckastra-service")),
      // Optional: a development package may carry none. When it does, the
      // release gate checks it file by file like any other payload.
      ...(existsSync(join(dist, "ffmpeg", "ffmpeg.exe")) ? { ffmpeg: fileHashes(join(dist, "ffmpeg")) } : {}),
    },
    migrations,
    dependencies: {
      lockSha256: existsSync(lockFile) ? sha256(readFileSync(lockFile)) : null,
      sbomSha256: existsSync(sbomFile) ? sha256(readFileSync(sbomFile)) : null,
      noticesSha256: existsSync(join(dist, "THIRD_PARTY_NOTICES.txt")) ? sha256(readFileSync(join(dist, "THIRD_PARTY_NOTICES.txt"))) : null,
    },
    // Everything a packaged app needs was there when this was written. A build
    // missing one of them is a build nobody should sign.
    complete: Object.values(payloads).every(Boolean) && Boolean(migrations),
  };
}

export function writeManifest(file = OUT) {
  const manifest = buildManifest();
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = writeManifest();
  const missing = Object.entries(manifest.payloads)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  console.log(
    `manifest: ${manifest.app.version} ${manifest.source.commit?.slice(0, 8) ?? "no git"}` +
      `${manifest.source.dirty ? ` +${manifest.source.changedFiles} changed` : ""}` +
      `${manifest.complete ? "" : ` — incomplete, missing: ${missing.join(", ") || "migrations"}`}`,
  );
  if (!manifest.complete && process.env.DECKASTRA_RELEASE === "1") {
    console.error("A release manifest must name every payload. Build the sidecar and the bundles first.");
    process.exit(1);
  }
}
