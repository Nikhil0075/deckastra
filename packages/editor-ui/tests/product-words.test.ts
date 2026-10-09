/**
 * No engineering words in the product (roadmap 08 §1.2, rule 4).
 *
 * People see credits, what is sent and what changed. They do not see which
 * model answered, a qualification gate, "local-only", or a budget in dollars to
 * four decimals. This reads the shipped source of both shells and the editor —
 * code, not comments, since a comment explaining a provider is not a string
 * anyone reads — and fails on any such word in a file not yet listed below.
 *
 * `STILL_TO_REMOVE` is a ratchet, not an exemption: each entry is a surface the
 * roadmap removes (§1.4, track 2), and the test also fails when an entry has
 * gone clean, so the list can only shrink. Done when it is empty.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const ROOTS = ["packages/editor-ui/src", "apps/desktop/src/renderer", "apps/web/app", "apps/web/components"];

const WORDS = /\b(anthropic|claude api|gemma|local-only|qualification|qualified model)\b|US\$/i;

// Empty since 2026-10-05: the last surfaces (the own-key field, the provider
// routes) went with track 2. Kept, so a new entry has to be argued for.
const STILL_TO_REMOVE: Record<string, string> = {};

/**
 * Files that name these words in order to keep them off the screen. Not a
 * ratchet: the filter has to know what it filters.
 */
const FILTERS: Record<string, string> = {
  "packages/editor-ui/src/lib/assistant-words.ts": "replaces service sentences that carry these words",
};

function files(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(tsx?|css)$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}

/** Source with comments blanked. Crude, and enough: strings here do not contain comment markers. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * A setting name on screen ("Set GITHUB_APP_ID…") asks a person to configure a
 * server. Matched by prefix and case-sensitively, so code constants such as
 * HEX_COLOR are not mistaken for one.
 */
const SETTING = /\b(DECKASTRA|GITHUB|ANTHROPIC|GOOGLE|VERTEX)_[A-Z0-9_]+/;

const offending = ROOTS.flatMap((root) => files(join(repo, root)))
  .filter((path) => {
    const source = code(readFileSync(path, "utf8"));
    return WORDS.test(source) || SETTING.test(source);
  })
  .map((path) => relative(repo, path).replace(/\\/g, "/"));

describe("product words", () => {
  it("finds the shipped source at all", () => {
    // A path that moved would make the check below pass on nothing.
    expect(ROOTS.flatMap((root) => files(join(repo, root))).length).toBeGreaterThan(50);
  });

  it("puts no engineering words in a surface people read", () => {
    expect(offending.filter((path) => !(path in STILL_TO_REMOVE) && !(path in FILTERS))).toEqual([]);
  });

  it("drops a surface from the to-remove list once it is clean", () => {
    expect(Object.keys(STILL_TO_REMOVE).filter((path) => !offending.includes(path))).toEqual([]);
  });
});
