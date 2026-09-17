/**
 * Handing a headless render its pictures (2026-09-17).
 *
 * `apps/worker` passed no `resolveAssetUrl`, so every export drew the renderer's
 * labelled placeholder — a PDF of a deck of photographs arrived with dashed
 * boxes in it, and nothing anywhere said so. The editor's fix does not transfer:
 * it answers either a same-origin path the desktop proxy authenticates or an
 * object URL fetched with a bearer, and the render host has no session, no
 * origin and no network at all.
 *
 * So the bytes are handed in. What this file pins down is the half that decides
 * whether that is safe and honest: a payload is checked rather than trusted, and
 * an image that cannot be drawn is *named* rather than silently becoming a
 * placeholder. The pixels themselves are `assets.browser.test.ts`, because only
 * a real browser can say whether the picture actually arrived.
 */

import { describe, expect, it } from "vitest";
import { buildDocumentScene } from "@deckastra/renderer";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import { AssetLibrary, MAX_INLINE_ASSET_BYTES, neededAssets, type InlineAsset } from "../src/assets";

/** Four bytes of nothing in particular; the library never decodes them. */
const BYTES = "AAECAw==";

function deckWithImage(): PresentationDocument {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  return document;
}

/** The asset the `technical` fixture cites, and the slide it sits on. */
function fixtureImage(): { assetId: string; slideId: string } {
  const document = deckWithImage();
  const scene = buildDocumentScene(document);
  for (const slide of scene.slides) {
    const needed = neededAssets(slide);
    if (needed.length > 0) return { assetId: needed[0]![0], slideId: slide.slideId };
  }
  throw new Error("The technical fixture no longer carries an image element.");
}

describe("what the renderer is handed", () => {
  it("turns supplied bytes into the one URL scheme the render page allows", () => {
    // `render-page.ts` aborts every request that is not a `data:` URL, because a
    // document that could make the render host fetch a URL is an SSRF primitive
    // as well as a source of nondeterminism. So a `data:` URL is not a shortcut
    // here; it is the only thing that can work.
    const library = new AssetLibrary([
      { assetId: "ast_one", storageKey: "workspaces/w/assets/a.png", mimeType: "image/png", data: BYTES },
    ]);

    expect(library.resolve("ast_one")).toBe(`data:image/png;base64,${BYTES}`);
    // By key as well as by id: a slide *background* carries only an `assetId`
    // while an image element carries both, and one payload has to serve both.
    expect(library.resolve("ast_other", "workspaces/w/assets/a.png")).toBe(
      `data:image/png;base64,${BYTES}`,
    );
    expect(library.resolve("ast_missing")).toBeUndefined();
  });

  it("refuses a payload rather than trusting the caller", () => {
    // The caller today is our own API. A resolver that will build a `data:` URL
    // out of whatever it is handed is one malformed row away from putting
    // arbitrary content into a customer's PDF, and the limits have to be the
    // worker's own rather than a promise somebody else keeps.
    const refused: InlineAsset[] = [
      { assetId: "not_image", mimeType: "application/pdf", data: BYTES },
      { assetId: "not_base64", mimeType: "image/png", data: "not base64 at all!!" },
      { assetId: "empty", mimeType: "image/png", data: "" },
      {
        assetId: "huge",
        mimeType: "image/png",
        data: "A".repeat(Math.ceil(((MAX_INLINE_ASSET_BYTES + 1024) * 4) / 3)),
      },
    ];
    // A good one alongside them, because "refuses everything" would pass every
    // assertion below and be a resolver that never draws a picture.
    const library = new AssetLibrary([
      ...refused,
      { assetId: "fine", mimeType: "image/png", data: BYTES },
    ]);

    for (const asset of refused) expect(library.resolve(asset.assetId)).toBeUndefined();
    expect(library.resolve("fine")).toBe(`data:image/png;base64,${BYTES}`);
  });

  it("stops at the total a single render embeds", () => {
    // Per-file alone is not a bound: forty 7MB photographs are forty acceptable
    // files and one page Chromium is asked to parse 280MB of base64 for.
    const oneMeg = "A".repeat(Math.ceil((1024 * 1024 * 4) / 3));
    const many = Array.from({ length: 40 }, (_, index) => ({
      assetId: `ast_${index}`,
      mimeType: "image/png",
      data: oneMeg,
    }));

    const library = new AssetLibrary(many);
    const embedded = many.filter((asset) => library.resolve(asset.assetId) !== undefined);

    expect(embedded.length).toBeGreaterThan(0);
    expect(embedded.length).toBeLessThan(many.length);
  });
});

