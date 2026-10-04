/**
 * Overlapping clips, named and fixable (D4.3, doc 04 §25.3).
 *
 * The compiler already warns. What is under test here is the part that makes a
 * warning worth reading: which *other* clip, by how much, on which property, and
 * two operations that resolve it — the shape the validator's catalog calls
 * `MECHANICALLY_FIXABLE`.
 *
 * An overlap is deliberately not an error. Two clips overlapping the same
 * property for a beat is a thing authors do on purpose; the product's job is to
 * make sure it was a decision rather than an accident.
 */

import { describe, expect, it } from "vitest";

import { MIN_CLIP_MS, findConflicts, type SourceClip } from "../src/timeline";
import type { CompiledClip, CompiledTimeline } from "../src/compile";

function compiled(
  id: string,
  startMs: number,
  endMs: number,
  properties: string[],
  targetId = "el_1",
): CompiledClip {
  return {
    id,
    trackId: `anm_${id}`,
    targetId,
    startMs,
    endMs,
    settledEndMs: endMs,
    periodMs: endMs - startMs,
    iterations: 1,
    direction: "normal",
    restOffset: 0,
    fill: "both",
    segment: 0,
    properties: properties.map((property) => ({ property, keyframes: [] })) as never,
  };
}

function timeline(clips: CompiledClip[]): CompiledTimeline {
  return {
    slideId: "sld_1",
    motionLevel: "full",
    durationMs: 1000,
    settledDurationMs: 1000,
    hasInfiniteMotion: false,
    clips,
    segments: [],
    markers: [],
    warnings: [],
    budget: { limitMs: 2500, entranceMs: 0, exceeded: false },
    animatedTargets: [],
  };
}

function source(id: string, startMs: number, durationMs: number): SourceClip {
  return { id, trackId: `anm_${id}`, startMs, durationMs };
}

describe("finding conflicts", () => {
  it("says which clips, which property, and for how long", () => {
    const conflicts = findConflicts(
      "sld_1",
      timeline([compiled("a", 0, 400, ["opacity"]), compiled("b", 300, 700, ["opacity"])]),
      [source("a", 0, 400), source("b", 300, 400)],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.property).toBe("opacity");
    expect(conflicts[0]!.earlierClipId).toBe("a");
    expect(conflicts[0]!.laterClipId).toBe("b");
    expect(conflicts[0]!.overlapMs).toBe(100);
    expect(conflicts[0]!.message).toContain("100ms");
  });

  it("ignores clips that share time but not a property", () => {
    // Fading one property while another moves is ordinary. Calling that a
    // conflict would train an author to ignore the warnings that matter.
    const conflicts = findConflicts(
      "sld_1",
      timeline([compiled("a", 0, 400, ["opacity"]), compiled("b", 100, 500, ["x"])]),
      [source("a", 0, 400), source("b", 100, 400)],
    );

    expect(conflicts).toEqual([]);
  });

  it("ignores clips that share a property but not a target", () => {
    const conflicts = findConflicts(
      "sld_1",
      timeline([
        compiled("a", 0, 400, ["opacity"], "el_1"),
        compiled("b", 100, 500, ["opacity"], "el_2"),
      ]),
      [source("a", 0, 400), source("b", 100, 400)],
    );

    expect(conflicts).toEqual([]);
  });

  it("reports one finding per property a pair collides on", () => {
    // A preset that moves and fades, over another that does both, is two
    // problems — reporting one would leave the author fixing the pair twice.
    const conflicts = findConflicts(
      "sld_1",
      timeline([
        compiled("a", 0, 400, ["opacity", "x"]),
        compiled("b", 200, 600, ["opacity", "x"]),
      ]),
      [source("a", 0, 400), source("b", 200, 400)],
    );

    expect(conflicts.map((one) => one.property).sort()).toEqual(["opacity", "x"]);
  });

  it("does not care which order the compiler emitted them in", () => {
    // An author who fixes one and re-opens the deck should not find the same
    // conflict described from the other side.
    const forwards = findConflicts(
      "sld_1",
      timeline([compiled("a", 0, 400, ["opacity"]), compiled("b", 300, 700, ["opacity"])]),
      [source("a", 0, 400), source("b", 300, 400)],
    );
    const backwards = findConflicts(
      "sld_1",
      timeline([compiled("b", 300, 700, ["opacity"]), compiled("a", 0, 400, ["opacity"])]),
      [source("b", 300, 400), source("a", 0, 400)],
    );

    expect(forwards).toEqual(backwards);
  });

  it("does not report clips that merely touch", () => {
    const conflicts = findConflicts(
      "sld_1",
      timeline([compiled("a", 0, 400, ["opacity"]), compiled("b", 400, 800, ["opacity"])]),
      [source("a", 0, 400), source("b", 400, 400)],
    );

    expect(conflicts).toEqual([]);
  });
});

describe("the fixes it offers", () => {
  const conflicts = () =>
    findConflicts(
      "sld_1",
      timeline([compiled("a", 0, 400, ["opacity"]), compiled("b", 300, 700, ["opacity"])]),
      [source("a", 0, 400), source("b", 300, 400)],
    );

  it("offers both sides of the overlap, each as one operation", () => {
    const [conflict] = conflicts();

    expect(conflict!.fixes.map((fix) => fix.label)).toEqual([
      "Start the later clip 100ms later",
      "Shorten the earlier clip to 300ms",
    ]);
    expect(conflict!.fixes.every((fix) => fix.operations.length === 1)).toBe(true);
  });

  it("writes the later clip's start as an offset from its trigger", () => {
    // The document stores offsets. Writing an absolute time would move a clip on
    // an `afterPrevious` track by however long everything before it runs.
    const [conflict] = conflicts();
    const delay = conflict!.fixes[0]!.operations[0] as { path: string; value: number };

    expect(delay.path).toBe("/slides/id:sld_1/animations/id:anm_b/clips/id:b/startMs");
    // Stored start 300 plus the 100ms overlap, not the compiled 300.
    expect(delay.value).toBe(400);
  });

  it("says what each fix costs", () => {
    // A fix with no caveat reads as free, and neither of these is.
    const [conflict] = conflicts();
    expect(conflict!.fixes.every((fix) => fix.caveat)).toBe(true);
  });

  it("will not offer a shortening that leaves a sliver", () => {
    const tiny = findConflicts(
      "sld_1",
      timeline([compiled("a", 0, 100, ["opacity"]), compiled("b", 60, 400, ["opacity"])]),
      [source("a", 0, 100), source("b", 60, 340)],
    );

    // 100 - 40 = 60, which is above the floor; the boundary is what matters.
    const shortening = tiny[0]!.fixes.find((fix) => fix.label.startsWith("Shorten"));
    expect(shortening).toBeDefined();

    const slivered = findConflicts(
      "sld_1",
      timeline([compiled("a", 0, 60, ["opacity"]), compiled("b", 20, 400, ["opacity"])]),
      [source("a", 0, 60), source("b", 20, 380)],
    );
    // 60 - 40 = 20, below MIN_CLIP_MS: a clip with a sliver beside it is not a
    // fix, it is a second thing to find and delete.
    expect(60 - 40).toBeLessThan(MIN_CLIP_MS);
    expect(slivered[0]!.fixes.some((fix) => fix.label.startsWith("Shorten"))).toBe(false);
  });
});
