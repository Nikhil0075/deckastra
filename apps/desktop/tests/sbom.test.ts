import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildSbom, parseLock } from "../scripts/sbom.mjs";

/**
 * What ships, listed with the hashes the build verified (final package review,
 * item 09). The lock is the source of truth for the service's dependencies, so
 * these check the list is read from it rather than from whatever is installed.
 */

const DESKTOP = join(import.meta.dirname, "..");
const LOCK = join(DESKTOP, "sidecar-requirements.lock");

describe("the dependency lock", () => {
  const text = readFileSync(LOCK, "utf8");
  const entries = parseLock(text);

  it("pins every package to one version", () => {
    expect(entries.length).toBeGreaterThan(50);
    for (const entry of entries) expect(entry.version).toMatch(/^\d/);
  });

  it("carries hashes for all of them, which is what makes the install verifiable", () => {
    const without = entries.filter((entry) => entry.hashes.length === 0);
    expect(without.map((entry) => entry.name)).toEqual([]);
  });

  it("names the freezer, because it decides what the binary carries", () => {
    expect(entries.map((entry) => entry.name.toLowerCase())).toContain("pyinstaller");
  });
});

describe("the SBOM", () => {
  const sbom = buildSbom();

  it("is CycloneDX, and says which build it describes", () => {
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.5");
    expect(sbom.metadata.component.version).toBe(
      JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")).version,
    );
  });

  it("lists the service's dependencies with the hashes pip verified", () => {
    const python = sbom.components.filter((component) => component.purl.startsWith("pkg:pypi/"));
    expect(python.length).toBeGreaterThan(50);
    for (const component of python) {
      const hashes = component.hashes ?? [];
      expect(hashes.length).toBeGreaterThan(0);
      expect(hashes[0]!.alg).toBe("SHA-256");
    }
    expect(python.map((component) => component.name.toLowerCase())).toContain("fastapi");
  });

  it("lists the JavaScript the bundles were built from", () => {
    const npm = sbom.components.filter((component) => component.purl.startsWith("pkg:npm/"));
    expect(npm.length).toBeGreaterThan(0);
  });

  it("gives every component a name, a version and a package URL", () => {
    for (const component of sbom.components) {
      expect(component.name).toBeTruthy();
      expect(component.version).toBeTruthy();
      expect(component.purl).toContain(component.version);
    }
  });
});
