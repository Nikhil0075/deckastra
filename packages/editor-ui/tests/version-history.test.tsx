import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";
import type { VersionSummary } from "@deckastra/workspace-contracts";
import animationFixture from "@deckastra/presentation-schema/fixtures/animation-test.mydeck.json" with { type: "json" };

import { useEditor } from "../src/lib/useEditor";
import {
  agentName,
  compareSlides,
  comparisonSummary,
  deckWideDiffers,
  slideOrderDiffers,
  versionRows,
  VERSION_PAGE,
} from "../src/lib/version-history";

/**
 * The version history drawer (editor Phase 5): how rows read, what "Compare
 * with current" marks, and that a restore obeys the rule every path that lets
 * the server replace the document obeys — drain the queue first, stop if it
 * cannot, and clear local undo once the document on screen is a different one.
 */

const deck = animationFixture as unknown as PresentationDocument;

function clone(): PresentationDocument {
  return structuredClone(deck);
}

function version(id: string, extra: Partial<VersionSummary> = {}): VersionSummary {
  return {
    id,
    parent_version_id: "parent",
    source: "user",
    label: null,
    created_by: "usr_1",
    created_at: "2026-09-19T10:00:00Z",
    is_snapshot: false,
    ...extra,
  };
}

describe("version rows", () => {
  const now = Date.parse("2026-09-19T10:18:00Z");

  it("number from the oldest listed, say what happened, and name who did it", () => {
    const { rows, truncated } = versionRows(
      [
        version("v3", { intent: "Rebalanced slide 4", change_source: "agent", agent_id: "layout" }),
        version("v2", { label: "Restored" }),
        version("v1", { parent_version_id: null }),
      ],
      "v3",
      now,
    );
    expect(rows.map((row) => row.number)).toEqual(["v3", "v2", "v1"]);
    expect(rows[0]).toMatchObject({ title: "Rebalanced slide 4", detail: "18 min ago · Layout Agent", byAgent: true, current: true });
    expect(rows[1]).toMatchObject({ title: "Restored", detail: "18 min ago · You", byAgent: false, current: false });
    // The first version was produced by no transaction and has no label.
    expect(rows[2]!.title).toBe("Created");
    expect(truncated).toBe(false);
  });

  it("say when the list is a page rather than the whole history", () => {
    const many = Array.from({ length: VERSION_PAGE }, (_, index) => version(`v${index}`));
    expect(versionRows(many, "v0", now).truncated).toBe(true);
  });

  it("name an external agent as one", () => {
    expect(agentName("mcp:codex")).toBe("codex (external agent)");
    expect(agentName("story_architect")).toBe("Story Architect Agent");
    expect(agentName("critic-agent")).toBe("Critic Agent");
  });
});

describe("compare with current", () => {
  it("marks slides by id, from the chosen version's side", () => {
    const viewed = clone();
    const current = clone();
    const [first, second, third] = current.slides;
    // Changed in the current deck; removed from it; and one added since.
    (first as unknown as { speakerNotes: string }).speakerNotes = "edited later";
    current.slides = [first!, third!, { ...structuredClone(second!), id: "sld_added_since" }];

    const marks = compareSlides(viewed, current);
    const byId = new Map(marks.map((entry) => [entry.slideId, entry]));
    expect(byId.get(first!.id)!.change).toBe("changed");
    expect(byId.get(second!.id)!.change).toBe("added");
    expect(byId.get(third!.id)!.change).toBe("same");
    expect(byId.get("sld_added_since")).toMatchObject({ change: "removed", position: null });
  });

  it("does not read key order or updatedAt as a change", () => {
    const viewed = clone();
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverseKeys(inner)]))
          : value;
    const reordered = reverseKeys(viewed) as PresentationDocument;
    const current = { ...clone(), updatedAt: "2030-01-01T00:00:00Z" };
    expect(compareSlides(viewed, reordered).every((entry) => entry.change === "same")).toBe(true);
    expect(deckWideDiffers(viewed, current)).toBe(false);
    expect(comparisonSummary(viewed, current)).toBe("Same content as the current deck.");
  });

  it("names a reorder and a deck-wide change, which slide marks alone would hide", () => {
    const viewed = clone();
    const current = clone();
    current.slides = [...current.slides].reverse();
    (current.metadata as { title: string }).title = "Renamed";
    expect(slideOrderDiffers(viewed, current)).toBe(true);
    expect(comparisonSummary(viewed, current)).toBe("slide order differs · deck settings differ");
  });
});

