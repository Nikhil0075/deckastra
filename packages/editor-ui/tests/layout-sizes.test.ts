import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIZES,
  DOCK_MIN,
  INSPECTOR,
  LIBRARY_WIDTH,
  MIN_CANVAS,
  RAIL_WIDTH,
  STRIP,
  clamp,
  dockHeight,
  fitLayout,
  loadLayout,
  saveLayout,
  withDock,
} from "../src/lib/layout-sizes";

const all = { tools: true, library: false, slides: true, inspector: true };
const canvasOf = (width: number, fitted: ReturnType<typeof fitLayout>, visible = all) =>
  width -
  (visible.tools ? RAIL_WIDTH : 0) -
  (visible.library ? LIBRARY_WIDTH : 0) -
  (visible.slides && !fitted.stripCollapsed ? fitted.strip : 0) -
  (visible.inspector ? fitted.inspector : 0);

describe("pane sizes", () => {
  it("keeps the frozen tokens as the defaults", () => {
    expect(DEFAULT_SIZES.strip).toBe(176);
    expect(DEFAULT_SIZES.inspector).toBe(288);
  });

  it("round-trips what was chosen, and brings anything out of range back inside", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    saveLayout({ strip: 240, inspector: 400, dock: { "motion:timeline": 420 } }, storage);
    expect(loadLayout(storage)).toEqual({ strip: 240, inspector: 400, dock: { "motion:timeline": 420 } });

    store.set("deckastra.layout", JSON.stringify({ strip: 5000, inspector: -3, dock: { "motion:timeline": 20, "nonsense:key": 300, "code:notes": "tall" } }));
    expect(loadLayout(storage)).toEqual({ strip: STRIP.max, inspector: INSPECTOR.min, dock: { "motion:timeline": DOCK_MIN } });
  });

  it("starts from the defaults when storage is missing, broken or refuses", () => {
    expect(loadLayout(undefined)).toEqual(DEFAULT_SIZES);
    expect(loadLayout({ getItem: () => "{not json" })).toEqual(DEFAULT_SIZES);
    expect(loadLayout({ getItem: () => { throw new Error("denied"); } })).toEqual(DEFAULT_SIZES);
    expect(() => saveLayout(DEFAULT_SIZES, { setItem: () => { throw new Error("quota"); } })).not.toThrow();
  });

  it("clamps and rounds", () => {
    expect(clamp(150.6, STRIP)).toBe(151);
    expect(clamp(Number.NaN, STRIP)).toBe(STRIP.min);
  });

  it("keeps the dock between its minimum and a share of the window", () => {
    expect(dockHeight(DEFAULT_SIZES, "motion", "timeline", 900)).toBe(300);
    expect(dockHeight(DEFAULT_SIZES, "design", "notes", 900)).toBe(168);
    const tall = withDock(DEFAULT_SIZES, "motion", "timeline", 2000, 900);
    expect(dockHeight(tall, "motion", "timeline", 900)).toBe(Math.floor(900 * 0.55));
    // The other mode's dock is untouched.
    expect(dockHeight(tall, "design", "timeline", 900)).toBe(168);
    expect(dockHeight(withDock(DEFAULT_SIZES, "code", "notes", 10, 900), "code", "notes", 900)).toBe(DOCK_MIN);
  });
});

describe("fitting the window", () => {
  it("changes nothing in a window that holds everything", () => {
    const fitted = fitLayout({ ...DEFAULT_SIZES, strip: 260, inspector: 420 }, 1920, all);
    expect(fitted).toEqual({ strip: 260, inspector: 420, stripCollapsed: false });
  });

  it("leaves a 1366 laptop's canvas over 60% of the window, with every pane kept at its size", () => {
    const fitted = fitLayout(DEFAULT_SIZES, 1366, all);
    expect(fitted).toEqual({ strip: 176, inspector: 288, stripCollapsed: false });
    expect(canvasOf(1366, fitted)).toBeGreaterThanOrEqual(0.6 * 1366);
  });

  it("never takes back a width someone dragged to, while the canvas is above the floor", () => {
    const chosen = { ...DEFAULT_SIZES, strip: 200, inspector: 520 };
    expect(fitLayout(chosen, 1440, all)).toEqual({ strip: 200, inspector: 520, stripCollapsed: false });
  });

  it("takes the strip, then the side panel, toward their minimums before putting anything away", () => {
    const wide = { ...DEFAULT_SIZES, strip: 320, inspector: 520 };
    // A little short: the strip alone gives it back.
    const slightly = fitLayout(wide, 1300, all);
    expect(slightly).toEqual({ strip: 252, inspector: 520, stripCollapsed: false });
    // More short: the strip goes to its minimum, then the side panel gives.
    const fitted = fitLayout(wide, 1100, all);
    expect(fitted.stripCollapsed).toBe(false);
    expect(fitted.strip).toBe(STRIP.min);
    expect(fitted.inspector).toBe(428);
    expect(canvasOf(1100, fitted)).toBe(MIN_CANVAS);
  });

  it("puts the strip away for now in a window too narrow for it, and never the side panel or library", () => {
    const visible = { ...all, library: true };
    const fitted = fitLayout(DEFAULT_SIZES, 1100, visible);
    expect(fitted.stripCollapsed).toBe(true);
    expect(fitted.inspector).toBe(INSPECTOR.min);
    // The chosen sizes are untouched: widen the window and they come back.
    expect(fitLayout(DEFAULT_SIZES, 2560, visible)).toEqual({ strip: 176, inspector: 288, stripCollapsed: false });
  });

  it("keeps every pane in a 1024px window at the default sizes", () => {
    expect(fitLayout(DEFAULT_SIZES, 1024, all)).toEqual({ strip: 176, inspector: 288, stripCollapsed: false });
  });

  it("does not report a hidden strip as collapsed", () => {
    expect(fitLayout(DEFAULT_SIZES, 900, { ...all, slides: false }).stripCollapsed).toBe(false);
  });
});
