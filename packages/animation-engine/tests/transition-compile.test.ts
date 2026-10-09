/**
 * Compiling and sampling a transition (doc 04 §26.2, §27).
 *
 * The contract that matters most here is the one the whole engine is shaped
 * around: **seeking to `t` and playing to `t` must produce identical styles.**
 * Everything relative is resolved at compile, so the sampler is a pure function
 * of time — and this is where that claim is checked rather than asserted.
 */

import { describe, expect, it } from "vitest";

import {
  compileTransition,
  entranceStartMs,
  sampleTransition,
  transitionCss,
  type TransitionNode,
  type TransitionSlide,
} from "../src/transition";

function node(id: string, bounds: TransitionNode["bounds"], extra: Partial<TransitionNode> = {}): TransitionNode {
  return { id, type: "text", bounds, ...extra };
}

const from: TransitionSlide = {
  id: "s1",
  nodes: [node("title", { x: 100, y: 100, width: 200, height: 50 }, { text: "Revenue" })],
};
const to: TransitionSlide = {
  id: "s2",
  nodes: [node("title", { x: 500, y: 400, width: 400, height: 100 }, { text: "Revenue" })],
};

describe("compiling", () => {
  it("cuts for the first slide, because there is nothing to come from", () => {
    // A fade from a blank surface is a flash, not a transition.
    const compiled = compileTransition({ type: "fade" }, undefined, to);
    expect(compiled.type).toBe("cut");
    expect(compiled.tracks).toEqual([]);
  });

  it("cuts under reduced motion, and says why", () => {
    const compiled = compileTransition({ type: "push" }, from, to, { motion: "reduced" });
    expect(compiled.type).toBe("cut");
    expect(compiled.durationMs).toBe(0);
    // Not a shortened push. Halving something a viewer asked not to see is not
    // an accommodation.
    expect(compiled.degraded).toContain("Reduced motion");
  });

  it("degrades a type it cannot draw to a fade and names it", () => {
    const compiled = compileTransition({ type: "kaleidoscope" }, from, to);
    expect(compiled.type).toBe("fade");
    expect(compiled.requestedType).toBe("kaleidoscope");
    expect(compiled.degraded).toContain("kaleidoscope");
  });

  it("carries the easing name, not its CSS", () => {
    // `easingAt` resolves names and answers linear for anything else, so a
    // compiled CSS string would sample every transition linearly with nothing
    // failing anywhere. CSS is produced at the DOM boundary instead.
    const compiled = compileTransition({ type: "fade", easing: "emphasized" }, from, to);
    expect(compiled.easing).toBe("emphasized");
    expect(compiled.tracks[0]!.easing).toBe("emphasized");
  });

  it("moves both slides for a push and only the incoming one for a slide", () => {
    const pushed = compileTransition({ type: "push" }, from, to);
    const slid = compileTransition({ type: "slide" }, from, to);

    // Without the outgoing track a push reads as two pictures rather than one
    // continuous surface.
    expect(pushed.tracks.map((track) => track.kind).sort()).toEqual(["incoming", "outgoing"]);
    expect(slid.tracks.map((track) => track.kind)).toEqual(["incoming"]);
  });

  it.each([
    ["wipe", "clipPath"],
    ["split", "scale"],
    ["iris", "clipPath"],
    ["flip", "rotate"],
    ["blurDissolve", "filter"],
  ] as const)("draws %s with a concrete CSS longhand", (type, property) => {
    const compiled = compileTransition({ type, durationMs: 400, easing: "linear" }, from, to);
    const css = transitionCss(compiled, 200);
    expect(Object.values(css).some((style) => style[property] !== undefined)).toBe(true);
    expect(sampleTransition(compiled, 200)).toEqual(sampleTransition(compiled, 200));
  });
});

