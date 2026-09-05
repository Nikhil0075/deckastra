/**
 * Timeline compilation (doc 04 §25, §27).
 *
 * The compiler is where relative intent becomes absolute time, and every bug it
 * can have is a bug the author cannot see by reading their document: a clip that
 * starts a beat late, a segment that never waits, a reduced-motion path that
 * leaves the slide blank.
 */

import type { AnimationTrack } from "@deckastra/presentation-schema";
import type { SceneNode, SlideScene } from "@deckastra/renderer";
import { describe, expect, it } from "vitest";

import { compileTimeline, resolveMotionLevel } from "../src/compile";
import { easingAt, round } from "../src/easing";
import { sampleAt } from "../src/sample";

// ------------------------------------------------------------------ fixtures

function node(id: string, overrides: Partial<SceneNode> = {}): SceneNode {
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
    ...overrides,
  };
}

function scene(nodes: SceneNode[], motion: Record<string, unknown> = {}): SlideScene {
  return {
    slideId: "sld_1",
    index: 0,
    width: 1920,
    height: 1080,
    nodes,
    paintOrder: nodes.map((one) => one.id),
    theme: { motion } as unknown as SlideScene["theme"],
    fonts: [],
  };
}

function track(
  id: string,
  targetId: string,
  trigger: AnimationTrack["trigger"],
  clips: Partial<AnimationTrack["clips"][number]>[],
): AnimationTrack {
  return {
    id,
    targetId,
    trigger,
    clips: clips.map((clip, index) => ({
      id: `clp_${id}_${index}`,
      startMs: 0,
      durationMs: 400,
      preset: "fade",
      ...clip,
    })),
  };
}

const THREE = scene([node("el_a"), node("el_b"), node("el_c")]);

// -------------------------------------------------------------- §25.1 timing

describe("relative triggers become absolute times", () => {
  it("slideEnter starts at zero", () => {
    const timeline = compileTimeline(THREE, [
      track("anm_1", "el_a", { type: "slideEnter" }, [{ durationMs: 400 }]),
    ]);
    expect(timeline.clips[0]!.startMs).toBe(0);
    expect(timeline.clips[0]!.endMs).toBe(400);
  });

  it("afterPrevious queues behind whatever ran last", () => {
    const timeline = compileTimeline(THREE, [
      track("anm_1", "el_a", { type: "slideEnter" }, [{ durationMs: 400 }]),
      track("anm_2", "el_b", { type: "afterPrevious" }, [{ durationMs: 300 }]),
    ]);
    expect(timeline.clips.map((clip) => [clip.startMs, clip.endMs])).toEqual([
      [0, 400],
      [400, 700],
    ]);
  });

  it("withPrevious starts alongside it", () => {
    const timeline = compileTimeline(THREE, [
      track("anm_1", "el_a", { type: "slideEnter" }, [{ durationMs: 400 }]),
      track("anm_2", "el_b", { type: "withPrevious" }, [{ durationMs: 300 }]),
    ]);
    expect(timeline.clips.map((clip) => clip.startMs)).toEqual([0, 0]);
  });

  it("a timer offsets from the cursor", () => {
    const timeline = compileTimeline(THREE, [
      track("anm_1", "el_a", { type: "slideEnter" }, [{ durationMs: 400 }]),
      track("anm_2", "el_b", { type: "timer", delayMs: 250 }, [{ durationMs: 300 }]),
    ]);
    expect(timeline.clips[1]!.startMs).toBe(650);
  });

  it("a clip's own startMs and delayMs are offsets from the trigger, not absolutes", () => {
    // Doc 02 §24.4. Reading them as absolute times makes every clip on an
    // `afterPrevious` track fire at the top of the slide.
    const timeline = compileTimeline(THREE, [
      track("anm_1", "el_a", { type: "slideEnter" }, [{ durationMs: 400 }]),
      track("anm_2", "el_b", { type: "afterPrevious" }, [
        { durationMs: 300, startMs: 100, delayMs: 50 },
      ]),
    ]);
    expect(timeline.clips[1]!.startMs).toBe(550);
  });

  it("a disabled track is not compiled", () => {
    const one = track("anm_1", "el_a", { type: "slideEnter" }, [{}]);
    const timeline = compileTimeline(THREE, [{ ...one, disabled: true }]);
    expect(timeline.clips).toEqual([]);
  });
});

// ------------------------------------------------------------- §25.1 segments

