"use client";

import { createHttpClient } from "@deckastra/workspace-client";
import type { WorkspaceClient } from "@deckastra/workspace-contracts";

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
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

let client: WorkspaceClient | undefined;

export function webWorkspaceClient(): WorkspaceClient {
  // Memoized because the session cache and its in-flight de-duplication live on
  // the client: two clients means two bootstraps and, on a fresh browser, two
  // users.
  client ??= createHttpClient({ baseUrl: API, clientId: "web-editor" });
  return client;
}
