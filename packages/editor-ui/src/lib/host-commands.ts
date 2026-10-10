/**
 * What a host command (the desktop's application menu) means to the editor
 * (editor Phase 8). Pure, so the mapping is testable without mounting a shell
 * nothing in this repository can render in jsdom.
 */
import type { HostCommand } from "@deckastra/workspace-contracts";

import type { ThemePreference } from "./chrome-theme";
import type { EditorMode } from "./editor-layout";

export type { HostCommand, SubscribeHostCommands } from "@deckastra/workspace-contracts";

/**
 * Commands the deck list carries out; from the editor they leave the deck first.
 * `all-decks` is one too: the home remembers whether it last showed Projects or
 * Templates, and leaving a deck through "All decks" must land on the decks.
 */
export type DeckListCommand = Extract<HostCommand, "new-deck" | "generate-deck" | "all-decks">;

export function modeForCommand(command: HostCommand): EditorMode | null {
  switch (command) {
    case "mode-design":
      return "design";
    case "mode-motion":
      return "motion";
    case "mode-code":
      return "code";
    default:
      return null;
  }
}

export function themeForCommand(command: HostCommand): ThemePreference | null {
  switch (command) {
    case "theme-system":
      return "system";
    case "theme-light":
      return "light";
    case "theme-dark":
      return "dark";
    default:
      return null;
  }
}

export function isDeckListCommand(command: HostCommand): command is DeckListCommand {
  return command === "new-deck" || command === "generate-deck" || command === "all-decks";
}
