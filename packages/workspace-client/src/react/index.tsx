"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceClient } from "@deckastra/workspace-contracts";

/**
 * The workspace authority, in context.
 *
 * A provider rather than a module-level singleton because the desktop mounts a
 * client for a loopback sidecar, the web mounts one for the API, and a test mounts
 * a fake — and a singleton makes the last of those a global mutation. It also
 * means a second window pointed at a second workspace is a nesting problem rather
 * than an impossible one.
 */
const WorkspaceClientContext = createContext<WorkspaceClient | null>(null);

export function WorkspaceClientProvider({
  client,
  children,
}: {
  client: WorkspaceClient;
  children: ReactNode;
}) {
  return (
    <WorkspaceClientContext.Provider value={client}>{children}</WorkspaceClientContext.Provider>
  );
}

/**
 * The client for this surface.
 *
 * Throws rather than falling back to a default. A component that silently talked
 * to `http://localhost:8000` because nobody wired a provider is exactly the class
 * of bug this package exists to remove, and it would only show up in production.
 */
export function useWorkspaceClient(): WorkspaceClient {
  const client = useContext(WorkspaceClientContext);
  if (!client) {
    throw new Error(
      "No WorkspaceClient in context. Wrap this tree in <WorkspaceClientProvider>.",
    );
  }
  return client;
}

/** For surfaces that must render without one, such as an error boundary above the provider. */
export function useOptionalWorkspaceClient(): WorkspaceClient | null {
  return useContext(WorkspaceClientContext);
}
