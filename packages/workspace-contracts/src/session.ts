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

/**
 * What this deployment can do, so a surface can be **absent rather than broken**.
 *
 * Sharing is refused wholesale on a local install — a link that machine mints
 * leads nowhere — and the panel used to find that out by calling the route and
 * rendering its 404 as "Not found.", which reads as a bug in a feature that was
 * never available. A 404 is not a capability signal either way: a missing deck
 * and a denied one answer the same, by design.
 *
 * Deployment-wide rather than per workspace, because that is what the refusal
 * keys on. A cloud server's own workspaces are `local` in the D5.1 sense and
 * share perfectly well.
 */
/**
 * The signed-in account's AI credits (`GET /v1/account/credits`, roadmap 08
 * §3.3). Read and shown, never computed by a client: the ledger reserves and
 * reconciles on the server. `plan` is the account's plan name ("free").
 */
export interface CreditBalance {
  plan: string;
  monthly_allowance: number;
  remaining_credits: number;
  period_start: string;
  period_end: string;
}

/**
 * What each hosted AI task can do right now (`GET /v1/account/capabilities`).
 *
 * The model map is empty until a model is qualified, so every task may be
 * unavailable with a reason. Render that honestly; never guess a model.
 */
export interface AccountTaskCapability {
  available: boolean;
  model: string | null;
  reason: string | null;
  /** The smallest reservation one call makes, in US dollars. Present only when available. */
  minimum_reservation_usd?: number;
}

export interface AccountCapabilities {
  provider: string;
  tasks: Record<string, AccountTaskCapability>;
}

/**
 * A cloud account deletion request (`DELETE /v1/account`). The receipt is
 * readable without a session, because the request ends the session.
 */
export interface AccountDeletion {
  id: string;
  status: string;
  message?: string;
}

export interface Capabilities {
  sharing: boolean;
  /**
   * Whether a generation can pause at its outline for review (editor Phase 6).
   * It needs a durable checkpoint store; where there is none, "review the
   * outline first" is not offered rather than offered and refused. Optional
   * because a server older than the field says nothing, which means no.
   */
  checkpoints?: boolean;
  /**
   * What pressing Generate will do here (final package review, item 19).
   * Optional because an older server says nothing.
   */
  generation?: GenerationStatus;
  assistant?: import("./assistant").AssistantCapabilities;
}

/**
 * Which provider writes a generated deck, whether it can, and why not.
 *
 * `stub` is the development planner (a template, not a model) and only a
 * checkout answers it; `none` is an installed product with nothing set up.
 */
export interface GenerationStatus {
  provider: "cloud" | "local" | "hybrid" | "vertex" | "stub" | "none" | "unavailable" | "misconfigured";
  available: boolean;
  reason: string | null;
}

export interface AccountContext {
  user: { id: string; email: string; name: string | null };
  workspaces: AccountWorkspace[];
  capabilities: Capabilities;
}

/** What `/health` answers. `generation` says whether a real key is configured. */
export interface HealthReport {
  generation: "model" | "stub" | "unavailable";
}
