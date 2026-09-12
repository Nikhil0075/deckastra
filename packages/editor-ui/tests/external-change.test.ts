import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";
import animationFixture from "@deckastra/presentation-schema/fixtures/animation-test.mydeck.json" with { type: "json" };

import { useEditor } from "../src/lib/useEditor";

/**
 * A change made somewhere else reaches the open editor (milestone D2).
 *
 * Found by running the app: an agent renamed the deck over MCP, the store had
 * the new title, and the window went on showing the old one. The user's next
 * edit would have met a conflict they did not cause. These cases pin both
 * halves of the fix — the change arrives, and it never arrives *over* unsaved
 * work, which would be the silent loss the autosave queue exists to prevent.
 */

const deck = animationFixture as unknown as PresentationDocument;

function withTitle(title: string): PresentationDocument {
  const copy = structuredClone(deck) as PresentationDocument & { metadata: { title: string } };
  copy.metadata.title = title;
  return copy;
}

interface Service {
  head: string;
  served: PresentationDocument;
  /** What a revert gives back, when a test cares. */
  reverted?: PresentationDocument;
  commit: "ok" | "offline";
  calls: { method: string; url: string }[];
}

/** What the head route now also reports: the change that produced the version. */
let headExtras: Record<string, unknown> = {
  transaction_id: "txn_outside",
  source: "agent",
  intent: "Restyle every slide",
  client_id: "mcp:codex",
};

function stubService(initial: Partial<Service> = {}) {
  const service: Service = { head: "v0", served: deck, commit: "ok", calls: [], ...initial };
  let saved = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? (init?.body ? "POST" : "GET");
      service.calls.push({ method, url });
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

      if (url.endsWith("/transactions")) {
        if (service.commit === "offline") throw new TypeError("Failed to fetch");
        saved += 1;
        // The editor's own save moves the head. A watcher that could not tell
        // this apart from someone else's change would adopt the user's own edit
        // as an outside one and clear their undo for nothing.
        service.head = `saved-${saved}`;
        return ok({ transaction_id: `txn_${saved}`, version_id: service.head });
      }
      if (url.endsWith("/head")) {
        return ok({ presentation_id: "p1", version_id: service.head, ...headExtras });
      }
      if (url.endsWith("/revert")) {
        service.head = "reverted";
        return ok({
          transaction_id: "txn_undo",
          version_id: service.head,
          document: service.reverted ?? deck,
        });
      }
      return ok({ document: service.served, version_id: service.head, can_edit: true });
    }),
  );
  return service;
}

function open(watchHeadMs = 25) {
  return renderHook(
    () =>
      useEditor({
        initialDocument: deck,
        presentationId: "p1",
        initialVersionId: "v0",
        watchHeadMs,
      }),
    { wrapper: withWorkspaceClient() },
  );
}

