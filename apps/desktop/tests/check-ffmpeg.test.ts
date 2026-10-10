import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — plain JavaScript build script, checked by these tests.
import { auditFfmpeg } from "../scripts/check-ffmpeg.mjs";
// @ts-expect-error — plain JavaScript build script, checked by these tests.
import { verifyRelease } from "../scripts/verify-release.mjs";

/**
 * A desktop installer distributes ffmpeg, so it may ship only an LGPL build
 * that can do what the exporter asks of it (apps/worker/src/video.ts).
 */

const LGPL = "configuration: --target-os=mingw32 --enable-version3 --disable-debug --enable-mediafoundation --enable-libvpx";
const ENCODERS = [
  "Encoders:",
  " V..... = Video",
  " V....D h264_mf              H264 via MediaFoundation (codec h264)",
  " V....D png                  PNG (Portable Network Graphics) image",
  " A....D aac                  AAC (Advanced Audio Coding)",
].join("\r\n");

describe("auditing an ffmpeg for the installer", () => {
  it("accepts an LGPL build with Media Foundation H.264 and built-in AAC", () => {
    expect(auditFfmpeg({ buildconf: LGPL, encoders: ENCODERS })).toEqual({ problems: [], warnings: [] });
  });

  it("refuses a GPL or non-free build", () => {
    for (const flag of ["--enable-gpl", "--enable-nonfree"]) {
      const { problems } = auditFfmpeg({ buildconf: `${LGPL} ${flag}`, encoders: ENCODERS });
      expect(problems.join(" ")).toContain(flag);
    }
  });

  it("refuses libx264 even if the configuration line was not read", () => {
    const { problems } = auditFfmpeg({ buildconf: LGPL, encoders: `${ENCODERS}\r\n V....D libx264              libx264 H.264` });
    expect(problems.join(" ")).toMatch(/libx264/);
  });

  it("refuses a build that cannot write the export's H.264 or AAC", () => {
    const noMf = auditFfmpeg({ buildconf: LGPL, encoders: ENCODERS.replace(/.*h264_mf.*\r\n/, "") }).problems;
    expect(noMf.join(" ")).toMatch(/h264_mf/);
    const noAac = auditFfmpeg({ buildconf: LGPL, encoders: ENCODERS.replace(/.*aac.*$/, "") }).problems;
    expect(noAac.join(" ")).toMatch(/aac/);
  });

  it("notes compiled-in OpenH264 without refusing the build", () => {
    const { problems, warnings } = auditFfmpeg({ buildconf: `${LGPL} --enable-libopenh264`, encoders: ENCODERS });
    expect(problems).toEqual([]);
    expect(warnings.join(" ")).toMatch(/libopenh264/);
  });

  it("refuses a binary that did not report its configuration", () => {
    expect(auditFfmpeg({ buildconf: "", encoders: ENCODERS }).problems.join(" ")).toMatch(/build configuration/);
  });
});

describe("the release gate and ffmpeg", () => {
  const PUBLISHER = "CN=Deckastra Test Publisher";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function release(withFfmpeg: boolean) {
    root = mkdtempSync(join(tmpdir(), "verify-ffmpeg-"));
    const releaseDir = join(root, "release");
    const unpacked = join(releaseDir, "win-unpacked");
    const resources = join(unpacked, "resources");
    const files: Record<string, Record<string, string>> = {
      worker: { "cli.mjs": "export {}\n" },
      mcp: { "cli.mjs": "export const mcp = 1;\n" },
      sidecar: { "deckastra-service.exe": "MZ service", "_internal/packages/deck-presets/media/MANIFEST.json": "{\"media\":[]}" },
      ...(withFfmpeg ? { ffmpeg: { "ffmpeg.exe": "MZ ffmpeg" } } : {}),
    };
    const installed: Record<string, Record<string, string>> = {};
    for (const [payload, entries] of Object.entries(files)) {
      installed[payload] = {};
      for (const [name, body] of Object.entries(entries)) {
        const file = join(resources, payload, name);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, body);
        installed[payload]![name] = sha(body);
      }
    }
    writeFileSync(join(unpacked, "Deckastra.exe"), "MZ app");
    writeFileSync(join(resources, "THIRD_PARTY_NOTICES.txt"), "notices");
    const manifest = JSON.stringify({
      builtAt: new Date(Date.now() - 60_000).toISOString(), complete: true, installed,
      source: { commit: "abc" }, dependencies: { noticesSha256: sha("notices") },
    });
    writeFileSync(join(resources, "build-manifest.json"), manifest);
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "build-manifest.json"), manifest);
    writeFileSync(join(releaseDir, "Deckastra-0.9.0-win-x64.exe"), "MZ installer");
    return { releaseDir, distManifest: join(root, "dist", "build-manifest.json") };
  }

  const signed = (also: RegExp | null = /ffmpeg\.exe$/) => (paths: string[]) =>
    new Map(paths.map((path) => [path,
      /Deckastra.*\.exe$|deckastra-service\.exe$/.test(path) || (also && also.test(path))
        ? { status: "Valid", subject: PUBLISHER } : { status: "NotSigned", subject: "" }]));

  const verify = (built: ReturnType<typeof release>, probe = signed(), ffmpegProbe = () => ({ buildconf: LGPL, encoders: ENCODERS })) =>
    verifyRelease({ releaseDir: built.releaseDir, distManifest: built.distManifest, probe, publisher: PUBLISHER, requireSigned: true, ffmpegProbe });

  it("passes a release without ffmpeg and says MP4 export is unavailable", () => {
    const result = verify(release(false));
    expect(result.problems).toEqual([]);
    expect(result.report.ffmpeg).toEqual({ present: false });
  });

  it("passes a shipped LGPL ffmpeg that is signed", () => {
    const result = verify(release(true));
    expect(result.problems).toEqual([]);
    expect(result.report.ffmpeg.present).toBe(true);
  });

  it("refuses a shipped GPL ffmpeg", () => {
    const result = verify(release(true), signed(), () => ({ buildconf: `${LGPL} --enable-gpl`, encoders: ENCODERS }));
    expect(result.problems.join(" ")).toMatch(/--enable-gpl/);
  });

  it("refuses a shipped ffmpeg that is not signed", () => {
    const result = verify(release(true), signed(null));
    expect(result.problems.join(" ")).toMatch(/ffmpeg\.exe is not validly signed/);
  });
});
