import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { validateDocument } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

import { copy, parseClipboardPayload, paste } from "../src/index";

/**
 * A copy carries the asset entries its pictures cite, so a paste into another
 * deck arrives as a picture rather than an unresolvable gap (MA-23).
 */
describe("clipboard across decks", () => {
  const source = loadFixture("technical");
  const image = source.slides.flatMap((slide) => slide.elements).find((element) => element.type === "image")!;
  const assetId = (image as { assetId: string }).assetId;

  it("copies the cited manifest entry and nothing else", () => {
    const payload = copy(source, [image.id])!;
    expect(payload.assets?.map((asset) => asset.id)).toEqual([assetId]);
    const text = source.slides[0]!.elements.find((element) => element.type === "text")!;
    expect(copy(source, [text.id])!.assets).toBeUndefined();
  });

  it("adds the entry to a deck that lacks it, in the same patch, and one undo takes both away", () => {
    const target = structuredClone(loadFixture("technical"));
    target.assets = target.assets.filter((asset) => asset.id !== assetId);
    target.slides.forEach((slide) => (slide.elements = slide.elements.filter((element) => element.type !== "image")));

    const payload = parseClipboardPayload(JSON.stringify(copy(source, [image.id])))!;
    const result = applyPatch(target, paste(target, payload, { targetSlideId: target.slides[0]!.id }).operations);
    expect(result.document.assets.some((asset) => asset.id === assetId)).toBe(true);
    expect(validateDocument(result.document).errors).toEqual([]);
    expect(applyPatch(result.document, result.inverse).document).toEqual(target);
  });

  it("does not duplicate an entry the deck already has", () => {
    const payload = copy(source, [image.id])!;
    const operations = paste(source, payload, { targetSlideId: source.slides[0]!.id }).operations;
    expect(operations.filter((operation) => operation.path === "/assets/-")).toHaveLength(0);
  });

  it("refuses clipboard text that is not a payload", () => {
    expect(parseClipboardPayload("hello")).toBeUndefined();
    expect(parseClipboardPayload(JSON.stringify({ version: 1, sourceSlideId: "x", elements: [] }))).toBeUndefined();
    expect(parseClipboardPayload(JSON.stringify({ version: 2, sourceSlideId: "x", elements: [{}] }))).toBeUndefined();
  });
});
