/**
 * Layout rules for the rewritten shell: zoom and mode. Editor state, so pure
 * and tested directly — nothing renders the shell in jsdom.
 */

import { describe, expect, it } from "vitest";

import {
  EDITOR_MODES,
  STAGE_PADDING,
  STAGE_TOP,
  ZOOM_STEPS,
  fitScale,
  formatZoom,
  resolveScale,
  stepZoom,
} from "../src/lib/editor-layout";

const HD = { width: 1920, height: 1080 };

describe("fitScale", () => {
  it("fits the whole slide with padding, using one factor for both axes", () => {
    // Width-limited stage.
    const wide = fitScale({ width: 1000 + STAGE_PADDING * 2, height: 2000 }, HD);
    expect(wide).toBeCloseTo(1000 / 1920, 3);
    // Height-limited stage: the width would allow more, the height decides.
    const tall = fitScale({ width: 4000, height: 540 + STAGE_TOP + STAGE_PADDING }, HD);
    expect(tall).toBeCloseTo(0.5, 3);
  });

  it("never collapses to zero or below in a tiny window", () => {
    expect(fitScale({ width: 10, height: 10 }, HD)).toBeGreaterThan(0);
  });
});

describe("zoom steps", () => {
  it("moves strictly smaller or larger from wherever fit landed", () => {
    expect(stepZoom(0.46, -1)).toBe(0.33);
    expect(stepZoom(0.46, 1)).toBe(0.5);
    // From exactly a step, the next one, never the same size.
    expect(stepZoom(0.5, 1)).toBe(0.67);
    expect(stepZoom(0.5, -1)).toBe(0.33);
  });

  it("stops at the ends", () => {
    expect(stepZoom(ZOOM_STEPS[0]!, -1)).toBe(ZOOM_STEPS[0]);
    expect(stepZoom(ZOOM_STEPS.at(-1)!, 1)).toBe(ZOOM_STEPS.at(-1));
  });

  it("resolves fit to the measured scale and a number to itself", () => {
    expect(resolveScale("fit", 0.46)).toBe(0.46);
    expect(resolveScale(1, 0.46)).toBe(1);
    expect(formatZoom(0.456)).toBe("46%");
  });
});

describe("modes", () => {
  it("has the four Figma modes, with Present deliberately not one of them", () => {
    expect(EDITOR_MODES.map((mode) => mode.value)).toEqual(["design", "motion", "code"]);
  });
});
