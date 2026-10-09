import { beforeAll, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";

import { FinalFrameSlide, textAnimationTargets } from "../src/components/FinalFrameSlide";

/**
 * Thumbnails draw text as plain runs (MVP sweep, 2026-10-10). Splitting every
 * line, word and character into its own span made the sixty-slide strip take
 * 1.5s against a 1s budget; only text whose final frame moves those pieces is
 * split, which is the exporter's rule.
 */

const HEADLINE = "el_01JB8Z9K2QW4RN7F3X03000100";

function sceneWith(preset?: string) {
  const document = structuredClone(loadFixture("animation"));
  const slide = document.slides[0]!;
  if (preset) {
    const track = slide.animations!.find((entry) => entry.targetId === HEADLINE)!;
    // Word presets target individual words only when the clip says how many.
    track.clips = [{ ...track.clips[0]!, preset, presetParams: { segmentCount: 3 }, propertyTracks: undefined } as never];
  }
  return buildDocumentScene(document).slides[0]!;
}

// Word and character spans, the ones that multiply with the amount of text.
// Effect layers and one line wrapper per paragraph are fixed per element.
const pieces = (root: HTMLElement, id?: string) => {
  const scope = id ? `[data-element-id="${id}"] ` : "";
  return root.querySelectorAll(`${scope}[data-sub-target^="word/"], ${scope}[data-sub-target^="glyph/"]`).length;
};

describe("thumbnail text", () => {
  beforeAll(() => {
    // jsdom has no CSS.escape; SlideMotion uses it to find the elements it moves.
    const css = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS ?? {};
    css.escape ??= (value: string) => value.replace(/["\\]/g, "\\$&");
    (globalThis as { CSS?: unknown }).CSS = css;
  });

  it("is not split where nothing moves it piece by piece", () => {
    const scene = sceneWith();
    expect(textAnimationTargets(scene)).toEqual([]);
    const { container } = render(<FinalFrameSlide scene={scene} width={240} />);
    expect(container.querySelectorAll("[data-element-id]").length).toBeGreaterThan(0);
    expect(pieces(container)).toBe(0);
  });

  it("is split only for the element a word animation moves", () => {
    const scene = sceneWith("wordCascade");
    expect(textAnimationTargets(scene)).toEqual([HEADLINE]);
    const { container } = render(<FinalFrameSlide scene={scene} width={240} />);
    expect(pieces(container, HEADLINE)).toBeGreaterThan(0);
    expect(pieces(container)).toBe(pieces(container, HEADLINE));
  });
});
