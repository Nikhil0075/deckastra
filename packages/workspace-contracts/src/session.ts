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

export interface AccountWorkspace {
  id: string;
  name: string;
  role: Role;
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
