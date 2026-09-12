import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";
import { ProposalsPanel } from "../src/components/ProposalsPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pending = {
  id: "txn_mcp",
  status: "pending",
  intent: "Rebuild the deck",
  reason: "The user asked for it",
  risk_tier: "high",
  agent_id: "mcp:claude-code",
  run_id: null,
  created_at: "2026-09-11T19:42:42",
  expires_at: "2026-09-12T19:42:42",
  operation_count: 7,
};

function stubServer(document: unknown) {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/proposals") && options?.method === "GET") return { ok: true, json: async () => [pending] };
    if (url.endsWith("/approve")) {
      return { ok: true, json: async () => ({ transaction_id: "txn_mcp", version_id: "v2", document }) };
    }
    return { ok: true, json: async () => ({ ...pending, status: "rejected" }) };
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("shows a proposal made over MCP and approving it saves first, then adopts the server's document", async () => {
  const document = loadFixture("technical");
  const fetcher = stubServer(document);
  const order: string[] = [];
  const saveNow = vi.fn(async () => { order.push("save"); return true; });
  const onApplied = vi.fn(() => { order.push("adopt"); return true; });

  render(<ProposalsPanel presentationId={document.id} onApplied={onApplied} saveNow={saveNow} pollMs={0} />,
    { wrapper: withWorkspaceClient() });

  expect(await screen.findByText("Rebuild the deck")).toBeTruthy();
  expect(screen.getByText(/from claude-code via MCP/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await screen.findByText("Applied: Rebuild the deck");

  expect(order).toEqual(["save", "adopt"]);
  expect(onApplied).toHaveBeenCalledWith(document, "v2");
  const approve = fetcher.mock.calls.find(([url]) => String(url).endsWith("/proposals/txn_mcp/approve"));
  expect(approve?.[1]?.method).toBe("POST");
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
});

it("does not approve while local edits are unsaved", async () => {
  const document = loadFixture("technical");
  const fetcher = stubServer(document);
  const onApplied = vi.fn(() => true);

  render(<ProposalsPanel presentationId={document.id} onApplied={onApplied} saveNow={async () => false} pollMs={0} />,
    { wrapper: withWorkspaceClient() });

  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  await screen.findByText(/not saved yet/);

  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(false);
  expect(onApplied).not.toHaveBeenCalled();
});

it("rejecting records a reason and removes the proposal", async () => {
  const document = loadFixture("technical");
  const fetcher = stubServer(document);

  render(<ProposalsPanel presentationId={document.id} onApplied={() => true} saveNow={async () => true} pollMs={0} />,
    { wrapper: withWorkspaceClient() });

  fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
  await waitFor(() => expect(screen.queryByText("Rebuild the deck")).toBeNull());

  const reject = fetcher.mock.calls.find(([url]) => String(url).endsWith("/proposals/txn_mcp/reject"));
  expect(JSON.parse(reject![1]!.body as string)).toEqual({ reason: "Declined in the editor" });
});
