import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseLock } from "../scripts/sbom.mjs";
import { sidecarLockFile, sidecarLockName, WINDOWS_LOCK } from "../scripts/sidecar-lock.mjs";

/**
 * Which lock the frozen service is built from. The build, the SBOM, the notices
 * and the manifest all ask this one function, so they cannot describe different
 * locks; these hold it to the answer the Windows release has always had.
 */

const DESKTOP = join(import.meta.dirname, "..");

describe("which lock the frozen service is built from", () => {
  it.each(["x64", "arm64", "ia32"])("is the original lock on Windows %s, as it always was", (arch) => {
    expect(sidecarLockName("win32", arch)).toBe("sidecar-requirements.lock");
    expect(WINDOWS_LOCK).toBe("sidecar-requirements.lock");
  });

  it("is the original lock on Linux, where CI reads it without freezing from it", () => {
    expect(sidecarLockName("linux", "x64")).toBe("sidecar-requirements.lock");
  });

  it("is a lock of its own on Apple silicon", () => {
    expect(sidecarLockName("darwin", "arm64")).toBe("sidecar-requirements.macos-arm64.lock");
  });

  it("refuses an Intel Mac rather than handing it the Windows lock", () => {
    expect(() => sidecarLockName("darwin", "x64")).toThrow(/macOS x64.*piptools compile/s);
  });

  it("joins the name onto the desktop package", () => {
    expect(sidecarLockFile(DESKTOP, "darwin", "arm64")).toBe(join(DESKTOP, "sidecar-requirements.macos-arm64.lock"));
  });
});

describe.each([
  ["Windows", "win32", "x64"],
  ["macOS arm64", "darwin", "arm64"],
])("the %s lock", (_name, platform, arch) => {
  const file = sidecarLockFile(DESKTOP, platform, arch);
  const entries = existsSync(file) ? parseLock(readFileSync(file, "utf8")) : [];
  const names = entries.map((entry) => entry.name.toLowerCase());

  it("is committed and pins every package, with hashes", () => {
    expect(existsSync(file)).toBe(true);
    expect(entries.length).toBeGreaterThan(50);
    expect(entries.filter((entry) => entry.hashes.length === 0).map((entry) => entry.name)).toEqual([]);
    expect(names).toContain("pyinstaller");
  });

  it("carries the freezer's own platform dependencies, and not the other platform's", () => {
    if (platform === "darwin") {
      expect(names).toContain("macholib");
      expect(names).not.toContain("pefile");
      expect(names).not.toContain("pywin32-ctypes");
    } else {
      expect(names).toContain("pefile");
      expect(names).not.toContain("macholib");
    }
  });
});
