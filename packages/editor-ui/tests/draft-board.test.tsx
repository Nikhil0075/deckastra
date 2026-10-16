import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
let buildFailure = false;

beforeEach(() => {
  buildFailure = false;
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url), "http://x").pathname;
    if (method === "PATCH" && path.endsWith("/drafts/drf_1")) return { ok: true, status: 200, json: async () => ({ ...initial, revision: 2, changed_since_build: true }) };
    if (method === "POST" && path.endsWith("/drafts/drf_1/build")) return buildFailure
      ? { ok: false, status: 422, json: async () => ({ detail: { message: "Fix these cards before building.", issues: [{ card_id: "crd_b", layout: "quote", message: "Add quote text before building." }] } }) }
      : { ok: true, status: 200, json: async () => ({ kind: "proposal", presentation_id: "prs_1", transaction_id: "txn_1", status: "pending", warnings: [] }) };
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

  it("requests semantic layout conversion and creates a layout-specific card", async () => {
    render(<DraftBoard initial={initial} onClose={() => {}} />, { wrapper: withWorkspaceClient() });
    const first = document.querySelector<HTMLElement>('[data-card-id="crd_a"]')!;
    fireEvent.click(within(first).getByRole("button", { name: "Layout title" }));
    fireEvent.click(screen.getByRole("option", { name: "quote" }));
    await waitFor(() => {
      const patch = fetcher.mock.calls.find(([, init]) => JSON.parse(String((init as RequestInit)?.body ?? "{}")).operations?.[0]?.op === "set_layout");
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ revision: 1, operations: [{ op: "set_layout", card_id: "crd_a", layout: "quote" }] });
    });

    fireEvent.click(screen.getByRole("button", { name: "New card layout statement" }));
    fireEvent.click(screen.getByRole("option", { name: "image" }));
    fireEvent.click(screen.getByRole("button", { name: "Add image card" }));
    await waitFor(() => {
      const adds = fetcher.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit)?.body ?? "{}"))).filter((body) => body.operations?.[0]?.op === "add");
      expect(adds.at(-1).operations[0].card.layout).toBe("image");
      expect(adds.at(-1).operations[0].card.blocks[1].role).toBe("image");
    });
  });

  it("names the card that must be fixed before a safe build", async () => {
    buildFailure = true;
    render(<DraftBoard initial={initial} onClose={() => {}} />, { wrapper: withWorkspaceClient() });
    fireEvent.click(screen.getByTestId("draft-build"));
    expect((await screen.findByRole("alert")).textContent).toContain("Fix these cards before building. Card 2: Add quote text before building.");
  });
});
