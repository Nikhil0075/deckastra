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

/**
 * What a membership grants *right now* (D5.4), which for a mirrored workspace is
 * not always what the stored role says.
 *
 * `authoritative` — a local workspace: the row is the decision, nothing to confirm.
 * `confirmed` — a mirror, vouched for by the server recently.
 * `stale` — a mirror, not heard from lately. Still works; worth saying.
 * `lapsed` — a mirror nobody has confirmed for long enough. Grants nothing.
 * `revoked` — the server said the membership is gone. Grants nothing.
 *
 * A workspace whose access does not authorize is still listed, with no projects.
 * The person knows it exists — it is on their machine — so dropping it from the
 * list looks like data loss, where naming it with a reason is something they can
 * act on.
 */
export type WorkspaceAccess =
  | "authoritative"
  | "confirmed"
  | "stale"
  | "lapsed"
  | "revoked";

export interface AccountWorkspace {
  id: string;
  name: string;
  role: Role;
  origin: WorkspaceOrigin;
  access: WorkspaceAccess;
  /** When the server last vouched for the membership; null in a local workspace. */
  confirmed_at: string | null;
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
