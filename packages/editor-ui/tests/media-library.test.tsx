import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContext } from "@deckastra/workspace-contracts";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { MediaLibraryView, parseTags, uploadKind } from "../src/components/MediaLibraryView";

const ACCOUNT = {
  user: { id: "usr_1", email: "me@local", name: "Me" },
  workspaces: [{ id: "wsp_1", name: "Mine", role: "owner", origin: "local", projects: [{ id: "prj_1", name: "P", description: null }] }],
  capabilities: { sharing: false },
} as unknown as AccountContext;

const asset = (id: string, extra: Record<string, unknown> = {}) => ({
  id, filename: `${id}.png`, kind: "image", content_type: "image/png", tags: [], description: null,
  metadata_version: 1, bytes: 2048, width: 40, height: 20, reference_count: 0, deleted_at: null as string | null, created_at: "2026-10-16T00:00:00Z", ...extra,
});

describe("Media page", () => {
  let fetcher: ReturnType<typeof vi.fn>;
  let live: ReturnType<typeof asset>[];
  let trash: ReturnType<typeof asset>[];

  beforeEach(() => {
    live = [asset("ast_used"), asset("ast_free", { tags: ["brand"] })];
    trash = [];
    fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname, searchParams } = new URL(String(url), "http://localhost");
      const method = init?.method ?? "GET";
      const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
      if (pathname.endsWith("/v1/dev/session")) return reply({ token: "t", user_id: "usr_1" });
      if (pathname === "/v1/assets") {
        return reply({ assets: searchParams.get("filter") === "deleted" ? trash : live, next_cursor: null });
      }
      if (pathname.endsWith("/view")) return reply({ asset_id: "x", mime_type: "image/png", base64: "AAAA", width: 4, height: 2 });
      if (pathname === "/v1/assets/ast_used/uses") {
        return reply({ asset_id: "ast_used", partial: false, decks: [{ presentation_id: "doc_a", title: "Quarterly", slide_ids: ["sld_1"], deleted: false }] });
      }
      if (pathname.endsWith("/uses")) return reply({ asset_id: "ast_free", partial: false, decks: [] });
      if (method === "PATCH" && pathname === "/v1/assets/ast_free") {
        const body = JSON.parse(String(init?.body));
        live = live.map((one) => (one.id === "ast_free" ? { ...one, ...body, metadata_version: 2 } : one));
        return reply({ ...live[1], change_id: "amc_1" });
      }
      if (method === "DELETE" && pathname === "/v1/workspace/assets/ast_free") {
        trash = live.filter((one) => one.id === "ast_free").map((one) => ({ ...one, deleted_at: "2026-10-17T00:00:00Z" }));
        live = live.filter((one) => one.id !== "ast_free");
        return reply({ id: "ast_free" });
      }
      if (pathname === "/v1/workspace/assets/ast_free/restore") {
        live = [...live, ...trash.map((one) => ({ ...one, deleted_at: null }))];
        trash = [];
        return reply({ id: "ast_free" });
      }
      return reply({ detail: "Not found." }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const view = (onOpenDeck = vi.fn()) => {
    render(<MediaLibraryView account={ACCOUNT} workspaceId="wsp_1" query="" now={Date.now()} onOpenDeck={onOpenDeck} />, { wrapper: withWorkspaceClient() });
    return onOpenDeck;
  };

  it("lists the workspace's files and says which decks use one", async () => {
    const onOpenDeck = view();
    const cards = await screen.findAllByTestId("media-card");
    expect(cards).toHaveLength(2);
    fireEvent.click(cards[0]!);
    const uses = await screen.findByTestId("media-uses");
    expect(within(uses).getByText("Quarterly")).toBeTruthy();
    // A file a deck shows cannot be moved to Trash, and the page says why.
    expect((screen.getByTestId("media-remove") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Used in 1 deck\. Remove it from those slides first\./)).toBeTruthy();
    fireEvent.click(within(uses).getByRole("button", { name: /Quarterly/ }));
    expect(onOpenDeck).toHaveBeenCalledWith("doc_a");
  });

  it("renames and tags a file with the version it read, then undoes nothing it did not do", async () => {
    view();
    fireEvent.click((await screen.findAllByTestId("media-card"))[1]!);
    await screen.findByTestId("media-unused");
    fireEvent.change(screen.getByTestId("media-name"), { target: { value: "Logo" } });
    fireEvent.change(screen.getByTestId("media-tags"), { target: { value: "brand, hero, Brand" } });
    fireEvent.click(screen.getByTestId("media-save"));
    await screen.findByTestId("media-undo-edit");
    const patch = fetcher.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PATCH")!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ expected_metadata_version: 1, filename: "Logo", tags: ["brand", "hero"] });
  });

  it("moves an unused file to Trash with an Undo, and restores it from Trash", async () => {
    view();
    fireEvent.click((await screen.findAllByTestId("media-card"))[1]!);
    await screen.findByTestId("media-unused");
    fireEvent.click(screen.getByTestId("media-remove"));
    await waitFor(() => expect(screen.getAllByTestId("media-card")).toHaveLength(1));
    expect(screen.getByTestId("media-notice").textContent).toMatch(/Moved “ast_free.png” to Trash/);

    fireEvent.click(screen.getByTestId("media-filter-deleted"));
    await waitFor(() => expect(screen.getAllByTestId("media-card")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("media-card")[0]!);
    fireEvent.click(await screen.findByTestId("media-restore"));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes("/ast_free/restore"))).toBe(true));
  });
});

describe("Media helpers", () => {
  it("reads tags as typed, once each, in order", () => {
    expect(parseTags(" brand, Hero ,, brand ,hero ")).toEqual(["brand", "Hero"]);
  });

  it("knows which files it can hold", () => {
    expect(uploadKind(new File([""], "a.png", { type: "image/png" }))).toBe("image");
    expect(uploadKind(new File([""], "brand.woff2", { type: "" }))).toBe("font");
    expect(uploadKind(new File([""], "notes.csv", { type: "" }))).toBe("document");
    expect(uploadKind(new File([""], "x.exe", { type: "application/octet-stream" }))).toBeNull();
  });
});