const title = (document: PresentationDocument) =>
  (document as unknown as { metadata: { title: string } }).metadata.title;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("a change made outside the editor", () => {
  it("reaches an idle editor, and says so", async () => {
    const service = stubService();
    const { result } = open();
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));

    // An agent renames the deck over MCP.
    service.served = withTitle("Renamed by an agent");
    service.head = "v1";

    await waitFor(() => expect(title(result.current.document)).toBe("Renamed by an agent"));
    // Said, not silently swapped: the deck on screen changed without the user
    // touching it, and silence would read as the app misbehaving.
    expect(result.current.save.status).toBe("updated");
  });

  it("never replaces a document with unsaved work in it", async () => {
    const service = stubService({ commit: "offline" });
    const { result } = open();
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));

    act(() => {
      result.current.apply([{ op: "replace", path: "/metadata/title", value: "Typed by the user" }], {
        label: "Retitle",
      });
    });
    await act(() => result.current.saveNow());

    // Meanwhile an agent changes the deck.
    service.served = withTitle("Renamed by an agent");
    service.head = "v1";
    await new Promise((done) => setTimeout(done, 200));

    // The user's words are still on screen. The save will meet a conflict when
    // it reaches the server, and the review that follows keeps both versions —
    // which is the only honest resolution when two people changed one thing.
    expect(title(result.current.document)).toBe("Typed by the user");
    expect(result.current.save.status).not.toBe("updated");
    // It did not even fetch the document it was not going to use.
    const fullReads = service.calls.filter(
      (call) => call.method === "GET" && call.url.endsWith("/presentations/p1"),
    );
    expect(fullReads).toEqual([]);
  });

  it("does not mistake the editor's own save for someone else's", async () => {
    const service = stubService();
    const { result } = open();
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));

    act(() => {
      result.current.apply([{ op: "replace", path: "/metadata/title", value: "Typed by the user" }], {
        label: "Retitle",
      });
    });
    await act(() => result.current.saveNow());
    expect(result.current.save.status).toBe("saved");
    await new Promise((done) => setTimeout(done, 200));

    // Undo still works. Adopting the editor's own save as an outside change
    // would have cleared it for no reason.
    expect(result.current.canUndo).toBe(true);
    expect(result.current.save.status).toBe("saved");
    expect(service.calls.some((call) => call.method === "GET" && call.url.endsWith("/presentations/p1"))).toBe(
      false,
    );
  });

  it("clears local undo when it takes a change in, because the inverses no longer fit", async () => {
    const service = stubService();
    const { result } = open();
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));

    act(() => {
      result.current.apply([{ op: "replace", path: "/metadata/title", value: "Typed by the user" }], {
        label: "Retitle",
      });
    });
    await act(() => result.current.saveNow());
    expect(result.current.canUndo).toBe(true);

    service.served = withTitle("Renamed by an agent");
    service.head = "v-agent";
    await waitFor(() => expect(title(result.current.document)).toBe("Renamed by an agent"));

    // Some inverses are index-addressed and were computed against the document
    // before the outside change. Replaying one now could land on the wrong
    // element, so the history goes rather than lies.
    expect(result.current.canUndo).toBe(false);
  });

  it("does not poll from a window nobody is looking at", async () => {
    const service = stubService();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { result } = open();
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));

    service.head = "v1";
    await new Promise((done) => setTimeout(done, 200));
    expect(service.calls.filter((call) => call.url.endsWith("/head"))).toEqual([]);

    // And catches up the moment it is looked at again.
    visibility.mockReturnValue("visible");
    service.served = withTitle("Renamed while hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(title(result.current.document)).toBe("Renamed while hidden"));
  });

  it("can be switched off", async () => {
    const service = stubService();
    const { result } = open(0);
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));
    service.head = "v1";
    await new Promise((done) => setTimeout(done, 150));
    expect(service.calls.filter((call) => call.url.endsWith("/head"))).toEqual([]);
  });
});


describe("undoing a change that arrived from elsewhere", () => {
  it("offers the change it adopted, and reverts it through the server", async () => {
    // The local history is cleared on adoption, so the toolbar's undo knows
    // nothing about this change. Without the server's inverse there is no way
    // back past someone else's edit at all.
    const service = stubService();
    const { result } = open();
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));

    service.served = withTitle("Renamed by an agent");
    service.reverted = withTitle("Back to how it was");
    service.head = "v1";
    await waitFor(() => expect(title(result.current.document)).toBe("Renamed by an agent"));

    expect(result.current.externalChange).toMatchObject({
      transactionId: "txn_outside",
      clientId: "mcp:codex",
      intent: "Restyle every slide",
    });

    await act(async () => {
      expect(await result.current.undoExternalChange()).toEqual({ ok: true });
    });

    expect(title(result.current.document)).toBe("Back to how it was");
    expect(result.current.externalChange).toBeNull();
    expect(
      service.calls.some((call) => call.url.endsWith("/transactions/txn_outside/revert")),
    ).toBe(true);
  });

  it("refuses while the user's own work is unsaved", async () => {
    const service = stubService({ commit: "offline" });
    const { result } = open();
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));

    service.served = withTitle("Renamed by an agent");
    service.head = "v1";
    await waitFor(() => expect(title(result.current.document)).toBe("Renamed by an agent"));

    act(() => {
      result.current.apply([{ op: "replace", path: "/metadata/title", value: "Mine" }], {
        label: "Retitle",
      });
    });
    await act(() => result.current.saveNow());

    // Reverting would replace the document, and an unsent operation authored
    // against the version about to be superseded can never be sent afterwards.
    await act(async () => {
      const answer = await result.current.undoExternalChange();
      expect(answer.ok).toBe(false);
      expect(answer.message).toMatch(/not saved yet/i);
    });
    expect(service.calls.some((call) => call.url.endsWith("/revert"))).toBe(false);
  });

  it("says so when there is nothing to undo", async () => {
    stubService();
    const { result } = open();
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));
    expect(result.current.externalChange).toBeNull();
    await act(async () => {
      expect((await result.current.undoExternalChange()).ok).toBe(false);
    });
  });
});
