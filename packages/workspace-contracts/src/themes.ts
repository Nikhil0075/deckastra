import type { PatchOperation } from "@deckastra/presentation-schema";

export interface SavedTheme {
  id: string;
  name: string;
  is_default: boolean;
}

export interface ThemeList {
  themes: SavedTheme[];
}

/**
 * A theme proposal: the portable definition plus the patch that adopts it.
 *
 * Fetching one is read-only. The operations are applied through the editor's own
 * `apply`, so adopting a theme keeps pending edits, undo and autosave — a themed
 * document carries both the id and the resolved tokens, because a `themeId` alone
 * would make the deck unopenable outside the workspace that owns the theme.
 */
export interface ThemeProposal {
  theme: SavedTheme;
  operations: PatchOperation[];
}

export interface SaveThemeRequest {
  name: string;
  definition: unknown;
  is_default: boolean;
}
