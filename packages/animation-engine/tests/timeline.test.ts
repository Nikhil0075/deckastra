/**
 * The timeline view and its edits (doc 04 §25.2).
 *
 * The claim under test is the one that makes the timeline part of the product
 * rather than a widget: dragging a clip is a patch against `slide.animations`,
 * so it lands in the same history as a text edit or an AI change and undoes the
 * same way.
 */

import type { AnimationTrack } from "@deckastra/presentation-schema";
import type { SceneNode, SlideScene } from "@deckastra/renderer";
import { describe, expect, it } from "vitest";

import { compileTimeline } from "../src/compile";
import { MIN_CLIP_MS, buildTimelineView, clipPatchOperations } from "../src/timeline";

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
  nodes: [node("el_a"), node("el_b")],
  paintOrder: ["el_a", "el_b"],
  theme: { motion: {} } as unknown as SlideScene["theme"],
  fonts: [],
};

const TRACKS: AnimationTrack[] = [
  {
    id: "anm_1",
    targetId: "el_a",
    trigger: { type: "slideEnter" },
    clips: [{ id: "clp_1", startMs: 0, durationMs: 400, preset: "blurReveal" }],
  },
  {
    id: "anm_2",
    targetId: "el_a",
    trigger: { type: "afterPrevious" },
    clips: [{ id: "clp_2", startMs: 0, durationMs: 300, preset: "fade" }],
  },
  {
    id: "anm_3",
    targetId: "el_b",
    trigger: { type: "afterPrevious" },
    clips: [{ id: "clp_3", startMs: 0, durationMs: 300, preset: "slide" }],
  },
];

const TIMELINE = compileTimeline(SCENE, TRACKS);

describe("the timeline view", () => {
  it("is one lane per target, not one per track", () => {
    // An author reads it by asking "when does the title move". Three tracks on
    // one element as three rows is three rows they have to re-join by eye.
    const view = buildTimelineView(TIMELINE);
    expect(view.lanes.map((lane) => lane.targetId)).toEqual(["el_a", "el_b"]);
    expect(view.lanes[0]!.bars).toHaveLength(2);
  });

  it("labels lanes with the element name when there is one", () => {
    const view = buildTimelineView(TIMELINE, new Map([["el_a", "Title"]]));
    expect(view.lanes[0]!.label).toBe("Title");
    // No name: the id, which is at least addressable, rather than "Untitled".
    expect(view.lanes[1]!.label).toBe("el_b");
  });

  it("marks a conflicted bar so the UI can stripe it", () => {
    const overlapping = compileTimeline(SCENE, [
      TRACKS[0]!,
      { ...TRACKS[1]!, trigger: { type: "withPrevious" } },
    ]);
    const view = buildTimelineView(overlapping);
    expect(view.lanes[0]!.bars.some((bar) => bar.conflicted)).toBe(true);
  });

  it("carries the budget so the warning is visible where the editing happens", () => {
    const view = buildTimelineView(TIMELINE);
    expect(view.budget.limitMs).toBe(2500);
    expect(view.budget.exceeded).toBe(false);
  });

  it("thins its grid as the slide gets longer", () => {
    expect(buildTimelineView(TIMELINE).ticks).toEqual([0, 1000]);
    const long = { ...TIMELINE, durationMs: 20_000 };
    expect(buildTimelineView(long).ticks[1]).toBe(2_000);
  });
});

describe("a timeline gesture is a patch", () => {
  const clip = TIMELINE.clips.find((one) => one.id === "clp_2")!;

  it("moving a clip writes an offset from its trigger, not an absolute time", () => {
    // Doc 02 §24.4. Writing an absolute time here means the clip silently
    // repositions itself whenever the clip before it changes duration.
    const operations = clipPatchOperations("sld_1", clip, { kind: "move", startMs: 600 }, 400);
    expect(operations).toEqual([
      {
        op: "replace",
        path: "/slides/id:sld_1/animations/id:anm_2/clips/id:clp_2/startMs",
        value: 200,
      },
    ]);
  });

  it("never writes a negative start", () => {
    const [operation] = clipPatchOperations("sld_1", clip, { kind: "move", startMs: 100 }, 400);
    expect(operation).toMatchObject({ op: "replace", value: 0 });
  });

  it("addresses by id, so inserting another track does not move the target", () => {
    // An index path into `slide.animations` breaks the moment a track is added
    // before it — which is exactly what adding an animation does.
    for (const operation of clipPatchOperations("sld_1", clip, { kind: "delete" }, 0)) {
      expect(operation.path).toMatch(/\/id:/);
      expect(operation.path).not.toMatch(/\/\d+/);
    }
  });

  it("trimming stops at a length that is still an animation", () => {
    const [operation] = clipPatchOperations("sld_1", clip, { kind: "trim", durationMs: 5 }, 0);
    expect(operation).toMatchObject({ op: "replace", value: MIN_CLIP_MS });
  });

  it("changing preset clears the old preset's parameters", () => {
    // Carrying a blurReveal `blur` onto a drawPath leaves a value nothing reads,
    // and the panel offering a control that does nothing.
    const operations = clipPatchOperations(
      "sld_1",
      clip,
      { kind: "preset", preset: "drawPath" },
      0,
    );
    expect(operations).toHaveLength(2);
    expect(operations[1]).toMatchObject({ path: expect.stringMatching(/presetParams$/), value: {} });
  });

  it("a trigger change targets the track, not the clip", () => {
    // The trigger belongs to the track (doc 02 §25); writing it on a clip would
    // be a property nothing reads.
    const operations = clipPatchOperations(
      "sld_1",
      clip,
      { kind: "trigger", trigger: { type: "click" } },
      0,
    );
    expect(operations[0]!.path).toBe("/slides/id:sld_1/animations/id:anm_2/trigger");
  });

  it("deleting removes the clip and nothing else", () => {
    const operations = clipPatchOperations("sld_1", clip, { kind: "delete" }, 0);
    expect(operations).toEqual([
      { op: "remove", path: "/slides/id:sld_1/animations/id:anm_2/clips/id:clp_2" },
    ]);
  });
});
