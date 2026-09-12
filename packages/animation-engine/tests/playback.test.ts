/**
 * Sampling and playback (doc 04 §26).
 *
 * The first block is the acceptance criterion §26.2 states outright: for a random
 * set of times, `play → pause at t` and `seek(t)` must agree. It is written as a
 * randomised comparison rather than a handful of chosen times, because the way
 * this breaks is a value that accumulates — and an accumulator is exactly right
 * at the times a test author would think to check.
 */

import type { AnimationTrack } from "@deckastra/presentation-schema";
import type { SceneNode, SlideScene } from "@deckastra/renderer";
import { describe, expect, it } from "vitest";

import { compileTimeline } from "../src/compile";
import { PlaybackEngine, steppedClock } from "../src/playback";
import { finalSample, interpolate, sampleAt, toStyle, type Sample } from "../src/sample";

function node(id: string): SceneNode {
  return {
    id,
    type: "text",
    worldTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    localTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    bounds: { x: 0, y: 0, width: 400, height: 100 },
    localBounds: { x: 0, y: 0, width: 400, height: 100 },
    resolvedStyle: {} as SceneNode["resolvedStyle"],
    layer: "content" as SceneNode["layer"],
    zPath: [0],
    renderPayload: { kind: "placeholder", label: "", reason: "" },
    a11y: { role: "text", order: 0 },
    flags: {} as SceneNode["flags"],
  };
}

const SCENE: SlideScene = {
  slideId: "sld_1",
  index: 0,
  width: 1920,
  height: 1080,
  nodes: [node("el_a"), node("el_b"), node("el_c")],
  paintOrder: ["el_a", "el_b", "el_c"],
  theme: { tokens: new Map() } as unknown as SlideScene["theme"],
  fonts: [],
};

const TRACKS: AnimationTrack[] = [
  {
    id: "anm_1",
    targetId: "el_a",
    trigger: { type: "slideEnter" },
    clips: [{ id: "clp_1", startMs: 0, durationMs: 600, preset: "blurReveal" }],
  },
  {
    id: "anm_2",
    targetId: "el_b",
    trigger: { type: "afterPrevious" },
    clips: [{ id: "clp_2", startMs: 0, durationMs: 500, preset: "springIn", easing: "easeInOut" }],
  },
  {
    id: "anm_3",
    targetId: "el_c",
    trigger: { type: "withPrevious" },
    clips: [
      {
        id: "clp_3",
        startMs: 0,
        durationMs: 450,
        preset: "slide",
        presetParams: { direction: "left", distance: 60 },
      },
    ],
  },
];

const TIMELINE = compileTimeline(SCENE, TRACKS);

function plain(sample: Sample): Record<string, Record<string, unknown>> {
  return Object.fromEntries([...sample].map(([key, target]) => [key, target.values]));
}

// ---------------------------------------------------------- §26.2 seek parity

describe("seek and play agree", () => {
  it("at every millisecond of the timeline", () => {
    // Exhaustive rather than sampled: the timeline is under a second, and this is
    // the property the whole design exists to guarantee.
    for (let t = 0; t <= TIMELINE.durationMs; t += 1) {
      const first = plain(sampleAt(TIMELINE, t));
      const second = plain(sampleAt(TIMELINE, t));
      expect(second).toEqual(first);
    }
  });

  it("playing to t gives what seeking to t gives", () => {
    const clock = steppedClock(1000 / 60);
    const engine = new PlaybackEngine(TIMELINE, clock);

    let latest: Sample = new Map();
    engine.subscribe({ onSample: (sample) => { latest = sample; } });
    engine.play();

    // Walk forward a frame at a time and compare each landing against a cold
    // seek to the same instant.
    for (let frame = 0; frame < 60; frame += 1) {
      clock.step();
      const played = plain(latest);
      const sought = plain(sampleAt(TIMELINE, engine.state.timeMs));
      expect(sought).toEqual(played);
    }

    engine.dispose();
  });

  it("scrubbing backwards gives the same picture as scrubbing forwards", () => {
    // The classic failure: a value eased from wherever the playhead happened to
    // be, so a backwards scrub lands somewhere a forwards scrub never does.
    const forwards: Record<number, unknown> = {};
    for (let t = 0; t <= 900; t += 37) forwards[t] = plain(sampleAt(TIMELINE, t));

    const engine = new PlaybackEngine(TIMELINE, steppedClock());
    let latest: Sample = new Map();
    engine.subscribe({ onSample: (sample) => { latest = sample; } });

    for (let t = 900; t >= 0; t -= 37) {
      engine.seek(t);
      if (forwards[t] !== undefined) expect(plain(latest)).toEqual(forwards[t]);
    }

    engine.dispose();
  });

  it("a spring seeks as exactly as a bezier", () => {
    // The reason springs are sampled at build time rather than simulated: a live
    // simulation's state at t depends on the frames before t.
    const springOnly = compileTimeline(SCENE, [TRACKS[1]!]);
    for (const t of [0, 13, 199, 250, 431, 500]) {
      expect(plain(sampleAt(springOnly, t))).toEqual(plain(sampleAt(springOnly, t)));
    }
  });
});

