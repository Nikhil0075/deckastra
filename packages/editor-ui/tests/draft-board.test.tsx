import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";
import type { DraftBoard as DraftBoardModel } from "@deckastra/workspace-contracts";

import { DraftBoard } from "../src/components/DraftBoard";

const initial: DraftBoardModel = {
  id: "drf_1", project_id: "prj_1", presentation_id: "prs_1", title: "Rough story",
  revision: 1, built_version_id: "ver_1", built_revision: 1, changed_since_build: false,
  created_by: "usr_1", created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:00:00Z",
  density_warnings: { crd_b: ["This card is dense."] },
  body: { cards: [
    { id: "crd_a", layout: "title", blocks: [{ role: "headline", text: "Opening" }] },
    { id: "crd_b", layout: "bullets", blocks: [{ role: "headline", text: "Case" }, { role: "bullet", text: "One" }, { role: "bullet", text: "Two" }] },
  ] },
};

let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url), "http://x").pathname;
    if (method === "PATCH" && path.endsWith("/drafts/drf_1")) return { ok: true, status: 200, json: async () => ({ ...initial, revision: 2, changed_since_build: true }) };
    if (method === "POST" && path.endsWith("/drafts/drf_1/build")) return { ok: true, status: 200, json: async () => ({ kind: "proposal", presentation_id: "prs_1", transaction_id: "txn_1", status: "pending", warnings: [] }) };
    return { ok: false, status: 404, json: async () => ({ detail: "Not found" }) };
  });
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("draft board", () => {
  it("shows wireframes and density warnings, reorders with the keyboard, and builds only on the button", async () => {
    const built = vi.fn();
    render(<DraftBoard initial={initial} onClose={() => {}} onBuilt={built} />, { wrapper: withWorkspaceClient() });
    expect(screen.getByText("This card is dense.")).toBeTruthy();
    expect(screen.getAllByText("headline")).toHaveLength(2);
    const second = document.querySelector('[data-card-id="crd_b"]')!;
    fireEvent.keyDown(second, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const patch = fetcher.mock.calls.find(([url, init]) => String(url).endsWith("/drafts/drf_1") && (init as RequestInit).method === "PATCH");
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ revision: 1, operations: [{ op: "move", card_id: "crd_b", index: 0 }] });
    fireEvent.click(screen.getByTestId("draft-build"));
    await waitFor(() => expect(built).toHaveBeenCalledWith("prs_1", "proposal"));
  });
});
