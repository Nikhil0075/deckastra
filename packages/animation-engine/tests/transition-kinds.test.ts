/**
 * The transitions added after the first twelve: clock wipe, cube, swap and
 * zoom blur, and a spring as a transition's easing.
 *
 * Each is held to the contract every kind keeps (seeking equals playing,
 * reduced motion cuts, the slide that has arrived is exactly the slide) and to
 * the one property that makes it that kind and not a near miss: a cube whose
 * faces stay joined, a swap that changes which slide is in front at the moment
 * they are furthest apart, a sweep that passes the corners.
 */

import { describe, expect, it } from "vitest";

import {
  compileTransition,
  sampleTransition,
  transitionCss,
  type TransitionNode,
  type TransitionSlide,
} from "../src/transition";
import { sweepPolygon } from "../src/transition/css";

function node(id: string, bounds: TransitionNode["bounds"]): TransitionNode {
  return { id, type: "text", bounds, text: "Revenue" };
}

const from: TransitionSlide = { id: "s1", nodes: [node("title", { x: 100, y: 100, width: 200, height: 50 })] };
const to: TransitionSlide = { id: "s2", nodes: [node("title", { x: 500, y: 400, width: 400, height: 100 })] };

const NEW_KINDS = ["clockWipe", "cube", "swap", "zoomBlur"] as const;
const DIRECTIONS = ["left", "right", "up", "down"] as const;
const SPRING = "spring(260,20,1)";

function percent(value: string | number | undefined): number {
  return Number(String(value ?? "0").replace("%", ""));
}