describe("clicks split the timeline into segments", () => {
  const clicked = compileTimeline(THREE, [
    track("anm_1", "el_a", { type: "slideEnter" }, [{ durationMs: 400 }]),
    track("anm_2", "el_b", { type: "click" }, [{ durationMs: 300 }]),
    track("anm_3", "el_c", { type: "click" }, [{ durationMs: 300 }]),
  ]);

  it("one segment per click, plus the entrance", () => {
    expect(clicked.segments).toHaveLength(3);
    expect(clicked.segments.map((segment) => segment.advanceOn)).toEqual([
      "slideEnter",
      "click",
      "click",
    ]);
  });

  it("each clip knows which segment it belongs to", () => {
    expect(clicked.clips.map((clip) => clip.segment)).toEqual([0, 1, 2]);
  });

  it("the entrance segment ends before the clicked ones start", () => {
    expect(clicked.segments[0]!.endMs).toBe(400);
    expect(clicked.segments[1]!.startMs).toBe(400);
  });
});

// ------------------------------------------------------------ §27 reduced motion

describe("reduced motion", () => {
  it("resolves in the order §27.1 requires", () => {
    // A viewer's explicit choice beats the OS, and the OS beats the document. A
    // deck author cannot push motion onto someone who asked for less.
    expect(resolveMotionLevel("none", { userMotionPreference: "full" })).toBe("full");
    expect(resolveMotionLevel(undefined, { systemPrefersReducedMotion: true })).toBe("reduced");
    expect(resolveMotionLevel("none", {})).toBe("none");
    expect(resolveMotionLevel(undefined, {})).toBe("full");
  });

  it("shortens durations to 0.6x", () => {
    const tracks = [track("anm_1", "el_a", { type: "slideEnter" }, [{ durationMs: 500 }])];
    const reduced = compileTimeline(THREE, tracks, { systemPrefersReducedMotion: true });
    expect(reduced.clips[0]!.endMs).toBe(300);
  });

  it("replaces positional motion with the preset's declared fallback", () => {
    const tracks = [
      track("anm_1", "el_a", { type: "slideEnter" }, [
        { preset: "blurReveal", durationMs: 500 },
      ]),
    ];

    const full = compileTimeline(THREE, tracks);
    expect(new Set(full.clips[0]!.properties.map((one) => one.property))).toEqual(
      new Set(["opacity", "blur", "y"]),
    );

    const reduced = compileTimeline(THREE, tracks, { systemPrefersReducedMotion: true });
    expect(reduced.clips[0]!.properties.map((one) => one.property)).toEqual(["opacity"]);
  });

  it("caps stagger at 60ms", () => {
    const group = node("grp_1", {
      type: "group",
      children: [node("el_x"), node("el_y"), node("el_z")],
    });
    const tracks = [
      track("anm_1", "grp_1", { type: "slideEnter" }, [
        { preset: "staggerReveal", presetParams: { childPreset: "fade", staggerMs: 200 } },
      ]),
    ];

    const reduced = compileTimeline(scene([group]), tracks, {
      systemPrefersReducedMotion: true,
    });
    const starts = reduced.clips.map((clip) => clip.startMs);
    expect(Math.max(...starts)).toBeLessThanOrEqual(60);
  });

  it("at level none the content is still there, at its end state", () => {
    // Doc 04 §27.3's hard requirement. The failure it guards against is removing
    // the entrance and leaving the element at opacity 0 forever.
    const tracks = [
      track("anm_1", "el_a", { type: "slideEnter" }, [{ preset: "fade", durationMs: 500 }]),
    ];
    const none = compileTimeline(THREE, tracks, { userMotionPreference: "none" });

    expect(none.durationMs).toBe(0);
    const sample = sampleAt(none, 0);
    expect(sample.get("el_a")!.values.opacity).toBe(1);
  });

  it("at level none clicks still advance", () => {
    const none = compileTimeline(
      THREE,
      [
        track("anm_1", "el_a", { type: "slideEnter" }, [{}]),
        track("anm_2", "el_b", { type: "click" }, [{}]),
      ],
      { userMotionPreference: "none" },
    );
    // Click-to-reveal is navigation, not decoration; removing it would take away
    // the presenter's ability to pace the slide.
    expect(none.segments).toHaveLength(2);
  });

  it("a clip may override the preset's fallback", () => {
    const tracks = [
      track("anm_1", "el_a", { type: "slideEnter" }, [
        { preset: "slide", reducedMotionBehavior: "skip", durationMs: 400 },
      ]),
    ];
    const reduced = compileTimeline(THREE, tracks, { systemPrefersReducedMotion: true });
    expect(reduced.clips).toEqual([]);
  });
});

