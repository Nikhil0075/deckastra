import type { HostCommand } from "@deckastra/workspace-contracts";

import type { EditCommand } from "../shared/ipc";

/**
 * Who answers the macOS Edit menu's Undo, Redo and Select All: the text field
 * with focus, or the editor.
 *
 * On a Mac those keys belong to the menu, so the menu has to carry them — and
 * then the page must still keep Phase 9's rule that Cmd+Z in a field is the
 * field's own undo, never the deck's. A focused input, textarea or editable
 * region gets the browser's own editing command (`execCommand`, which acts on
 * that field's undo stack and selection); anything else becomes the host
 * command the editor already answers. Returns the command to pass on, or
 * `null` when the field took it.
 */
export function routeEditCommand(
  command: EditCommand,
  doc: Document,
  exec: (name: "undo" | "redo" | "selectAll") => void = (name) => void doc.execCommand(name),
): HostCommand | null {
  const active = doc.activeElement as HTMLElement | null;
  const editing = Boolean(
    active &&
      (active.isContentEditable ||
        active.closest('[contenteditable=""], [contenteditable="true"]') !== null ||
        active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA"),
  );
  if (editing) {
    exec(command === "select-all" ? "selectAll" : command);
    return null;
  }
  return command;
}
