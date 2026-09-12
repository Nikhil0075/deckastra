"use client";

import type { ReactNode } from "react";
import { WorkspaceClientProvider } from "@deckastra/workspace-client/react";

import { webWorkspaceClient } from "../lib/client";

/**
 * Everything the tree needs that is not the document.
 *
 * A client component under the server-rendered layout, because the workspace
 * client holds a session cache and cannot be constructed on the server.
 */
export function Providers({ children }: { children: ReactNode }) {
  return <WorkspaceClientProvider client={webWorkspaceClient()}>{children}</WorkspaceClientProvider>;
}
