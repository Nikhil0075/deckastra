import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { RepositoryPanel } from "../src/components/RepositoryPanel";
import { ThemePanel } from "../src/components/ThemePanel";
import { useEditor } from "../src/lib/useEditor";

/**
 * Every surface has four states, each said (roadmap 08 §1.2 rule 5): reading,
 * could not read, nothing there, and done. These are the surfaces the rule's
 * audit found claiming "nothing" before they had read anything, or reporting a
 * failed read as an ordinary note.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const failed = (status: number, detail: string) => ({ ok: false, status, json: async () => ({ detail }) }) as Response;

describe("connected repositories", () => {
  it("says it is reading, never 'nothing connected', before the list arrives", async () => {
    let answer: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    render(<RepositoryPanel selected={[]} onSelectionChange={() => {}} embedded />, { wrapper: withWorkspaceClient() });
    expect(screen.getByText("Reading connected repositories…")).toBeTruthy();
    expect(screen.queryByText(/Nothing connected yet/)).toBeNull();
    answer(ok({ repositories: [], github: { install_url: null }, local_allowed: false }));
    expect(await screen.findByText(/Nothing connected yet/)).toBeTruthy();
    // Whoever runs the server configures GitHub; the panel names no setting.
    expect(screen.getByText("Connecting GitHub repositories is not set up on this server.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/GITHUB_/);
  });

  it("says when the list could not be read, and reads it again on request", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(failed(503, "Service unavailable"))
      .mockResolvedValueOnce(ok({ repositories: [], github: { install_url: null }, local_allowed: false }));
    vi.stubGlobal("fetch", fetcher);
    render(<RepositoryPanel selected={[]} onSelectionChange={() => {}} embedded />, { wrapper: withWorkspaceClient() });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Service unavailable/);
    expect(screen.queryByText(/Nothing connected yet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Nothing connected yet/)).toBeTruthy();
  });
});

describe("saved workspace themes", () => {
  const document = loadFixture("technical");
  function Harness() {
    const editor = useEditor({ initialDocument: document, presentationId: document.id, initialVersionId: "v0" });
    return <ThemePanel editor={editor} presentationId={document.id} />;
  }

  it("says there are none yet, once it has read that there are none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ themes: [] })));
    render(<Harness />, { wrapper: withWorkspaceClient() });
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(await screen.findByText(/No saved themes in this workspace yet/)).toBeTruthy();
  });

  it("reports a list that could not be read as an error, with a way to try again", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(failed(500, "Database is busy"))
      .mockResolvedValueOnce(ok({ themes: [{ id: "thm_1", name: "Brand", is_default: false }] }));
    vi.stubGlobal("fetch", fetcher);
    render(<Harness />, { wrapper: withWorkspaceClient() });
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be read: Database is busy/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("option", { name: "Brand" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("pending changes", () => {
  it("says when it could not check, instead of looking for ever, and recovers on the next read", async () => {
    const { ProposalsPanel } = await import("../src/components/ProposalsPanel");
    const fetcher = vi.fn().mockResolvedValueOnce(failed(503, "Busy")).mockResolvedValue(ok([]));
    vi.stubGlobal("fetch", fetcher);
    const document = loadFixture("technical");
    render(
      <ProposalsPanel
        presentationId={document.id}
        document={document}
        onApplied={() => true}
        saveNow={async () => true}
        currentVersionId={() => "v0"}
        pollMs={0}
      />,
      { wrapper: withWorkspaceClient() },
    );
    expect(await screen.findByTestId("proposals-unread")).toBeTruthy();
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText(/Nothing is waiting for you/)).toBeTruthy();
    expect(screen.queryByTestId("proposals-unread")).toBeNull();
  });
});
