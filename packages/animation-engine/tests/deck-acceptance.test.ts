/**
 * D4's acceptance gates, over the deck the product ships.
 *
 * Every other test in this package builds its input. These run the conformance
 * fixture through the real scene build and assert the three properties doc 04
 * makes acceptance criteria — because a property that holds for a literal and
 * fails for the deck in the repository is not a property, it is a coincidence.
 *
 * 1. **Seeking and playing agree** (§26.2), now that a deck has transitions as
 *    well as clips, and the two keep separate clocks.
 * 2. **Reduced motion is honoured all the way down**: transitions cut, clips
 *    fall back, and nothing fails to appear.
 * 3. **The entrance budget is enforced** (§24.2) rather than requested.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { buildDocumentScene } from "@deckastra/renderer";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { compileTimeline, sampleAt } from "../src";
import {
  compileTransition,
  entranceStartMs,
  sampleTransition,
  transitionSlideFromScene,
} from "../src/transition";

const FIXTURE = join(
  __dirname,
  "..",
  "..",
  "presentation-schema",
  "fixtures",
  "animation-test.mydeck.json",
);

const deck = JSON.parse(readFileSync(FIXTURE, "utf8")) as PresentationDocument;
const scene = buildDocumentScene(deck);

/**
 * Play forward in frames and return the last sample, landing exactly on `at`.
 *
 * The obvious loop — `t <= at; t += 16` — stops at the largest multiple of 16
 * below `at` and then compares two different instants, which fails whatever the
 * product does. Written once here rather than in each test, because getting it
 * subtly wrong is how a parity check comes to measure nothing.
 */
function playTo<T>(compiled: T, at: number, sample: (compiled: T, t: number) => unknown): unknown {
  let played = sample(compiled, 0);
  for (let t = 0; t < at; t = Math.min(at, t + 16)) played = sample(compiled, t + 16 > at ? at : t + 16);
  return played;
}

/**
 * Compiled at a stated motion level.
 *
 * `userMotionPreference` is the viewer's explicit choice, which doc 04 §27.1
 * puts above the OS and above the document — the right lever for a test that
 * means "what does a viewer who asked for less actually get". An invented
 * `motionLevel` option was passed here first; `CompileOptions` ignores unknown
 * keys, so every "reduced" assertion below was silently running at full motion
 * and passing anyway. The typechecker found it; vitest could not.
 */
function timelines(motionLevel: "full" | "reduced") {
  return deck.slides.map((slide, index) =>
    compileTimeline(scene.slides[index]!, (slide.animations ?? []) as never, {
      userMotionPreference: motionLevel,
    }),
  );
}

function transitions(motion: "full" | "reduced") {
  return scene.slides.map((slide, index) =>
    compileTransition(
      slide.transition,
      index > 0 ? transitionSlideFromScene(scene.slides[index - 1]!) : undefined,
      transitionSlideFromScene(slide),
      { motion },
    ),
  );
}

describe("seeking and playing agree, across the whole deck", () => {
  it("holds for every clip timeline", () => {
    // The way this breaks is a value advanced frame by frame, so each timeline
    // is played forward in 16ms steps and then asked the same question cold.
    for (const timeline of timelines("full")) {
      if (timeline.durationMs === 0) continue;

      for (const at of [0, Math.round(timeline.durationMs / 3), timeline.durationMs]) {
        expect(playTo(timeline, at, sampleAt)).toEqual(sampleAt(timeline, at));
      }
    }
  });

  it("holds for every transition, which keeps its own clock", () => {
    for (const transition of transitions("full")) {
      if (transition.durationMs === 0) continue;

      const at = Math.round(transition.durationMs / 2);
      expect(playTo(transition, at, sampleTransition)).toEqual(sampleTransition(transition, at));
    }
  });

  it("keeps a slide's entrances out of its own arrival", () => {
    // Two motions competing for one moment. On a push it is worse than untidy:
    // an element animating relative to a surface that is itself still moving.
    for (const [index, transition] of transitions("full").entries()) {
      const timeline = timelines("full")[index]!;
      if (transition.durationMs === 0 || timeline.durationMs === 0) continue;
      expect(entranceStartMs(transition)).toBe(transition.durationMs);
    }
  });
});

describe("reduced motion, all the way down", () => {
  it("cuts every transition", () => {
    for (const transition of transitions("reduced")) {
      expect(transition.type).toBe("cut");
      expect(transition.durationMs).toBe(0);
      expect(transition.tracks).toEqual([]);
    }
  });

  it("says so rather than silently shortening", () => {
    // Halving the duration of something a viewer asked not to see is not an
    // accommodation, and a viewer who set the preference deserves to know the
    // deck honoured it.
    const spoken = transitions("reduced").filter((one) => one.degraded);
    expect(spoken.length).toBeGreaterThan(0);
    for (const transition of spoken) expect(transition.degraded).toContain("Reduced motion");
  });

  it("still shows every animated element at the end", () => {
    // The one thing reduced motion must never mean. A fallback that left an
    // element at opacity 0 would hide content from exactly the people who asked
    // for less movement.
    // `sampleAt` answers a Map. Reading it with `Object.entries` yields nothing
    // and the loop below then inspects zero elements while looking thorough —
    // which is what this test did until the count at the end caught it.
    let inspected = 0;

    for (const timeline of timelines("reduced")) {
      const final = sampleAt(timeline, timeline.durationMs);
      for (const [targetId, sampled] of final) {
        // The sample is `{ targetId, values }`, not the values themselves.
        // Reading it as a flat record finds nothing and inspects nothing.
        const opacity = (sampled as { values: Record<string, unknown> }).values?.opacity;
        if (opacity === undefined) continue;
        inspected += 1;
        expect(
          Number(opacity),
          `${targetId} is invisible under reduced motion`,
        ).toBeGreaterThan(0);
      }
    }

    expect(inspected, "no animated element was actually examined").toBeGreaterThan(0);
  });
});

describe("the entrance budget is computed, not requested", () => {
  it("holds for every slide in the deck", () => {
    // Doc 04 §24.2. `_fit_to_budget` compresses; this is the check that it did.
    for (const timeline of timelines("full")) {
      expect(
        timeline.budget.entranceMs,
        `slide ${timeline.slideId} over-runs its entrance budget`,
      ).toBeLessThanOrEqual(timeline.budget.limitMs);
      expect(timeline.budget.exceeded).toBe(false);
    }
  });
});