describe("morph", () => {
  it("crossfades and says so when nothing is paired", () => {
    const compiled = compileTransition({ type: "morph" }, from, to);

    expect(compiled.type).toBe("morph");
    expect(compiled.tracks.every((track) => track.kind === "incoming")).toBe(true);
    expect(compiled.warnings[0]).toContain("no paired elements");
  });

  it("moves a paired element and crossfades the rest", () => {
    // Not text: a box morph, scaled by its box.
    const boxFrom: TransitionSlide = { id: "s1", nodes: [node("card", { x: 100, y: 100, width: 200, height: 50 }, { type: "shape" })] };
    const boxTo: TransitionSlide = { id: "s2", nodes: [node("card", { x: 500, y: 400, width: 400, height: 100 }, { type: "shape" })] };
    const compiled = compileTransition(
      { type: "morph", durationMs: 400, easing: "linear", sharedElements: [{ sourceElementId: "card", destinationElementId: "card" }] },
      boxFrom,
      boxTo,
    );

    const targets = new Set(compiled.tracks.filter((track) => track.kind === "paired").map((track) => track.targetId));
    expect([...targets].sort()).toEqual(["pair:in:card", "pair:out:card"]);

    // Where the arriving copy's box actually is, composed the way CSS composes
    // the longhands about the slide origin - the renderer's transform-origin.
    // Asserting the numbers the kind emits would pass against the bug this
    // replaced: those numbers were right and the origin they assumed was not.
    const at = (t: number) => boxOf(sampleTransition(compiled, t)["pair:in:card"]!, boxTo.nodes[0]!.bounds);
    expect(at(0)).toEqual({ x: 100, y: 100, width: 200, height: 50 });
    expect(at(200)).toEqual({ x: 300, y: 250, width: 300, height: 75 });
    expect(at(400)).toEqual({ x: 500, y: 400, width: 400, height: 100 });

    // The leaving copy is on the same path at every instant.
    const leaving = (t: number) => boxOf(sampleTransition(compiled, t)["pair:out:card"]!, boxFrom.nodes[0]!.bounds);
    for (const t of [0, 100, 200, 300, 400]) expect(leaving(t)).toEqual(at(t));
  });

  it("crosses the two copies without ever dipping", () => {
    const compiled = compileTransition({ type: "morph", durationMs: 400 }, from, to, { autoPair: true });
    for (const t of [0, 100, 200, 300, 400]) {
      const styles = sampleTransition(compiled, t);
      const arriving = Number(styles["pair:in:title"]!.opacity);
      const leaving = Number(styles["pair:out:title"]!.opacity);
      // One of the two is always fully drawn, so two identical copies read as
      // one object rather than a flicker at the midpoint.
      expect(Math.max(arriving, leaving)).toBe(1);
    }
    expect(sampleTransition(compiled, 0)["pair:in:title"]!.opacity).toBe(0);
    expect(sampleTransition(compiled, 400)["pair:out:title"]!.opacity).toBe(0);
  });

  it("scales text by its type size and holds its alignment edge, never stretching a glyph", () => {
    // The box doubled in width; the type went from 40px to 60px. Scaling by the
    // box would draw every letter twice as wide as it is tall at the start.
    const textFrom: TransitionSlide = {
      id: "s1",
      nodes: [node("t", { x: 100, y: 100, width: 400, height: 60 }, { fontSize: 40, anchor: { x: 100, y: 100 } })],
    };
    const textTo: TransitionSlide = {
      id: "s2",
      nodes: [node("t", { x: 200, y: 300, width: 800, height: 90 }, { fontSize: 60, anchor: { x: 200, y: 300 } })],
    };
    const compiled = compileTransition(
      { type: "morph", durationMs: 400, easing: "linear", sharedElements: [{ sourceElementId: "t", destinationElementId: "t" }] },
      textFrom,
      textTo,
    );
    const start = sampleTransition(compiled, 0)["pair:in:t"]!;
    expect(start.scaleX).toBe(start.scaleY);
    expect(Number(start.scaleX)).toBeCloseTo(40 / 60, 2);
    // The left edge of the words sits where the source's did.
    expect(boxOf(start, textTo.nodes[0]!.bounds).x).toBeCloseTo(100, 0);
    expect(boxOf(start, textTo.nodes[0]!.bounds).y).toBeCloseTo(100, 0);
  });

  it("moves a group with everything in it, and does not pair a child of a paired group again", () => {
    const groupFrom: TransitionSlide = {
      id: "s1",
      nodes: [
        node("card", { x: 0, y: 0, width: 100, height: 100 }, { type: "group" }),
        node("label", { x: 10, y: 10, width: 80, height: 20 }, { type: "shape", parentId: "card" }),
      ],
    };
    const groupTo: TransitionSlide = {
      id: "s2",
      nodes: [
        node("card", { x: 500, y: 0, width: 100, height: 100 }, { type: "group" }),
        node("label", { x: 510, y: 10, width: 80, height: 20 }, { type: "shape", parentId: "card" }),
      ],
    };
    const compiled = compileTransition(
      {
        type: "morph",
        sharedElements: [
          { sourceElementId: "card", destinationElementId: "card" },
          { sourceElementId: "label", destinationElementId: "label" },
        ],
      },
      groupFrom,
      groupTo,
    );
    const targets = new Set(compiled.tracks.filter((track) => track.kind === "paired").map((track) => track.targetId));
    expect([...targets].sort()).toEqual(["pair:in:card", "pair:out:card"]);
    expect(compiled.warnings.join(" ")).toMatch(/moves with the group/);
  });

  it("does not emit a track for a pair that does not move", () => {
    // A compositor layer per element, for no motion — and on a slide where the
    // title genuinely stays put, that is most of the slide.
    const still: TransitionSlide = { id: "s3", nodes: [...from.nodes] };
    const compiled = compileTransition({ type: "morph" }, from, still, { autoPair: true });

    expect(compiled.tracks.filter((track) => track.kind === "paired")).toHaveLength(0);
  });

  it("respects a matchMode that forbids scaling", () => {
    const scaled = compileTransition(
      { type: "morph", sharedElements: [{ sourceElementId: "title", destinationElementId: "title" }] },
      from,
      to,
    );
    const positionOnly = compileTransition(
      {
        type: "morph",
        sharedElements: [
          { sourceElementId: "title", destinationElementId: "title", matchMode: "position" },
        ],
      },
      from,
      to,
    );

    const startScale = (compiled: typeof scaled) => sampleTransition(compiled, 0)["pair:in:title"]!.scaleX;
    // The title is text with no type size recorded here, so it scales by its box.
    expect(startScale(scaled)).toBe(0.5);
    // An author who wrote "position" decided the sizes differ for a reason.
    expect(startScale(positionOnly)).toBe(1);
  });
});

