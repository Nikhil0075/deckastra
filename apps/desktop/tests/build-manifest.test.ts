import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }));

import { hashTree, buildManifest as readBuildManifest } from "../scripts/manifest.mjs";
import { mismatchedMigrations, type BuildManifest } from "../src/main/build-manifest";

/**
 * What this build is (final package review, item 07): the manifest that records
 * it, and the pairing check that uses it.
 */

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "deckastra-tree-"));
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  return root;
}

describe("hashing a payload", () => {
  it("is the same for the same files, wherever the tree is", () => {
    const first = tree({ "a.py": "one", "sub/b.py": "two" });
    const second = tree({ "a.py": "one", "sub/b.py": "two" });
    expect(hashTree(first)!.sha256).toBe(hashTree(second)!.sha256);
    expect(hashTree(first)!.files).toBe(2);
  });

  it("changes when content, a name or the set of files changes", () => {
    const base = hashTree(tree({ "a.py": "one", "sub/b.py": "two" }))!.sha256;
    expect(hashTree(tree({ "a.py": "one!", "sub/b.py": "two" }))!.sha256).not.toBe(base);
    expect(hashTree(tree({ "a.py": "one", "sub/c.py": "two" }))!.sha256).not.toBe(base);
    expect(hashTree(tree({ "a.py": "one" }))!.sha256).not.toBe(base);
  });

  it("ignores what a build leaves behind, so a rerun hashes the same", () => {
    const root = tree({ "a.py": "one", "__pycache__/a.cpython-312.pyc": "junk" });
    expect(hashTree(root)!.files).toBe(1);
  });

  it("answers null for a payload that was never built", () => {
    expect(hashTree(join(tmpdir(), "deckastra-not-built-at-all"))).toBeNull();
  });
});

// These two build a real manifest, which hashes every payload — the frozen
// service alone is ~950 files — so they are given room rather than racing the
// default timeout on a loaded machine.
describe("the manifest", { timeout: 120_000 }, () => {
  it("names this build, its source and its payloads", () => {
    const manifest = readBuildManifest();
    expect(manifest.app.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.runtime.electron).toMatch(/44\./);
    // Built from a working tree, which is why the commit alone is not identity.
    expect(manifest.source.commit).toMatch(/^[0-9a-f]{40}$/);
    if (manifest.source.dirty) expect(manifest.source.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.migrations!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("says so rather than passing when a payload is missing", () => {
    const partial = { ...readBuildManifest(), payloads: { app: null } } as unknown as BuildManifest;
    expect(Object.values(partial.payloads).every(Boolean)).toBe(false);
  });
});

describe("pairing an app with its service", () => {
  const manifest = (sha256: string) => ({ migrations: { sha256, files: 1 } }) as BuildManifest;

  it("refuses a service built from other migrations", () => {
    expect(mismatchedMigrations(manifest("aaa"), "bbb")).toEqual({ expected: "aaa", found: "bbb" });
  });

  it("accepts its own service", () => {
    expect(mismatchedMigrations(manifest("aaa"), "aaa")).toBeNull();
  });

  it("does not guess where either side says nothing", () => {
    // A checkout has no manifest; an older service reports no digest. Refusing
    // on silence would refuse every development run.
    expect(mismatchedMigrations(null, "bbb")).toBeNull();
    expect(mismatchedMigrations(manifest("aaa"), undefined)).toBeNull();
    expect(mismatchedMigrations(manifest("aaa"), "")).toBeNull();
  });
});
