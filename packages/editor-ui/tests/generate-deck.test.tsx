import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { GenerateDeck } from "../src/components/GenerateDeck";

/**
 * Generating a deck with the story checkpoint (editor Phase 6).
 *
 * Driven through a real client over a stubbed `fetch`: what matters is which
 * decision reached the server — an approval that builds, a revision that
 * carries its note — and that an outline nobody decided is not lost.
 */

const OUTLINE = {
  title: "The control tower",
  narrative_arc: "Problem, proposal, ask",
  slides: [
    { headline: "Migrations fail quietly", key_message: "Nobody sees drift", layout: "statement" },
    { headline: "One place to watch", key_message: "", layout: "bullets" },
  ],
  warnings: [],
};

function stub(answers: { review?: unknown; decide?: unknown[]; run?: unknown; checkpoint?: unknown }) {
  const decisions = [...(answers.decide ?? [])];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url.includes("/repositories")) return ok({ repositories: [] });
    if (url.endsWith("/v1/generate/review")) return ok(answers.review);
    if (url.endsWith("/v1/generate")) return ok(answers.run);
    if (url.endsWith("/resume")) return ok(decisions.shift());
    if (url.endsWith("/checkpoint")) {
      if (!answers.checkpoint) return { ok: false, status: 404, json: async () => ({ detail: "No." }) } as Response;
      return ok(answers.checkpoint);
    }
    void init;
    return ok({});
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

const bodyOf = (fetcher: ReturnType<typeof stub>, suffix: string) =>
  fetcher.mock.calls
    .filter(([url]) => String(url).endsWith(suffix))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

function show(overrides: Partial<Parameters<typeof GenerateDeck>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    projectId: "prj_1",
    reviewAvailable: true,
    onGenerated: vi.fn(),
    ...overrides,
  };
  const view = render(<GenerateDeck {...props} />, { wrapper: withWorkspaceClient() });
  return { props, view };
}