describe("sampling", () => {
  const compiled = compileTransition({ type: "fade", durationMs: 400, easing: "linear" }, from, to);

  it("is a pure function of time: seeking equals playing", () => {
    // The acceptance criterion doc 04 §26.2 states. The way it breaks is a value
    // advanced frame by frame, so this plays forward in small steps and then
    // asks the same question cold.
    let played: unknown;
    for (let t = 0; t <= 400; t += 16) played = sampleTransition(compiled, Math.min(t, 250));
    const sought = sampleTransition(compiled, 250);

    expect(sampleTransition(compiled, 250)).toEqual(sought);
    expect(played).toEqual(sampleTransition(compiled, 250));
  });

  it("clamps rather than extrapolating", () => {
    // Past the end a transition holds its final frame: that is what "the slide
    // has arrived" means, and extrapolating would keep fading past opaque.
    expect(sampleTransition(compiled, 10_000)).toEqual(sampleTransition(compiled, 400));
    expect(sampleTransition(compiled, -50)).toEqual(sampleTransition(compiled, 0));
  });

  it("interpolates linearly when asked to", () => {
    expect(sampleTransition(compiled, 200)["slide:in"]!.opacity).toBe(0.5);
  });

  it("switches rather than blending values whose units disagree", () => {
    // Blending `100%` into `0px` has no meaning, and inventing one produces
    // motion nobody asked for. Built by hand because no kind emits a mismatch —
    // which is the point: the sampler must not depend on them never doing so.
    const mixed = {
      ...compiled,
      durationMs: 100,
      tracks: [
        {
          targetId: "slide:in",
          kind: "incoming" as const,
          easing: "linear",
          keyframes: [
            { offset: 0, properties: { translateX: "100%" } },
            { offset: 1, properties: { translateX: "0px" } },
          ],
        },
      ],
    };

    expect(sampleTransition(mixed, 20)["slide:in"]!.translateX).toBe("100%");
    expect(sampleTransition(mixed, 80)["slide:in"]!.translateX).toBe("0px");
  });

  it("gives nothing back for a cut", () => {
    expect(sampleTransition(compileTransition({ type: "cut" }, from, to), 0)).toEqual({});
  });
});

describe("the boundary with the rest of motion", () => {
  it("holds the incoming slide's entrances until the transition ends", () => {
    // Otherwise an entrance animates relative to a surface that is itself still
    // moving, which looks like a bug rather than a build.
    const compiled = compileTransition({ type: "push", durationMs: 450 }, from, to);
    expect(entranceStartMs(compiled)).toBe(450);
  });

  it("emits longhands, never a transform shorthand", () => {
    // The renderer already puts a base `transform` on the element; a shorthand
    // here would erase it and send the element to the slide origin.
    const compiled = compileTransition({ type: "morph" }, from, to, { autoPair: true });
    const css = transitionCss(compiled, 0)["pair:in:title"]!;

    expect(css.transform).toBeUndefined();
    expect(css.translate).toMatch(/^-?[\d.]+px -?[\d.]+px$/);
    expect(css.scale).toBe("0.5 0.5");
  });
});

/**
 * Where a box lands under sampled longhands, composed as CSS composes them
 * about `transform-origin: 0 0` at the slide origin: `p' = t + R*S*p`.
 */
function boxOf(
  styles: Record<string, string | number>,
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const px = (value: string | number | undefined) => Number(String(value ?? 0).replace("px", ""));
  const tx = px(styles.translateX);
  const ty = px(styles.translateY);
  const sx = Number(styles.scaleX ?? 1);
  const sy = Number(styles.scaleY ?? 1);
  const round = (value: number) => Math.round(value * 100) / 100;
  return { x: round(tx + sx * box.x), y: round(ty + sy * box.y), width: round(sx * box.width), height: round(sy * box.height) };
}