describe("what the report says about a picture that did not arrive", () => {
  it("names an asset the scene needs and the render was not given", () => {
    // The failure that looks like success: the slide renders, the export
    // finishes, and a dashed box arrives where a photograph should be. Doc 04
    // §32.2 requires the user to see what was degraded *before* they download.
    const { assetId, slideId } = fixtureImage();
    const scene = buildDocumentScene(deckWithImage());

    const warnings = new AssetLibrary().problems(scene.slides);
    const found = warnings.find((warning) => warning.feature === `asset:${assetId}`)!;

    expect(found).toBeDefined();
    expect(found.action).toBe("dropped");
    expect(found.severity).toBe("warning");
    expect(found.slideId).toBe(slideId);
    expect(found.message).toMatch(/not available to the renderer/);
  });

  it("says nothing when the picture was supplied", () => {
    const { assetId } = fixtureImage();
    const scene = buildDocumentScene(deckWithImage());

    const library = new AssetLibrary([{ assetId, mimeType: "image/png", data: BYTES }]);

    expect(library.problems(scene.slides)).toEqual([]);
  });

  it("repeats the reason the caller gave rather than inventing one", () => {
    // "This file is too large to embed" and "this deck cites an asset that does
    // not exist" are different things to tell a person, and an omission cannot
    // tell them apart — which is why the API sends a `problem` instead of
    // leaving the entry out.
    const { assetId } = fixtureImage();
    const scene = buildDocumentScene(deckWithImage());

    const library = new AssetLibrary([
      { assetId, problem: "its stored bytes could not be read" },
    ]);
    const [warning] = library.problems(scene.slides);

    expect(warning!.message).toMatch(/its stored bytes could not be read/);
  });

  it("reports bytes the browser could not decode as a failure, not a success", () => {
    // Supplied and accepted is not the same as drawn. A JPEG that is really a
    // truncated upload passes every check on this side and produces a blank box
    // in the file, so the browser's own verdict is the one that counts.
    const { assetId } = fixtureImage();
    const scene = buildDocumentScene(deckWithImage());

    const library = new AssetLibrary([{ assetId, mimeType: "image/png", data: BYTES }]);
    const [warning] = library.problems(scene.slides, [assetId]);

    expect(warning!.feature).toBe(`asset:${assetId}`);
    expect(warning!.message).toMatch(/could not decode/);
  });

  it("gives each missing asset its own line", () => {
    // The ledger deduplicates on feature and action, so a single "image" feature
    // name would collapse four missing pictures into one warning naming one of
    // them — and the three nobody was told about are the three that ship.
    const document = deckWithImage();
    const slide = document.slides[0]!;
    slide.background = { ...(slide.background ?? {}), assetId: "ast_background" } as never;
    const scene = buildDocumentScene(document);

    const features = new AssetLibrary().problems(scene.slides).map((one) => one.feature);

    expect(new Set(features).size).toBe(features.length);
    expect(features).toContain("asset:ast_background");
  });
});

describe("what a scene actually needs", () => {
  it("counts a slide background, not only image elements", () => {
    // A full-bleed background image is the one most likely to be noticed missing
    // and the one least likely to be walked for: it is not an element, it hangs
    // off the slide.
    const document = deckWithImage();
    const slide = document.slides[0]!;
    slide.background = { ...(slide.background ?? {}), assetId: "ast_background" } as never;

    const scene = buildDocumentScene(document);
    const needed = neededAssets(scene.slides[0]!).map(([assetId]) => assetId);

    expect(needed).toContain("ast_background");
  });
});
