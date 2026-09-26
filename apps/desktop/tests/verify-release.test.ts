import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — plain JavaScript build script, checked by these tests.
import { verifyRelease } from "../scripts/verify-release.mjs";

/**
 * The release gate (register items 11–12, MA-34), against a release folder built
 * here file by file, with the signature probe injected. Every refusal below is a
 * release a person could otherwise have shipped.
 */

const PUBLISHER = "CN=Deckastra Test Publisher";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
let root: string;

afterEach(() => rmSync(root, { recursive: true, force: true }));

function build(overrides: { extraInstaller?: boolean } = {}) {
  root = mkdtempSync(join(tmpdir(), "verify-release-"));
  const release = join(root, "release");
  const unpacked = join(release, "win-unpacked");
  const resources = join(unpacked, "resources");
  const files: Record<string, Record<string, string>> = {
    worker: { "cli.mjs": "export {}\n" },
    mcp: { "cli.mjs": "export const mcp = 1;\n" },
    sidecar: { "deckastra-service.exe": "MZ service", "_internal/python313.dll": "MZ python" },
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
    builtAt: new Date(Date.now() - 60_000).toISOString(),
    complete: true,
    installed,
    source: { commit: "abc" },
    dependencies: { noticesSha256: sha("notices") },
  });
  writeFileSync(join(resources, "build-manifest.json"), manifest);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "build-manifest.json"), manifest);
  writeFileSync(join(release, "Deckastra-0.9.0-win-x64.exe"), "MZ installer");
  if (overrides.extraInstaller) {
    const old = join(release, "Deckastra-0.0.0-win-x64.exe");
    writeFileSync(old, "MZ old");
    utimesSync(old, new Date(0), new Date(0));
  }
  return { release, resources, unpacked, distManifest: join(root, "dist", "build-manifest.json") };
}

/** Everything of ours signed by the publisher, third-party DLLs unsigned. */
function signedProbe(unsignedOurs: string[] = []) {
  return (paths: string[]) =>
    new Map(
      paths.map((path) => {
        const ours = /Deckastra.*\.exe$|deckastra-service\.exe$/.test(path);
        if (ours && !unsignedOurs.some((name) => path.endsWith(name))) return [path, { status: "Valid", subject: PUBLISHER }];
        return [path, { status: "NotSigned", subject: "" }];
      }),
    );
}

function verify(release: ReturnType<typeof build>, probe = signedProbe()) {
  return verifyRelease({ releaseDir: release.release, distManifest: release.distManifest, probe, publisher: PUBLISHER, requireSigned: true });
}

describe("the release gate", () => {
  it("passes a current, intact release whose own executables are signed, listing unsigned third-party libraries", () => {
    const result = verify(build());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.report.unsignedThirdParty).toEqual(["win-unpacked/resources/sidecar/_internal/python313.dll"]);
    expect(result.report.installer.sha256).toBe(sha("MZ installer"));
  });

  it("refuses an unsigned service executable", () => {
    const result = verify(build(), signedProbe(["deckastra-service.exe"]));
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/deckastra-service\.exe is not validly signed/);
  });

  it("refuses a signature from someone else", () => {
    const release = build();
    const probe = (paths: string[]) => new Map(paths.map((path) => [path, { status: "Valid", subject: "CN=Somebody Else" }]));
    expect(verify(release, probe).problems.join("\n")).toMatch(/not by CN=Deckastra Test Publisher/);
  });

  it("refuses a swapped service binary, and a tampered bundle, even in report mode", () => {
    const release = build();
    writeFileSync(join(release.resources, "sidecar", "deckastra-service.exe"), "MZ something else");
    writeFileSync(join(release.resources, "worker", "cli.mjs"), "fetch('https://evil.example')\n");
    const result = verifyRelease({
      releaseDir: release.release,
      distManifest: release.distManifest,
      probe: signedProbe(["deckastra-service.exe"]),
      publisher: PUBLISHER,
      requireSigned: false,
    });
    const text = result.problems.join("\n");
    expect(text).toMatch(/deckastra-service\.exe differs from the build and carries no valid signature/);
    expect(text).toMatch(/worker: 1 file\(s\) differ from the build/);
  });

  it("allows a native file changed by signing, when the signature is valid", () => {
    const release = build();
    writeFileSync(join(release.resources, "sidecar", "deckastra-service.exe"), "MZ service + signature");
    expect(verify(release).ok).toBe(true);
  });

  it("refuses a changed third-party library without a valid signature", () => {
    const release = build();
    writeFileSync(join(release.resources, "sidecar", "_internal", "python313.dll"), "MZ injected");
    expect(verify(release).problems.join("\n")).toMatch(/python313\.dll differs from the build/);
  });

  it("refuses added and missing files", () => {
    const release = build();
    writeFileSync(join(release.resources, "mcp", "extra.mjs"), "x");
    rmSync(join(release.resources, "worker", "cli.mjs"));
    const text = verify(release).problems.join("\n");
    expect(text).toMatch(/mcp: 1 file\(s\) not in the build/);
    expect(text).toMatch(/worker: 1 file\(s\) missing/);
  });

  it("refuses a stale release: one whose manifest is not the current build's", () => {
    const release = build();
    writeFileSync(release.distManifest, JSON.stringify({ builtAt: new Date().toISOString(), complete: true, installed: {} }));
    expect(verify(release).problems.join("\n")).toMatch(/stale/);
  });

  it("refuses a release older than the build now in dist, even when the dist manifest was not rewritten", () => {
    const release = build();
    const embedded = { payloads: { app: { sha256: "old" } }, source: { commit: "abc", treeSha256: "t1" }, migrations: { sha256: "m" } };
    const manifest = JSON.parse(readFileSync(join(release.resources, "build-manifest.json"), "utf8"));
    writeFileSync(join(release.resources, "build-manifest.json"), JSON.stringify({ ...manifest, ...embedded }));
    const result = verifyRelease({
      releaseDir: release.release,
      distManifest: release.distManifest,
      current: { payloads: { app: { sha256: "new" } }, source: { commit: "abc", treeSha256: "t1" }, migrations: { sha256: "m" } },
      probe: signedProbe(),
      publisher: PUBLISHER,
      requireSigned: true,
    });
    expect(result.problems.join(" ")).toMatch(/stale: the app bundle changed/);
    const same = verifyRelease({
      releaseDir: release.release,
      distManifest: release.distManifest,
      current: embedded,
      probe: signedProbe(),
      publisher: PUBLISHER,
      requireSigned: true,
    });
    expect(same.problems.join(" ")).not.toMatch(/stale/);
  });

  it("refuses a folder holding an old installer beside the new one", () => {
    expect(verify(build({ extraInstaller: true })).problems.join("\n")).toMatch(/2 installers/);
  });

  it("refuses a release without its notices, or with notices this build did not write", () => {
    const release = build();
    writeFileSync(join(release.resources, "THIRD_PARTY_NOTICES.txt"), "edited");
    expect(verify(release).problems.join(" ")).toMatch(/differs from the notices this build wrote/);
    rmSync(join(release.resources, "THIRD_PARTY_NOTICES.txt"));
    expect(verify(release).problems.join(" ")).toMatch(/ships no THIRD_PARTY_NOTICES/);
  });

  it("refuses an empty release folder rather than passing on nothing", () => {
    const release = build();
    rmSync(release.release, { recursive: true, force: true });
    const result = verify(release);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/No installer/);
  });
});
