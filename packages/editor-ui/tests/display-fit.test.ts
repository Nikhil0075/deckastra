/**
 * Fitting a slide to a display (D4.3, doc 04 §4.2).
 *
 * These are cheap tests for a rule whose failures are expensive and late: a deck
 * stretched to fill a 4:3 screen looks fine in a browser window and wrong on the
 * wall, by which point the presenter is already talking.
 */

import { describe, expect, it } from "vitest";

import { fitToDisplay } from "../src/lib/display-fit";

const SLIDE = { width: 1920, height: 1080 };

describe("fitting a slide to a display", () => {
  it("uses one factor for both axes", () => {
    // The whole rule. Two factors is a stretched deck, and every glyph and
    // circle on it is wrong in a way nobody notices until it is six feet wide.
    const fit = fitToDisplay(SLIDE, { width: 1600, height: 1200 });

    expect(fit.width / SLIDE.width).toBeCloseTo(fit.height / SLIDE.height);
    expect(fit.scale).toBeCloseTo(1600 / 1920);
  });

  it("letterboxes on the axis with room to spare", () => {
    // A 16:9 deck on a 4:3 screen: bars above and below, none at the sides.
    const fit = fitToDisplay(SLIDE, { width: 1600, height: 1200 });

    expect(fit.letterbox.x).toBe(0);
    expect(fit.letterbox.y).toBeGreaterThan(0);

    // And the other way round on a wider display.
    const wide = fitToDisplay(SLIDE, { width: 3440, height: 1440 });
    expect(wide.letterbox.y).toBe(0);
    expect(wide.letterbox.x).toBeGreaterThan(0);
  });

  it("fills exactly when the aspect ratios match", () => {
    const fit = fitToDisplay(SLIDE, { width: 3840, height: 2160 });

    expect(fit.scale).toBe(2);
    expect(fit.letterbox).toEqual({ x: 0, y: 0 });
  });

  it("scales up as readily as down", () => {
    // A 1080p deck on a 4K projector should use the projector, not sit in the
    // middle at native size.
    expect(fitToDisplay(SLIDE, { width: 7680, height: 4320 }).scale).toBe(4);
  });

  it("answers zero for a surface that has not been measured", () => {
    // An ordinary first render. Infinity or NaN here would reach a CSS transform
    // and take the whole stage with it.
    for (const available of [
      { width: 0, height: 0 },
      { width: 1920, height: 0 },
      { width: -10, height: 100 },
    ]) {
      const fit = fitToDisplay(SLIDE, available);
      expect(fit.scale).toBe(0);
      expect(Number.isFinite(fit.width)).toBe(true);
    }
  });

  it("refuses to divide by a slide with no size", () => {
    expect(fitToDisplay({ width: 0, height: 0 }, { width: 1920, height: 1080 }).scale).toBe(0);
  });
});
