// @vitest-environment jsdom
/**
 * A project's cards are only ever that project's (audit UI-02, 2026-09-19).
 *
 * Every answer is held until the test releases it, so the order in which
 * responses *arrive* is chosen here rather than left to timing. The first case
 * is the audit's reproducer.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { DeckList } from "../src/components/DeckList";
import { latestRequests } from "../src/lib/latest-request";

vi.mock("../src/components/FinalFrameSlide", () => ({ FinalFrameSlide: () => <div /> }));

type Held = { path: string; release: (response: Response) => void };
let held: Held[];
let deleted: string[];

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deck = (id: string, title: string) => ({ id, title, version_id: null, slide_count: 1 });

beforeEach(() => {
  held = [];
  deleted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("/account")) {
        return reply({
          user: { id: "usr_test" },
          capabilities: { sharing: false, checkpoints: false },
          workspaces: [
            {
              id: "wsp_test",
              name: "Workspace",
              role: "owner",
              projects: [
                { id: "prj_a", name: "Project A" },
                { id: "prj_b", name: "Project B" },
              ],
            },
          ],
        });
      }
      if (init?.method === "DELETE") {
        deleted.push(path);
        return reply({});
      }
      if (path.includes("/presentations")) {
        return new Promise<Response>((release) => held.push({ path, release }));
      }
      return reply({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The oldest held request for a project, answered and removed. */
async function answer(project: "a" | "b", response: Response) {
  const index = held.findIndex((request) => request.path.includes(`/projects/prj_${project}/`));
  expect(index, `no request for project ${project} is waiting`).toBeGreaterThanOrEqual(0);
  const [request] = held.splice(index, 1);
  await act(async () => request!.release(response));
}

const waiting = (project: "a" | "b") => held.filter((request) => request.path.includes(`/projects/prj_${project}/`)).length;

async function mount() {
  render(<DeckList onOpen={() => {}} />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(waiting("a")).toBe(1));
}

const pick = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));

describe("switching projects", () => {
  it("does not let a late answer for A replace B's cards", async () => {
    await mount();
    pick("Project B");
    await answer("b", reply({ presentations: [deck("doc_b", "B only deck")] }));
    await screen.findByText("B only deck");

    await answer("a", reply({ presentations: [deck("doc_a", "A only deck")] }));
    expect(screen.queryByText("A only deck")).toBeNull();
    expect(screen.getByText("B only deck")).toBeTruthy();
  });

  it("shows A's second answer, never its first, after A → B → A", async () => {
    await mount();
    pick("Project B");
    pick("Project A");
    await waitFor(() => expect(waiting("a")).toBe(2));

    // The newer request for A answers first; then the stale ones straggle in.
    const [first, second] = held.filter((request) => request.path.includes("/projects/prj_a/"));
    await act(async () => second!.release(reply({ presentations: [deck("doc_new", "A as it is now")] })));
    await screen.findByText("A as it is now");
    await act(async () => first!.release(reply({ presentations: [deck("doc_old", "A as it was")] })));
    await answer("b", reply({ presentations: [deck("doc_b", "B only deck")] }));

    expect(screen.queryByText("A as it was")).toBeNull();
    expect(screen.queryByText("B only deck")).toBeNull();
    expect(screen.getByText("A as it is now")).toBeTruthy();
  });

  it("does not show a stale project's error over the current project's cards", async () => {
    await mount();
    pick("Project B");
    await answer("b", reply({ presentations: [deck("doc_b", "B only deck")] }));
    await answer("a", reply({ detail: "Project A could not be read." }, 500));
    expect(screen.queryByText("Project A could not be read.")).toBeNull();
    expect(screen.getByText("B only deck")).toBeTruthy();
  });

  it("does not let a refresh after deleting in A fill B's view", async () => {
    await mount();
    await answer("a", reply({ presentations: [deck("doc_a", "A only deck"), deck("doc_a2", "Another A deck")] }));
    await screen.findByText("A only deck");

    // Delete in A: the refresh that follows is held while the person moves on.
    const card = screen.getByText("A only deck").closest("article")!;
    fireEvent.click(card.querySelector('[data-testid="deck-menu"]')!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(deleted).toHaveLength(1));
    await waitFor(() => expect(waiting("a")).toBe(1));

    pick("Project B");
    await answer("b", reply({ presentations: [deck("doc_b", "B only deck")] }));
    await answer("a", reply({ presentations: [deck("doc_a2", "Another A deck")] }));
    expect(screen.queryByText("Another A deck")).toBeNull();
    expect(screen.getByText("B only deck")).toBeTruthy();
  });
});

describe("latestRequests", () => {
  it("keeps only the newest ticket current", () => {
    const requests = latestRequests();
    const first = requests.begin();
    expect(first()).toBe(true);
    const second = requests.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
