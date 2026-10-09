import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { dataEntries, missingData } from "../scripts/sidecar-data.mjs";

/**
 * The service binary must carry everything it reads by path (final package
 * review, item 08). Checked against the real repository, and against a copy with
 * one input removed at a time — the failure that used to ship silently.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Each case copies the bundled inputs into a scratch root, which is real
// file work; given room rather than racing the default timeout.
describe("what the frozen service must carry", { timeout: 120_000 }, () => {
  it("is all present in this checkout", () => {
    expect(missingData(dataEntries(ROOT))).toEqual([]);
  });

  it("names each one that is absent", () => {
    const missing = missingData(dataEntries(join(tmpdir(), "deckastra-no-such-root")));
    expect(missing).toHaveLength(dataEntries(ROOT).length);
    expect(missing.join(" ")).toContain("not found");
  });

  it.each([
    ["the migrations", join("infrastructure", "database", "migrations")],
    ["alembic's config", join("infrastructure", "database", "alembic.ini")],
    ["the generated schema", join("packages", "presentation-schema", "generated")],
    ["the generated presets", join("packages", "deck-presets", "generated")],
    ["the bundled font packs", join("packages", "renderer", "font-packs")],
  ])("refuses a build missing %s", (_name, relative) => {
    // A scratch root holding only the bundled inputs, so removing one is the only
    // difference between a build that may ship and one that may not.
    const root = mkdtempSync(join(tmpdir(), "deckastra-sidecar-"));
    for (const [from] of dataEntries(ROOT)) {
      const to = join(root, from.slice(ROOT.length + 1));
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
    }
    expect(missingData(dataEntries(root))).toEqual([]);

    rmSync(join(root, relative), { recursive: true, force: true });
    const missing = missingData(dataEntries(root));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain(relative.split("\\").join("\\"));
    rmSync(root, { recursive: true, force: true });
  });

  it("counts an empty directory as missing, because it ships nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "deckastra-sidecar-"));
    for (const [from] of dataEntries(ROOT)) {
      const to = join(root, from.slice(ROOT.length + 1));
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
    }
    const fontPacks = join(root, "packages", "renderer", "font-packs");
    for (const entry of readdirSync(fontPacks)) rmSync(join(fontPacks, entry), { recursive: true, force: true });

    const missing = missingData(dataEntries(root));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("(empty)");
    rmSync(root, { recursive: true, force: true });
  });

  it("still passes a file that exists and is not a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "deckastra-sidecar-"));
    for (const [from] of dataEntries(ROOT)) {
      const to = join(root, from.slice(ROOT.length + 1));
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
    }
    writeFileSync(join(root, "infrastructure", "database", "alembic.ini"), "[alembic]\n", "utf8");
    expect(missingData(dataEntries(root))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
