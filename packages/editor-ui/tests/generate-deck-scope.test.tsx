// @vitest-environment jsdom
/**
 * The generation drawer belongs to one project and one run (final package
 * review, items 02 and 03). Every server answer is held until the test releases
 * it, so the order in which answers *arrive* is chosen here. The first case of
 * each item is the review's reproducer.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { GenerateDeck, resetGenerationRequestsForTests } from "../src/components/GenerateDeck";

const outlineFor = (name: string) => ({
  title: `${name} outline`,
  narrative_arc: name,
  slides: [{ headline: `Only for ${name}`, key_message: name, layout: "statement" }],
  warnings: [],
});

type Held = { path: string; body: unknown; release: (response: Response) => void };
let held: Held[];

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const key = (project: string) => `deckastra.pending-outline:${project}`;

beforeEach(() => {
  held = [];
  localStorage.clear();
  resetGenerationRequestsForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("/repositories")) return reply({ repositories: [] });
      return new Promise<Response>((release) =>
        held.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined, release }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function answer(suffix: string, response: Response) {
  await waitFor(() => expect(held.some((request) => request.path.endsWith(suffix))).toBe(true));
  const index = held.findIndex((request) => request.path.endsWith(suffix));
  const [request] = held.splice(index, 1);
  await act(async () => request!.release(response));
}

function drawer(projectId: string, onGenerated = vi.fn()) {
  return <GenerateDeck open projectId={projectId} reviewAvailable onClose={() => {}} onGenerated={onGenerated} />;
}

const mount = (projectId: string, onGenerated = vi.fn()) =>
  render(drawer(projectId, onGenerated), { wrapper: withWorkspaceClient() });

describe("item 03: a paused outline survives a failure that says nothing about it", () => {
  it("keeps the pointer on a 503, and Try again recovers the same outline", async () => {
    localStorage.setItem(key("prj_a"), "run_a");
    mount("prj_a");
    await answer("/runs/run_a/checkpoint", reply({ detail: "temporarily unavailable" }, 503));
    expect(localStorage.getItem(key("prj_a"))).toBe("run_a");
    expect(await screen.findByTestId("outline-unreachable")).toBeTruthy();

    fireEvent.click(screen.getByTestId("outline-retry"));
    await answer("/runs/run_a/checkpoint", reply({ run_id: "run_a", status: "awaiting_story", outline: outlineFor("A") }));
    expect(await screen.findByText("Only for A")).toBeTruthy();
    expect(screen.queryByTestId("outline-unreachable")).toBeNull();
  });

  it.each([
    ["an expired session", 401],
    ["a server error", 500],
  ])("keeps the pointer after %s", async (_name, status) => {
    localStorage.setItem(key("prj_a"), "run_a");
    mount("prj_a");
    await answer("/checkpoint", reply({ detail: "nope" }, status));
    expect(localStorage.getItem(key("prj_a"))).toBe("run_a");
  });

  it("forgets on the server's 404, and only the run it asked about", async () => {
    localStorage.setItem(key("prj_a"), "run_a");
    mount("prj_a");
    await waitFor(() => expect(held).toHaveLength(1));
    // A newer run was started for the same project while the old answer was out.
    localStorage.setItem(key("prj_a"), "run_new");
    await answer("/runs/run_a/checkpoint", reply({ detail: "This run is not waiting for a review." }, 404));
    expect(localStorage.getItem(key("prj_a"))).toBe("run_new");
  });
});

describe("item 02: one project's run never shows under another", () => {
  it("does not show A's paused outline after switching to B", async () => {
    localStorage.setItem(key("prj_a"), "run_a");
    const view = mount("prj_a");
    await answer("/runs/run_a/checkpoint", reply({ run_id: "run_a", status: "awaiting_story", outline: outlineFor("A") }));
    await screen.findByText("Only for A");

    view.rerender(drawer("prj_b"));
    expect(screen.queryByText("Only for A")).toBeNull();
    expect(screen.getByTestId("generate-instruction")).toBeTruthy();
  });

  it("keeps an outline A was writing for A when it arrives after the switch, and shows it on return", async () => {
    const view = mount("prj_a");
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "A's deck" } });
    fireEvent.click(screen.getByTestId("generate-submit"));
    await waitFor(() => expect(held.some((request) => request.path.endsWith("/generate/review"))).toBe(true));

    view.rerender(drawer("prj_b"));
    await answer("/generate/review", reply({ run_id: "run_a", status: "awaiting_story", outline: outlineFor("A") }));
    expect(screen.queryByText("Only for A")).toBeNull();
    expect(localStorage.getItem(key("prj_a"))).toBe("run_a");
    expect(localStorage.getItem(key("prj_b"))).toBeNull();

    view.rerender(drawer("prj_a"));
    await answer("/runs/run_a/checkpoint", reply({ run_id: "run_a", status: "awaiting_story", outline: outlineFor("A") }));
    expect(await screen.findByText("Only for A")).toBeTruthy();
  });

  it("does not let an older generation replace a newer run, in either order", async () => {
    // The recheck's case (2026-09-20): the drawer is closed and opened again
    // between the two, so nothing held inside the component can tell them apart.
    const first = mount("prj_a");
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "First request" } });
    fireEvent.click(screen.getByTestId("generate-submit"));
    await waitFor(() => expect(held).toHaveLength(1));
    const old = held.shift()!;
    first.unmount();

    mount("prj_a");
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "New request" } });
    fireEvent.click(screen.getByTestId("generate-submit"));
    await answer("/generate/review", reply({ run_id: "run_new", status: "awaiting_story", outline: outlineFor("NEW") }));
    expect(localStorage.getItem(key("prj_a"))).toBe("run_new");

    await act(async () => old.release(reply({ run_id: "run_old", status: "awaiting_story", outline: outlineFor("OLD") })));
    expect(localStorage.getItem(key("prj_a"))).toBe("run_new");
    expect(screen.queryByText("Only for OLD")).toBeNull();
    expect(screen.getByText("Only for NEW")).toBeTruthy();
  });

  it("keeps the newer run when the older one answers first", async () => {
    const first = mount("prj_a");
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "First request" } });
    fireEvent.click(screen.getByTestId("generate-submit"));
    await waitFor(() => expect(held).toHaveLength(1));
    const old = held.shift()!;
    first.unmount();

    mount("prj_a");
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "New request" } });
    fireEvent.click(screen.getByTestId("generate-submit"));
    await waitFor(() => expect(held.some((request) => request.path.endsWith("/generate/review"))).toBe(true));

    // The abandoned one lands first; the current one still wins.
    await act(async () => old.release(reply({ run_id: "run_old", status: "awaiting_story", outline: outlineFor("OLD") })));
    expect(localStorage.getItem(key("prj_a"))).toBeNull();
    await answer("/generate/review", reply({ run_id: "run_new", status: "awaiting_story", outline: outlineFor("NEW") }));
    expect(localStorage.getItem(key("prj_a"))).toBe("run_new");
  });

  it("does not let a late decision on an abandoned run retire a newer one", async () => {
    localStorage.setItem(key("prj_a"), "run_a");
    const view = mount("prj_a");
    await answer("/checkpoint", reply({ run_id: "run_a", status: "awaiting_story", outline: outlineFor("A") }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(held.some((request) => request.path.endsWith("/resume"))).toBe(true));
    const decision = held.splice(held.findIndex((r) => r.path.endsWith("/resume")), 1)[0]!;
    view.unmount();

    // A new generation for the same project is started and paused.
    mount("prj_a");
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "Something else" } });
    fireEvent.click(screen.getByTestId("generate-submit"));
    await answer("/generate/review", reply({ run_id: "run_new", status: "awaiting_story", outline: outlineFor("NEW") }));

    await act(async () =>
      decision.release(reply({ run_id: "run_a", status: "completed", generation: { presentation_id: "doc_a" } })),
    );
    expect(localStorage.getItem(key("prj_a"))).toBe("run_new");
  });

  it("does not open A's finished deck from B", async () => {
    localStorage.setItem(key("prj_a"), "run_a");
    const onGenerated = vi.fn();
    const view = mount("prj_a", onGenerated);
    await answer("/checkpoint", reply({ run_id: "run_a", status: "awaiting_story", outline: outlineFor("A") }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(held.some((request) => request.path.endsWith("/resume"))).toBe(true));

    view.rerender(drawer("prj_b", onGenerated));
    await answer(
      "/resume",
      reply({ run_id: "run_a", status: "completed", generation: { presentation_id: "doc_made_for_a" } }),
    );
    expect(onGenerated).not.toHaveBeenCalled();
    // The run is finished, so A no longer has one waiting.
    expect(localStorage.getItem(key("prj_a"))).toBeNull();
  });

  it("does not open a deck after the drawer is gone", async () => {
    const onGenerated = vi.fn();
    const view = render(
      <GenerateDeck open projectId="prj_a" reviewAvailable={false} onClose={() => {}} onGenerated={onGenerated} />,
      { wrapper: withWorkspaceClient() },
    );
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "A's deck" } });
    fireEvent.click(screen.getByTestId("generate-submit"));
    await waitFor(() => expect(held.some((request) => request.path.endsWith("/v1/generate"))).toBe(true));
    view.unmount();
    await answer("/v1/generate", reply({ presentation_id: "doc_a" }));
    expect(onGenerated).not.toHaveBeenCalled();
  });
});