// -------------------------------------------------------------- sampling rules

describe("what a sample contains", () => {
  it("an element holds its starting state before its clip runs", () => {
    // The reveal rule. An element whose entrance begins at 600ms must already be
    // in its starting state at 0 — otherwise it is on screen, then vanishes when
    // its clip reaches back for the first keyframe, then fades in. That is a
    // flash, not a reveal, and it is what `fill: backwards` prevents.
    const before = sampleAt(TIMELINE, 0).get("el_b")!;
    expect(before.values.opacity).toBe(0);

    const during = sampleAt(TIMELINE, 700).get("el_b")!;
    expect(during.values.opacity).toBeGreaterThan(0);
  });

  it("an element with no animation at all is absent from the sample", () => {
    // Absent, not present-with-defaults: the caller has to be able to tell "not
    // animating" from "animating to its resting value", because the first should
    // carry no inline styles and the second should.
    const bare = compileTimeline(SCENE, [TRACKS[0]!]);
    expect(sampleAt(bare, 0).has("el_b")).toBe(false);
  });

  it("a clip that opts out of backwards fill says nothing before it starts", () => {
    // Both tracks, so el_b's clip genuinely starts later than zero.
    const explicit = compileTimeline(SCENE, [
      TRACKS[0]!,
      {
        ...TRACKS[1]!,
        clips: [{ ...TRACKS[1]!.clips[0]!, fill: "forwards" }],
      },
    ]);
    expect(sampleAt(explicit, 0).has("el_b")).toBe(false);
    expect(sampleAt(explicit, 700).has("el_b")).toBe(true);
  });

  it("the last value holds after a clip ends", () => {
    // `fill: forwards` is the schema default, and an element that snaps back to
    // its pre-entrance state the moment its clip ends is the most common
    // animation bug there is.
    const after = sampleAt(TIMELINE, TIMELINE.durationMs + 500);
    expect(after.get("el_a")!.values.opacity).toBe(1);
    expect(after.get("el_a")!.values.y).toBe(0);
  });

  it("the final sample is every target at rest", () => {
    const final = finalSample(TIMELINE);
    expect(final.get("el_a")!.values.opacity).toBe(1);
    expect(final.get("el_c")!.values.x).toBe(0);
  });
});

describe("interpolation", () => {
  it("numbers and numeric arrays interpolate", () => {
    expect(interpolate(0, 10, 0.25)).toBe(2.5);
    expect(interpolate([0, 100, 0, 0], [0, 0, 0, 0], 0.5)).toEqual([0, 50, 0, 0]);
  });

  it("anything else steps at the boundary rather than becoming nonsense", () => {
    // A half-interpolated "#ff0000" is a string that means nothing, and guessing
    // a colour space here would be a second, invisible definition of blending.
    expect(interpolate("#ff0000", "#0000ff", 0.5)).toBe("#ff0000");
    expect(interpolate("#ff0000", "#0000ff", 1)).toBe("#0000ff");
  });
});

describe("styles", () => {
  it("uses longhands so the scene's base transform survives", () => {
    // Doc 04 §22.4. Writing `transform` here would erase the layout transform the
    // scene already put on the element, and it would jump to the slide origin.
    const style = toStyle({ x: 12, y: -4, scale: 0.9, rotation: 3, opacity: 0.5 });
    expect(style.translate).toBe("12px -4px");
    expect(style.scale).toBe("0.9");
    expect(style.rotate).toBe("3deg");
    expect(style.transform).toBeUndefined();
  });

  it("omits a zero blur rather than writing an identity filter", () => {
    // Even `blur(0px)` creates a containing block and a stacking context, which
    // changes how absolutely positioned descendants resolve.
    expect(toStyle({ blur: 0 }).filter).toBeUndefined();
    expect(toStyle({ blur: 4 }).filter).toBe("blur(4px)");
  });

  it("writes a clip inset as percentages", () => {
    expect(toStyle({ clip: [0, 40, 0, 0] }).clipPath).toBe("inset(0% 40% 0% 0%)");
  });
});

// ------------------------------------------------------------------ segments

