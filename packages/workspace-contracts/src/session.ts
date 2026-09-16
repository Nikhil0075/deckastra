import type { Role } from "./roles";

/**
 * Who the caller is, and where their work goes.
 *
 * The desktop implementation seeds exactly one of these at first launch and never
 * changes it; the web implementation gets it from `/v1/dev/session` today and
 * from a real sign-in later. Neither difference reaches a component.
 */
export interface Session {
  token: string;
  userId: string;
  workspaceId: string;
  projectId: string | null;
}

export interface AccountProject {
  id: string;
  name: string;
  description: string | null;
}

/**
 * Where a workspace's authority lives (D5.1).
 *
 * `local` is a workspace this machine owns outright — the personal one a desktop
 * install seeds, whose decks have never left the device. `cloud` is a mirror of a
 * workspace the server owns, kept locally so the app works offline.
 *
 * It matters to a picker: "move this deck to the company workspace" is a
 * decision about whether the deck leaves the machine, and a list that renders
 * both kinds identically hides the only part that cannot be undone.
 */
export type WorkspaceOrigin = "local" | "cloud";

export interface AccountWorkspace {
  id: string;
  name: string;
  role: Role;
  origin: WorkspaceOrigin;
  projects: AccountProject[];
}

export interface AccountContext {
  user: { id: string; email: string; name: string | null };
  workspaces: AccountWorkspace[];
}

/** What `/health` answers. `generation` says whether a real key is configured. */
export interface HealthReport {
  generation: "model" | "stub";
}