// ------------------------------------------------------------------ the hook

interface Service {
  head: string;
  commit: "ok" | "offline";
  calls: { method: string; url: string; body?: unknown }[];
}

const restoredDoc = (() => {
  const copy = clone();
  (copy.metadata as { title: string }).title = "As it was";
  return copy;
})();

function stubService(initial: Partial<Service> = {}) {
  const service: Service = { head: "v5", commit: "ok", calls: [], ...initial };
  let saved = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      service.calls.push({ method, url, body });
      const ok = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as Response;
      if (url.endsWith("/transactions")) {
        if (service.commit === "offline") throw new TypeError("Failed to fetch");
        saved += 1;
        service.head = `saved-${saved}`;
        return ok({ transaction_id: `txn_${saved}`, version_id: service.head });
      }
      if (url.includes("/versions/") && url.endsWith("/restore")) {
        service.head = "v6";
        return ok({ transaction_id: "txn_restore", version_id: "v6", document: restoredDoc, risk_tier: "high" });
      }
      if (url.endsWith("/revert")) {
        service.head = "v7";
        return ok({ transaction_id: "txn_unrestore", version_id: "v7", document: deck });
      }
      if (url.endsWith("/head")) return ok({ presentation_id: "p1", version_id: service.head });
      return ok({ document: deck, version_id: service.head, can_edit: true });
    }),
  );
  return service;
}

function open() {
  return renderHook(
    () =>
      useEditor({
        initialDocument: deck,
        presentationId: "p1",
        initialVersionId: "v5",
        // Out of the way: these cases are about the restore, not the watcher.
        watchHeadMs: 600_000,
      }),
    { wrapper: withWorkspaceClient() },
  );
}

const titleOf = (document: PresentationDocument) => (document.metadata as { title: string }).title;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("restoring a version from the editor", () => {
  it("tells the server what was on screen, adopts the result and clears local undo", async () => {
    const service = stubService();
    const { result } = open();
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));

    act(() => {
      result.current.apply([{ op: "replace", path: "/metadata/title", value: "Typed here" }], { label: "Rename" });
    });
    await act(async () => {
      expect(await result.current.saveNow()).toBe(true);
    });
    expect(result.current.canUndo).toBe(true);

    let answer: { ok: boolean } | undefined;
    await act(async () => {
      answer = await result.current.restoreVersion("v2");
    });
    expect(answer).toEqual({ ok: true });

    const restore = service.calls.find((call) => call.url.endsWith("/versions/v2/restore"))!;
    // The version the person was looking at: their own save, not the one the
    // editor opened on.
    expect(restore.body).toEqual({ expected_version_id: "saved-1" });
    expect(titleOf(result.current.document)).toBe("As it was");
    expect(result.current.currentVersionId()).toBe("v6");
    // The rename's inverse described a document that is no longer on screen.
    expect(result.current.canUndo).toBe(false);
    expect(result.current.restoredVersion).toMatchObject({ versionId: "v2", transactionId: "txn_restore" });

    await act(async () => {
      answer = await result.current.undoRestore();
    });
    expect(answer).toEqual({ ok: true });
    expect(service.calls.some((call) => call.url.endsWith("/transactions/txn_restore/revert"))).toBe(true);
    expect(result.current.currentVersionId()).toBe("v7");
    expect(result.current.restoredVersion).toBeNull();
  });

  it("restores nothing while an edit cannot be saved", async () => {
    const service = stubService({ commit: "offline" });
    const { result } = open();
    await waitFor(() => expect(result.current.recoveryReady).toBe(true));

    act(() => {
      result.current.apply([{ op: "replace", path: "/metadata/title", value: "Unsent" }], { label: "Rename" });
    });

    let answer: { ok: boolean; message?: string } | undefined;
    await act(async () => {
      answer = await result.current.restoreVersion("v2");
    });
    expect(answer?.ok).toBe(false);
    expect(answer?.message).toMatch(/not saved/);
    // Never asked: the unsent edit would have been stranded behind the restore.
    expect(service.calls.some((call) => call.url.endsWith("/restore"))).toBe(false);
    expect(titleOf(result.current.document)).toBe("Unsent");
    expect(result.current.restoredVersion).toBeNull();
  });
});
