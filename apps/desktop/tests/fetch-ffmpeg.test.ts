import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — plain JavaScript build script, checked by these tests.
import { fetchPinned, verifyPinned } from "../scripts/fetch-ffmpeg.mjs";
// @ts-expect-error — plain JavaScript build script, checked by these tests.
import { ffmpegComponent } from "../scripts/notices.mjs";
// @ts-expect-error — plain JavaScript build script, checked by these tests.
import { verifyRelease } from "../scripts/verify-release.mjs";

/**
 * The installer ships one audited ffmpeg (ffmpeg.lock.json). These hold the
 * build to exactly those bytes, and its notices to that build's licence.
 */

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const pin = (bytes: string) => ({ object: "gs://bucket/file", generation: "1", sha256: sha(bytes), bytes: Buffer.byteLength(bytes) });
let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));
const scratch = () => (root = mkdtempSync(join(tmpdir(), "ffmpeg-pin-")));

describe("fetching the pinned ffmpeg", () => {
  it("accepts only the pinned bytes", () => {
    const dir = scratch();
    const file = join(dir, "ffmpeg.exe");
    writeFileSync(file, "MZ audited");
    expect(verifyPinned(file, pin("MZ audited"))).toBeNull();
    expect(verifyPinned(file, pin("MZ another"))).toMatch(/SHA-256/);
    expect(verifyPinned(file, pin("MZ a longer binary"))).toMatch(/size/);
    expect(verifyPinned(join(dir, "absent.exe"), pin("x"))).toBe("missing");
  });

  it("fetches into place and does not fetch again what already verifies", () => {
    const dir = scratch();
    const lock = { files: { "ffmpeg.exe": pin("MZ audited"), "LICENSE.txt": pin("LGPL-3.0") } };
    const copies: string[] = [];
    const bodies: Record<string, string> = { "ffmpeg.exe": "MZ audited", "LICENSE.txt": "LGPL-3.0" };
    const copy = (name: string, _pin: unknown, target: string) => { copies.push(name); writeFileSync(target, bodies[name]!); };
    expect(fetchPinned({ lock, destination: dir, copy })).toEqual({ "ffmpeg.exe": "fetched", "LICENSE.txt": "fetched" });
    expect(fetchPinned({ lock, destination: dir, copy })).toEqual({ "ffmpeg.exe": "verified", "LICENSE.txt": "verified" });
    expect(copies).toEqual(["ffmpeg.exe", "LICENSE.txt"]);
  });

  it("refuses bytes that are not the pinned ones and leaves nothing behind", () => {
    const dir = scratch();
    const lock = { files: { "ffmpeg.exe": pin("MZ audited") } };
    const copy = (_name: string, _pin: unknown, target: string) => writeFileSync(target, "MZ swapped!");
    expect(() => fetchPinned({ lock, destination: dir, copy })).toThrow(/does not match ffmpeg\.lock\.json/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("replaces a stale copy rather than trusting it", () => {
    const dir = scratch();
    writeFileSync(join(dir, "ffmpeg.exe"), "MZ older build");
    const lock = { files: { "ffmpeg.exe": pin("MZ audited") } };
    fetchPinned({ lock, destination: dir, copy: (_n: string, _p: unknown, target: string) => writeFileSync(target, "MZ audited") });
    expect(verifyPinned(join(dir, "ffmpeg.exe"), lock.files["ffmpeg.exe"])).toBeNull();
  });
});

describe("ffmpeg in the third-party notices", () => {
  const lockFile = () => {
    const file = join(root, "ffmpeg.lock.json");
    writeFileSync(file, JSON.stringify({
      version: "n9.0.2-24-gfd5d616c29", build: "BtbN win64-lgpl", license: "LGPL-3.0-or-later",
      source: { ffmpeg: "https://git.ffmpeg.org/gitweb/ffmpeg.git/commit/fd5d616c29", buildScripts: "https://github.com/BtbN/FFmpeg-Builds" },
    }));
    return file;
  };

  it("names the version, the licence text and where the source is", () => {
    const dir = join(scratch(), "ffmpeg");
    mkdirSync(dir);
    writeFileSync(join(dir, "ffmpeg.exe"), "MZ");
    writeFileSync(join(dir, "LICENSE.txt"), "GNU LESSER GENERAL PUBLIC LICENSE Version 3");
    const { component, problems } = ffmpegComponent(dir, lockFile());
    expect(problems).toEqual([]);
    expect(component).toMatchObject({ name: "ffmpeg", version: "n9.0.2-24-gfd5d616c29", license: "LGPL-3.0-or-later" });
    const text = component.texts.map((entry: { text: string }) => entry.text).join("\n");
    expect(text).toContain("Version 3");
    expect(text).toContain("git.ffmpeg.org");
  });

  it("refuses a packaged ffmpeg without its licence", () => {
    const dir = join(scratch(), "ffmpeg");
    mkdirSync(dir);
    writeFileSync(join(dir, "ffmpeg.exe"), "MZ");
    expect(ffmpegComponent(dir, lockFile()).problems.join(" ")).toMatch(/LICENSE\.txt/);
  });

  it("says nothing when the package carries no ffmpeg", () => {
    expect(ffmpegComponent(join(scratch(), "absent"), "unused")).toEqual({ component: null, problems: [] });
  });
});

describe("the release gate and a binary added after the build", () => {
  it("refuses an ffmpeg the build manifest never recorded", () => {
    const release = join(scratch(), "release");
    const unpacked = join(release, "win-unpacked");
    const resources = join(unpacked, "resources");
    const files: Record<string, Record<string, string>> = {
      worker: { "cli.mjs": "export {}\n" }, mcp: { "cli.mjs": "export const mcp = 1;\n" }, sidecar: { "deckastra-service.exe": "MZ service" },
    };
    const installed: Record<string, Record<string, string>> = {};
    for (const [payload, entries] of Object.entries(files)) {
      installed[payload] = {};
      for (const [name, body] of Object.entries(entries)) {
        mkdirSync(join(resources, payload), { recursive: true });
        writeFileSync(join(resources, payload, name), body);
        installed[payload]![name] = sha(body);
      }
    }
    // Not in `installed`: placed after the build.
    mkdirSync(join(resources, "ffmpeg"), { recursive: true });
    writeFileSync(join(resources, "ffmpeg", "ffmpeg.exe"), "MZ dropped in");
    writeFileSync(join(unpacked, "Deckastra.exe"), "MZ app");
    writeFileSync(join(resources, "THIRD_PARTY_NOTICES.txt"), "notices");
    const manifest = JSON.stringify({ builtAt: new Date(Date.now() - 60_000).toISOString(), complete: true, installed,
      source: { commit: "abc" }, dependencies: { noticesSha256: sha("notices") } });
    writeFileSync(join(resources, "build-manifest.json"), manifest);
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "build-manifest.json"), manifest);
    writeFileSync(join(release, "Deckastra-0.9.0-win-x64.exe"), "MZ installer");
    const result = verifyRelease({
      releaseDir: release, distManifest: join(root, "dist", "build-manifest.json"), publisher: "CN=Test", requireSigned: false,
      probe: (paths: string[]) => new Map(paths.map((path) => [path, { status: "Valid", subject: "CN=Test" }])),
      ffmpegProbe: () => ({ buildconf: "configuration: --enable-version3", encoders: " V....D h264_mf  x\n A....D aac  y" }),
    });
    expect(result.problems.join(" ")).toMatch(/records no files for ffmpeg/);
    expect(existsSync(join(resources, "ffmpeg", "ffmpeg.exe"))).toBe(true);
  });
});
