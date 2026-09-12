import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";

import { useEditor } from "../src/lib/useEditor";
import { recoveryKey, recoveryPointer } from "../src/lib/editor-recovery";
import { recoveryLocks } from "./helpers/recovery-locks";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";
import { createElement, StrictMode } from "react";
import { openRecoveryJournal } from "../src/lib/editor-recovery";
import type { ConflictReview } from "../src/lib/reconcile";
import { applyPatch } from "@deckastra/transactions";

/**
 * Autosave, tested as a persistence contract rather than as a hook.
 *
 * The bug this suite exists for: `flush` used to clear the queue *before* the
 * request, so a 409, a 500 or an offline network discarded the operations
 * permanently. Nothing looked wrong — the in-memory document still showed the
 * edit — until a reload. So the assertions here are all of one shape: **what
 * reached the server**, across a failure and a retry.
 *
 * A stub `fetch` rather than a mock server, because the interesting states are
 * the ones a real server makes hard to produce on demand: offline, 409, a save
 * that is still in flight when the next edit arrives.
 */

interface Sent {
  operations: PatchOperation[];
  expected_version_id: string;
  intent: string;
}

/** A controllable transactions endpoint. */
function stubApi() {
  const sent: Sent[] = [];
  let version = 0;
  /** Set to make the next call fail; cleared after it fires. */
  let failure: null | "offline" | 409 | 500 = null;
  /** Set to hold the next call open until released. */
  let gate: null | { release: () => void; opened: Promise<void> } = null;

  const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent;

    if (gate) {
      const held = gate;
      gate = null;
      await held.opened;
    }

    const mode = failure;
    failure = null;

    if (mode === "offline") throw new TypeError("Failed to fetch");
    if (mode === 409) {
      return response(409, { detail: { message: "This deck changed elsewhere." } });
    }
    if (mode === 500) return response(500, { detail: "Server error" });

    sent.push(body);
    version += 1;
    return response(200, { version_id: `v${version}` });
  });

  return {
    sent,
    fetchStub,
    failNext(mode: "offline" | 409 | 500) {
      failure = mode;
    },
    holdNext() {
      let release!: () => void;
      const opened = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { release, opened };
      return () => release();
    },
    /** Every operation the server actually accepted, in order. */
    accepted(): PatchOperation[] {
      return sent.flatMap((call) => call.operations);
    },
  };
}

function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

let api: ReturnType<typeof stubApi>;
let document: PresentationDocument;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(navigator, "locks", { configurable: true, value: recoveryLocks() });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api = stubApi();
  vi.stubGlobal("fetch", api.fetchStub);
  document = loadFixture("technical") as PresentationDocument;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function editor(initialVersionId = "v0") {
  const hook = renderHook(
    () =>
      useEditor({
        initialDocument: document,
        presentationId: "prs_test",
        initialVersionId,
      }),
    { wrapper: withWorkspaceClient() },
  );
  await waitFor(() => expect(hook.result.current.recoveryReady).toBe(true));
  return hook;
}

function currentRecoveryKey() {
  return recoveryKey("prs_test", sessionStorage.getItem(recoveryPointer("prs_test"))!);
}

/** A minimal but real operation: retitle the deck. */
function retitle(title: string): PatchOperation[] {
  return [{ op: "replace", path: "/metadata/title", value: title }];
}

