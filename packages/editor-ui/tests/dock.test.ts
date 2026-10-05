import { describe, expect, it } from "vitest";

import { DEFAULT_DOCK, dockBodyHeight, loadDock, saveDock, selectDockTab, toggleDockTab } from "../src/lib/dock";

function memory(initial?: string) {
  const store = new Map<string, string>(initial === undefined ? [] : [["deckastra.dock", initial]]);
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

describe("the dock under the canvas", () => {
  it("is closed while designing and open on the timeline in Motion", () => {
    // Roadmap 08 §1.2 rule 1: the canvas comes first.
    expect(DEFAULT_DOCK.design.open).toBe(false);
    expect(DEFAULT_DOCK.code.open).toBe(false);
    expect(DEFAULT_DOCK.motion).toEqual({ open: true, tab: "timeline" });
  });

  it("falls back to each mode's default on its own", () => {
    expect(loadDock(memory())).toEqual(DEFAULT_DOCK);
    expect(loadDock(memory("{broken"))).toEqual(DEFAULT_DOCK);
    expect(loadDock(undefined)).toEqual(DEFAULT_DOCK);
    // One damaged entry does not reset the others.
    const layout = loadDock(memory(JSON.stringify({ design: { open: true, tab: "nope" }, motion: { open: "yes" } })));
    expect(layout.design).toEqual({ open: true, tab: "notes" });
    expect(layout.motion).toEqual(DEFAULT_DOCK.motion);
  });

  it("remembers each mode separately", () => {
    const storage = memory();
    saveDock({ ...DEFAULT_DOCK, design: { open: true, tab: "notes" } }, storage);
    const back = loadDock(storage);
    expect(back.design.open).toBe(true);
    expect(back.code.open).toBe(false);
  });

  it("does not fail when storage refuses the write", () => {
    expect(() =>
      saveDock(DEFAULT_DOCK, {
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).not.toThrow();
  });

  it("toggles a tab away and back, and a pressed tab always shows", () => {
    const closed = { open: false, tab: "notes" as const };
    expect(toggleDockTab(closed, "timeline")).toEqual({ open: true, tab: "timeline" });
    expect(toggleDockTab({ open: true, tab: "timeline" }, "timeline")).toEqual({ open: false, tab: "timeline" });
    expect(toggleDockTab({ open: true, tab: "timeline" }, "notes")).toEqual({ open: true, tab: "notes" });
    expect(selectDockTab({ open: true, tab: "notes" }, "notes")).toEqual({ open: true, tab: "notes" });
  });

  it("gives the timeline room in Motion mode", () => {
    expect(dockBodyHeight("motion", "timeline")).toBeGreaterThan(dockBodyHeight("design", "timeline"));
  });
});
