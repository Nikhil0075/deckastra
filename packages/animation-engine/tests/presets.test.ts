/**
 * Preset expansion (doc 04 §22.2, §24, §27.3).
 *
 * The first test in this file is the one doc 04 §27.3 asks for by name: a preset
 * without a reduced-motion fallback fails the build. The rest check that a preset
 * expands into the tracks its row in §24 promises, because a preset is a contract
 * with the exporter as much as with the browser.
 */

import { describe, expect, it } from "vitest";

import {
  PRESETS,
  PRESET_NAMES,
  durationForBounds,
  resolvePreset,
} from "../src/presets";
import { parseSpring, sampleSpring } from "../src/easing";

const context = {
  bounds: { x: 100, y: 200, width: 400, height: 120 },
  motion: { defaultDurationMs: 400, defaultEasing: "easeOut", staggerMs: 70 },
  params: {},
  durationMs: 400,
};

describe("every preset declares a reduced-motion fallback", () => {
  // Doc 04 §27.3, verbatim: "Every preset must declare a fallback. A preset
  // without one fails a build-time test."
  it.each(PRESET_NAMES)("%s", (name) => {
    const preset = PRESETS[name]!;
    expect(preset.reducedMotion).toBeTruthy();
    expect(preset.reducedMotion === "instant" || PRESET_NAMES.includes(preset.reducedMotion)).toBe(
      true,
    );
  });

  it("a fallback is never a preset that leaves content invisible", () => {
    // The failure this guards: `fade`'s fallback being something whose first
    // keyframe is opacity 0 and whose last is also 0.
    for (const name of PRESET_NAMES) {
      const preset = PRESETS[name]!;
      if (preset.reducedMotion === "instant") continue;

      const fallback = PRESETS[preset.reducedMotion]!;
      const opacity = fallback
        .expand(context)
        .tracks.find((track) => track.property === "opacity");
      if (!opacity) continue;

      const last = opacity.keyframes[opacity.keyframes.length - 1]!;
      expect(last.value).toBe(1);
    }
  });
});

describe("the ten MVP presets expand as §24 describes", () => {
  it("fade animates opacity and nothing else", () => {
    const { tracks } = PRESETS.fade!.expand(context);
    expect(tracks.map((track) => track.property)).toEqual(["opacity"]);
  });

  it("slide moves on one axis, as an offset from where layout put it", () => {
    const { tracks } = PRESETS.slide!.expand({
      ...context,
      params: { direction: "up", distance: 40 },
    });

    const y = tracks.find((track) => track.property === "y")!;
    // 40 below its resting place, arriving at 0 — not at `bounds.y`. An absolute
    // value here would animate to the wrong place the moment the element moves.
    expect(y.keyframes[0]!.value).toBe(-40);
    expect(y.keyframes[1]!.value).toBe(0);

    // No x track at all: a 0 → 0 track is work with no effect, and it would
    // collide with anything legitimately animating x.
    expect(tracks.find((track) => track.property === "x")).toBeUndefined();
  });

  it("blurReveal carries opacity, blur and a rise", () => {
    const { tracks } = PRESETS.blurReveal!.expand(context);
    expect(new Set(tracks.map((track) => track.property))).toEqual(
      new Set(["opacity", "blur", "y"]),
    );
  });

  it("maskReveal emits an inset a clip-path can take", () => {
    const { tracks } = PRESETS.maskReveal!.expand({
      ...context,
      params: { direction: "left" },
    });

    const clip = tracks[0]!;
    expect(clip.property).toBe("clip");
    expect(clip.keyframes[0]!.value).toEqual([0, 100, 0, 0]);
    expect(clip.keyframes[1]!.value).toEqual([0, 0, 0, 0]);
  });

  it("staggerReveal expands per child with an increasing delay", () => {
    const { children } = PRESETS.staggerReveal!.expand({
      ...context,
      params: { childPreset: "fade", staggerMs: 80 },
      children: [
        { id: "el_a", bounds: context.bounds },
        { id: "el_b", bounds: context.bounds },
        { id: "el_c", bounds: context.bounds },
      ],
    });

    expect(children!.map((child) => child.delayMs)).toEqual([0, 80, 160]);
    expect(children![0]!.tracks[0]!.property).toBe("opacity");
  });

  it("staggerReveal over nothing animates the whole element and says so", () => {
    const expansion = PRESETS.staggerReveal!.expand(context);
    expect(expansion.tracks.length).toBeGreaterThan(0);
    expect(expansion.warning).toMatch(/no children/);
  });

  it("drawPath runs stroke progress end to end", () => {
    const forward = PRESETS.drawPath!.expand(context).tracks[0]!;
    expect(forward.property).toBe("pathProgress");
    expect(forward.keyframes.map((keyframe) => keyframe.value)).toEqual([0, 1]);

    const reverse = PRESETS.drawPath!.expand({ ...context, params: { direction: "reverse" } })
      .tracks[0]!;
    expect(reverse.keyframes.map((keyframe) => keyframe.value)).toEqual([1, 0]);
  });

  it("numberCount counts to the value it was given", () => {
    const { tracks } = PRESETS.numberCount!.expand({
      ...context,
      params: { from: 10, to: 4_200 },
    });
    expect(tracks[0]!.keyframes.map((keyframe) => keyframe.value)).toEqual([10, 4_200]);
  });

  it("springIn is sampled into keyframes, not left as a curve to simulate", () => {
    const { tracks } = PRESETS.springIn!.expand(context);
    const y = tracks.find((track) => track.property === "y")!;

    // Many keyframes rather than two: a live spring cannot answer seek(t)
    // without having played the frames before t (doc 04 §22.3).
    expect(y.keyframes.length).toBeGreaterThan(10);
    expect(y.keyframes[0]!.offset).toBe(0);
    expect(y.keyframes[y.keyframes.length - 1]!.offset).toBe(1);
    expect(y.keyframes[y.keyframes.length - 1]!.value).toBe(0);
  });

  it("sharedElementMorph without a pairing crossfades and says why", () => {
    const expansion = PRESETS.sharedElementMorph!.expand(context);
    expect(expansion.tracks.map((track) => track.property)).toEqual(["opacity"]);
    expect(expansion.warning).toMatch(/crossfade/);
  });
});