// ------------------------------------------------------------------ warnings

describe("what the compiler reports", () => {
  it("a track pointing at a missing element is a warning, not a failure", () => {
    const timeline = compileTimeline(THREE, [
      track("anm_1", "el_gone", { type: "slideEnter" }, [{}]),
      track("anm_2", "el_a", { type: "slideEnter" }, [{}]),
    ]);

    expect(timeline.warnings.map((warning) => warning.code)).toContain("W130");
    // The rest of the slide still animates.
    expect(timeline.clips).toHaveLength(1);
  });

  it("overlapping clips on one property are a conflict, and later wins", () => {
    const timeline = compileTimeline(THREE, [
      track("anm_1", "el_a", { type: "slideEnter" }, [{ preset: "fade", durationMs: 800 }]),
      track("anm_2", "el_a", { type: "withPrevious" }, [{ preset: "fade", durationMs: 400 }]),
    ]);

    expect(timeline.warnings.map((warning) => warning.code)).toContain("W136");

    // Not blended: at 200ms the value is the later clip's alone, computed on its
    // own 400ms timeline. A blend is a number nobody can predict from the
    // document and no exporter can reproduce.
    const value = sampleAt(timeline, 200).get("el_a")!.values.opacity;
    expect(value).toBe(round(easingAt("easeOut", 200 / 400)));
    // And demonstrably not the earlier clip's, which is only a quarter through.
    expect(value).not.toBe(round(easingAt("easeOut", 200 / 800)));
  });

  it("an entrance past the budget is flagged with the number", () => {
    const timeline = compileTimeline(
      THREE,
      [
        track("anm_1", "el_a", { type: "slideEnter" }, [{ durationMs: 1500 }]),
        track("anm_2", "el_b", { type: "afterPrevious" }, [{ durationMs: 1500 }]),
      ],
      { entranceBudgetMs: 2500 },
    );

    expect(timeline.budget.exceeded).toBe(true);
    expect(timeline.budget.entranceMs).toBe(3000);
    expect(timeline.warnings.find((warning) => warning.code === "W131")!.message).toMatch(/3000ms/);
  });

  it("a click segment does not count against the entrance budget", () => {
    // The budget is about the presenter talking over an entrance. A revealed
    // bullet happens when they ask for it, so it cannot be over-running.
    const timeline = compileTimeline(
      THREE,
      [
        track("anm_1", "el_a", { type: "slideEnter" }, [{ durationMs: 800 }]),
        track("anm_2", "el_b", { type: "click" }, [{ durationMs: 3000 }]),
      ],
      { entranceBudgetMs: 2500 },
    );

    expect(timeline.budget.exceeded).toBe(false);
    expect(timeline.budget.entranceMs).toBe(800);
  });

  it("a clip with neither a preset nor tracks says it does nothing", () => {
    const timeline = compileTimeline(THREE, [
      track("anm_1", "el_a", { type: "slideEnter" }, [{ preset: undefined }]),
    ]);
    expect(timeline.warnings.map((warning) => warning.code)).toContain("W133");
  });
});

// ------------------------------------------------------------------ authoring

describe("explicit property tracks", () => {
  it("win over the preset name, which survives as provenance", () => {
    // Doc 02 §24: a preset "opened" in the timeline becomes explicit keyframes
    // via an ordinary patch, and the UI can still say what it started as.
    const timeline = compileTimeline(THREE, [
      track("anm_1", "el_a", { type: "slideEnter" }, [
        {
          preset: "blurReveal",
          durationMs: 400,
          propertyTracks: [
            { property: "rotation", keyframes: [{ offset: 0, value: -8 }, { offset: 1, value: 0 }] },
          ],
        },
      ]),
    ]);

    expect(timeline.clips[0]!.properties.map((one) => one.property)).toEqual(["rotation"]);
    expect(timeline.clips[0]!.preset).toBe("blurReveal");
  });
});

describe("determinism", () => {
  it("compiling the same input twice gives the same numbers", () => {
    const tracks = [
      track("anm_1", "el_a", { type: "slideEnter" }, [{ preset: "springIn", durationMs: 600 }]),
      track("anm_2", "el_b", { type: "afterPrevious" }, [{ preset: "blurReveal" }]),
    ];
    expect(compileTimeline(THREE, tracks)).toEqual(compileTimeline(THREE, tracks));
  });
});
