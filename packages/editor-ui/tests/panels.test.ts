import { describe, expect, it } from "vitest";

import {
  ALL_VISIBLE,
  loadPanels,
  panelsForCommand,
  panelsForKey,
  savePanels,
  toggleFocus,
  togglePanel,
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

describe("which panels are on screen", () => {
  it("shows everything when nothing, or nothing usable, is saved", () => {
    expect(loadPanels(memory())).toEqual(ALL_VISIBLE);
    expect(loadPanels(memory("not json"))).toEqual(ALL_VISIBLE);
    // A non-boolean reads as visible: a panel nobody can find is worse than one they can close.
    expect(loadPanels(memory(JSON.stringify({ tools: "no", slides: false })))).toEqual({ ...ALL_VISIBLE, slides: false });
    expect(loadPanels(undefined)).toEqual(ALL_VISIBLE);
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
    // Notes and timeline too: in a wide window the canvas fits by height, so
    // hiding only the side panels freed room the slide could not use.
    const focused = toggleFocus({ ...ALL_VISIBLE, dock: false });
    expect(focused).toEqual({ tools: false, slides: false, inspector: false, notes: false, dock: false });
    expect(toggleFocus(focused)).toEqual(ALL_VISIBLE);
  });

  it("answers the menu's commands and leaves others alone", () => {
    expect(panelsForCommand("panel-slides", ALL_VISIBLE)).toEqual(togglePanel(ALL_VISIBLE, "slides"));
    expect(panelsForCommand("panels-all", { ...ALL_VISIBLE, dock: false })).toEqual(ALL_VISIBLE);
    expect(panelsForCommand("undo", ALL_VISIBLE)).toBeNull();
  });

  it("answers Ctrl+Alt+digit by position and Ctrl+. for focus, by code so AltGr layouts work", () => {
    expect(panelsForKey(key({ ctrlKey: true, altKey: true, code: "Digit3", key: "³" }), ALL_VISIBLE)).toEqual({
      ...ALL_VISIBLE,
      inspector: false,
    });
    expect(panelsForKey(key({ ctrlKey: true, key: "." }), ALL_VISIBLE)?.notes).toBe(false);
    expect(panelsForKey(key({ ctrlKey: true, altKey: true, code: "Digit5" }), ALL_VISIBLE)?.dock).toBe(false);
    // Ctrl+1 is the mode switch, and Ctrl+Shift+Alt+1 is nothing of ours.
    expect(panelsForKey(key({ ctrlKey: true, code: "Digit1", key: "1" }), ALL_VISIBLE)).toBeNull();
    expect(panelsForKey(key({ ctrlKey: true, altKey: true, shiftKey: true, code: "Digit1" }), ALL_VISIBLE)).toBeNull();
    expect(panelsForKey(key({ altKey: true, code: "Digit1" }), ALL_VISIBLE)).toBeNull();
  });
});
