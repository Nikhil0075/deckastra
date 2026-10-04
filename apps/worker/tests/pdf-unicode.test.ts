import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { glyphText } from "../src/pdf-unicode";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as { create(buffer: Buffer): Parameters<typeof glyphText>[0] & { getGlyph(id: number): { name: string }; numGlyphs: number } };
const file = (pkg: string, name: string) => readFileSync(require.resolve(`@fontsource/${pkg}/files/${name}`));

describe("characters for glyphs the cmap does not name", () => {
  const devanagari = fontkit.create(file("noto-sans-devanagari", "noto-sans-devanagari-devanagari-400-normal.woff2"));
  const text = glyphText(devanagari);

  it("names every width variant of the vowel sign ि as U+093F", () => {
    const variants = Array.from({ length: devanagari.numGlyphs }, (_, id) => id).filter((id) => /^uni093F\.\d+$/.test(devanagari.getGlyph(id).name));
    expect(variants.length).toBeGreaterThan(5); // the loop really looked at something
    for (const id of variants) expect(text.get(id), devanagari.getGlyph(id).name).toBe("ि");
  });

  it("names a conjunct by the letters it joins", () => {
    // Ligature glyphs map to more than one character: क्ष and the rest.
    const ligatures = [...text.values()].filter((value) => [...value].length > 1);
    expect(ligatures.length).toBeGreaterThan(20);
    expect(ligatures).toContain("क्ष"); // क्ष
  });

  it("never overrides what the cmap says", () => {
    expect(text.get(devanagari.glyphForCodePoint(0x0915).id)).toBe("क");
  });
});
