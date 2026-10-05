"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { WorkspaceClientProvider } from "@deckastra/workspace-client/react";

import { cloudSignIn, webCloudAuth, webWorkspaceClient } from "../lib/client";
import { SignInGate } from "./SignIn";

/**
 * Everything the tree needs that is not the document.
 *
 * A client component under the server-rendered layout, because the workspace
 * client holds a session cache and cannot be constructed on the server. With a
 * hosted Deckastra configured, nothing below renders until someone is signed in,
 * except a shared deck.
 */
export function Providers({ children }: { children: ReactNode }) {
  // A share link is its own credential and is opened by people with no
  // account, so its page is never behind the sign-in.
  const shared = usePathname()?.startsWith("/shared/") ?? false;
  return (
    <WorkspaceClientProvider client={webWorkspaceClient()}>
      <SignInGate enabled={cloudSignIn && !shared} auth={webCloudAuth}>
        {children}
      </SignInGate>
    </WorkspaceClientProvider>
  );
}
