import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

import type { AgentAccess } from "../shared/ipc";

/**
 * Whether an agent may reach this install — the user's decision, remembered.
 *
 * D2 made the credential narrow: an attached agent gets `read`, `write` and
 * `export`, and the authority refuses approval and sharing outright. That is
 * worth having, and it is not consent. An app that published a credential the
 * moment it started would have decided on the user's behalf that anything on
 * their machine able to read one file may edit their decks.
 *
 * So the attachment is published only while this says yes, and it says no until
 * someone clicks. Three consequences, each deliberate:
 *
 * - **Off by default**, including for an install that used to work: after an
 *   update the toggle has to be pressed once. An existing setup quietly keeping a
 *   permission nobody granted is the thing this exists to stop.
 * - **It lapses.** Twelve hours, the life of the grant it publishes. A permission
 *   that never expires is one nobody revisits, and "I turned it on for an
 *   afternoon in March" should not still be true in June.
 * - **Stopping means stopping.** The caller withdraws the attachment *and* tells
 *   the service to refuse the grants it has already issued; the file is only the
 *   way in for the next reader.
 */

/** What an attached agent may do. Never `approve`, never `share`. */
export const AGENT_SCOPES = ["read", "write", "export"] as const;

/** How long a decision lasts. The grant's own life, so the two cannot disagree. */
export const ACCESS_TTL_SECONDS = 12 * 60 * 60;

const OFF: AgentAccess = { allowed: false, scopes: [], expiresAt: null, decidedAt: null };

function accessPath(): string {
  return join(app.getPath("userData"), "agent-access.json");
}

function lapsed(access: AgentAccess): boolean {
  return !access.expiresAt || Date.parse(access.expiresAt) <= Date.now();
}

/**
 * The decision as it stands, which is not always the decision as it was written:
 * an allowance whose time is up reads as off, and says when it ended.
 */
export async function readAgentAccess(): Promise<AgentAccess> {
  let stored: AgentAccess;
  try {
    stored = JSON.parse(await readFile(accessPath(), "utf8")) as AgentAccess;
  } catch {
    // Missing or unreadable both mean nobody has said yes on this machine, which
    // is the safe reading of both.
    return OFF;
  }
  if (!stored?.allowed) return { ...OFF, decidedAt: stored?.decidedAt ?? null };
  if (lapsed(stored)) return { ...stored, allowed: false };
  return stored;
}

export async function setAgentAccess(allow: boolean): Promise<AgentAccess> {
  const now = new Date();
  const next: AgentAccess = allow
    ? {
        allowed: true,
        scopes: [...AGENT_SCOPES],
        expiresAt: new Date(now.getTime() + ACCESS_TTL_SECONDS * 1_000).toISOString(),
        decidedAt: now.toISOString(),
      }
    : { ...OFF, decidedAt: now.toISOString() };

  await writeFile(accessPath(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  return next;
}

/**
 * Tell the service to stop honouring the grants it has already signed.
 *
 * With the launch secret, because only the app's own credential carries
 * `administer` — an agent that could revoke grants could revoke someone else's.
 * Best effort: if the service is not answering there is nothing live to revoke,
 * and the attachment is withdrawn either way.
 */
export async function revokeIssuedGrants(service: { port: number; secret: string }): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/v1/local/agent-access/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${service.secret}`, "content-type": "application/json" },
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
  }
}
