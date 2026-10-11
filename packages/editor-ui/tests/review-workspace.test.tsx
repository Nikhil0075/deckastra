/**
 * The Review view (UI audit 2026-10-10, unit 4), driven through a real client
 * over a stubbed `fetch`: what reaches the server is the point — an approval
 * naming the version on screen, a save drained first, an undo that is a server
 * revert of that transaction.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import fixture from "../../presentation-schema/fixtures/technical-deck.mydeck.json";
import { ReviewWorkspace } from "../src/components/ReviewWorkspace";
import type { EditorApi } from "../src/lib/useEditor";

vi.mock("../src/lib/measurer", () => ({ useBrowserMeasurer: () => undefined }));
vi.mock("@deckastra/renderer/react", () => ({
  ScaledSlide: ({ scene, width }: { scene: { slideId: string }; width: number }) => <div data-thumbnail={scene.slideId} data-width={width} />,
}));

const deck = fixture as unknown as PresentationDocument;
const first = deck.slides[0]!;
const second = deck.slides[1]!;

const pending = (id: string, intent: string, risk = "high") => ({
  id,
  status: "pending",
  intent,
  reason: "Because the agent said so",
  risk_tier: risk,
  agent_id: "mcp:codex",
  run_id: null,
  created_at: "2026-10-10T00:00:00Z",
  expires_at: null,
  operation_count: 2,
});

// Renames two slides, so the change touches two of them.
const operations = [
  { op: "replace", path: `/slides/id:${first.id}/name`, value: "Renamed one" },
  { op: "add", path: `/slides/id:${second.id}/name`, value: "Renamed two" },
];

let width: PropertyDescriptor | undefined;
let height: PropertyDescriptor | undefined;
let fetcher: ReturnType<typeof vi.fn>;
let list: Array<ReturnType<typeof pending>>;

beforeEach(() => {
  width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  list = [pending("txn_a", "Rename two slides"), pending("txn_b", "Tighten the agenda", "low")];
  const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), "http://x").pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path.endsWith("/proposals")) return reply(list);
    const detail = /\/proposals\/(txn_[a-z])$/.exec(path);
    if (method === "GET" && detail) return reply({ ...list.find((one) => one.id === detail[1])!, operations, base_version_id: "ver_screen" });
    const approved = /\/proposals\/(txn_[a-z])\/approve$/.exec(path);
    if (approved) {
      list = list.filter((one) => one.id !== approved[1]);
      // The approval commits a transaction of its own, distinct from the
      // proposal's record: Undo must revert this one.
      return reply({ transaction_id: `${approved[1]}_applied`, version_id: "ver_after", document: deck });
    }
    const rejected = /\/proposals\/(txn_[a-z])\/reject$/.exec(path);
    if (rejected) {
      list = list.filter((one) => one.id !== rejected[1]);
      return reply({ ok: true });
    }
    if (/\/transactions\/txn_[a-z]\/revert$/.test(path)) return reply({ transaction_id: "txn_undo", version_id: "ver_undone", document: deck });
    return { ok: false, status: 404, json: async () => ({ detail: "Not found." }) };
  });
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
  if (height) Object.defineProperty(HTMLElement.prototype, "clientHeight", height);
});

function editor(overrides: Partial<EditorApi> = {}): EditorApi {
  return {
    sourceDocument: deck,
    locale: null,
    currentVersionId: () => "ver_screen",
    adoptDocument: vi.fn(() => true),
    saveNow: vi.fn(async () => true),
    revertChange: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as EditorApi;
}

const calls = () =>
  fetcher.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${new URL(String(url), "http://x").pathname}`);

describe("the Review view", () => {
  it("lists what waits and opens on the one asked for, with every slide it touches", async () => {
    render(<ReviewWorkspace editor={editor()} presentationId="prs_1" initialProposalId="txn_a" onClose={() => {}} />, { wrapper: withWorkspaceClient() });
    const items = await screen.findAllByTestId("review-proposal");
    expect(items.map((item) => item.getAttribute("data-proposal-id"))).toEqual(["txn_a", "txn_b"]);
    expect(items[0]!.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(screen.getAllByTestId("review-slide")).toHaveLength(2));
    expect(screen.getByText(/1 of 2 changed/)).toBeTruthy();
  });

  it("draws Before and After as large as the stage allows, side by side", async () => {
    render(<ReviewWorkspace editor={editor()} presentationId="prs_1" onClose={() => {}} />, { wrapper: withWorkspaceClient() });
    const after = await screen.findByTestId("review-after");
    const picture = await waitFor(() => {
      const found = after.querySelector("[data-width]");
      if (!found) throw new Error("not drawn yet");
      return found;
    });
    // Half of a 1200px stage less the gap and the frame, and far bigger than a
    // 288px column's pair.
    expect(Number(picture.getAttribute("data-width"))).toBe(Math.floor((1200 - 24) / 2 - 2));
  });

  it("steps through the changed slides", async () => {
    render(<ReviewWorkspace editor={editor()} presentationId="prs_1" onClose={() => {}} />, { wrapper: withWorkspaceClient() });
    await screen.findByText(/1 of 2 changed/);
    fireEvent.click(screen.getByRole("button", { name: "Next changed slide" }));
    expect(screen.getByText(/2 of 2 changed/)).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("review-slide")[0]!);
    expect(screen.getByText(/1 of 2 changed/)).toBeTruthy();
  });

  it("wipes between Before and After", async () => {
    render(<ReviewWorkspace editor={editor()} presentationId="prs_1" onClose={() => {}} />, { wrapper: withWorkspaceClient() });
    await screen.findByTestId("review-after");
    fireEvent.click(screen.getByTestId("review-compare-wipe"));
    const range = await screen.findByTestId("review-wipe-range");
    fireEvent.change(range, { target: { value: "30" } });
    const after = screen.getByTestId("review-wipe").querySelector<HTMLElement>(".dk-review__wipe-after")!;
    expect(after.style.clipPath).toBe("inset(0 0 0 30%)");
  });

  it("saves first, approves the version on screen, and offers Undo through a server revert", async () => {
    const ed = editor();
    const history = vi.fn();
    render(<ReviewWorkspace editor={ed} presentationId="prs_1" onClose={() => {}} onOpenHistory={history} />, {
      wrapper: withWorkspaceClient(),
    });
    await screen.findAllByTestId("review-proposal");
    fireEvent.click(screen.getByTestId("review-approve"));
    const row = await screen.findByTestId("review-applied");
    expect(ed.saveNow).toHaveBeenCalled();
    expect(ed.adoptDocument).toHaveBeenCalledWith(deck, "ver_after");
    const approval = fetcher.mock.calls.find(([url]) => String(url).endsWith("/approve"));
    expect(JSON.parse(String((approval![1] as RequestInit).body))).toMatchObject({ expected_version_id: "ver_screen" });
    // The next one waiting is selected.
    expect(screen.getAllByTestId("review-proposal").map((item) => item.getAttribute("data-proposal-id"))).toEqual(["txn_b"]);

    fireEvent.click(within(row).getByTestId("review-undo"));
    await waitFor(() => expect(ed.revertChange).toHaveBeenCalledWith("txn_a_applied"));
    expect(await within(row).findByText("Undone · new version")).toBeTruthy();

    // Approving and undoing are versions, and the history is where they are listed.
    fireEvent.click(screen.getByTestId("review-history"));
    expect(history).toHaveBeenCalled();
  });

  it("approves nothing while local edits cannot be saved", async () => {
    const ed = editor({ saveNow: vi.fn(async () => false) });
    render(<ReviewWorkspace editor={ed} presentationId="prs_1" onClose={() => {}} />, { wrapper: withWorkspaceClient() });
    await screen.findAllByTestId("review-proposal");
    fireEvent.click(screen.getByTestId("review-approve"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not saved/);
    expect(calls().some((call) => call.endsWith("/approve"))).toBe(false);
  });

  it("says why an Undo was refused", async () => {
    const ed = editor({ revertChange: vi.fn(async () => ({ ok: false, message: "A later edit changed that slide." })) });
    render(<ReviewWorkspace editor={ed} presentationId="prs_1" onClose={() => {}} />, { wrapper: withWorkspaceClient() });
    await screen.findAllByTestId("review-proposal");
    fireEvent.click(screen.getByTestId("review-approve"));
    fireEvent.click(within(await screen.findByTestId("review-applied")).getByTestId("review-undo"));
    expect(await screen.findByText("A later edit changed that slide.")).toBeTruthy();
    expect(within(screen.getByTestId("review-applied")).getByTestId("review-undo")).toBeTruthy();
  });

  it("rejects, and says when nothing is left", async () => {
    list = [pending("txn_a", "Rename two slides")];
    render(<ReviewWorkspace editor={editor()} presentationId="prs_1" onClose={() => {}} />, { wrapper: withWorkspaceClient() });
    await screen.findAllByTestId("review-proposal");
    fireEvent.click(screen.getByTestId("review-reject"));
    expect(await screen.findByText(/Nothing is waiting for you/)).toBeTruthy();
    expect(calls()).toContain("POST /v1/presentations/prs_1/proposals/txn_a/reject");
  });

  it("goes back to editing on Escape and from its button", async () => {
    const onClose = vi.fn();
    render(<ReviewWorkspace editor={editor()} presentationId="prs_1" onClose={onClose} />, { wrapper: withWorkspaceClient() });
    await screen.findAllByTestId("review-proposal");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("close-review"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
