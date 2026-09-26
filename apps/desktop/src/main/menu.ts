import { Menu, type MenuItemConstructorOptions } from "electron";

import type { MenuCommand } from "../shared/ipc";

/**
 * The application menu (editor Phase 8).
 *
 * Every item sends one name from `MENU_COMMANDS` to the window that has focus;
 * the page decides what it means there. Nothing here edits a deck, and nothing
 * here knows one exists: the menu is another way to press a button the window
 * already has.
 *
 * **Keys the editor already owns stay the editor's.** Undo, Redo and Present
 * have page shortcuts that know whether a text field has focus — Ctrl+Z in the
 * notes field is the field's own undo, not the deck's. A registered menu
 * accelerator would take the key before the page saw it and undo the deck from
 * inside a text box. So those items *show* their shortcut and do not register it
 * (`registerAccelerator: false`, honoured on Windows and Linux). macOS always
 * registers menu accelerators, so there the items carry no accelerator at all
 * until someone can measure the Mac build — which nobody here can.
 *
 * The keys the menu does register (Ctrl+N, Ctrl+1…4, …) are ones the page has
 * no binding for, so there is exactly one handler for every key either way.
 */
export interface MenuActions {
  /** Write a report someone can send (item 18). Main's own dialog. */
  exportDiagnostics: () => Promise<void>;
  /** Copy this install somewhere safe (item 14). Main's own dialog. */
  backUp: () => Promise<void>;
  /** Put a backup back (item 14). Stops the service, so it is main's too. */
  restore: () => Promise<void>;
  /** Show the licences of what ships (item 33). Optional so older callers compile. */
  showNotices?: () => Promise<void>;
}

export function installMenu(
  send: (command: MenuCommand) => void,
  actions: MenuActions,
  platform = process.platform,
): Menu {
  const menu = Menu.buildFromTemplate(menuTemplate(send, platform, actions));
  Menu.setApplicationMenu(menu);
  return menu;
}

export function menuTemplate(
  send: (command: MenuCommand) => void,
  platform: string,
  actions?: MenuActions,
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  // The id is the command, so the acceptance harness can press the real item
  // (`getMenuItemById`) rather than faking the message it sends.
  const item = (label: string, command: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
    id: command,
    label,
    accelerator,
    click: () => send(command),
  });
  /** A shortcut the page handles; shown, never registered (see above). */
  const pageOwned = (label: string, command: MenuCommand, accelerator: string): MenuItemConstructorOptions =>
    mac ? item(label, command) : { ...item(label, command, accelerator), registerAccelerator: false };

  return [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "&File",
      submenu: [
        item("New deck", "new-deck", "CmdOrCtrl+N"),
        item("Generate a deck…", "generate-deck", "CmdOrCtrl+Shift+N"),
        { type: "separator" },
        item("All decks", "all-decks", "CmdOrCtrl+Shift+O"),
        { type: "separator" },
        // Handled here rather than sent to the page, and not because it is
        // convenient: a backup needs a folder, and the renderer names no path
        // anywhere in this product. A restore additionally stops the service,
        // which the page has no way to do and no business doing.
        { id: "back-up", label: "Back up…", click: () => void actions?.backUp() },
        { id: "restore-backup", label: "Restore from a backup…", click: () => void actions?.restore() },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        pageOwned("Undo", "undo", "CmdOrCtrl+Z"),
        pageOwned("Redo", "redo", "CmdOrCtrl+Shift+Z"),
        { type: "separator" },
        item("Version history", "version-history", "CmdOrCtrl+Alt+H"),
      ],
    },
    {
      label: "&View",
      submenu: [
        item("Design", "mode-design", "CmdOrCtrl+1"),
        item("AI", "mode-ai", "CmdOrCtrl+2"),
        item("Motion", "mode-motion", "CmdOrCtrl+3"),
        item("Code", "mode-code", "CmdOrCtrl+4"),
        { type: "separator" },
        {
          label: "Theme",
          submenu: [
            item("Match the system", "theme-system"),
            item("Light", "theme-light"),
            item("Dark", "theme-dark"),
          ],
        },
        { type: "separator" },
        item("Intelligence…", "open-intelligence"),
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "&Slide",
      submenu: [pageOwned("Present", "present", "CmdOrCtrl+Shift+P")],
    },
    {
      label: "&Help",
      submenu: [
        {
          id: "export-diagnostics",
          label: "Export diagnostics…",
          // Handled here rather than sent to the page: the report is written by
          // the main process, which is the only side that knows the build, the
          // service and where the logs are.
          click: () => void actions?.exportDiagnostics(),
        },
        {
          id: "third-party-notices",
          label: "Third-party notices",
          click: () => void actions?.showNotices?.(),
        },
      ],
    },
  ];
}
