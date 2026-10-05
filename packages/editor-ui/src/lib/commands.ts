/**
 * The command palette's list (roadmap 08 §1.5): every command the editor can
 * carry out by name, findable by typing.
 *
 * The future-proof entry point. A new feature adds an entry here rather than a
 * button somewhere, and the palette, the application menu and the keyboard all
 * reach it through one dispatcher: each entry names a `HostCommand`, which is
 * exactly what the desktop's menu sends, so the shell has one place that knows
 * what "colors" or "panel-notes" means. Pure, so finding is testable without a
 * palette.
 */
import type { HostCommand } from "@deckastra/workspace-contracts";

export interface PaletteCommand {
  command: HostCommand;
  label: string;
  group: "Assistant" | "Edit" | "View" | "Panels" | "Theme" | "Deck";
  /** Other words someone might type for it. */
  keywords?: string;
  /** Shown, not bound: the key belongs to whichever handler already has it. */
  shortcut?: string;
  /** Only where the shell can leave the deck (a host with a deck list). */
  needsExit?: boolean;
  /** Only where the host has a Settings screen to open. */
  needsSettings?: boolean;
  /** Also offered on the home, where there is no deck to act on. */
  home?: boolean;
}

export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { command: "assistant", label: "Open the assistant", group: "Assistant", keywords: "ai ask help change write" },
  { command: "undo", label: "Undo", group: "Edit", shortcut: "Ctrl+Z" },
  { command: "redo", label: "Redo", group: "Edit", shortcut: "Ctrl+Shift+Z" },
  { command: "version-history", label: "Version history", group: "Edit", keywords: "restore earlier versions" },
  { command: "colors", label: "Colours…", group: "Edit", keywords: "colors palette named brand" },
  { command: "present", label: "Present", group: "Deck", keywords: "slideshow play start" },
  { command: "mode-design", label: "Design", group: "View", keywords: "mode inspector" },
  { command: "mode-motion", label: "Motion", group: "View", keywords: "mode animation timeline transition" },
  { command: "mode-code", label: "Code", group: "View", keywords: "mode json source" },
  { command: "panel-notes", label: "Speaker notes", group: "Panels", shortcut: "Ctrl+Alt+4", keywords: "dock" },
  { command: "panel-dock", label: "Timeline", group: "Panels", shortcut: "Ctrl+Alt+5", keywords: "dock motion" },
  { command: "panel-tools", label: "Insert tools", group: "Panels", shortcut: "Ctrl+Alt+1", keywords: "rail" },
  { command: "panel-slides", label: "Slides", group: "Panels", shortcut: "Ctrl+Alt+2", keywords: "strip thumbnails" },
  { command: "panel-inspector", label: "Side panel", group: "Panels", shortcut: "Ctrl+Alt+3", keywords: "inspector" },
  { command: "panels-focus", label: "Focus on the slide", group: "Panels", shortcut: "Ctrl+.", keywords: "hide everything" },
  { command: "panels-all", label: "Show everything", group: "Panels" },
  { command: "theme-system", label: "Match the system", group: "Theme", keywords: "appearance light dark", home: true },
  { command: "theme-light", label: "Light", group: "Theme", keywords: "appearance", home: true },
  { command: "theme-dark", label: "Dark", group: "Theme", keywords: "appearance night", home: true },
  { command: "all-decks", label: "All decks", group: "Deck", keywords: "home library list", needsExit: true, home: true },
  { command: "new-deck", label: "New deck", group: "Deck", keywords: "blank create", needsExit: true, home: true },
  { command: "generate-deck", label: "Generate a deck", group: "Deck", keywords: "write create ai", needsExit: true, home: true },
  { command: "open-settings", label: "Settings…", group: "View", keywords: "preferences account privacy agents", needsSettings: true, home: true },
];

/** One row of the palette: a command, or the assistant asked in the person's own words. */
export type PaletteItem = { kind: "command"; entry: PaletteCommand } | { kind: "ask"; text: string };

/**
 * What the palette shows for `query`. Every word typed has to appear in the
 * label, group or keywords; a label that starts with the query ranks first.
 * Anything typed is also offered to the assistant, last, so a sentence that
 * matches no command is still somewhere to go.
 */
export function findCommands(
  query: string,
  options: { canExit: boolean; canOpenSettings?: boolean; place?: "deck" | "home" },
): PaletteItem[] {
  const home = options.place === "home";
  const available = PALETTE_COMMANDS.filter(
    (entry) =>
      (home ? entry.home === true : true) &&
      (home || options.canExit || !entry.needsExit) &&
      (options.canOpenSettings || !entry.needsSettings),
  );
  const text = query.trim();
  if (!text) return available.map((entry) => ({ kind: "command", entry }));
  const words = text.toLowerCase().split(/\s+/);
  const scored = available
    .map((entry) => {
      const label = entry.label.toLowerCase();
      const haystack = `${label} ${entry.group.toLowerCase()} ${entry.keywords ?? ""}`;
      if (!words.every((word) => haystack.includes(word))) return null;
      const score = label.startsWith(text.toLowerCase()) ? 0 : label.includes(words[0]!) ? 1 : 2;
      return { entry, score };
    })
    .filter((hit): hit is { entry: PaletteCommand; score: number } => hit !== null)
    .sort((a, b) => a.score - b.score);
  return [...scored.map(({ entry }) => ({ kind: "command" as const, entry })), { kind: "ask", text }];
}