describe("unknown presets", () => {
  it("degrade to a fade and report it", () => {
    // The schema keeps unknown preset names (doc 02 §0.8), so a v2 deck opened
    // here must still animate. Refusing would delete the author's motion.
    const { preset, degraded } = resolvePreset("holographicUnfold");
    expect(preset.name).toBe("fade");
    expect(degraded).toMatch(/holographicUnfold/);
  });

  it("a known preset resolves without a warning", () => {
    expect(resolvePreset("blurReveal").degraded).toBeUndefined();
  });
});

describe("springs", () => {
  it("parse only when they are springs", () => {
    expect(parseSpring("spring(180, 12, 1)")).toEqual({
      stiffness: 180,
      damping: 12,
      mass: 1,
    });
    expect(parseSpring("easeOut")).toBeUndefined();
    // A zero mass divides by zero; a zero stiffness never returns to rest.
    expect(parseSpring("spring(180, 12, 0)")).toBeUndefined();
    expect(parseSpring("spring(0, 12, 1)")).toBeUndefined();
  });

  it("always end exactly at rest", () => {
    // A spring 0.3% short leaves the element permanently 0.3% off its layout
    // position — a misalignment nobody can find by reading the document.
    for (const damping of [8, 14, 26]) {
      const samples = sampleSpring({ stiffness: 180, damping, mass: 1 }, 600);
      expect(samples[samples.length - 1]).toEqual({ offset: 1, value: 1 });
    }
  });

  it("sample identically twice", () => {
    const spring = { stiffness: 210, damping: 11, mass: 1 };
    expect(sampleSpring(spring, 500)).toEqual(sampleSpring(spring, 500));
  });

  it("an underdamped spring overshoots", () => {
    const samples = sampleSpring({ stiffness: 300, damping: 6, mass: 1 }, 900);
    expect(Math.max(...samples.map((sample) => sample.value))).toBeGreaterThan(1);
  });
});

describe("duration guidance", () => {
  it("follows §24.2's scale bands", () => {
    expect(durationForBounds({ width: 48, height: 48 })).toBe(280);
    expect(durationForBounds({ width: 600, height: 200 })).toBe(450);
    expect(durationForBounds({ width: 1920, height: 1080 })).toBe(650);
  });
});
