import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { auditFfmpeg, probeFfmpeg } from "./check-ffmpeg.mjs";

/**
 * Is this release what was built, is it current, and is it signed? (Register
 * items 11 and 12; manual-authoring plan MA-34.)
 *
 * `check-signing.mjs` asks whether the installer is signed. That is necessary
 * and nowhere near enough: an installer is a wrapper, and what runs on a
 * customer's machine is the tree it lays down — the app executable, the frozen
 * workspace service and its native libraries, the exporter and the MCP server.
 * A signed installer around an unsigned or swapped service is the case this
 * exists to refuse. So this reads the unpacked payload electron-builder built
 * the installer from (`release/win-unpacked`), which is byte-for-byte what the
 * installer extracts, and checks four things:
 *
 * 1. **One installer, and nothing stale.** Exactly one `.exe` at the top of the
 *    release folder. Two means an old build is lying beside the new one, and a
 *    person copying "the installer" may take the wrong one.
 * 2. **Current.** The manifest shipped inside the release is the manifest of the
 *    build in `dist/` right now. A release folder left over from yesterday's
 *    build cannot pass against today's tree.
 * 3. **Intact.** Every file the manifest recorded for the worker, the MCP server
 *    and the service is present with the recorded hash, and nothing is added.
 *    JavaScript bundles cannot carry an Authenticode signature, so for them the
 *    hash *is* the check. A native file (`.exe`, `.dll`, `.pyd`, `.node`) may
 *    differ from its recorded hash only because signing added a signature — and
 *    then only if that signature is valid.
 * 4. **Signed.** The installer, `Deckastra.exe` and the service executable must
 *    carry a valid signature from `DECKASTRA_SIGNING_PUBLISHER`. Every other
 *    native file is inventoried with its status: a third-party library the
 *    build did not sign is allowed only if it is exactly what was built.
 *
 * The asar archive is not hashed here: its integrity belongs to Electron's own
 * asar integrity fuse, and restating it would be a second, weaker check.
 *
 * Pure policy in `verifyRelease`, with the signature probe injected, so the
 * refusals are tested without a certificate (`tests/verify-release.test.ts`).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = dirname(HERE);

export const NATIVE = new Set([".exe", ".dll", ".pyd", ".node", ".sys"]);
const PAYLOADS = ["worker", "mcp", "sidecar"];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function posix(root, file) {
  return relative(root, file).split(sep).join("/");
}

/**
 * @param {object} input
 * @param {string} input.releaseDir   The electron-builder output folder.
 * @param {string} input.distManifest The manifest of the build in `dist/` (used when `current` is absent).
 * @param {{payloads: object, source: object, migrations: object} | undefined} input.current
 *        The build as it is now — `buildManifest()` — against which the release must match.
 * @param {(paths: string[]) => Map<string, {status: string, subject?: string}>} input.probe
 *        Signature status per absolute path (Authenticode on Windows).
 * @param {string | undefined} input.publisher Required subject substring for our executables.
 * @param {boolean} input.requireSigned Whether an unsigned executable is a failure.
 */
