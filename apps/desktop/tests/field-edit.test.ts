import { afterEach, describe, expect, it } from "vitest";

import { routeEditCommand } from "../src/renderer/field-edit";

/**
 * The macOS Edit menu's Undo, Redo and Select All: a focused field answers them
 * itself, and only otherwise does the editor. Measured on the first Mac build,
 * where a real Cmd+Z in the notes field did nothing at all.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function run(command: "undo" | "redo" | "select-all") {
  const ran: string[] = [];
  const forwarded = routeEditCommand(command, document, (name) => ran.push(name));
  return { ran, forwarded };
}

describe("the macOS Edit menu", () => {
  it.each([
    ["a textarea", () => document.createElement("textarea")],
    ["an input", () => document.createElement("input")],
    [
      "an editable region",
      () => {
        const div = document.createElement("div");
        div.setAttribute("contenteditable", "true");
        div.tabIndex = 0;
        return div;
      },
    ],
  ])("is the field's own undo, redo and select-all in %s, never the deck's", (_name, make) => {
    const field = make();
    document.body.append(field);
    field.focus();
    expect(document.activeElement).toBe(field);

    expect(run("undo")).toEqual({ ran: ["undo"], forwarded: null });
    expect(run("redo")).toEqual({ ran: ["redo"], forwarded: null });
    expect(run("select-all")).toEqual({ ran: ["selectAll"], forwarded: null });
  });

  it("is the editor's when no field has focus", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();

    expect(run("undo")).toEqual({ ran: [], forwarded: "undo" });
    expect(run("redo")).toEqual({ ran: [], forwarded: "redo" });
    expect(run("select-all")).toEqual({ ran: [], forwarded: "select-all" });
  });
});
