"use client";

import { useEffect, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";

import type { AuthState } from "./auth";
import { webCloudAuth } from "./client";

/**
 * Who the bar's account menu names, and its Sign out, from the hosted sign-in.
 * Undefined with the development sign-in: there is no one to sign out.
 */
export function useAccountMenu() {
  const auth = webCloudAuth();
  const client = useWorkspaceClient();
  const [state, setState] = useState<AuthState>(() => auth?.state() ?? { status: "loading" });
  useEffect(() => auth?.subscribe(setState), [auth]);
  if (!auth || state.status !== "signed-in") return undefined;
  return {
    identity: { name: state.user.name, email: state.user.email },
    onSignOut: () => {
      client.session.clear();
      void auth.signOut();
    },
  };
}
