import { describe, expect, it, vi } from "vitest";
import { isWorkspaceError, quotaDetail } from "@deckastra/workspace-contracts";

import { createHttpClient, type FetchLike } from "../src/http";
import { WorkspaceRequestError } from "../src/errors";
import { memorySessionStore } from "../src/session-store";

/**
 * The transport, tested as a contract rather than as a wrapper.
 *
 * These assertions are the behaviour ten call sites used to implement
 * individually. Each one below is a case where getting it wrong is invisible
 * until it matters: a status the caller needed and did not get, a request issued
 * a microtask too late to survive unload, a second session created because two
 * components asked at once.
 */

const seeded = () => {
  const store = memorySessionStore();
  store.write({ token: "tkn", userId: "usr", workspaceId: "wsp", projectId: "prj" });
  return store;
};

function client(fetchImpl: FetchLike) {
  return createHttpClient({
    baseUrl: "http://api.test/",
    clientId: "test-client",
    sessionStore: seeded(),
    fetch: fetchImpl,
  });
}

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

const refusal = (status: number, detail: unknown): Response =>
  ({ ok: false, status, json: async () => ({ detail }) }) as Response;

describe("the HTTP workspace client", () => {
  it("strips a trailing slash from the base URL and sends the bearer token", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ok({ version_id: "v1" }));
    await client(fetchImpl).documents.read("prs_1");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://api.test/v1/presentations/prs_1");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer tkn");
  });

  it("issues the request in the caller's own task", () => {
    // Not a stylistic point. The autosave drain runs from `beforeunload` and
    // relies on `keepalive`, which only helps if the request has actually left
    // before the page is torn down — one deferred microtask loses the save.
    const fetchImpl = vi.fn<FetchLike>(async () => ok({ version_id: "v1" }));
    void client(fetchImpl).documents.commit("prs_1", {
      operations: [],
      intent: "Edit",
      expected_version_id: "v0",
      client_id: "test-client",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the status and the raw detail on a refusal", async () => {
    const fetchImpl: FetchLike = async () => refusal(409, { message: "This deck changed elsewhere." });
    const error = await client(fetchImpl)
      .documents.commit("prs_1", {
        operations: [],
        intent: "Edit",
        expected_version_id: "v0",
        client_id: "test-client",
      })
      .catch((caught: unknown) => caught);

    expect(isWorkspaceError(error)).toBe(true);
    expect((error as WorkspaceRequestError).status).toBe(409);
    expect((error as WorkspaceRequestError).message).toBe("This deck changed elsewhere.");
  });

  it("surfaces a quota refusal as data rather than a sentence", async () => {
    const detail = { limit: "generations", used: 50, allowed: 50, resets_at: "2026-10-01T00:00:00Z" };
    const fetchImpl: FetchLike = async () => refusal(429, detail);
    const error = await client(fetchImpl)
      .generation.run({ instruction: "x", audience: "y", slide_count: 5, repository_ids: [] })
      .catch((caught: unknown) => caught);

    expect(quotaDetail(error)).toEqual(detail);
  });

  it("unwraps a string detail and falls back when there is none", async () => {
    const withString: FetchLike = async () => refusal(500, "Storage unavailable");
    await expect(client(withString).documents.read("prs_1")).rejects.toThrow("Storage unavailable");

    const withNothing: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response;
    await expect(client(withNothing).exports.retry("exp_1")).rejects.toThrow(
      "This export could not be retried.",
    );
  });

  it("reports an unreachable authority as status 0, not as a thrown TypeError", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const error = await client(fetchImpl).health().catch((caught: unknown) => caught);
    expect(isWorkspaceError(error)).toBe(true);
    expect((error as WorkspaceRequestError).status).toBe(0);
  });

  it("lets an abort through untouched", async () => {
    // Every caller that can abort checks for it by name; rethrowing it as a
    // request failure turns "the user navigated away" into "the export failed".
    const fetchImpl: FetchLike = async () => {
      throw new DOMException("Aborted", "AbortError");
    };
    const error = await client(fetchImpl).exports.status("exp_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("sends keepalive only when asked, and never by default", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ok({ version_id: "v1" }));
    const api = client(fetchImpl);
    const body = { operations: [], intent: "Edit", expected_version_id: "v0", client_id: "test-client" };

    await api.documents.commit("prs_1", body);
    await api.documents.commit("prs_1", body, { keepalive: true });

    expect(fetchImpl.mock.calls[0]![1]!.keepalive).toBeUndefined();
    expect(fetchImpl.mock.calls[1]![1]!.keepalive).toBe(true);
  });

  it("refuses a cached answer for a version read and for an explicit fresh read", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ok({ version_id: "v1" }));
    const api = client(fetchImpl);

    await api.documents.readAt("prs_1", "v0");
    await api.documents.read("prs_1", { fresh: true });
    await api.documents.read("prs_1");

    expect(fetchImpl.mock.calls[0]![0]).toBe("http://api.test/v1/presentations/prs_1?at_version=v0");
    expect(fetchImpl.mock.calls[0]![1]!.cache).toBe("no-store");
    expect(fetchImpl.mock.calls[1]![1]!.cache).toBe("no-store");
    expect(fetchImpl.mock.calls[2]![1]!.cache).toBeUndefined();
  });

  it("does not attach a token to the two unauthenticated reads", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ok({ generation: "stub" }));
    const api = client(fetchImpl);

    await api.health();
    await api.shares.redeem("share-token");

    for (const [, init] of fetchImpl.mock.calls) {
      expect((init!.headers as Record<string, string>).Authorization).toBeUndefined();
    }
  });

  it("bootstraps one session even when several callers ask at once", async () => {
    // A fresh browser with three components mounting at once used to create
    // three users.
    const bootstrapSession = vi.fn(async () => ({
      token: "fresh",
      userId: "usr",
      workspaceId: "wsp",
      projectId: null,
    }));
    const api = createHttpClient({
      baseUrl: "http://api.test",
      clientId: "test-client",
      sessionStore: memorySessionStore(),
      bootstrapSession,
      fetch: async () => ok({}),
    });

    await Promise.all([api.session.ensure(), api.session.ensure(), api.session.ensure()]);
    expect(bootstrapSession).toHaveBeenCalledTimes(1);
  });

  it("records the client that authored a patch", async () => {
    // Provenance that names the wrong surface is worse than none, so the id is
    // supplied rather than defaulted.
    expect(client(async () => ok({})).clientId).toBe("test-client");
  });
});
