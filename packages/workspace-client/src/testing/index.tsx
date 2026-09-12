import { createElement, type ReactNode } from "react";
import type { WorkspaceClient } from "@deckastra/workspace-contracts";

import { createHttpClient, type HttpClientOptions } from "../http";
import { memorySessionStore } from "../session-store";
import { WorkspaceClientProvider } from "../react";

/**
 * A workspace client for tests, over whatever `fetch` the test stubbed.
 *
 * Shipped from the client package rather than copied into each suite: the web
 * app and the editor package both need it, and two copies of a test harness
 * drift the same way two copies of a client do.
 *
 * Deliberately real rather than a hand-written fake: these suites exist to check
 * *what reached the server*, and a fake client would let a change to the request
 * body pass every one of them. The only two things replaced are the ones a test
 * cannot supply — a session, seeded rather than bootstrapped so no suite has to
 * stub `/v1/dev/session`, and the base URL.
 */
export function testWorkspaceClient(overrides: Partial<HttpClientOptions> = {}): WorkspaceClient {
  const sessionStore = memorySessionStore();
  sessionStore.write({
    token: "token",
    userId: "usr_test",
    workspaceId: "wsp_test",
    projectId: "prj_test",
  });

  return createHttpClient({
    baseUrl: "http://api.test",
    clientId: "web-editor",
    sessionStore,
    bootstrapSession: () => {
      throw new Error("A test asked for a session bootstrap; seed one instead.");
    },
    ...overrides,
  });
}

/**
 * A `renderHook`/`render` wrapper providing the client.
 *
 * `inner` composes another wrapper underneath — StrictMode, for the suites that
 * check effect replay — because the provider has to sit outside it for the tree
 * to keep one client across the double render.
 */
export function withWorkspaceClient(
  client: WorkspaceClient = testWorkspaceClient(),
  inner?: (children: ReactNode) => ReactNode,
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const body = inner ? inner(children) : children;
    return createElement(WorkspaceClientProvider, { client, children: body });
  };
}