function ask(text: string) {
  fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: text } });
  fireEvent.click(screen.getByTestId("generate-submit"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("generating with the outline first", () => {
  it("stops at the outline, revises with the note, then builds and opens the deck", async () => {
    const fetcher = stub({
      review: { run_id: "run_1", status: "awaiting_story", outline: OUTLINE },
      decide: [
        { run_id: "run_1", status: "awaiting_story", outline: { ...OUTLINE, title: "The control tower, revised" } },
        { run_id: "run_1", status: "completed", generation: { presentation_id: "doc_new", document: {}, diagnostics: {} } },
      ],
    });
    const { props } = show();
    ask("Why our migration needs a control tower");

    expect(await screen.findByText("Migrations fail quietly")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(bodyOf(fetcher, "/v1/generate/review")[0]).toMatchObject({
      instruction: "Why our migration needs a control tower",
      project_id: "prj_1",
    });
    // Nothing is built yet, and the outline outlives the drawer.
    expect(props.onGenerated).not.toHaveBeenCalled();
    expect(localStorage.getItem("deckastra.pending-outline:prj_1")).toBe("run_1");

    // A revision needs something said about what to change.
    const revise = screen.getByTestId("checkpoint-revise") as HTMLButtonElement;
    expect(revise.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("checkpoint-note"), { target: { value: "Lead with the cost." } });
    expect(revise.disabled).toBe(false);
    fireEvent.click(revise);
    expect(await screen.findByText("The control tower, revised")).toBeTruthy();

    fireEvent.click(screen.getByTestId("checkpoint-approve"));
    await waitFor(() => expect(props.onGenerated).toHaveBeenCalledWith("doc_new"));

    expect(bodyOf(fetcher, "/v1/runs/run_1/resume")).toEqual([
      { action: "revise", note: "Lead with the cost." },
      { action: "approve" },
    ]);
    expect(localStorage.getItem("deckastra.pending-outline:prj_1")).toBeNull();
  });

  it("discarding makes nothing and says so", async () => {
    stub({
      review: { run_id: "run_2", status: "awaiting_story", outline: OUTLINE },
      decide: [{ run_id: "run_2", status: "rejected" }],
    });
    const { props } = show();
    ask("A deck");
    await screen.findByTestId("checkpoint-discard");
    // Remembered while it waits, so the check below is about the discard.
    expect(localStorage.getItem("deckastra.pending-outline:prj_1")).toBe("run_2");
    fireEvent.click(screen.getByTestId("checkpoint-discard"));
    expect(await screen.findByText(/Nothing was made/)).toBeTruthy();
    expect(props.onGenerated).not.toHaveBeenCalled();
    expect(localStorage.getItem("deckastra.pending-outline:prj_1")).toBeNull();
  });

  it("picks up an outline that was left waiting", async () => {
    localStorage.setItem("deckastra.pending-outline:prj_1", "run_3");
    stub({ checkpoint: { run_id: "run_3", status: "awaiting_story", outline: OUTLINE } });
    show();
    expect(await screen.findByText("One place to watch")).toBeTruthy();
  });

  it("forgets an outline the server no longer holds", async () => {
    localStorage.setItem("deckastra.pending-outline:prj_1", "run_gone");
    stub({});
    show();
    await waitFor(() => expect(localStorage.getItem("deckastra.pending-outline:prj_1")).toBeNull());
    expect(screen.getByTestId("generate-instruction")).toBeTruthy();
  });

  it("where a run cannot pause, the option is absent and the deck is generated directly", async () => {
    const fetcher = stub({ run: { presentation_id: "doc_direct", document: {}, diagnostics: {} } });
    const { props } = show({ reviewAvailable: false });
    expect(screen.queryByTestId("generate-review")).toBeNull();
    ask("A deck");
    await waitFor(() => expect(props.onGenerated).toHaveBeenCalledWith("doc_direct"));
    expect(bodyOf(fetcher, "/v1/generate/review")).toEqual([]);
  });
});

describe("the home's prompt bar", () => {
  it("is always there, and opens the drawer only once Create is pressed", async () => {
    const fetcher = stub({ review: { run_id: "run_9", status: "awaiting_story", outline: OUTLINE } });
    show();
    expect(screen.getByTestId("home-prompt")).toBeTruthy();
    expect(screen.queryByTestId("generate-drawer")).toBeNull();
    expect(screen.getByTestId("home-prompt").hasAttribute("data-drawer-open")).toBe(false);
    const input = screen.getByTestId("generate-instruction");
    fireEvent.change(input, { target: { value: "Why we need a control tower" } });
    // Enter creates; the brief is what was typed.
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("story-checkpoint");
    expect(screen.getByTestId("generate-drawer")).toBeTruthy();
    // The home steps aside for the drawer rather than being covered by it.
    expect(screen.getByTestId("home-prompt").hasAttribute("data-drawer-open")).toBe(true);
    expect(bodyOf(fetcher, "/v1/generate/review")[0]).toMatchObject({ instruction: "Why we need a control tower" });
  });

  it("keeps a waiting outline one press away after the drawer is put away", async () => {
    stub({ review: { run_id: "run_10", status: "awaiting_story", outline: OUTLINE } });
    show();
    ask("A short deck");
    await screen.findByTestId("story-checkpoint");
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByTestId("story-checkpoint")).toBeNull();
    fireEvent.click(await screen.findByTestId("outline-waiting"));
    expect(await screen.findByTestId("story-checkpoint")).toBeTruthy();
  });

  it("offers a blank deck beside Create, and nothing to a viewer", () => {
    stub({});
    const onBlank = vi.fn();
    const { view } = show({ onBlank });
    fireEvent.click(screen.getByTestId("new-deck"));
    expect(onBlank).toHaveBeenCalledOnce();
    view.unmount();
    show({ onBlank, disabled: true });
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "Anything" } });
    expect((screen.getByTestId("generate-submit") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("new-deck") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("one deck at a time", () => {
  it("will not start a second run while an outline waits, and says why", async () => {
    const fetcher = stub({ review: { run_id: "run_11", status: "awaiting_story", outline: OUTLINE } });
    show();
    ask("The first deck");
    await screen.findByTestId("story-checkpoint");
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "A second deck" } });
    const create = screen.getByTestId("generate-submit") as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId("generate-instruction"), { key: "Enter" });
    expect(screen.getByText(/before starting another/)).toBeTruthy();
    expect(bodyOf(fetcher, "/v1/generate/review")).toHaveLength(1);
  });
});
