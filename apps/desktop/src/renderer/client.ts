import { createHttpClient, memorySessionStore } from "@deckastra/workspace-client";
import type { AccountContext, Session, WorkspaceClient } from "@deckastra/workspace-contracts";

/**
 * The workspace client, pointed at this machine's own service.
 *
 * The whole of D1, in one function. D0 needed a hand-written `WorkspaceClient`
 * over a JSON file; there is nothing to write here, because the desktop now
 * speaks the same HTTP the web app does — to a service running as a child
 * process rather than in a datacentre. `useEditor`, autosave, conflict review and
 * every panel are the cloud's code, unchanged and unaware.
 *
 * The base URL is a path on the renderer's own origin. The main process proxies
 * it to the loopback port and injects the bearer, so **this code never holds the
 * token and never learns the port** — which is what makes "a compromised page
 * cannot reach the service directly" a property of the process boundary rather
 * than of this file's good behaviour.
 */
export const SERVICE_BASE = "/__api";

/**
 * A session, without a sign-in.
 *
 * The service authenticates the *proxy*, not the page, so there is no token for
 * the client to fetch or store — but `useEditor` and the panels still expect a
 * session object, and the workspace and project ids on it are real and are needed
 * to create anything. So the bootstrap reads the account it already has instead
 * of minting one: `/v1/account` is the same endpoint the web app's picker uses,
 * and in local mode it returns the singleton the service seeded at launch.
 */
async function bootstrapSession(context: {
  baseUrl: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<Session> {
  const response = await context.fetch(`${context.baseUrl}/v1/account`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 503
        ? "The workspace service is still starting."
        : `Could not read this workspace (${response.status}).`,
    );
  }

  const account = (await response.json()) as AccountContext;
  const workspace = account.workspaces[0];
  const project = workspace?.projects[0];
  if (!workspace || !project) {
    throw new Error("This install has no workspace yet.");
  }

  return {
    // Not a credential. The proxy holds the real one; this exists because the
    // shape has a `token` and the editor threads a session around.
    token: "proxied",
    userId: account.user.id,
    workspaceId: workspace.id,
    projectId: project.id,
  };
}

export function createDesktopClient(): WorkspaceClient {
  return createHttpClient({
    baseUrl: SERVICE_BASE,
    // Not "web-editor". Every transaction this build writes carries it, and
    // provenance that names the wrong surface is worse than none.
    clientId: "desktop-editor",
    // In memory, not `localStorage`: the session is derived from a service that
    // restarts with the app, and a cached one that outlived it would name a
    // workspace this install no longer has.
    sessionStore: memorySessionStore(),
    bootstrapSession,
  });
}
