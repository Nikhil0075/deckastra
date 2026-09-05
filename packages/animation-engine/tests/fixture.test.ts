/**
 * The engine against the animation seed deck.
 *
 * Everything else in this suite builds its own scene, which means everything else
 * tests the engine against scenes an engine author thought of. This one compiles
 * the committed `animation-test` fixture through the real scene builder — the
 * same document the renderer, the exporter and the visual-regression gate all
 * read.
 *
 * It is the test that catches a mismatch between what the fixture says a deck can
 * contain and what the engine can compile.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { describe, expect, it } from "vitest";

import { compileTimeline } from "../src/compile";
import { PlaybackEngine, steppedClock } from "../src/playback";
import { sampleAt, type Sample } from "../src/sample";

const FIXTURE = fileURLToPath(
  new URL(
    "../../presentation-schema/fixtures/animation-test.mydeck.json",
    import.meta.url,
  ),
);

const document = JSON.parse(readFileSync(FIXTURE, "utf8")) as PresentationDocument;
const scene = buildDocumentScene(document);

function timelineFor(index: number) {
  return compileTimeline(scene.slides[index]!, document.slides[index]!.animations ?? []);
}

function plain(sample: Sample): Record<string, Record<string, unknown>> {
  return Object.fromEntries([...sample].map(([key, target]) => [key, target.values]));
}

describe("the sequenced entrance slide", () => {
  const timeline = timelineFor(0);

  it("compiles without a warning", () => {
    // Every warning here is something a reader of the fixture cannot see: a
    // target that does not exist, a clip that does nothing, a conflict.
    expect(timeline.warnings).toEqual([]);
  });

  it("orders the tracks the way the triggers say", () => {
    // slideEnter → afterPrevious → withPrevious(+70) → afterPrevious.
    expect(timeline.clips.map((clip) => clip.startMs)).toEqual([0, 400, 470, 870]);
  });

  it("stays inside the entrance budget", () => {
    // 1570ms against 2500. The fixture is the reference for what a well-paced
    // entrance looks like, so it failing its own budget would be a poor example.
    expect(timeline.budget.exceeded).toBe(false);
    expect(timeline.budget.entranceMs).toBeLessThan(timeline.budget.limitMs);
  });

  it("has one segment, because nothing on it waits for a click", () => {
    expect(timeline.segments).toHaveLength(1);
  });

  it("keeps its authored keyframes rather than re-deriving them from the preset", () => {
    // The fixture's clips carry explicit propertyTracks with `fadeUp` as the
    // preset name. Doc 02 §24: the tracks win and the name survives as
    // provenance, so the UI can still say what it started as.
    const headline = timeline.clips[0]!;
    expect(headline.preset).toBe("fadeUp");
    expect(headline.properties.map((one) => one.property)).toEqual(["opacity", "y"]);
  });

  it("counts the metric up to the value the document names", () => {
    const count = timeline.clips.find((clip) => clip.preset === "numberCount")!;
    const values = count.properties[0]!.keyframes.map((keyframe) => keyframe.value);
    expect(values).toEqual([0, 128]);
  });

  it("seeks and plays identically across the whole slide", () => {
    const clock = steppedClock();
    const engine = new PlaybackEngine(timeline, clock);
    let latest: Sample = new Map();
    engine.subscribe({ onSample: (sample) => { latest = sample; } });

    engine.play();
    for (let frame = 0; frame < 120; frame += 1) {
      clock.step();
      expect(plain(sampleAt(timeline, engine.state.timeMs))).toEqual(plain(latest));
    }
    engine.dispose();
  });
});

describe("the click-to-reveal slide", () => {
  const timeline = timelineFor(1);

  it("compiles without a warning", () => {
    expect(timeline.warnings).toEqual([]);
  });

  it("splits into a segment per click", () => {
    // Nothing runs on entry; both reveals wait for the presenter.
    expect(timeline.segments.map((segment) => segment.advanceOn)).toEqual([
      "slideEnter",
      "click",
      "click",
    ]);
    expect(timeline.budget.entranceMs).toBe(0);
  });

  it("expands the stagger into one clip per child", () => {
    const staggered = timeline.clips.filter((clip) => clip.preset === "staggerReveal");
    expect(staggered).toHaveLength(3);
    // 90ms apart, as the document asks.
    expect(staggered.map((clip) => clip.startMs - staggered[0]!.startMs)).toEqual([0, 90, 180]);
    // Each child, not the group: a group draws no content of its own, so
    // animating it would move three bullets as one block.
    expect(new Set(staggered.map((clip) => clip.targetId)).size).toBe(3);
  });

  it("draws the arrow as stroke progress", () => {
    const draw = timeline.clips.find((clip) => clip.preset === "drawPath")!;
    expect(draw.properties[0]!.property).toBe("pathProgress");
  });

  it("under reduced motion shows the arrow drawn rather than fading it in", () => {
    // Doc 04 §27.3: a drawn path's fallback is the drawn path. Fading it would
    // be a different statement, not a quieter one.
    const reduced = compileTimeline(
      scene.slides[1]!,
      document.slides[1]!.animations ?? [],
      { systemPrefersReducedMotion: true },
    );
    expect(reduced.clips.find((clip) => clip.preset === "drawPath")).toBeUndefined();
  });

  it("still advances on click when motion is off entirely", () => {
    const none = compileTimeline(
      scene.slides[1]!,
      document.slides[1]!.animations ?? [],
      { userMotionPreference: "none" },
    );
    expect(none.segments).toHaveLength(3);

    const engine = new PlaybackEngine(none, steppedClock());
    expect(engine.next()).toBe(true);
    expect(engine.next()).toBe(true);
    expect(engine.next()).toBe(false);
    engine.dispose();
  });
});

describe("the whole deck", () => {
  it("every slide compiles, and compiles the same way twice", () => {
    for (let index = 0; index < document.slides.length; index += 1) {
      const first = timelineFor(index);
      const second = timelineFor(index);
      expect(second).toEqual(first);
    }
  });

  it("every clip in the fixture resolves to a reduced-motion path", () => {
    // Doc 04 §27.3's requirement, checked end to end rather than per preset:
    // compile the whole deck at reduced motion and assert every target that
    // animates at full motion still ends up visible.
    for (let index = 0; index < document.slides.length; index += 1) {
      const full = timelineFor(index);
      const reduced = compileTimeline(
        scene.slides[index]!,
        document.slides[index]!.animations ?? [],
        { systemPrefersReducedMotion: true },
      );

      for (const targetId of full.animatedTargets) {
        const at = sampleAt(reduced, reduced.durationMs + 1).get(targetId);
        // Either it still animates and lands at full opacity, or its clip was
        // dropped as `instant` — which means the element was never faded out and
        // is simply on the slide. Both are "the content appears"; the failure
        // this catches is a fallback that leaves it at opacity 0.
        if (at && at.values.opacity !== undefined) {
          expect(at.values.opacity, `${targetId} is invisible at reduced motion`).toBe(1);
        }
      }
    }
  });

  it("every preset the fixture names is one the engine can expand or knowingly degrade", () => {
    for (const slide of document.slides) {
      for (const track of slide.animations ?? []) {
        for (const clip of track.clips) {
          const compiled = timelineFor(document.slides.indexOf(slide));
          const degraded = compiled.warnings.filter((warning) => warning.code === "W134");
          // A degradation is allowed — the schema keeps unknown presets — but it
          // must never happen silently, and the fixture should not rely on it.
          expect(degraded.map((warning) => warning.clipId)).not.toContain(clip.id);
        }
      }
    }
  });
});
