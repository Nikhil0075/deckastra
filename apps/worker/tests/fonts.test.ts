import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { newId } from "@deckastra/presentation-schema";
import { expect, it } from "vitest";

import { AssetLibrary } from "../src/assets";
import { bundledFamiliesUsed, fontsNotEmbedded, pageFontCss } from "../src/fonts";

/**
 * The render page declares every face a deck uses, from `data:` URLs, because
 * it has no network and the bundled families are installed nowhere
 * (Design tab review, 2026-09-26).
 */

function deckIn(family: string) {
  const document = structuredClone(loadFixture("technical"));
  (document.theme.typography as unknown as Record<string, { fontFamily: string }>).h1!.fontFamily = family;
  return document;
}

it("embeds the bundled families a deck names, Latin subsets only, with no URL left to fetch", async () => {
  const document = deckIn("Playfair Display");
  expect(bundledFamiliesUsed(document).map((font) => font.family)).toEqual(expect.arrayContaining(["Inter", "Playfair Display"]));

  const css = await pageFontCss(document, new AssetLibrary());
  expect(css).toContain("font-family: 'Playfair Display Variable'");
  expect(css).toContain("url(data:font/woff2;base64,");
  // Nothing relative survives: the render page aborts every non-data request.
  expect(css).not.toMatch(/url\(\.\//);
  expect(css).not.toContain("cyrillic");
  // `swap` would let a capture catch the fallback.
  expect(css).not.toContain("swap");
});

it("declares an uploaded face from the bytes the library accepted, and names one it did not get", async () => {
  const document = deckIn("Acme Sans");
  const id = newId("ast");
  document.assets.push({ id, type: "font", storageKey: "k/acme.woff2", fontFamily: "Acme Sans", mimeType: "font/woff2" } as never);

  const supplied = new AssetLibrary([{ assetId: id, storageKey: "k/acme.woff2", mimeType: "font/woff2", data: "d09GMgABAAAAAA==" }]);
  expect(await pageFontCss(document, supplied)).toContain('font-family:"Acme Sans";src:url("data:font/woff2;base64,d09GMgABAAAAAA==")');
  // A font is not a picture: PowerPoint does not get it as media.
  expect(supplied.images().size).toBe(0);

  const refused = new AssetLibrary([{ assetId: id, problem: "its stored bytes could not be read" }]);
  expect(await pageFontCss(document, refused)).not.toContain("Acme Sans");
  const slide = { slideId: "sld_x", fontFaces: [{ family: "Acme Sans", assetId: id }], nodes: [] } as never;
  expect(refused.problems([slide])).toEqual([
    expect.objectContaining({ feature: `font:${id}`, action: "approximated", message: expect.stringContaining("fallback") }),
  ]);
});

it("tells a PowerPoint recipient which fonts are named and not carried", () => {
  const warnings = fontsNotEmbedded(deckIn("Lora"));
  expect(warnings.map((warning) => warning.feature)).toContain("font:Lora");
  expect(warnings.every((warning) => warning.action === "approximated")).toBe(true);
});
