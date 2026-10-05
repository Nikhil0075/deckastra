"use client";

import { createHttpClient } from "@deckastra/workspace-client";
import type { WorkspaceClient } from "@deckastra/workspace-contracts";

import { createCloudAuth, type CloudAuth } from "./auth";
import { cloudConfig } from "./cloud";

/**
 * The one place this app decides where the workspace authority lives.
 *
 * There used to be ten of these lines. That was survivable while every surface
 * talked to the same API over the same transport, and stopped being survivable
 * the moment a second shell existed: a component that reads
 * `NEXT_PUBLIC_API_URL` cannot be mounted anywhere but here.
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time, so this has to stay a literal
 * property access rather than a lookup through a variable.
 *
 * With `NEXT_PUBLIC_DECKASTRA_CLOUD` set, the app signs in to that hosted
 * Deckastra (`lib/auth.ts`) and talks to its API. Without it, the development
 * sign-in against `NEXT_PUBLIC_API_URL`.
 */
const CLOUD = cloudConfig();
// A hosted environment's tokens are good only at its own API, so naming one
// decides the API too; a leftover `NEXT_PUBLIC_API_URL` in `.env.local` must
// not send them to a local server that cannot check them.
const API = CLOUD?.apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

let client: WorkspaceClient | undefined;
let auth: CloudAuth | null | undefined;

/** Whether this build signs in to a hosted Deckastra. The same answer on the server and in the browser. */
export const cloudSignIn = CLOUD !== null;

/** The hosted sign-in, or null when this build uses the development one (and always on the server). */
export function webCloudAuth(): CloudAuth | null {
  if (auth === undefined) auth = CLOUD && typeof window !== "undefined" ? createCloudAuth(CLOUD) : null;
  return auth;
}

export function webWorkspaceClient(): WorkspaceClient {
  // Memoized because the session cache and its in-flight de-duplication live on
  // the client: two clients means two bootstraps and, on a fresh browser, two
  // users.
  const cloud = webCloudAuth();
  client ??= createHttpClient({
    baseUrl: API,
    clientId: "web-editor",
    ...(cloud ? { sessionStore: cloud.sessionStore, bootstrapSession: cloud.bootstrap } : {}),
  });
  return client;
}
