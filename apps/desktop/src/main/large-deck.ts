import { randomBytes } from "node:crypto";

import animationFixture from "@deckastra/presentation-schema/fixtures/animation-test.mydeck.json" with { type: "json" };
import technicalFixture from "@deckastra/presentation-schema/fixtures/technical-deck.mydeck.json" with { type: "json" };

/**
 * A deck big enough to measure against (final package review, item 30).
 *
 * The register is explicit that "a small fixture's working-set sample is not a
 * memory qualification", and it is right: every performance number this project
 * has recorded came from a five-slide deck that fits in a cache. What a person
 * actually opens is sixty slides with photographs in them, and the interesting
 * costs — thumbnail strips, scene caches, image decoding, motion compilation —
 * only appear at that size.
 *
 * **Built from the fixtures rather than invented**, which is the decision worth
 * stating. The two seed decks between them already carry every element type,
 * container groups, a drawn path, click reveals, a staggered group and a
 * shared-element morph; a deck generated from first principles would be sixty
 * slides of whatever the generator's author happened to think of, and would
 * drift from the schema the moment either changed. Repeating known-valid
 * content measures the product on the content it actually has.
 *
 * Every id is minted fresh, because ids are unique forever and a deck with the
 * same element on six slides is not a deck the product would ever store.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID-shaped id the schema accepts: a known prefix and 26 Crockford characters. */
function newId(prefix: string): string {
  const random = randomBytes(26);
  return `${prefix}_${[...random].map((byte) => ALPHABET[byte % 32]).join("")}`;
}

/** Every `{prefix}_{ULID}` in a value, whatever shape it is nested in. */
function idsWithin(value: unknown): Set<string> {
  const found = new Set<string>();
  const pattern = /\b([a-z][a-z0-9]*)_([0-9A-HJKMNP-TV-Z]{26})\b/g;
  for (const match of JSON.stringify(value).matchAll(pattern)) found.add(match[0]);
  return found;
}

export interface PerfAsset {
  id: string;
  /** The schema requires it, and refused a manifest without one. */
  type: "image";
  storageKey: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  altText: string;
}

export interface LargeDeck {
  slides: unknown[];
  theme: unknown;
  assets: PerfAsset[];
  /** What was actually built, for the record. */
  shape: {
    slides: number;
    elements: number;
    groups: number;
    images: number;
    animatedSlides: number;
    transitions: number;
  };
}

/**
 * `slideCount` slides, repeating the fixtures' own slides with fresh ids.
 *
 * The pool is cloned and renumbered **a block at a time**, not slide by slide.
 * A morph names elements on the slide before it and an animation names elements
 * on its own, so renumbering one slide in isolation would break exactly the
 * cross-slide references this deck exists to exercise — and break them
 * silently, since the result still validates as a deck with an unpaired morph.
 */
export function buildLargeDeck(slideCount: number, assets: PerfAsset[]): LargeDeck {
  const pool = [
    ...(technicalFixture as { slides: unknown[] }).slides,
    ...(animationFixture as { slides: unknown[] }).slides,
  ];
  const slides: unknown[] = [];

  while (slides.length < slideCount) {
    const block = JSON.parse(JSON.stringify(pool)) as unknown[];
    const mapping = new Map<string, string>();
    for (const id of idsWithin(block)) {
      const prefix = id.slice(0, id.indexOf("_"));
      // Asset ids name stored rows and are replaced below with real ones, so
      // they are deliberately not renumbered here.
      if (prefix !== "ast") mapping.set(id, newId(prefix));
    }

    let text = JSON.stringify(block);
    for (const [from, to] of mapping) text = text.split(from).join(to);
    const renumbered = JSON.parse(text) as unknown[];

    for (const slide of renumbered) {
      if (slides.length >= slideCount) break;
      slides.push(slide);
    }
  }

  // Point every image at one of the assets that actually exist here. The
  // fixture's own asset id names a row this install has never had, and an image
  // citing one draws the labelled placeholder — which measures the placeholder
  // rather than the decoding this deck is for.
  let imageIndex = 0;
  let images = 0;
  const pointAtRealAssets = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) pointAtRealAssets(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const element = node as Record<string, unknown>;
    if (element.type === "image" && typeof element.assetId === "string" && assets.length > 0) {
      const asset = assets[imageIndex % assets.length]!;
      element.assetId = asset.id;
      element.altText = asset.altText;
      imageIndex += 1;
      images += 1;
    }
    for (const child of Object.values(element)) pointAtRealAssets(child);
  };
  pointAtRealAssets(slides);

  // And one picture on every slide. The fixtures carry a single image between
  // the ten of them, so repeating them gives seven across sixty — which
  // measures the thumbnail strip and the scene build but barely touches image
  // decoding, the cost this deck exists to put under load. Placed in the lower
  // right, inside the viewport and clear of the fixtures' own content.
  if (assets.length > 0) {
    slides.forEach((slide, index) => {
      const record = slide as { elements?: unknown[] };
      if (!Array.isArray(record.elements)) return;
      const asset = assets[index % assets.length]!;
      record.elements.push({
        id: newId("el"),
        type: "image",
        name: "Measured photograph",
        transform: { x: 1480, y: 820, width: 320, height: 180 },
        assetId: asset.id,
        fit: "cover",
        altText: asset.altText,
      });
      images += 1;
    });
  }

  let elements = 0;
  let groups = 0;
  let animatedSlides = 0;
  let transitions = 0;
  const countElements = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) countElements(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const element = node as Record<string, unknown>;
    if (typeof element.type === "string" && element.transform) {
      elements += 1;
      if (element.type === "group") groups += 1;
    }
    for (const child of Object.values(element)) countElements(child);
  };
  for (const slide of slides) {
    const record = slide as Record<string, unknown>;
    countElements(record.elements);
    if (Array.isArray(record.animations) && record.animations.length > 0) animatedSlides += 1;
    if (record.transition) transitions += 1;
  }

  return {
    slides,
    theme: (technicalFixture as { theme: unknown }).theme,
    assets,
    shape: { slides: slides.length, elements, groups, images, animatedSlides, transitions },
  };
}