export function verifyRelease({ releaseDir, distManifest, current, probe, publisher, requireSigned, ffmpegProbe = probeFfmpeg }) {
  const problems = [];
  const report = { installer: null, embedded: null, payloads: {}, signatures: [], unsignedThirdParty: [], ffmpeg: null };

  // 1. One installer.
  const installers = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter((name) => extname(name).toLowerCase() === ".exe").map((name) => join(releaseDir, name))
    : [];
  if (installers.length === 0) problems.push(`No installer in ${releaseDir}. Build one first.`);
  if (installers.length > 1) {
    problems.push(
      `${installers.length} installers in ${releaseDir} (${installers.map((file) => file.slice(releaseDir.length + 1)).join(", ")}). ` +
        "A release folder holds exactly one; clean it and build again.",
    );
  }
  const installer = installers.length === 1 ? installers[0] : undefined;
  if (installer) report.installer = { file: installer, sha256: sha256(readFileSync(installer)), bytes: statSync(installer).size };

  const unpacked = join(releaseDir, "win-unpacked");
  const resources = join(unpacked, "resources");
  if (!existsSync(resources)) {
    problems.push(`No unpacked payload at ${unpacked}; the installer's contents cannot be checked.`);
    return { ok: false, problems, report };
  }

  // 2. Current.
  const embeddedFile = join(resources, "build-manifest.json");
  if (!existsSync(embeddedFile)) {
    problems.push("The release carries no build manifest, so what it contains cannot be named.");
    return { ok: false, problems, report };
  }
  const embeddedText = readFileSync(embeddedFile, "utf8");
  const embedded = JSON.parse(embeddedText);
  report.embedded = { builtAt: embedded.builtAt, commit: embedded.source?.commit ?? null, treeSha256: embedded.source?.treeSha256 ?? null };
  if (embedded.complete !== true) problems.push("The release's build manifest says the build was incomplete.");
  if (!embedded.installed) problems.push("The release's build manifest predates per-file hashes; rebuild it.");
  if (current) {
    // Measured now, not read from a file: `dist/build-manifest.json` is only
    // rewritten by the manifest step, so after a plain rebuild it still matches
    // yesterday's release. What is in `dist` and in the source tree right now is
    // what "current" means.
    const stale = [];
    for (const [name, value] of Object.entries(current.payloads ?? {})) {
      if ((embedded.payloads?.[name]?.sha256 ?? null) !== (value?.sha256 ?? null)) stale.push(`the ${name} bundle`);
    }
    if ((embedded.source?.treeSha256 ?? null) !== (current.source?.treeSha256 ?? null) || (embedded.source?.commit ?? null) !== (current.source?.commit ?? null)) {
      stale.push("the source tree");
    }
    if ((embedded.migrations?.sha256 ?? null) !== (current.migrations?.sha256 ?? null)) stale.push("the migrations");
    if (stale.length > 0) {
      problems.push(`The release is stale: ${stale.join(", ")} changed since it was built. Rebuild the release.`);
    }
  } else if (!existsSync(distManifest)) {
    problems.push(`No build manifest at ${distManifest}; cannot tell whether the release is current.`);
  } else if (readFileSync(distManifest, "utf8") !== embeddedText) {
    problems.push(
      "The release was not built from the current build: its manifest differs from dist/build-manifest.json. " +
        "It is stale — rebuild the release.",
    );
  }
  if (installer && embedded.builtAt && statSync(installer).mtimeMs + 1000 < Date.parse(embedded.builtAt)) {
    problems.push("The installer is older than the build it claims to contain.");
  }

  // Notices: shipped, and the ones this build wrote (item 33).
  const notices = join(resources, "THIRD_PARTY_NOTICES.txt");
  if (!existsSync(notices)) {
    problems.push("The release ships no THIRD_PARTY_NOTICES.txt.");
  } else if (embedded.dependencies?.noticesSha256 && sha256(readFileSync(notices)) !== embedded.dependencies.noticesSha256) {
    problems.push("THIRD_PARTY_NOTICES.txt differs from the notices this build wrote.");
  } else if (!embedded.dependencies?.noticesSha256) {
    problems.push("The build manifest records no notices; run `npm run notices` before the manifest.");
  }

  // 3. Intact — collect every native file first, so one probe call covers them.
  const native = [];
  const nativeRecorded = new Map();
  // ffmpeg is optional in a development package, so it is checked whenever
  // the build recorded it or the folder holds anything: a binary placed there
  // after the build is "not in the build", never silently accepted.
  const ffmpegFolder = join(resources, "ffmpeg");
  const shipsFfmpeg = Boolean(embedded.installed?.ffmpeg) || (existsSync(ffmpegFolder) && readdirSync(ffmpegFolder).length > 0);
  for (const payload of [...PAYLOADS, ...(shipsFfmpeg ? ["ffmpeg"] : [])]) {
    const recorded = embedded.installed?.[payload];
    const folder = join(resources, payload);
    const summary = { files: 0, missing: [], added: [], changed: [], nativeChanged: [] };
    report.payloads[payload] = summary;
    if (!recorded) {
      problems.push(`The manifest records no files for ${payload}.`);
      continue;
    }
    const present = existsSync(folder) ? new Map([...walk(folder)].map((file) => [posix(folder, file), file])) : new Map();
    summary.files = present.size;
    for (const [name, hash] of Object.entries(recorded)) {
      const file = present.get(name);
      if (!file) {
        summary.missing.push(name);
        continue;
      }
      const actual = sha256(readFileSync(file));
      const isNative = NATIVE.has(extname(name).toLowerCase());
      if (isNative) {
        native.push(file);
        nativeRecorded.set(file, actual === hash);
      }
      if (actual !== hash) (isNative ? summary.nativeChanged : summary.changed).push(name);
    }
    for (const name of present.keys()) if (!(name in recorded)) summary.added.push(name);
    if (summary.missing.length) problems.push(`${payload}: ${summary.missing.length} file(s) missing, e.g. ${summary.missing[0]}.`);
    if (summary.added.length) problems.push(`${payload}: ${summary.added.length} file(s) not in the build, e.g. ${summary.added[0]}.`);
    if (summary.changed.length) problems.push(`${payload}: ${summary.changed.length} file(s) differ from the build, e.g. ${summary.changed[0]}.`);
  }

  // Every other native file anywhere in the app folder — Electron's DLLs,
  // electron-builder's `resources/elevate.exe` — so nothing executable ships
  // uninventoried. Their build-time bytes are not recorded, so an unsigned one
  // is listed rather than judged.
  const seen = new Set(native);
  for (const file of walk(unpacked)) {
    if (!seen.has(file) && NATIVE.has(extname(file).toLowerCase())) native.push(file);
  }

  // 4. Signed.
  const ours = [
    ...(installer ? [installer] : []),
    join(unpacked, "Deckastra.exe"),
    join(resources, "sidecar", "deckastra-service.exe"),
  ];
  for (const file of ours) if (!existsSync(file)) problems.push(`Expected executable is missing: ${file}.`);

  // 5. ffmpeg, when shipped, is an LGPL build that can do the export's job,
  // and it is signed like our own executables: the installer distributes it.
  // Its absence is not a failure, only a release without MP4 export.
  const ffmpeg = join(resources, "ffmpeg", "ffmpeg.exe");
  if (existsSync(ffmpeg)) {
    const { problems: ffmpegProblems, warnings } = auditFfmpeg(ffmpegProbe(ffmpeg));
    report.ffmpeg = { present: true, file: posix(releaseDir, ffmpeg), warnings };
    for (const problem of ffmpegProblems) problems.push(`${posix(releaseDir, ffmpeg)}: ${problem}`);
    ours.push(ffmpeg);
  } else {
    report.ffmpeg = { present: false };
  }
  const statuses = probe([...new Set([...ours.filter(existsSync), ...native])]);

  for (const file of ours.filter(existsSync)) {
    const status = statuses.get(file) ?? { status: "Unknown" };
    const fromPublisher = status.status === "Valid" && (!publisher || (status.subject ?? "").includes(publisher));
    report.signatures.push({ file: posix(releaseDir, file), ours: true, ...status });
    if (nativeRecorded.get(file) === false && status.status !== "Valid") {
      // In any mode: a changed executable with no valid signature is a swap.
      problems.push(`${posix(releaseDir, file)} differs from the build and carries no valid signature.`);
    } else if (!fromPublisher && requireSigned) {
      problems.push(
        status.status === "Valid"
          ? `${posix(releaseDir, file)} is signed by "${status.subject}", not by ${publisher}.`
          : `${posix(releaseDir, file)} is not validly signed (${status.status}).`,
      );
    }
  }
  for (const file of native) {
    if (ours.includes(file)) continue;
    const status = statuses.get(file) ?? { status: "Unknown" };
    report.signatures.push({ file: posix(releaseDir, file), ours: false, ...status });
    const unchanged = nativeRecorded.get(file);
    if (status.status === "Valid") continue;
    if (unchanged === false) {
      // Changed since the build and not validly signed: not a signature, a swap.
      problems.push(`${posix(releaseDir, file)} differs from the build and carries no valid signature.`);
    } else {
      report.unsignedThirdParty.push(posix(releaseDir, file));
    }
  }

  return { ok: problems.length === 0, problems, report };
}

