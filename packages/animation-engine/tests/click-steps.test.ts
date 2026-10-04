import { describe, expect, it } from "vitest";
import { clickStepCount, validateDocument, type AnimationTrack, type PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture, FIXTURE_NAMES } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";

import { compileTimeline } from "../src/index";

/**
 * W323 is judged in the schema, which cannot import this engine, so the schema
 * restates the compiler's rule for click steps (`clickStepCount`). This holds
 * the restatement to the compiler on every slide of every fixture, and on the
 * cases that make the two differ if one drifts: a disabled track, a track whose
 * target has gone, and a clicked element inside a group.
 */
function variants(): PresentationDocument[] {
  const out: PresentationDocument[] = [];
  for (const name of Object.keys(FIXTURE_NAMES)) {
    const document = loadFixture(name as never) as PresentationDocument;
    out.push(document);
    const altered = structuredClone(document);
    for (const slide of altered.slides) {
      const tracks = (slide.animations ?? []) as AnimationTrack[];
      if (tracks[0]) tracks[0] = { ...tracks[0], trigger: { type: "click" } };
      if (tracks[1]) tracks[1] = { ...tracks[1], disabled: true, trigger: { type: "click" } };
      if (tracks[2]) tracks[2] = { ...tracks[2], targetId: "el_01JB8Z9K2QW4RN7F3XGONEGONE", trigger: { type: "click" } };
    }
    out.push(altered);
  }
  return out;
}

describe("click steps", () => {
  it("are counted by the schema exactly as the compiler makes segments", () => {
    let slides = 0;
    for (const document of variants()) {
      const scene = buildDocumentScene(document);
      document.slides.forEach((slide, index) => {
        const compiled = compileTimeline(scene.slides[index]!, (slide.animations ?? []) as AnimationTrack[]);
        expect(clickStepCount(slide), `${document.metadata.title} slide ${index + 1}`).toBe(compiled.segments.length);
        slides += 1;
      });
    }
    expect(slides).toBeGreaterThan(20); // the loop really ran
  });

  it("names a narration line on a step the slide no longer has, and only that one", () => {
    const document = loadFixture("multilingual") as PresentationDocument;
    expect(validateDocument(document).warnings.filter((issue) => issue.code === "W323")).toEqual([]);
    const slide = document.slides[1]!;
    const steps = clickStepCount(slide);
    slide.narration!.cues[0] = { ...slide.narration!.cues[0]!, step: steps };
    const found = validateDocument(document).warnings.filter((issue) => issue.code === "W323");
    expect(found).toHaveLength(1);
    expect(found[0]!.targetIds).toEqual([slide.narration!.cues[0]!.id]);
  });
});
