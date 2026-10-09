import { describe, expect, it } from "vitest";

import { DEFAULT_DOCK } from "../src/lib/dock";
import {
  ALL_VISIBLE,
  FOCUSED,
  loadPanels,
  panelsForCommand,
  panelsForKey,
  savePanels,
  toggleFocus,
  togglePanel,
  type Chrome,
} from "../src/lib/panels";

function memory(initial?: string) {
  const store = new Map<string, string>(initial === undefined ? [] : [["deckastra.panels", initial]]);
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    store,
  };
}

const key = (over: Partial<KeyboardEvent>) =>
  ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "", code: "", ...over }) as KeyboardEvent;

const designing: Chrome = { panels: { ...ALL_VISIBLE }, dock: { ...DEFAULT_DOCK.design } };

describe("which panels are on screen", () => {
  it("shows every side region when nothing, or nothing usable, is saved", () => {
    expect(loadPanels(memory())).toEqual(ALL_VISIBLE);
    expect(loadPanels(memory("not json"))).toEqual(ALL_VISIBLE);
    // A non-boolean reads as visible: a panel nobody can find is worse than one they can close.
    expect(loadPanels(memory(JSON.stringify({ tools: "no", slides: false })))).toEqual({ ...ALL_VISIBLE, slides: false });
    expect(loadPanels(undefined)).toEqual(ALL_VISIBLE);
  });

  it("ignores the notes and timeline an older build stored here", () => {
    // They belong to each mode's dock now; reading them back would reopen the
    // squeezed canvas in Design.
    expect(loadPanels(memory(JSON.stringify({ notes: true, dock: true, inspector: false })))).toEqual({
      ...ALL_VISIBLE,
      inspector: false,
    });
  });

  it("remembers what was hidden", () => {
    const storage = memory();
    savePanels({ ...ALL_VISIBLE, inspector: false }, storage);
    expect(loadPanels(storage)).toEqual({ ...ALL_VISIBLE, inspector: false });
  });

  it("does not fail when storage refuses the write", () => {
    expect(() =>
      savePanels(ALL_VISIBLE, {
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).not.toThrow();
  });

  it("focus mode leaves nothing but the slide, and the way back shows everything", () => {
    const open: Chrome = { panels: { ...ALL_VISIBLE }, dock: { open: true, tab: "timeline" } };
    const focused = toggleFocus(open);
    expect(focused).toEqual({ panels: FOCUSED, dock: { open: false, tab: "timeline" } });
    // Back means everything, the dock on the tab it last showed.
    expect(toggleFocus(focused)).toEqual(open);
  });

  it("answers the menu's commands and leaves others alone", () => {
    expect(panelsForCommand("panel-slides", designing)?.panels).toEqual(togglePanel(ALL_VISIBLE, "slides"));
    expect(panelsForCommand("panel-notes", designing)?.dock).toEqual({ open: true, tab: "notes" });
    expect(panelsForCommand("panel-dock", designing)?.dock).toEqual({ open: true, tab: "timeline" });
    expect(panelsForCommand("panels-all", { ...designing, panels: FOCUSED })).toEqual({
      panels: ALL_VISIBLE,
      dock: { open: true, tab: "notes" },
    });
    expect(panelsForCommand("undo", designing)).toBeNull();
  });

  it("answers Ctrl+Alt+digit by position and Ctrl+. for focus, by code so AltGr layouts work", () => {
    expect(panelsForKey(key({ ctrlKey: true, altKey: true, code: "Digit3", key: "³" }), designing)?.panels).toEqual({
      ...ALL_VISIBLE,
      inspector: false,
    });
    expect(panelsForKey(key({ ctrlKey: true, key: "." }), designing)?.panels).toEqual(FOCUSED);
    expect(panelsForKey(key({ ctrlKey: true, altKey: true, code: "Digit4" }), designing)?.dock).toEqual({ open: true, tab: "notes" });
    expect(panelsForKey(key({ ctrlKey: true, altKey: true, code: "Digit5" }), designing)?.dock).toEqual({ open: true, tab: "timeline" });
    // Ctrl+1 is the mode switch, and Ctrl+Shift+Alt+1 is nothing of ours.
    expect(panelsForKey(key({ ctrlKey: true, code: "Digit1", key: "1" }), designing)).toBeNull();
    expect(panelsForKey(key({ ctrlKey: true, altKey: true, shiftKey: true, code: "Digit1" }), designing)).toBeNull();
    expect(panelsForKey(key({ altKey: true, code: "Digit1" }), designing)).toBeNull();
  });
});
