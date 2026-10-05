import { describe, expect, it, vi } from "vitest";
import type { AccountContext, PresentationSummary, WorkspaceClient } from "@deckastra/workspace-contracts";

import { RECENT_LIMIT, loadView, viewTitle } from "../src/lib/deck-views";

const account = {
  user: { id: "usr", email: "a@example.com", name: null },
  workspaces: [
    { id: "wsp_1", name: "Mine", role: "owner", origin: "local", projects: [{ id: "prj_a", name: "Board", description: null }, { id: "prj_b", name: "Sales", description: null }] },
    { id: "wsp_2", name: "Theirs", role: "viewer", origin: "local", projects: [{ id: "prj_c", name: "Shared", description: null }] },
  ],
  capabilities: { sharing: true },
} as unknown as AccountContext;

const deck = (id: string, updated: string, extra: Partial<PresentationSummary> = {}): PresentationSummary => ({
  id,
  title: id,
  version_id: "v",
  updated_at: updated,
  ...extra,
});

function client(lists: Record<string, PresentationSummary[]>, trash: Record<string, PresentationSummary[]> = {}) {
  return {
    documents: {
      list: vi.fn(async (projectId: string) => lists[projectId] ?? []),
      trash: vi.fn(async (projectId: string) => trash[projectId] ?? []),
    },
  } as unknown as WorkspaceClient;
}

describe("the home's views", () => {
  it("lists every deck across projects, newest first, saying where each lives and whether it can be edited", async () => {
    const api = client({
      prj_a: [deck("old", "2026-10-01T10:00:00Z")],
      prj_b: [deck("new", "2026-10-04T10:00:00Z")],
      prj_c: [deck("shared", "2026-10-03T10:00:00Z")],
    });
    const decks = await loadView(api, account, { kind: "all" });
    expect(decks.map((d) => [d.id, d.projectName, d.editable])).toEqual([
      ["new", "Sales", true],
      ["shared", "Shared", false],
      ["old", "Board", true],
    ]);
  });

  it("keeps Recent to the few most recently edited", async () => {
    const many = Array.from({ length: 20 }, (_, i) => deck(`d${i}`, `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
    const decks = await loadView(client({ prj_a: many }), account, { kind: "recent" });
    expect(decks).toHaveLength(RECENT_LIMIT);
    expect(decks[0]!.id).toBe("d19");
  });

  it("reads the trash of every project, most recently deleted first", async () => {
    const api = client({}, {
      prj_a: [deck("gone-early", "x", { deleted_at: "2026-10-01T00:00:00Z" })],
      prj_c: [deck("gone-late", "x", { deleted_at: "2026-10-04T00:00:00Z" })],
    });
    expect((await loadView(api, account, { kind: "trash" })).map((d) => d.id)).toEqual(["gone-late", "gone-early"]);
    expect(api.documents.list).not.toHaveBeenCalled();
  });

  it("reads one project for a project view", async () => {
    const api = client({ prj_b: [deck("only", "2026-10-01T00:00:00Z")] });
    expect((await loadView(api, account, { kind: "project", projectId: "prj_b" })).map((d) => d.id)).toEqual(["only"]);
    expect(api.documents.list).toHaveBeenCalledTimes(1);
  });

  it("fails the view when a project cannot be read, rather than leaving its decks out", async () => {
    const api = client({});
    (api.documents.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    await expect(loadView(api, account, { kind: "all" })).rejects.toThrow("offline");
  });

  it("names each view", () => {
    expect(viewTitle({ kind: "all" }, account)).toBe("All decks");
    expect(viewTitle({ kind: "project", projectId: "prj_c" }, account)).toBe("Shared");
  });
});
