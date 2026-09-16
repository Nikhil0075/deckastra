/**
 * Split, ripple and keyframe editing (D4.2, doc 04 §25.2).
 *
 * All three return operations and mutate nothing, so these tests read the
 * patches rather than a result — which is the point of the design: a timeline
 * gesture is a transaction with an inverse, in the same history as a text edit.
 *
 * The property under most of them is doc 02 §24.5's: **a keyframe's offset is
 * 0–1 of its clip's duration, not a time.** That is what makes trimming one
 * property change instead of N, and it is what makes splitting hard — each half
 * has its own duration, so every offset has to be re-expressed against it.
 */

import { describe, expect, it } from "vitest";

import {
  MIN_CLIP_MS,
  moveKeyframeOperations,
  openPresetOperations,
  removeKeyframeOperations,
  rippleAfterTrim,
  rippleOperations,
  setKeyframeOperations,
  splitClip,
} from "../src/timeline";

const SLIDE = "sld_1";

function clip(overrides: Record<string, unknown> = {}) {
  return {
    id: "clp_1",
    trackId: "anm_1",
    startMs: 0,
    durationMs: 400,
    propertyTracks: [
      {
        property: "opacity",
        keyframes: [
          { offset: 0, value: 0 },
          { offset: 1, value: 1 },
        ],
      },
    ],
    ...overrides,
  } as never;
}

// ------------------------------------------------------------------- split

describe("splitting a clip", () => {
  it("re-expresses each half's keyframes against its own duration", () => {
    const { operations } = splitClip(SLIDE, clip(), 100, "clp_2") as { operations: any[] };

    const [duration, tracks, added] = operations;
    expect(duration.value).toBe(100);

    // The first quarter of a 0→1 fade, stretched back over its own full length:
    // the seam value is 0.25, and it now sits at offset 1.
    expect(tracks.value[0].keyframes).toEqual([
      { offset: 0, value: 0 },
      { offset: 1, value: 0.25 },
    ]);
    // The second half starts from that same value, so the join does not jump.
    expect(added.value.propertyTracks[0].keyframes).toEqual([
      { offset: 0, value: 0.25 },
      { offset: 1, value: 1 },
    ]);
    expect(added.value.durationMs).toBe(300);
  });

  it("starts the second half where the first one ends", () => {
    // `startMs` is an offset from the trigger, so this is arithmetic on one axis.
    // Treating it as absolute would drop the second half at the trigger instead.
    const { operations } = splitClip(SLIDE, clip({ startMs: 250 }), 100, "clp_2") as { operations: any[] };
    expect(operations.at(-1)!.value.startMs).toBe(350);
  });

  it("refuses a cut that would leave a sliver", () => {
    const tooClose = splitClip(SLIDE, clip(), MIN_CLIP_MS - 1, "clp_2");
    expect(tooClose.operations).toEqual([]);
    expect(tooClose.warning).toContain(`${MIN_CLIP_MS}ms`);

    const tooLate = splitClip(SLIDE, clip(), 400 - (MIN_CLIP_MS - 1), "clp_2");
    expect(tooLate.operations).toEqual([]);
  });

  it("says when a value had no midpoint to take", () => {
    // A colour has no interpolation this module could invent, and inventing one
    // would put a value in the document the author never chose.
    const coloured = clip({
      propertyTracks: [
        {
          property: "fill",
          keyframes: [
            { offset: 0, value: "#ff0000" },
            { offset: 1, value: "#0000ff" },
          ],
        },
      ],
    });

    const { operations, warning } = splitClip(SLIDE, coloured, 100, "clp_2") as {
      operations: any[];
      warning: string;
    };

    expect(warning).toContain("cannot be interpolated");
    expect(operations[1].value[0].keyframes.at(-1)!.value).toBe("#ff0000");
  });

  it("keeps the preset name on both halves as provenance", () => {
    const { operations } = splitClip(
      SLIDE,
      clip({ preset: "blurReveal" }),
      200,
      "clp_2",
    ) as { operations: any[] };

    // "This started as blurReveal" stays true of both halves — but its
    // parameters do not travel with an opened clip, because the tracks are what
    // animates and stale parameters would mislead the inspector.
    expect(operations.at(-1)!.value.preset).toBe("blurReveal");
    expect(operations.at(-1)!.value.presetParams).toBeUndefined();
  });

  it("splits a clip that was never opened, without inventing tracks", () => {
    const preset = clip({ preset: "fade", presetParams: { from: 0 }, propertyTracks: undefined });
    const { operations } = splitClip(SLIDE, preset, 200, "clp_2") as { operations: any[] };

    expect(operations.some((operation) => operation.path.endsWith("/propertyTracks"))).toBe(false);
    expect(operations.at(-1)!.value.presetParams).toEqual({ from: 0 });
  });
});

// ------------------------------------------------------------------ ripple