describe("autosave", () => {
  it("restores its journal during StrictMode's effect replay", async () => {
    const saved = await openRecoveryJournal("prs_test");
    const snapshot = structuredClone(document); snapshot.metadata.title = "Strict recovery";
    saved.write({ format: 1, versionId: "v0", document: snapshot, operations: retitle("Strict recovery"), labels: ["Retitle"] });
    saved.close();
    const hook = renderHook(() => useEditor({ initialDocument: document, presentationId: "prs_test", initialVersionId: "v0" }), {
      wrapper: withWorkspaceClient(undefined, (children) => createElement(StrictMode, null, children)),
    });
    await waitFor(() => expect(hook.result.current.recoveryReady).toBe(true));
    expect(hook.result.current.document.metadata.title).toBe("Strict recovery");
    expect(currentRecoveryKey()).toBe(saved.key);
  });

  it("a late acknowledgement after unmount only clears the old owner's journal", async () => {
    const first = await editor();
    act(() => first.result.current.apply(retitle("Old request"), { label: "Retitle" }));
    const firstKey = currentRecoveryKey();
    const release = api.holdNext();
    let saving!: Promise<boolean>;
    act(() => { saving = first.result.current.saveNow(); });
    first.unmount();
    const second = await editor();
    const secondKey = currentRecoveryKey();
    act(() => second.result.current.apply(retitle("New editor"), { label: "Retitle" }));
    release();
    await act(async () => { await saving; });
    expect(localStorage.getItem(firstKey)).toBeNull();
    expect(JSON.parse(localStorage.getItem(secondKey)!).document.metadata.title).toBe("New editor");
  });

  it("one editor's acknowledgement cannot erase another mounted editor's offline work", async () => {
    const first = await editor();
    act(() => first.result.current.apply(retitle("Offline first tab"), { label: "Retitle" }));
    const firstKey = currentRecoveryKey();
    api.failNext("offline");
    await act(async () => { await first.result.current.saveNow(); });
    const second = await editor();
    const secondKey = currentRecoveryKey();
    expect(secondKey).not.toBe(firstKey);
    expect(second.result.current.document.metadata.title).toBe(document.metadata.title);
    act(() => second.result.current.apply(retitle("Saved second tab"), { label: "Retitle" }));
    await act(async () => { expect(await second.result.current.saveNow()).toBe(true); });
    expect(localStorage.getItem(secondKey)).toBeNull();
    expect(JSON.parse(localStorage.getItem(firstKey)!).document.metadata.title).toBe("Offline first tab");
  });

  it("offers an abandoned copy and refuses to replace newer local work with it", async () => {
    const first = await editor();
    act(() => first.result.current.apply(retitle("Abandoned"), { label: "Retitle" }));
    const firstKey = currentRecoveryKey(); first.unmount();
    sessionStorage.clear();
    const second = await editor("server-v2");
    expect(second.result.current.recoveryCopies).toEqual([expect.objectContaining({ key: firstKey, active: false })]);
    act(() => second.result.current.apply(retitle("New local"), { label: "Retitle" }));
    await expect(second.result.current.recoverCopy(firstKey)).rejects.toThrow("this tab's edits");
    expect(second.result.current.document.metadata.title).toBe("New local");
    expect(localStorage.getItem(firstKey)).not.toBeNull();
  });

  it("recovers a closed tab against its historical base when the server advanced", async () => {
    const first = await editor();
    act(() => first.result.current.apply(retitle("Abandoned"), { label: "Retitle" }));
    const firstKey = currentRecoveryKey(); first.unmount(); sessionStorage.clear();
    const second = await editor("server-v2");
    await act(async () => { await second.result.current.recoverCopy(firstKey); });
    expect(second.result.current.document.metadata.title).toBe("Abandoned");
    expect(second.result.current.save.status).toBe("conflict");
    expect(await second.result.current.saveNow()).toBe(false);
    expect(api.fetchStub).not.toHaveBeenCalled();
  });

  it("keeps the queue when the network fails, and a retry persists it exactly once", async () => {
    const { result } = await editor();

    api.failNext("offline");
    act(() => result.current.apply(retitle("First"), { label: "Retitle" }));
    await act(async () => {
      await result.current.saveNow();
    });

    expect(result.current.save.status).toBe("error");
    expect(api.accepted()).toHaveLength(0);

    // The Retry button. Before the fix this posted an empty queue and reported
    // success, and the edit was gone.
    await act(async () => {
      await result.current.saveNow();
    });

    expect(api.accepted()).toEqual(retitle("First"));
    expect(result.current.save.status).toBe("saved");
  });

  it("does not send an operation twice across a failure", async () => {
    const { result } = await editor();

    api.failNext(500);
    act(() => result.current.apply(retitle("First"), { label: "Retitle" }));
    await act(async () => {
      await result.current.saveNow();
    });
    await act(async () => {
      await result.current.saveNow();
    });
    await act(async () => {
      await result.current.saveNow();
    });

    expect(api.accepted()).toEqual(retitle("First"));
  });

  it("sends edits made during a slow save, in order, in the same drain", async () => {
    const { result } = await editor();

    act(() => result.current.apply(retitle("First"), { label: "One" }));

    const release = api.holdNext();
    let flushed!: Promise<boolean>;
    act(() => {
      flushed = result.current.saveNow();
    });

    // Arrives while the first request is still open.
    act(() => result.current.apply(retitle("Second"), { label: "Two" }));

    release();
    await act(async () => {
      await flushed;
    });

    expect(api.accepted()).toEqual([...retitle("First"), ...retitle("Second")]);
    // Two requests, because the second batch could not join a request already
    // on the wire — but one drain, so the user did not wait for another debounce.
    expect(api.sent).toHaveLength(2);
  });

  it("puts a failed batch back in front of newer work", async () => {
    const { result } = await editor();

    act(() => result.current.apply(retitle("First"), { label: "One" }));

    const release = api.holdNext();
    api.failNext("offline");
    let flushed!: Promise<boolean>;
    act(() => {
      flushed = result.current.saveNow();
    });
    act(() => result.current.apply(retitle("Second"), { label: "Two" }));
    release();
    await act(async () => {
      await flushed;
    });

    expect(api.accepted()).toHaveLength(0);

    await act(async () => {
      await result.current.saveNow();
    });

    // Order is the assertion: a patch replayed out of order is a different
    // document, and here it would leave the deck titled "First".
    expect(api.accepted()).toEqual([...retitle("First"), ...retitle("Second")]);
  });

  it("retains the work behind a 409 and never re-sends it with a fresh version", async () => {
    const { result } = await editor();

    api.failNext(409);
    act(() => result.current.apply(retitle("First"), { label: "One" }));
    await act(async () => {
      await result.current.saveNow();
    });

    expect(result.current.save.status).toBe("conflict");
    expect(api.accepted()).toHaveLength(0);

    // Nothing auto-retried: overwriting the other writer is exactly what
    // optimistic concurrency exists to refuse.
    expect(api.fetchStub).toHaveBeenCalledTimes(1);
  });

  it("reports the drain result so a caller can refuse to proceed", async () => {
    const { result } = await editor();

    expect(await result.current.saveNow()).toBe(true);

    api.failNext(500);
    act(() => result.current.apply(retitle("First"), { label: "One" }));
    await act(async () => {
      expect(await result.current.saveNow()).toBe(false);
    });
    await act(async () => {
      expect(await result.current.saveNow()).toBe(true);
    });
  });

  it("refuses adoption and retains queued work and its document", async () => {
    const { result } = await editor();

    api.failNext("offline");
    act(() => result.current.apply(retitle("First"), { label: "One" }));
    await act(async () => {
      await result.current.saveNow();
    });

    act(() => expect(result.current.adoptDocument(document, "v9")).toBe(false));

    expect(result.current.save.status).toBe("conflict");
    expect(result.current.document.metadata.title).toBe("First");
    const calls = api.fetchStub.mock.calls.length;
    expect(await result.current.saveNow()).toBe(false);
    expect(api.fetchStub.mock.calls.length).toBe(calls);
  });

  it("all drain callers await the in-flight acknowledgement", async () => {
    const { result } = await editor();
    act(() => result.current.apply(retitle("Waiting"), { label: "Retitle" }));
    const release = api.holdNext();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    let settled = false;
    act(() => {
      first = result.current.saveNow();
      second = result.current.saveNow();
      void second.then(() => { settled = true; });
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(api.fetchStub).toHaveBeenCalledTimes(1);
    release();
    await act(async () => expect(await Promise.all([first, second])).toEqual([true, true]));
  });

  it("keeps edits made after the AI preflight save", async () => {
    const { result } = await editor();
    expect(await result.current.saveNow()).toBe(true);
    act(() => result.current.apply(retitle("Typed while AI worked"), { label: "Retitle" }));
    act(() => expect(result.current.adoptDocument(document, "ai-version")).toBe(false));
    expect(result.current.document.metadata.title).toBe("Typed while AI worked");
  });

  it("recovers an offline edit after unmount and persists it against its original version", async () => {
    const first = await editor();
    act(() => first.result.current.apply(retitle("Recovered title"), { label: "Retitle" }));
    api.failNext("offline");
    await act(async () => { await first.result.current.saveNow(); });
    first.unmount();
    const recovered = await editor();
    expect(recovered.result.current.document.metadata.title).toBe("Recovered title");
    await act(async () => { expect(await recovered.result.current.saveNow()).toBe(true); });
    expect(api.accepted()).toEqual(retitle("Recovered title"));
    expect(api.sent[0]!.expected_version_id).toBe("v0");
    expect(localStorage.getItem(currentRecoveryKey())).toBeNull();
  });

  it("retains recovery without replay when the server version changed", async () => {
    const first = await editor();
    act(() => first.result.current.apply(retitle("Local copy"), { label: "Retitle" }));
    first.unmount();
    const recovered = await editor("new-server-version");
    expect(recovered.result.current.document.metadata.title).toBe("Local copy");
    expect(recovered.result.current.save.status).toBe("conflict");
    expect(await recovered.result.current.saveNow()).toBe(false);
    expect(api.fetchStub).not.toHaveBeenCalled();
    expect(localStorage.getItem(currentRecoveryKey())).not.toBeNull();
  });

  it("journals the active batch on unload without a competing request", async () => {
    const { result } = await editor();
    act(() => result.current.apply(retitle("In flight"), { label: "Retitle" }));
    const release = api.holdNext();
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.saveNow(); });
    act(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    expect(api.fetchStub).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(currentRecoveryKey())!).operations).toEqual(retitle("In flight"));
    release();
    await act(async () => { await saving; });
    expect(localStorage.getItem(currentRecoveryKey())).toBeNull();
  });

  it("saves a reviewed merge against the reviewed server version", async () => {
    const { result } = await editor();
    act(() => result.current.apply(retitle("Local title"), { label: "Retitle" }));
    const server = structuredClone(document);
    server.slides[0]!.elements[0]!.name = "Remote name";
    act(() => result.current.adoptDocument(server, "remote-v2"));
    const review: ConflictReview = { base: document, local: result.current.document, server, serverVersionId: "remote-v2" };
    await act(async () => expect(await result.current.resolveConflict(review, {})).toBe(true));
    expect(api.sent[0]!.expected_version_id).toBe("remote-v2");
    const persisted = applyPatch(server, api.accepted()).document;
    expect(persisted.metadata.title).toBe("Local title");
    expect(persisted.slides[0]!.elements[0]!.name).toBe("Remote name");
    expect(localStorage.getItem(currentRecoveryKey())).toBeNull();
  });

  it("refuses a review that predates a newer local edit", async () => {
    const { result } = await editor();
    const review: ConflictReview = { base: document, local: result.current.document, server: document, serverVersionId: "remote-v2" };
    act(() => result.current.apply(retitle("After review"), { label: "Retitle" }));
    await expect(result.current.resolveConflict(review, {})).rejects.toThrow("after opening this review");
    expect(result.current.document.metadata.title).toBe("After review");
    expect(api.fetchStub).not.toHaveBeenCalled();
  });

  it("requires every competing edit to have an explicit choice", async () => {
    const { result } = await editor();
    act(() => result.current.apply(retitle("Mine"), { label: "Retitle" }));
    const server = structuredClone(document); server.metadata.title = "Theirs";
    const review: ConflictReview = { base: document, local: result.current.document, server, serverVersionId: "remote-v2" };
    await expect(result.current.resolveConflict(review, {})).rejects.toThrow("Choose a version");
    expect(api.fetchStub).not.toHaveBeenCalled();
    await act(async () => expect(await result.current.resolveConflict(review, { "/metadata/title": "local" })).toBe(true));
    expect(result.current.document.metadata.title).toBe("Mine");
  });

  it("retains the reviewed result if the server advances again before saving", async () => {
    const { result } = await editor();
    act(() => result.current.apply(retitle("Mine"), { label: "Retitle" }));
    const review: ConflictReview = { base: document, local: result.current.document, server: document, serverVersionId: "remote-v2" };
    api.failNext(409);
    await act(async () => expect(await result.current.resolveConflict(review, {})).toBe(false));
    expect(result.current.save.status).toBe("conflict");
    expect(result.current.document.metadata.title).toBe("Mine");
    expect(JSON.parse(localStorage.getItem(currentRecoveryKey())!).document.metadata.title).toBe("Mine");
    const calls = api.fetchStub.mock.calls.length;
    expect(await result.current.saveNow()).toBe(false);
    expect(api.fetchStub.mock.calls.length).toBe(calls);
  });

  it("loads the historical base and latest server version without writing", async () => {
    const { result } = await editor();
    act(() => result.current.apply(retitle("Mine"), { label: "Retitle" }));
    const server = structuredClone(document); server.metadata.title = "Theirs";
    api.fetchStub.mockImplementation(async (url) => response(200, {
      document: url.includes("at_version=v0") ? document : server,
      version_id: url.includes("at_version=v0") ? "v0" : "remote-v2",
    }));
    const review = await result.current.reviewConflict();
    expect(review.base).toEqual(document);
    expect(review.local.metadata.title).toBe("Mine");
    expect(review.server.metadata.title).toBe("Theirs");
    expect(review.serverVersionId).toBe("remote-v2");
    expect(api.fetchStub).toHaveBeenCalledTimes(2);
    expect(api.fetchStub.mock.calls.every(([, init]) => !init?.body)).toBe(true);
  });

  it("debounces rather than posting per keystroke", async () => {
    const { result } = await editor();

    act(() => {
      result.current.apply(retitle("A"), { label: "One", coalesceKey: "title" });
      result.current.apply(retitle("AB"), { label: "One", coalesceKey: "title" });
      result.current.apply(retitle("ABC"), { label: "One", coalesceKey: "title" });
    });

    expect(api.fetchStub).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await waitFor(() => expect(api.fetchStub).toHaveBeenCalledTimes(1));

    expect(api.sent[0]!.operations).toHaveLength(3);
  });
});