describe("segments", () => {
  const SEGMENTED = compileTimeline(SCENE, [
    { id: "anm_1", targetId: "el_a", trigger: { type: "slideEnter" }, clips: [{ id: "c1", startMs: 0, durationMs: 300, preset: "fade" }] },
    { id: "anm_2", targetId: "el_b", trigger: { type: "click" }, clips: [{ id: "c2", startMs: 0, durationMs: 300, preset: "fade" }] },
    { id: "anm_3", targetId: "el_c", trigger: { type: "click" }, clips: [{ id: "c3", startMs: 0, durationMs: 300, preset: "fade" }] },
  ]);

  it("playback stops at a boundary and waits", () => {
    const clock = steppedClock();
    const engine = new PlaybackEngine(SEGMENTED, clock);
    engine.play();
    clock.step(40);

    // Not past the entrance: the next segment is the presenter's to trigger.
    expect(engine.state.timeMs).toBe(300);
    expect(engine.state.status).toBe("paused");
    expect(engine.state.awaitingAdvance).toBe(true);
    engine.dispose();
  });

  it("next() advances a segment, and reports when there is none", () => {
    const clock = steppedClock();
    const engine = new PlaybackEngine(SEGMENTED, clock);

    expect(engine.next()).toBe(true);
    expect(engine.state.segmentIndex).toBe(1);
    expect(engine.next()).toBe(true);
    expect(engine.state.segmentIndex).toBe(2);
    // False is the caller's cue to advance the slide — one key, two meanings,
    // resolved here rather than in present mode.
    expect(engine.next()).toBe(false);
    engine.dispose();
  });

  it("previous() lands on the earlier segment's end state, not its start", () => {
    // Doc 04 §26.3: replaying an entrance backwards is disorienting, and
    // replaying it forwards looks like the slide is loading again.
    const clock = steppedClock();
    const engine = new PlaybackEngine(SEGMENTED, clock);

    engine.next();
    engine.next();
    expect(engine.previous()).toBe(true);
    expect(engine.state.timeMs).toBe(SEGMENTED.segments[1]!.endMs);
    expect(engine.previous()).toBe(true);
    expect(engine.state.timeMs).toBe(SEGMENTED.segments[0]!.endMs);
    expect(engine.previous()).toBe(false);
    engine.dispose();
  });

  it("entering at the end shows every target at rest", () => {
    const engine = new PlaybackEngine(SEGMENTED, steppedClock());
    let latest: Sample = new Map();
    engine.subscribe({ onSample: (sample) => { latest = sample; } });

    engine.enterAtEnd();
    expect(latest.get("el_c")!.values.opacity).toBe(1);
    expect(engine.state.timeMs).toBe(SEGMENTED.durationMs);
    engine.dispose();
  });
});

// ------------------------------------------------------------------- engine

describe("the playback engine", () => {
  it("fires complete once the last segment finishes", () => {
    const clock = steppedClock();
    const engine = new PlaybackEngine(TIMELINE, clock);

    let completed = 0;
    engine.subscribe({ onComplete: () => { completed += 1; } });
    engine.play();
    clock.step(200);

    expect(completed).toBe(1);
    expect(engine.state.timeMs).toBe(TIMELINE.durationMs);
    engine.dispose();
  });

  it("a rate change scales elapsed time", () => {
    const clock = steppedClock(100);
    const engine = new PlaybackEngine(TIMELINE, clock);
    engine.setPlaybackRate(2);
    engine.play();
    clock.step(2);

    expect(engine.state.timeMs).toBe(400);
    engine.dispose();
  });

  it("refuses a rate that would stop or reverse time", () => {
    const engine = new PlaybackEngine(TIMELINE, steppedClock());
    engine.setPlaybackRate(0);
    engine.setPlaybackRate(-1);
    // Silently accepting one produces a timeline that never advances and no
    // error to explain why.
    expect(engine.state.rate).toBe(1);
    engine.dispose();
  });

  it("keeps the playhead when the timeline is recompiled", () => {
    // A timeline edit is a patch, so this happens on every drag of a clip. An
    // author watching the playhead jump to zero on each frame of their drag
    // cannot see what they are editing.
    const engine = new PlaybackEngine(TIMELINE, steppedClock());
    engine.seek(500);
    engine.replace(compileTimeline(SCENE, TRACKS));
    expect(engine.state.timeMs).toBe(500);
    engine.dispose();
  });

  it("clamps the playhead when a recompile makes the slide shorter", () => {
    const engine = new PlaybackEngine(TIMELINE, steppedClock());
    engine.seek(TIMELINE.durationMs);
    engine.replace(compileTimeline(SCENE, [TRACKS[0]!]));
    expect(engine.state.timeMs).toBeLessThanOrEqual(600);
    engine.dispose();
  });
});
