import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ Menu: {} }));

import { menuTemplate } from "../src/main/menu";
import { MENU_COMMANDS, isMenuCommand, type MenuCommand } from "../src/shared/ipc";

const actions = () => ({ exportDiagnostics: async () => {}, backUp: async () => {}, restore: async () => {} });

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])]);
}

describe("the application menu", () => {
  it("sends exactly the command an item names, and every command has an item", () => {
    const sent: MenuCommand[] = [];
    // Items that send a command. The Help menu's own actions are handled in the
    // main process (item 18) and are checked separately below.
    const all = items(menuTemplate((command) => sent.push(command), "win32", actions()))
      .filter((item) => item.click)
      .filter((item) => isMenuCommand(item.id));
    for (const item of all) (item.click as () => void)();
    expect(sent).toEqual(all.map((item) => item.id));
    expect(new Set(sent)).toEqual(new Set(MENU_COMMANDS));
  });

  it("writes a diagnostics report from the main process, without going near the page", () => {
    const calls: string[] = [];
    const template = menuTemplate(
      () => calls.push("sent a command"),
      "win32",
      { ...actions(), exportDiagnostics: async () => void calls.push("exported") },
    );
    const help = items(template).find((item) => item.id === "export-diagnostics");
    expect(help?.label).toBe("Export diagnostics…");
    (help!.click as () => void)();
    expect(calls).toEqual(["exported"]);
  });

  it("backs up and restores from the main process, and neither is a page command", () => {
    // Both need something the page cannot have: a folder, and — for a restore —
    // the service stopped. `MENU_COMMANDS` must not learn either name, or the
    // page would be offered a job it cannot do.
    const calls: string[] = [];
    const template = menuTemplate(() => calls.push("sent a command"), "win32", {
      exportDiagnostics: async () => {},
      backUp: async () => void calls.push("backed up"),
      restore: async () => void calls.push("restored"),
    });
    const byId = new Map(items(template).map((item) => [item.id, item]));

    expect(byId.get("back-up")?.label).toBe("Back up…");
    expect(byId.get("restore-backup")?.label).toBe("Restore from a backup…");
    (byId.get("back-up")!.click as () => void)();
    (byId.get("restore-backup")!.click as () => void)();

    expect(calls).toEqual(["backed up", "restored"]);
    expect(isMenuCommand("back-up")).toBe(false);
    expect(isMenuCommand("restore-backup")).toBe(false);
  });

  it("leaves the keys the editor owns to the editor", () => {
    // A registered Ctrl+Z would be taken before the page saw it, and undo the
    // deck from inside the notes field instead of undoing the typing.
    const byId = new Map(items(menuTemplate(() => {}, "win32", actions())).map((item) => [item.id, item]));
    for (const id of ["undo", "redo", "present", "command-palette"]) {
      expect(byId.get(id)?.accelerator).toBeTruthy();
      expect(byId.get(id)?.registerAccelerator).toBe(false);
    }
    expect(byId.get("new-deck")?.registerAccelerator).toBeUndefined();

    // macOS registers every menu accelerator regardless, so there they are absent.
    const mac = new Map(items(menuTemplate(() => {}, "darwin", actions())).map((item) => [item.id, item]));
    for (const id of ["undo", "redo", "present"]) expect(mac.get(id)?.accelerator).toBeUndefined();
  });

  it("registers no key the editor already binds", () => {
    const registered = items(menuTemplate(() => {}, "win32", actions()))
      .filter((item) => item.accelerator && item.registerAccelerator !== false)
      .map((item) => item.accelerator);
    // The editor's own bindings with a modifier (packages/editor/src/keyboard.ts).
    const editor = ["D", "C", "X", "V", "A", "G", "Z", "Y", "]", "[", "L", "H", "P", "K"];
    for (const accelerator of registered) {
      const key = String(accelerator).split("+").pop();
      const plainOrShift = !String(accelerator).includes("Alt");
      if (plainOrShift) expect(editor).not.toContain(key);
    }
  });

  it("lets only listed names through the bridge", () => {
    expect(isMenuCommand("undo")).toBe(true);
    expect(isMenuCommand("rm -rf")).toBe(false);
    expect(isMenuCommand({ command: "undo" })).toBe(false);
  });
});
