import { afterEach, describe, expect, it } from "vitest";

import { focusNextRegion, nextRegionIndex } from "../src/lib/regions";

/**
 * F6 between the editor's regions (editor Phase 8): the desktop convention for
 * reaching the next part of the window without tabbing through every control.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function layout() {
  document.body.innerHTML = `
    <header data-region="app bar"><button id="bar">Undo</button></header>
    <nav data-region="slides"><button id="thumb">Slide 1</button></nav>
    <div data-region="canvas" tabindex="0" id="canvas"></div>
    <section data-region="timeline"><p>Nothing moves.</p></section>
    <div hidden><aside data-region="panel"><button id="hidden">Gone</button></aside></div>
  `;
}

describe("region cycling", () => {
  it("wraps in both directions and starts at an end", () => {
    expect(nextRegionIndex(-1, 4, false)).toBe(0);
    expect(nextRegionIndex(-1, 4, true)).toBe(3);
    expect(nextRegionIndex(3, 4, false)).toBe(0);
    expect(nextRegionIndex(0, 4, true)).toBe(3);
    expect(nextRegionIndex(0, 0, false)).toBe(-1);
  });

  it("walks the regions in page order, focusing each one's first control", () => {
    layout();
    const visits: Array<string | null> = [];
    for (let i = 0; i < 5; i += 1) visits.push(focusNextRegion(document, false));
    // A hidden region is not a stop; the walk wraps back to the start.
    expect(visits).toEqual(["app bar", "slides", "canvas", "timeline", "app bar"]);
    expect(document.activeElement?.id).toBe("bar");
  });

  it("focuses a region that is itself a target, and makes a region with no controls focusable", () => {
    layout();
    document.getElementById("thumb")!.focus();
    expect(focusNextRegion(document, false)).toBe("canvas");
    expect(document.activeElement?.id).toBe("canvas");
    expect(focusNextRegion(document, false)).toBe("timeline");
    const timeline = document.querySelector<HTMLElement>('[data-region="timeline"]')!;
    expect(document.activeElement).toBe(timeline);
    expect(timeline.tabIndex).toBe(-1);
    // Shift+F6 goes back.
    expect(focusNextRegion(document, true)).toBe("canvas");
  });
});
