import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { newId } from "@deckastra/presentation-schema";
import { expect, it } from "vitest";

import { BUNDLED_FONTS, CURATED_FONTS, buildDocumentScene, resolveFontStack } from "../src/index";
import { SlideView } from "../src/react/index";

/**
 * The bundled font library (Design tab review, 2026-09-26) is one list read in
 * three places. These hold the three to it.
 */

it("gives every bundled family a curated entry naming its registered face", () => {
  for (const font of BUNDLED_FONTS) {
    const curated = CURATED_FONTS.find((one) => one.family === font.family);
    expect(curated, font.family).toBeDefined();
    // The stylesheet registers the face name ("Inter Variable"), so a stack that
    // named only the family would fall through to the fallback.
    expect(resolveFontStack(font.family)).toContain(font.face);
  }
});

it("imports every bundled stylesheet in the editor, so the faces are there while editing", () => {
  const styles = readFileSync(new URL("../../editor-ui/src/styles.css", import.meta.url), "utf8");
  for (const font of BUNDLED_FONTS) expect(styles, font.css).toContain(`@import "${font.css}";`);
});

it("declares a deck's uploaded fonts where the slide is drawn, through the asset resolver", () => {
  const document = structuredClone(loadFixture("technical"));
  const id = newId("ast");
  document.assets.push({
    id,
    type: "font",
    storageKey: "workspaces/w/assets/acme.woff2",
    fileName: "acme.woff2",
    mimeType: "font/woff2",
    fontFamily: 'Acme "Sans"',
    fontWeight: "100 900",
  } as never);
  const slide = buildDocumentScene(document).slides[0]!;
  expect(slide.fontFaces).toEqual([
    expect.objectContaining({ family: 'Acme "Sans"', assetId: id, weight: "100 900" }),
  ]);

  const markup = renderToStaticMarkup(
    <SlideView scene={slide} mode="export" resolveAssetUrl={(asset) => (asset === id ? "data:font/woff2;base64,AAAA" : undefined)} />,
  );
  // The quote in the family is removed rather than allowed to end the string.
  expect(markup).toContain('@font-face{font-family:"Acme Sans";src:url("data:font/woff2;base64,AAAA")');

  // No bytes, no rule: the text falls back rather than naming a broken source.
  const without = renderToStaticMarkup(<SlideView scene={slide} mode="export" />);
  expect(without).not.toContain("@font-face");
});