describe.each(NEW_KINDS)("%s", (type) => {
  it("is drawn as itself, not degraded to a fade", () => {
    const compiled = compileTransition({ type, durationMs: 600 }, from, to);
    expect(compiled.type).toBe(type);
    expect(compiled.degraded).toBeUndefined();
    expect(compiled.tracks.length).toBeGreaterThan(0);
  });

  it("gives the same styles whether it was played to a time or sought to it", () => {
    const compiled = compileTransition({ type, durationMs: 600 }, from, to);
    let visited = 0;
    for (let at = 0; at <= 600; at += 37) {
      // Play: every earlier frame is sampled first. Seek: this one alone.
      for (let earlier = 0; earlier < at; earlier += 16) sampleTransition(compiled, earlier);
      expect(sampleTransition(compiled, at)).toEqual(sampleTransition(compiled, at));
      expect(transitionCss(compiled, at)).toEqual(transitionCss(compiled, at));
      visited += 1;
    }
    expect(visited).toBeGreaterThan(10);
  });

  it("cuts under reduced motion", () => {
    const reduced = compileTransition({ type, durationMs: 600 }, from, to, { motion: "reduced" });
    expect(reduced.type).toBe("cut");
    expect(reduced.durationMs).toBe(0);
    expect(reduced.tracks).toEqual([]);
  });

  it.each(DIRECTIONS)("leaves the arriving slide exactly where it lives (%s)", (direction) => {
    const compiled = compileTransition({ type, durationMs: 600, direction }, from, to);
    const arrived = sampleTransition(compiled, 600)["slide:in"]!;

    // Whatever the kind animates must end at the value that means "untouched".
    const identity: Record<string, number> = {
      opacity: 1, scaleX: 1, scaleY: 1, blur: 0, rotateX: 0, rotateY: 0, clipSweep: 360, behind: 0,
    };
    let checked = 0;
    for (const [name, value] of Object.entries(arrived)) {
      if (name === "transformOrigin") continue;
      if (name === "translateX" || name === "translateY") expect(percent(value)).toBe(0);
      else expect(value).toBe(identity[name]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("cube", () => {
  /** Where a slide's hinge is on the stage, as a percentage along the axis of travel. */
  function hinge(style: Record<string, string | number>, horizontal: boolean): number {
    const [x, y] = String(style.transformOrigin).split(" ");
    return percent(horizontal ? x : y) + percent(horizontal ? style.translateX : style.translateY);
  }

  it.each(DIRECTIONS)("keeps the two faces joined at their shared edge for the whole turn (%s)", (direction) => {
    const horizontal = direction === "left" || direction === "right";
    for (const easing of ["linear", "emphasized", SPRING]) {
      const compiled = compileTransition({ type: "cube", durationMs: 700, direction, easing }, from, to);
      let frames = 0;
      for (let at = 0; at <= 700; at += 25) {
        const styles = sampleTransition(compiled, at);
        expect(hinge(styles["slide:out"]!, horizontal)).toBeCloseTo(hinge(styles["slide:in"]!, horizontal), 2);
        frames += 1;
      }
      expect(frames).toBe(29);
    }
  });

  it.each(DIRECTIONS)("turns both faces away from the viewer and through a right angle between them (%s)", (direction) => {
    const horizontal = direction === "left" || direction === "right";
    const turn = horizontal ? "rotateY" : "rotateX";
    const compiled = compileTransition({ type: "cube", durationMs: 700, direction, easing: "linear" }, from, to);
    for (const at of [0, 175, 350, 525, 700]) {
      const styles = sampleTransition(compiled, at);
      const leaving = Number(styles["slide:out"]![turn]);
      const arriving = Number(styles["slide:in"]![turn]);
      // Two neighbouring faces of a cube are always 90 degrees apart.
      expect(Math.abs(leaving - arriving)).toBeCloseTo(90, 3);
    }
    // Leaving to the left or upward and to the right or downward are mirror turns.
    const end = Number(sampleTransition(compiled, 700)["slide:out"]![turn]);
    const mirror = compileTransition(
      { type: "cube", durationMs: 700, easing: "linear", direction: horizontal ? (direction === "left" ? "right" : "left") : direction === "up" ? "down" : "up" },
      from,
      to,
    );
    expect(Number(sampleTransition(mirror, 700)["slide:out"]![turn])).toBe(-end);
  });

  it("asks for a viewing distance, and writes the turn as a rotate longhand", () => {
    const compiled = compileTransition({ type: "cube", durationMs: 700, easing: "linear" }, from, to);
    expect(compiled.perspective).toBeGreaterThan(1);
    expect(transitionCss(compiled, 350)["slide:out"]!.rotate).toBe("y -45deg");
    expect(transitionCss(compiled, 350)["slide:out"]!.transformOrigin).toBe("100% 50%");

    const vertical = compileTransition({ type: "cube", durationMs: 700, easing: "linear", direction: "up" }, from, to);
    expect(transitionCss(vertical, 350)["slide:out"]!.rotate).toBe("x 45deg");
  });

  it("leaves flat kinds without a 3D context", () => {
    expect(compileTransition({ type: "fade" }, from, to).perspective).toBeUndefined();
    expect(compileTransition({ type: "clockWipe" }, from, to).perspective).toBeUndefined();
  });
});

describe("swap", () => {
  it("puts the arriving slide behind until the cards are furthest apart, then in front", () => {
    const compiled = compileTransition({ type: "swap", durationMs: 1000, easing: "easeOut" }, from, to);
    const order = (at: number) => transitionCss(compiled, at)["slide:in"]!.zIndex;

    for (const at of [0, 100, 250, 400, 499]) expect(order(at)).toBe("-1");
    for (const at of [510, 600, 750, 900, 1000]) expect(order(at)).toBe("0");
  });

  it("parts the two slides to opposite sides at the midpoint", () => {
    const compiled = compileTransition({ type: "swap", durationMs: 1000 }, from, to);
    const middle = sampleTransition(compiled, 500);
    expect(percent(middle["slide:out"]!.translateX)).toBe(-42);
    expect(percent(middle["slide:in"]!.translateX)).toBe(42);
    expect(middle["slide:out"]!.opacity).toBe(1);
    expect(middle["slide:in"]!.opacity).toBe(1);
  });
});

describe("clock wipe", () => {
  it("uncovers nothing at the start and everything at the end", () => {
    expect(sweepPolygon(0)).toBe("polygon(50% 50%, 50% 50%, 50% 50%)");
    expect(sweepPolygon(360)).toBe("none");
    expect(sweepPolygon(Number.NaN)).toBe(sweepPolygon(0));
    expect(sweepPolygon(720)).toBe("none");
  });

  it("passes each corner of the slide in turn", () => {
    expect(sweepPolygon(90)).toBe("polygon(50% 50%, 50% 0%, 100% 0%, 100% 50%)");
    expect(sweepPolygon(180)).toBe("polygon(50% 50%, 50% 0%, 100% 0%, 100% 100%, 50% 100%)");
    expect(sweepPolygon(270)).toBe("polygon(50% 50%, 50% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 50%)");
    // Exactly at a corner the hand's own point is the corner, so it is not listed twice.
    expect(sweepPolygon(45)).toBe("polygon(50% 50%, 50% 0%, 100% 0%)");
  });

  it("only ever grows", () => {
    // The area of the swept polygon, by the shoelace formula, must never fall.
    const area = (shape: string): number => {
      if (shape === "none") return 10_000;
      const points = [...shape.matchAll(/(-?[\d.]+)% (-?[\d.]+)%/g)].map((match) => [Number(match[1]), Number(match[2])] as const);
      let twice = 0;
      for (let index = 0; index < points.length; index += 1) {
        const [x1, y1] = points[index]!;
        const [x2, y2] = points[(index + 1) % points.length]!;
        twice += x1 * y2 - x2 * y1;
      }
      return Math.abs(twice) / 2;
    };
    let previous = -1;
    let steps = 0;
    for (let angle = 0; angle <= 360; angle += 3) {
      const now = area(sweepPolygon(angle));
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
      steps += 1;
    }
    expect(steps).toBe(121);
    expect(previous).toBe(10_000);
  });

  it("reaches the browser as a clip-path", () => {
    const compiled = compileTransition({ type: "clockWipe", durationMs: 400, easing: "linear" }, from, to);
    expect(transitionCss(compiled, 100)["slide:in"]!.clipPath).toBe(sweepPolygon(90));
    expect(transitionCss(compiled, 400)["slide:in"]!.clipPath).toBe("none");
  });
});

describe("zoom blur", () => {
  it("writes the blur at zero too, so an arrived slide is not left soft", () => {
    const compiled = compileTransition({ type: "zoomBlur", durationMs: 500, easing: "linear" }, from, to);
    expect(transitionCss(compiled, 250)["slide:in"]!.filter).toBe("blur(9px)");
    expect(transitionCss(compiled, 500)["slide:in"]!.filter).toBe("none");
    // The same repair for the kind that had the fault first.
    const dissolve = compileTransition({ type: "blurDissolve", durationMs: 500, easing: "linear" }, from, to);
    expect(transitionCss(dissolve, 500)["slide:in"]!.filter).toBe("none");
  });
});

describe("a spring as the easing", () => {
  it("is sampled into keyframes, so nothing downstream has to know what a spring is", () => {
    const compiled = compileTransition({ type: "push", durationMs: 600, easing: SPRING }, from, to);
    expect(compiled.easing).toBe(SPRING);
    for (const track of compiled.tracks) {
      expect(track.easing).toBe("linear");
      expect(track.keyframes.length).toBeGreaterThan(10);
    }
  });

  it("lets movement pass its end and come back", () => {
    const compiled = compileTransition({ type: "push", durationMs: 600, easing: SPRING }, from, to);
    let furthest = Number.POSITIVE_INFINITY;
    for (let at = 0; at <= 600; at += 5) {
      furthest = Math.min(furthest, percent(sampleTransition(compiled, at)["slide:in"]!.translateX));
    }
    // Arriving from 100% toward 0%: an overshoot is a moment below zero.
    expect(furthest).toBeLessThan(-1);
    expect(percent(sampleTransition(compiled, 600)["slide:in"]!.translateX)).toBe(0);
  });

  it("differs from the straight line an unresolved spring used to be drawn as", () => {
    const sprung = compileTransition({ type: "push", durationMs: 600, easing: SPRING }, from, to);
    const linear = compileTransition({ type: "push", durationMs: 600, easing: "linear" }, from, to);
    expect(sampleTransition(sprung, 150)).not.toEqual(sampleTransition(linear, 150));
  });

  it("never takes opacity, blur or a clip outside its own range", () => {
    for (const type of ["zoom", "zoomBlur", "clockWipe", "iris", "fade"]) {
      const compiled = compileTransition({ type, durationMs: 600, easing: SPRING }, from, to);
      let frames = 0;
      for (let at = 0; at <= 600; at += 5) {
        for (const style of Object.values(sampleTransition(compiled, at))) {
          if (style.opacity !== undefined) {
            expect(Number(style.opacity)).toBeGreaterThanOrEqual(0);
            expect(Number(style.opacity)).toBeLessThanOrEqual(1);
          }
          if (style.blur !== undefined) expect(Number(style.blur)).toBeGreaterThanOrEqual(0);
          if (style.clipSweep !== undefined) expect(Number(style.clipSweep)).toBeLessThanOrEqual(360);
          if (style.clipRadius !== undefined) expect(Number(style.clipRadius)).toBeLessThanOrEqual(75);
        }
        frames += 1;
      }
      expect(frames).toBe(121);
    }
  });

  it("keeps seek and play identical", () => {
    const compiled = compileTransition({ type: "cube", durationMs: 700, easing: SPRING }, from, to);
    for (const at of [0, 90, 333, 512, 700]) {
      for (let earlier = 0; earlier < at; earlier += 16) sampleTransition(compiled, earlier);
      expect(sampleTransition(compiled, at)).toEqual(sampleTransition(compiled, at));
    }
  });

  it("says so when a transition moves in stages and cannot take one", () => {
    const compiled = compileTransition({ type: "swap", durationMs: 800, easing: SPRING }, from, to);
    expect(compiled.warnings.join(" ")).toContain("spring was not applied");
    // The order of the two slides is on its own clock and must be untouched.
    expect(transitionCss(compiled, 300)["slide:in"]!.zIndex).toBe("-1");
    expect(transitionCss(compiled, 700)["slide:in"]!.zIndex).toBe("0");
    // And nothing is left on an easing the sampler would read as a straight line.
    expect(compiled.tracks.every((track) => !track.easing.startsWith("spring"))).toBe(true);
  });

  it("leaves a morph's crossfade on its own clock", () => {
    const compiled = compileTransition(
      {
        type: "morph",
        durationMs: 600,
        easing: SPRING,
        sharedElements: [{ sourceElementId: "title", destinationElementId: "title" }],
      },
      from,
      to,
    );
    const fades = compiled.tracks.filter(
      (track) => track.kind === "paired" && track.keyframes.every((frame) => Object.keys(frame.properties).join() === "opacity"),
    );
    expect(fades.length).toBe(2);
    for (const fade of fades) expect(fade.keyframes.length).toBe(3);
  });
});
