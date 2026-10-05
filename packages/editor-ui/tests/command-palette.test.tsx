// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "../src/components/shell/CommandPalette";
import { findCommands, PALETTE_COMMANDS } from "../src/lib/commands";

afterEach(cleanup);

describe("finding a command", () => {
  it("lists everything for an empty query, and leaves out leaving the deck where the host cannot", () => {
    expect(findCommands("", { canExit: true, canOpenSettings: true })).toHaveLength(PALETTE_COMMANDS.length);
    expect(findCommands("settings", { canExit: true }).some((item) => item.kind === "command")).toBe(false);
    const stay = findCommands("", { canExit: false }).map((item) => (item.kind === "command" ? item.entry.command : "ask"));
    expect(stay).not.toContain("all-decks");
    expect(stay).not.toContain("ask");
  });

  it("matches every word against the label, the group and its keywords, best match first", () => {
    const labels = (query: string) =>
      findCommands(query, { canExit: true }).flatMap((item) => (item.kind === "command" ? [item.entry.label] : []));
    expect(labels("time")[0]).toBe("Timeline");
    expect(labels("animation")).toContain("Motion");
    expect(labels("dark")).toContain("Dark");
    expect(labels("notes dock")).toEqual(["Speaker notes"]);
  });

  it("always offers the words to the assistant, last", () => {
    const items = findCommands("make the title shorter", { canExit: true });
    expect(items.at(-1)).toEqual({ kind: "ask", text: "make the title shorter" });
  });
});

describe("the palette on the home", () => {
  it("offers only what applies without a deck, and settings where the host has them", () => {
    const home = findCommands("", { canExit: true, canOpenSettings: true, place: "home" })
      .map((item) => (item.kind === "command" ? item.entry.command : null));
    expect(home).toEqual(["theme-system", "theme-light", "theme-dark", "all-decks", "new-deck", "generate-deck", "open-settings"]);
    expect(findCommands("undo", { canExit: true, place: "home" })).toEqual([{ kind: "ask", text: "undo" }]);
  });

  it("turns words typed into a deck to describe, not a question for the assistant", () => {
    render(<CommandPalette open place="home" onClose={() => {}} onCommand={() => {}} onAsk={() => {}} canExit />);
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "a pitch for a bakery" } });
    expect(screen.getByTestId("command-ask").textContent).toBe("Describe a deck: a pitch for a bakery");
  });
});

describe("the palette", () => {
  function open(props: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
    const onCommand = vi.fn();
    const onAsk = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} onCommand={onCommand} onAsk={onAsk} canExit {...props} />);
    return { onCommand, onAsk, onClose, input: screen.getByTestId("command-palette-input") };
  }

  it("takes focus, filters as you type and runs the chosen command through the shell's dispatcher", () => {
    const { input, onCommand, onClose } = open();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "timeline" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    expect(onCommand).toHaveBeenCalledWith("panel-dock");
  });

  it("moves the active row with the arrows and says which one it is", () => {
    const { input, onCommand } = open();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const active = document.getElementById(input.getAttribute("aria-activedescendant")!)!;
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(active.textContent).toBe("UndoCtrl+Z");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    // Up from the first row wraps to the last.
    const last = findCommands("", { canExit: true }).at(-1)!;
    expect(onCommand).toHaveBeenCalledWith(last.kind === "command" ? last.entry.command : null);
  });

  it("hands a sentence to the assistant without sending it", () => {
    const { input, onAsk, onCommand } = open();
    fireEvent.change(input, { target: { value: "add a slide about pricing" } });
    fireEvent.click(screen.getByTestId("command-ask"));
    expect(onAsk).toHaveBeenCalledWith("add a slide about pricing");
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("closes on Escape, on Ctrl+K and on the backdrop, and keeps typing away from the editor", () => {
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    const { input, onClose } = open();
    fireEvent.keyDown(input, { key: "d" });
    expect(outside).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    fireEvent.mouseDown(document.querySelector(".dk-palette__scrim")!);
    expect(onClose).toHaveBeenCalledTimes(3);
    window.removeEventListener("keydown", outside);
  });
});
