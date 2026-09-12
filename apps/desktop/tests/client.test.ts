import { describe, expect, it, vi } from "vitest";

import { SERVICE_BASE, createDesktopClient } from "../src/renderer/client";

/**
 * The desktop's workspace client.
 *
 * There is almost nothing to test here, and that is the result worth pinning:
 * D0 needed a hand-written `WorkspaceClient` over a JSON file, and D1 needs one
 * `createHttpClient` call, because the desktop now speaks the same HTTP the web
 * app does. What these cases guard is the part that is *not* shared — where it
 * points, and what it must never carry.
 */

const account = {
  user: { id: "usr_local", email: "local@deckastra.invalid", name: "You" },
  workspaces: [
    { id: "wsp_local", name: "You's workspace", role: "owner", projects: [{ id: "prj_local", name: "First", description: null }] },
  ],
};

function stubFetch(handler?: (url: string, init?: RequestInit) => Response) {
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    if (handler) return handler(url, init);
    return { ok: true, status: 200, json: async () => account } as Response;
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

describe("the desktop workspace client", () => {
  it("talks to the proxy on its own origin, not to a loopback port", async () => {
    // The whole security argument in one assertion: this code cannot name the
    // service's host, because it does not know it. A relative path resolves
    // against the renderer's origin, and the main process does the rest.
    expect(SERVICE_BASE).toBe("/__api");
    expect(SERVICE_BASE).not.toContain("127.0.0.1");
    expect(SERVICE_BASE).not.toContain("http");

    const fetchStub = stubFetch();
    await createDesktopClient().session.ensure();
    expect(fetchStub.mock.calls[0]![0]).toBe("/__api/v1/account");
    vi.unstubAllGlobals();
  });

  it("never sends a bearer token, because it does not have one", async () => {
    const fetchStub = stubFetch();
    const client = createDesktopClient();
    await client.session.ensure();
    await client.documents.read("doc_1").catch(() => {});

    for (const [, init] of fetchStub.mock.calls) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      // A real token would be a credential sitting in a renderer that also runs
      // document content. The proxy injects the only one that exists.
      expect(headers.Authorization ?? "").not.toContain("Bearer local");
    }
    vi.unstubAllGlobals();
  });

  it("records the client that authored a patch", () => {
    stubFetch();
    // Not "web-editor". Provenance that names the wrong surface is worse than
    // none, and every transaction this build writes carries it.
    expect(createDesktopClient().clientId).toBe("desktop-editor");
    vi.unstubAllGlobals();
  });

  it("derives the session from the account the service already seeded", async () => {
    stubFetch();
    const session = await createDesktopClient().session.ensure();
    expect(session.workspaceId).toBe("wsp_local");
    expect(session.projectId).toBe("prj_local");
    vi.unstubAllGlobals();
  });

  it("says the service is starting rather than reporting a request failure", async () => {
    // 503 is what the proxy answers before the sidecar is up. The distinction
    // matters: one is a condition that resolves itself, the other is a bug.
    stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }) as Response);
    await expect(createDesktopClient().session.ensure()).rejects.toThrow(/still starting/);
    vi.unstubAllGlobals();
  });

  it("refuses to invent a session when the install has no workspace", async () => {
    stubFetch(
      () =>
        ({ ok: true, status: 200, json: async () => ({ user: account.user, workspaces: [] }) }) as Response,
    );
    await expect(createDesktopClient().session.ensure()).rejects.toThrow(/no workspace/);
    vi.unstubAllGlobals();
  });
});