describe("rippling", () => {
  const clips = [
    { id: "a", startMs: 0, durationMs: 200 },
    { id: "b", startMs: 200, durationMs: 200 },
    { id: "c", startMs: 400, durationMs: 200 },
  ];

  it("moves only what starts at or after the point", () => {
    const { operations, movedClipIds } = rippleOperations(SLIDE, "anm_1", clips, 200, 100);

    expect(movedClipIds).toEqual(["b", "c"]);
    expect(operations.map((operation) => (operation as { value: number }).value)).toEqual([300, 500]);
  });

  it("clamps at the trigger rather than writing a negative start", () => {
    // A clip with a negative startMs is not an earlier clip, it is an invalid
    // document. Clamping per clip keeps a mostly-sensible ripple from failing
    // because one clip sits at zero.
    const { operations, warning } = rippleOperations(SLIDE, "anm_1", clips, 0, -300);

    expect(operations.every((operation) => (operation as { value: number }).value >= 0)).toBe(true);
    expect(warning).toContain("could not move any earlier");
  });

  it("does nothing for a zero delta", () => {
    expect(rippleOperations(SLIDE, "anm_1", clips, 0, 0).operations).toEqual([]);
  });

  it("follows a trim by the amount the clip actually changed", () => {
    const { operations, movedClipIds } = rippleAfterTrim(SLIDE, "anm_1", clips, "a", 300);

    // `a` grew by 100, so everything after its old end moves by 100 — and `a`
    // itself is not in the result: the trim is a separate operation.
    expect(movedClipIds).toEqual(["b", "c"]);
    expect((operations[0] as { value: number }).value).toBe(300);
  });

  it("orders by time rather than by array position", () => {
    // Document order is something an author can rearrange for their own reasons;
    // what a ripple is about is time.
    const shuffled = [clips[2]!, clips[0]!, clips[1]!];
    expect(rippleOperations(SLIDE, "anm_1", shuffled, 200, 50).movedClipIds).toEqual(["b", "c"]);
  });
});

// --------------------------------------------------------------- keyframes

describe("opening a preset", () => {
  const context = {
    bounds: { x: 0, y: 0, width: 400, height: 200 },
    motion: { defaultDurationMs: 400, defaultEasing: "easeOut", staggerMs: 60 },
  };

  it("expands it into the keyframes it was already producing", () => {
    const { operations } = openPresetOperations(
      SLIDE,
      clip({ preset: "fade", propertyTracks: undefined }),
      context,
    );

    expect(operations).toHaveLength(1);
    expect(operations[0]!.op).toBe("add");
    expect(operations[0]!.path).toContain("/propertyTracks");
    expect((operations[0] as { value: unknown[] }).value.length).toBeGreaterThan(0);
  });

  it("refuses to open a clip that is already open", () => {
    // Opening twice would discard the author's edits and put the preset back,
    // which is the worst possible answer to a double click.
    expect(openPresetOperations(SLIDE, clip(), context).operations).toEqual([]);
  });

  it("says so when there is no preset to open", () => {
    const { operations, warning } = openPresetOperations(
      SLIDE,
      clip({ preset: undefined, propertyTracks: undefined }),
      context,
    );
    expect(operations).toEqual([]);
    expect(warning).toContain("no preset");
  });
});

describe("editing keyframes", () => {
  it("normalises milliseconds into offsets once, at the boundary", () => {
    // Callers think in time; the document stores fractions. Doing this in three
    // call sites is how two of them come to disagree.
    const { operations } = setKeyframeOperations(SLIDE, clip(), "opacity", 100, 0.5);
    const keyframes = (operations[0] as { value: { offset: number }[] }).value;

    expect(keyframes.map((frame) => frame.offset)).toEqual([0, 0.25, 1]);
  });

  it("replaces a keyframe already at that offset rather than doubling it", () => {
    const { operations } = setKeyframeOperations(SLIDE, clip(), "opacity", 400, 0.8);
    const keyframes = (operations[0] as { value: { offset: number; value: number }[] }).value;

    expect(keyframes).toHaveLength(2);
    expect(keyframes.at(-1)).toEqual({ offset: 1, value: 0.8 });
  });

  it("keeps keyframes sorted in the same operation that writes them", () => {
    // A patch that left them unordered would be a document the compiler reads
    // differently than the author sees.
    const { operations } = setKeyframeOperations(SLIDE, clip(), "opacity", 200, 0.4);
    const offsets = (operations[0] as { value: { offset: number }[] }).value.map((f) => f.offset);

    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("moves a keyframe, and replaces one it lands on", () => {
    const three = clip({
      propertyTracks: [
        {
          property: "opacity",
          keyframes: [
            { offset: 0, value: 0 },
            { offset: 0.5, value: 0.5 },
            { offset: 1, value: 1 },
          ],
        },
      ],
    });

    const moved = moveKeyframeOperations(SLIDE, three, "opacity", 0.5, 100);
    expect((moved.operations[0] as { value: { offset: number }[] }).value.map((f) => f.offset)).toEqual([
      0, 0.25, 1,
    ]);

    const collided = moveKeyframeOperations(SLIDE, three, "opacity", 0.5, 400);
    expect(collided.warning).toContain("already a keyframe there");
    expect((collided.operations[0] as { value: unknown[] }).value).toHaveLength(2);
  });

  it("will not remove the last keyframe of a track", () => {
    // The schema requires at least one, and "stop animating this property" is a
    // different intent with a different control.
    const single = clip({
      propertyTracks: [{ property: "opacity", keyframes: [{ offset: 0, value: 0 }] }],
    });

    const { operations, warning } = removeKeyframeOperations(SLIDE, single, "opacity", 0);
    expect(operations).toEqual([]);
    expect(warning).toContain("only one keyframe");
  });

  it("refuses an edit to a property the clip does not animate", () => {
    const { operations, warning } = setKeyframeOperations(SLIDE, clip(), "rotation", 100, 45);
    expect(operations).toEqual([]);
    expect(warning).toContain("rotation");
  });
});
