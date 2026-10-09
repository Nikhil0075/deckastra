import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Is this ffmpeg one a desktop installer may ship?
 *
 * The installer hands ffmpeg to every user, so it must be an LGPL build: no
 * `--enable-gpl` (that brings libx264 and makes the whole app's distribution
 * subject to the GPL) and no `--enable-nonfree` (not redistributable at all).
 * It must also be able to do the job the exporter gives it: write H.264 through
 * Windows Media Foundation (`h264_mf`) with ffmpeg's built-in AAC encoder. The
 * worker's encoder choice (`apps/worker/src/video.ts`) relies on exactly that.
 *
 * Both facts are read from the binary, never assumed from a download page.
 */
export function auditFfmpeg({ buildconf, encoders }) {
  const problems = [];
  const warnings = [];
  const flags = new Set(buildconf.split(/\s+/).map((flag) => flag.trim()).filter(Boolean));
  if (!buildconf.includes("configuration:")) problems.push("ffmpeg did not report its build configuration (-buildconf).");
  for (const flag of ["--enable-gpl", "--enable-nonfree"]) {
    if (flags.has(flag)) problems.push(`ffmpeg was built with ${flag}; a desktop installer may ship only an LGPL build.`);
  }
  if (flags.has("--enable-libopenh264")) {
    // Allowed by the licence, but compiled-in OpenH264 is outside Cisco's
    // royalty coverage. The worker never selects it; say so in the report.
    warnings.push(
      "ffmpeg includes libopenh264. Export never selects it (Cisco's patent coverage applies only to its own " +
        "separately downloaded binary), so it is unused weight rather than a licence problem.",
    );
  }
  const names = new Set();
  for (const line of encoders.split(/\r?\n/)) {
    const match = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
    if (match && match[1] !== "=") names.add(match[1]);
  }
  if (!names.has("h264_mf")) problems.push("ffmpeg has no h264_mf (Windows Media Foundation) encoder; MP4 export would fail.");
  if (!names.has("aac")) problems.push("ffmpeg has no built-in aac encoder; MP4 export would fail.");
  if (names.has("libx264")) problems.push("ffmpeg includes libx264, which is GPL; a desktop installer may not ship it.");
  return { problems, warnings };
}

/** Ask the binary itself. */
export function probeFfmpeg(path) {
  const run = (args) => {
    const result = spawnSync(path, args, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    return `${result.stdout}\n${result.stderr}`;
  };
  return { buildconf: run(["-hide_banner", "-buildconf"]), encoders: run(["-hide_banner", "-encoders"]) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/check-ffmpeg.mjs <path to ffmpeg.exe>");
    process.exit(2);
  }
  const { problems, warnings } = auditFfmpeg(probeFfmpeg(path));
  for (const warning of warnings) console.warn(`[check-ffmpeg] note: ${warning}`);
  for (const problem of problems) console.error(`[check-ffmpeg] ${problem}`);
  if (problems.length) process.exitCode = 1;
  else console.log("[check-ffmpeg] LGPL build with h264_mf and aac: suitable for the desktop installer.");
}
