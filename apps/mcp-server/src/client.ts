import { createHttpClient, memorySessionStore } from "@deckastra/workspace-client";
import type { AccountContext, Session, WorkspaceClient } from "@deckastra/workspace-contracts";

import { NotRunning, type Attached } from "./attach";

/**
 * The workspace authority, as the MCP server sees it (milestone D2.1).
 *
 * There is nothing here but configuration, and that is the design: this server is
 * a **thin adapter over `WorkspaceClient`**, not a second implementation of the
 * product. Every rule the editor obeys — optimistic concurrency, proposal before
 * apply, server-computed risk, the authorization ladder — holds for an agent
 * because an agent's request is the same request, arriving at the same routes.
 *
 * The one thing this file establishes is *who is asking*. The launch secret is
 * the session's token, so `send()` carries it as the bearer with no special
 * casing anywhere in the client.
 */
export function createAttachedClient(attached: Attached, clientLabel: string): WorkspaceClient {
  return createHttpClient({
    baseUrl: attached.baseUrl,
    // Prefixed so a transaction's provenance says which external client wrote it.
    // `patch.ts` reserves a non-web origin for exactly this, and a record that
    // said "web-editor" for an agent's edit would make the history unreadable at
    // the moment someone most needs it.
    clientId: `mcp:${clientLabel}`.slice(0, 60),
    // In memory. The session is derived from a service that dies with the app,
    // and a cached one written to disk would be a second copy of the secret.
    sessionStore: memorySessionStore(),
    bootstrapSession: async ({ baseUrl, fetch: doFetch }): Promise<Session> => {
      const response = await doFetch(`${baseUrl}/v1/account`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${attached.attachment.grant}`,
        },
      });
      if (!response.ok) {
        throw new NotRunning(
          response.status === 401 || response.status === 403
            ? "Deckastra refused this grant — it expired, or the app restarted. Reconnect to pick up a fresh one."
            : `Deckastra's workspace service answered ${response.status} while reading the account.`,
        );
      }

      const account = (await response.json()) as AccountContext;
      const workspace = account.workspaces[0];
      const project = workspace?.projects[0];
      if (!workspace || !project) {
        throw new NotRunning("This Deckastra install has no workspace yet. Open the app once first.");
      }

      return {
        // The only credential this process has: a grant that can read, write and
        // export, and cannot approve or share. The authority enforces that, so a
        // tool added here in future cannot quietly exceed it.
        token: attached.attachment.grant,
        userId: account.user.id,
        workspaceId: workspace.id,
        projectId: project.id,
      };
    },
  });
}
