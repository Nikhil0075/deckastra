import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { compileTransition, transitionSlideFromScene, type CompiledTransition } from "@deckastra/animation-engine";

import { SlideTransition } from "../src/components/SlideTransition";

/**
 * What a transition writes on the two stages, and what it takes off again.
 *
 * Three faults lived here with every engine test green, because the engine's
 * output was right and the last step, writing it to an element, was not:
 *
 * - `style.setProperty("clipPath", …)` does nothing and says nothing, so a wipe
 *   and an iris showed the next slide at once.
 * - A kind writes only its own properties, so choosing another kind on the same
 *   stage left the first one's turn or clip underneath it.
 * - A slide that had arrived kept the last frame's styles for good.
 */

beforeEach(() => {
  // jsdom has no `CSS.escape`, and the leaving slide's motion looks its
  // elements up with it.
  if (typeof CSS === "undefined" || !CSS.escape) vi.stubGlobal("CSS", { escape: (value: string) => value });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const scene = buildDocumentScene(structuredClone(loadFixture("animation")) as PresentationDocument);
const from = scene.slides[0]!;
const to = scene.slides[1]!;

function compiled(type: string, durationMs = 600): CompiledTransition {
  return compileTransition(
    { type, durationMs, easing: "linear" },
    transitionSlideFromScene(from),
    transitionSlideFromScene(to),
    { motion: "full" },
  );
}

function stageAt(transition: CompiledTransition, timeMs: number) {
  return <SlideTransition compiled={transition} from={from} to={to} width={960} height={540} scale={0.5} timeMs={timeMs} />;
}

function stages(container: HTMLElement) {
  return {
    incoming: container.querySelector("[data-present-stage]") as HTMLElement,
    outgoing: container.querySelector("[data-transition-out] > div") as HTMLElement | null,
  };
}

/** The properties a transition may write. React's own (position, inset) are not among them. */
const TRANSITION_PROPERTIES = [
  "translate", "scale", "rotate", "opacity", "clip-path", "filter", "transform-origin", "z-index",
];

function carried(element: HTMLElement): string[] {
  return TRANSITION_PROPERTIES.filter((name) => element.style.getPropertyValue(name) !== "");
}

describe("writing a transition to the stage", () => {
  it("names every property the way CSS does", () => {
    const names = new Set<string>();
    const real = CSSStyleDeclaration.prototype.setProperty;
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
      this: CSSStyleDeclaration,
      name: string,
      value: string | null,
      priority?: string,
    ) {
      names.add(name);
      return real.call(this, name, value, priority);
    });

    for (const type of ["wipe", "iris", "clockWipe", "cube", "swap", "zoomBlur"]) {
      render(stageAt(compiled(type), 300));
      cleanup();
    }

    // Each of these is two words in CSS and one camel-cased word in the engine.
    expect(names).toContain("clip-path");
    expect(names).toContain("transform-origin");
    expect(names).toContain("z-index");
    expect([...names].filter((name) => /[A-Z]/.test(name))).toEqual([]);
  });

  it("takes one kind's styles off when another kind is chosen on the same stage", () => {
    const view = render(stageAt(compiled("cube"), 300));
    const before = stages(view.container);
    expect(carried(before.incoming)).toEqual(expect.arrayContaining(["translate", "rotate", "transform-origin"]));
    expect(carried(before.outgoing!)).toEqual(expect.arrayContaining(["translate", "rotate", "transform-origin"]));

    // The clock wipe animates the arriving slide's clip and nothing else, and
    // has no track for the leaving slide at all.
    view.rerender(stageAt(compiled("clockWipe"), 300));
    const after = stages(view.container);
    expect(after.incoming).toBe(before.incoming);
    expect(carried(after.incoming)).toEqual(["clip-path"]);
    expect(carried(after.outgoing!)).toEqual([]);
  });

  it.each(["fade", "wipe", "iris", "flip", "blurDissolve", "clockWipe", "cube", "swap", "zoomBlur"])(
    "leaves nothing on the slide once a %s has arrived",
    (type) => {
      const transition = compiled(type);
      const view = render(stageAt(transition, 300));
      expect(carried(stages(view.container).incoming).length).toBeGreaterThan(0);

      view.rerender(stageAt(transition, transition.durationMs));
      const arrived = stages(view.container);
      expect(arrived.outgoing).toBeNull();
      expect(carried(arrived.incoming)).toEqual([]);
    },
  );

  it("gives a turning kind its viewing distance on both parents, and only while it runs", () => {
    const cube = compiled("cube");
    const view = render(stageAt(cube, 300));
    const root = view.container.firstElementChild as HTMLElement;
    const wrapper = view.container.querySelector("[data-transition-out]") as HTMLElement;
    // 1.8 stage widths.
    expect(root.style.perspective).toBe("1728px");
    expect(wrapper.style.perspective).toBe("1728px");

    view.rerender(stageAt(cube, cube.durationMs));
    expect((view.container.firstElementChild as HTMLElement).style.perspective).toBe("");

    cleanup();
    const flat = render(stageAt(compiled("fade"), 300));
    expect((flat.container.firstElementChild as HTMLElement).style.perspective).toBe("");
  });
});
