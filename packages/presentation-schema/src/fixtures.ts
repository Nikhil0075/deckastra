import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PresentationDocument } from "./document";

/**
 * Access to the seed fixtures for downstream packages.
 *
 * The renderer, the editor, the export adapters and agent evaluation all test
 * against the same three documents (doc 05 §35). Without this, each of them
 * reimplements the same path arithmetic to find the fixture directory, and each
 * one breaks differently when the package layout changes.
 *
 * This module reads from disk, so it is a separate entry point
 * (`@deckastra/presentation-schema/fixtures`). The main entry must stay usable in
 * a browser, where `node:fs` does not exist.
 */

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export const FIXTURE_NAMES = {
  /** Every MVP element type; container layouts. The general renderer and export fixture. */
  technical: "technical-deck.mydeck.json",
  /** Repository-grounded content where every claim carries a provenance record. */
  repository: "repository-context.mydeck.json",
  /** Every MVP trigger, preset shape and reduced-motion path. */
  animation: "animation-test.mydeck.json",
} as const;

export type FixtureName = keyof typeof FIXTURE_NAMES;

/**
 * Load one seed fixture.
 *
 * Returns the raw parsed JSON rather than a validated-and-reconstructed document:
 * fixtures are already known-valid (the build script refuses to write an invalid
 * one), and parsing here would reorder keys and defeat byte-identity comparisons
 * in the tests that consume this.
 */
export function loadFixture(name: FixtureName): PresentationDocument {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, FIXTURE_NAMES[name]), "utf8"),
  ) as PresentationDocument;
}

export function loadAllFixtures(): Record<FixtureName, PresentationDocument> {
  return {
    technical: loadFixture("technical"),
    repository: loadFixture("repository"),
    animation: loadFixture("animation"),
  };
}

/** Absolute paths of every fixture on disk, for tooling that needs the file. */
export function fixturePaths(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".mydeck.json"))
    .sort()
    .map((f) => join(FIXTURE_DIR, f));
}