/** Authenticode status for many files in one PowerShell call. */
export function authenticodeProbe(paths) {
  const result = new Map();
  if (paths.length === 0) return result;
  if (process.platform !== "win32") {
    for (const path of paths) result.set(path, { status: "Unsupported" });
    return result;
  }
  const list = paths.map((path) => `'${path.replace(/'/g, "''")}'`).join(",");
  const script =
    `$ErrorActionPreference='SilentlyContinue'; @(${list}) | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; ` +
    `[pscustomobject]@{ Path = $_; Status = [string]$s.Status; Subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' } } } | ConvertTo-Json -Compress`;
  let out = "[]";
  try {
    out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    for (const path of paths) result.set(path, { status: `ProbeFailed: ${String(error.message ?? error).slice(0, 120)}` });
    return result;
  }
  const parsed = JSON.parse(out.trim() || "[]");
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) result.set(row.Path, { status: row.Status || "Unknown", subject: row.Subject || "" });
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const requireSigned = process.env.DECKASTRA_RELEASE === "1";
  const { buildManifest } = await import("./manifest.mjs");
  const { ok, problems, report } = verifyRelease({
    releaseDir: join(DESKTOP, "release"),
    distManifest: join(DESKTOP, "dist", "build-manifest.json"),
    current: buildManifest(),
    probe: authenticodeProbe,
    publisher: process.env.DECKASTRA_SIGNING_PUBLISHER,
    requireSigned,
  });
  const signed = report.signatures.filter((row) => row.status === "Valid").length;
  console.log(
    `[verify-release] installer: ${report.installer ? `${report.installer.sha256} (${report.installer.bytes} bytes)` : "none"}\n` +
      `[verify-release] native files: ${report.signatures.length}, validly signed: ${signed}, ` +
      `unsigned but unchanged third-party: ${report.unsignedThirdParty.length}`,
  );
  console.log(
    report.ffmpeg?.present
      ? `[verify-release] ffmpeg: ${report.ffmpeg.file}${report.ffmpeg.warnings.length ? ` (${report.ffmpeg.warnings.length} note(s))` : ""}`
      : "[verify-release] ffmpeg: not shipped; this build cannot export MP4.",
  );
  for (const warning of report.ffmpeg?.warnings ?? []) console.log(`[verify-release] note: ${warning}`);
  for (const row of report.signatures.filter((entry) => entry.ours)) {
    console.log(`[verify-release] ${row.status === "Valid" ? "signed  " : "UNSIGNED"} ${row.file} ${row.subject ?? ""}`);
  }
  for (const problem of problems) console.error(`[verify-release] ${problem}`);
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  if (!ok) {
    console.error(requireSigned ? "[verify-release] Refusing to call this a release." : "[verify-release] Not releasable (report mode).");
    process.exitCode = 1;
  }
}
