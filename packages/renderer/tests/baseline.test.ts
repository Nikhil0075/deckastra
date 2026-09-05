import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import { buildDocumentScene } from "../src/scene";
import { documentDigest } from "../src/digest";

/**
 * The visual-regression gate (doc 04 §34).
 *
 * Each seed deck's resolved scene is written out as a readable digest and
 * committed. A change to geometry, colour, text metrics, chart marks, diagram
 * layout, paint order or font resolution moves a line here, and the diff says
 * which node moved and how.
 *
 * Regenerate deliberately, never reflexively:
 *
 *   UPDATE_BASELINES=1 npx vitest run tests/baseline.test.ts
 *
 * A baseline updated without reading the diff is a gate that has been turned
 * off while still appearing to be on — which is worse than not having one.
 *
 * **What this does not cover.** It digests the scene, not pixels. It cannot see
 * a bug that lives purely in the React emit step or in the browser's painting of
 * it. Those need the headless render service (Phase 8); until then this is the
 * gate and that is its limit.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, "..", "baselines");

const FIXTURES = ["technical", "repository", "animation"] as const;

// Fonts are pinned rather than probed. In Node there is nothing to probe, but
// saying so explicitly means the baseline cannot start depending on where it ran.
const FONTS = { available: new Set<string>(), unknown: true };

describe("scene baselines", () => {
  for (const name of FIXTURES) {
    it(`${name} matches its committed baseline`, () => {
      const digest = documentDigest(buildDocumentScene(loadFixture(name), { fonts: FONTS }));
      const path = join(BASELINES, `${name}.digest.txt`);

      if (process.env.UPDATE_BASELINES === "1") {
        mkdirSync(BASELINES, { recursive: true });
        writeFileSync(path, `${digest}\n`, "utf8");
        return;
      }

      expect(existsSync(path), `Missing baseline ${path}. Run with UPDATE_BASELINES=1.`).toBe(true);

      const expected = readFileSync(path, "utf8").replace(/\r\n/g, "\n").trimEnd();
      expect(digest).toBe(expected);
    });
  }

  it("builds the same scene twice", () => {
    // The prerequisite for a baseline meaning anything. If this fails, the
    // baseline comparisons above are noise.
    for (const name of FIXTURES) {
      const document = loadFixture(name);
      expect(documentDigest(buildDocumentScene(document, { fonts: FONTS }))).toBe(
        documentDigest(buildDocumentScene(document, { fonts: FONTS })),
      );
    }
  });
});
