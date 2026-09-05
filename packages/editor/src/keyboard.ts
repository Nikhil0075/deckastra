/**
 * Keyboard shortcuts (doc 04 §10.1, §14.5; doc 05 §13).
 *
 * The map is data rather than a switch statement inside an event handler, for
 * three reasons: a shortcuts help panel can render it, a conflict is detectable
 * by a test rather than by a user, and the same bindings drive both the editor
 * and present mode without being written twice.
 */

export type EditorCommand =
  | "delete"
  | "duplicate"
  | "copy"
  | "cut"
  | "paste"
  | "selectAll"
  | "group"
  | "ungroup"
  | "undo"
  | "redo"
  | "undoLastAgentChange"
  | "bringForward"
  | "sendBackward"
  | "bringToFront"
  | "sendToBack"
  | "escape"
  | "cycleNext"
  | "cyclePrevious"
  | "nudgeUp"
  | "nudgeDown"
  | "nudgeLeft"
  | "nudgeRight"
  | "toggleLock"
  | "toggleHidden"
  | "enterTextEdit"
  | "present";

export interface KeyBinding {
  key: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  command: EditorCommand;
  label: string;
}

export const BINDINGS: KeyBinding[] = [
  { key: "Backspace", command: "delete", label: "Delete selection" },
  { key: "Delete", command: "delete", label: "Delete selection" },
  { key: "d", mod: true, command: "duplicate", label: "Duplicate" },
  { key: "c", mod: true, command: "copy", label: "Copy" },
  { key: "x", mod: true, command: "cut", label: "Cut" },
  { key: "v", mod: true, command: "paste", label: "Paste" },
  { key: "a", mod: true, command: "selectAll", label: "Select all" },
  { key: "g", mod: true, command: "group", label: "Group" },
  { key: "g", mod: true, shift: true, command: "ungroup", label: "Ungroup" },
  { key: "z", mod: true, command: "undo", label: "Undo" },
  { key: "z", mod: true, shift: true, command: "redo", label: "Redo" },
  // AI-specific undo (doc 01 §4.2): walks back to the last agent change rather
  // than the last change of any kind.
  { key: "z", mod: true, alt: true, command: "undoLastAgentChange", label: "Undo last AI change" },
  { key: "]", mod: true, command: "bringForward", label: "Bring forward" },
  { key: "[", mod: true, command: "sendBackward", label: "Send backward" },
  { key: "]", mod: true, shift: true, command: "bringToFront", label: "Bring to front" },
  { key: "[", mod: true, shift: true, command: "sendToBack", label: "Send to back" },
  { key: "Escape", command: "escape", label: "Back out one level" },
  { key: "Tab", command: "cycleNext", label: "Next sibling" },
  { key: "Tab", shift: true, command: "cyclePrevious", label: "Previous sibling" },
  { key: "ArrowUp", command: "nudgeUp", label: "Nudge up" },
  { key: "ArrowDown", command: "nudgeDown", label: "Nudge down" },
  { key: "ArrowLeft", command: "nudgeLeft", label: "Nudge left" },
  { key: "ArrowRight", command: "nudgeRight", label: "Nudge right" },
  { key: "l", mod: true, shift: true, command: "toggleLock", label: "Lock / unlock" },
  { key: "h", mod: true, shift: true, command: "toggleHidden", label: "Show / hide" },
  { key: "Enter", command: "enterTextEdit", label: "Edit text" },
  { key: "p", mod: true, shift: true, command: "present", label: "Present" },
];

export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface ResolvedCommand {
  command: EditorCommand;
  binding: KeyBinding;
  /** Shift is also a modifier for nudge distance, so it is surfaced separately. */
  shift: boolean;
}

/**
 * Match an event to a command.
 *
 * Bindings are checked most-specific first: `Cmd+Shift+Z` must not match the
 * `Cmd+Z` binding, which is what happens when a handler tests modifiers loosely.
 */
export function resolveCommand(event: KeyEventLike): ResolvedCommand | undefined {
  const mod = Boolean(event.metaKey || event.ctrlKey);
  const shift = Boolean(event.shiftKey);
  const alt = Boolean(event.altKey);
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  const candidates = BINDINGS.filter(
    (binding) =>
      (binding.key.length === 1 ? binding.key.toLowerCase() : binding.key) === key &&
      Boolean(binding.mod) === mod &&
      Boolean(binding.shift) === shift &&
      Boolean(binding.alt) === alt,
  );

  const binding = candidates[0];
  return binding ? { command: binding.command, binding, shift } : undefined;
}

/** Formatted for a help panel or a menu. */
export function describeBinding(binding: KeyBinding, platform: "mac" | "other" = "other"): string {
  const parts: string[] = [];
  if (binding.mod) parts.push(platform === "mac" ? "⌘" : "Ctrl");
  if (binding.shift) parts.push(platform === "mac" ? "⇧" : "Shift");
  if (binding.alt) parts.push(platform === "mac" ? "⌥" : "Alt");

  const key =
    binding.key.length === 1
      ? binding.key.toUpperCase()
      : binding.key.replace("Arrow", "").replace("Backspace", "⌫");

  parts.push(key);
  return parts.join(platform === "mac" ? "" : "+");
}

/**
 * Shortcuts that must not fire while the user is typing.
 *
 * Without this, typing "d" in a text box duplicates the element and typing a
 * space scrolls the slide — the classic way an editor feels broken the first time
 * someone writes a sentence in it.
 */
const SAFE_WHILE_TYPING = new Set<EditorCommand>(["escape", "undo", "redo", "copy", "cut", "paste"]);

export function isAllowedWhileTyping(command: EditorCommand): boolean {
  return SAFE_WHILE_TYPING.has(command);
}
