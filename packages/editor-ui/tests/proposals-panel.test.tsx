import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";
import { ProposalsPanel } from "../src/components/ProposalsPanel";

// jsdom has no text layout, so the browser measurer cannot run here; the scene
// falls back to the estimator. The pictures themselves are the renderer's, and
// covered by its own suites; what these cases check is which slide is drawn.
vi.mock("../src/lib/measurer", () => ({ useBrowserMeasurer: () => undefined }));
vi.mock("../src/components/FinalFrameSlide", () => ({
  FinalFrameSlide: ({ scene }: { scene: { slideId: string } }) => <div data-thumbnail={scene.slideId} />,
}));

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

function stubServer(document: unknown, operations: unknown[] = []) {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/proposals") && options?.method === "GET") return { ok: true, json: async () => [pending] };
    if (url.endsWith("/proposals/txn_mcp") && options?.method === "GET") {
      return { ok: true, json: async () => ({ ...pending, operations, base_version_id: "v1" }) };
    }
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

  render(<ProposalsPanel presentationId={document.id} document={document} onApplied={onApplied} saveNow={saveNow} currentVersionId={() => "v1"} pollMs={0} />,
    { wrapper: withWorkspaceClient() });

  expect(await screen.findByText("Rebuild the deck")).toBeTruthy();
  expect(screen.getByText(/from claude-code via MCP/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText("Applied: Rebuild the deck");

  expect(order).toEqual(["save", "adopt"]);
  expect(onApplied).toHaveBeenCalledWith(document, "v2");
  const approve = fetcher.mock.calls.find(([url]) => String(url).endsWith("/proposals/txn_mcp/approve"));
  expect(approve?.[1]?.method).toBe("POST");
  // The version this panel was showing. Without it the authority refuses an
  // approval against a deck that moved after the proposal was made — because
  // that is a change nobody reviewed — so a surface that shows the deck has to
  // say what it showed.
  expect(JSON.parse(approve![1]!.body as string)).toEqual({ expected_version_id: "v1" });
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
});

it("does not approve while local edits are unsaved", async () => {
  const document = loadFixture("technical");
  const fetcher = stubServer(document);
  const onApplied = vi.fn(() => true);

  render(<ProposalsPanel presentationId={document.id} document={document} onApplied={onApplied} saveNow={async () => false} currentVersionId={() => "v1"} pollMs={0} />,
    { wrapper: withWorkspaceClient() });

  fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
  await screen.findByText(/not saved yet/);

  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(false);
  expect(onApplied).not.toHaveBeenCalled();
});

it("rejecting records a reason and removes the proposal", async () => {
  const document = loadFixture("technical");
  const fetcher = stubServer(document);

  render(<ProposalsPanel presentationId={document.id} document={document} onApplied={() => true} saveNow={async () => true} currentVersionId={() => "v1"} pollMs={0} />,
    { wrapper: withWorkspaceClient() });

  fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
  await waitFor(() => expect(screen.queryByText("Rebuild the deck")).toBeNull());

  const reject = fetcher.mock.calls.find(([url]) => String(url).endsWith("/proposals/txn_mcp/reject"));
  expect(JSON.parse(reject![1]!.body as string)).toEqual({ reason: "Declined in the editor" });
});


it("draws the change as Before and After, from the deck on screen", async () => {
  // jsdom lays nothing out; the card sizes its pictures from its own width.
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  const document = loadFixture("technical");
  const slide = document.slides[1]!;
  const element = slide.elements[0]!;
  stubServer(document, [{ op: "remove", path: `/slides/id:${slide.id}/elements/id:${element.id}` }]);

  render(<ProposalsPanel presentationId={document.id} document={document} onApplied={() => true} saveNow={async () => true} currentVersionId={() => "v1"} pollMs={0} />,
    { wrapper: withWorkspaceClient() });

  const before = await screen.findByTestId("proposal-before");
  const after = screen.getByTestId("proposal-after");
  // Drawn once the card has measured the room it has.
  await waitFor(() => expect(before.querySelector("[data-thumbnail]")).toBeTruthy());
  expect(before.querySelector("[data-thumbnail]")?.getAttribute("data-thumbnail")).toBe(slide.id);
  expect(after.querySelector("[data-thumbnail]")?.getAttribute("data-thumbnail")).toBe(slide.id);
  // The slide the change touches, numbered as the deck has it.
  expect(screen.getByText(/^Slide 2/)).toBeTruthy();
  // Written against the version on screen, so no rebase is claimed.
  expect(screen.queryByText(/Written against an earlier version/)).toBeNull();
  width.mockRestore();
});

it("says when a change no longer applies, and still lets it be rejected", async () => {
  const document = loadFixture("technical");
  stubServer(document, [{ op: "remove", path: `/slides/id:${document.slides[0]!.id}/elements/id:el_gone` }]);

  render(<ProposalsPanel presentationId={document.id} document={document} onApplied={() => true} saveNow={async () => true} currentVersionId={() => "v2"} pollMs={0} />,
    { wrapper: withWorkspaceClient() });

  expect(await screen.findByText(/no longer applies to the deck as it is now/)).toBeTruthy();
  expect(screen.queryByTestId("proposal-before")).toBeNull();
  expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(false);
  // Its base is not the version on screen, and the card says so.
  expect(screen.getByText(/Written against an earlier version/)).toBeTruthy();
});
