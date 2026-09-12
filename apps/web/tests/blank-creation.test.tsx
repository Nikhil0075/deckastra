import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Session } from "@deckastra/workspace-contracts";

import { testWorkspaceClient, withWorkspaceClient } from "@deckastra/workspace-client/testing";

import Home from "../app/page";

/** Seeded with the token these cases assert reaches the server. */
const client = () => {
  const store: { current: Session } = {
    current: { token: "test-token", userId: "usr_test", workspaceId: "wsp_test", projectId: "prj_test" },
  };
  return testWorkspaceClient({
    sessionStore: {
      read: () => store.current,
      write: (session) => { store.current = session; },
      clear: () => {},
    },
  });
};

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
// The editor package is real apart from the two pieces this route does not
// exercise: browser text measurement, and the repository list, which would issue
// its own requests and say nothing about blank creation.
vi.mock("@deckastra/editor-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@deckastra/editor-ui")>()),
  useBrowserMeasurer: () => undefined,
  RepositoryPanel: () => null,
}));

/** The account read every surface makes on mount, answered once here. */
const account = {
  ok: true,
  json: async () => ({
    user: { id: "usr_test", email: "test@example.com", name: "Test" },
    workspaces: [
      { id: "wsp_test", name: "Test", role: "owner", projects: [{ id: "prj_test", name: "Test", description: null }] },
    ],
  }),
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockClear(); });

it.each(["home", "generation failure"])("creates a blank deck from %s and opens its saved editor", async entry => {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/health")) return { ok: true, json: async () => ({ generation: "stub" }) };
    if (url.endsWith("/v1/account")) return account;
    if (url.endsWith("/v1/generate")) return { ok: false, status: 502, json: async () => ({ detail: "Generation failed" }) };
    expect(url).toMatch(/\/v1\/presentations$/);
    expect(options?.method).toBe("POST");
    expect(options?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    return { ok: true, json: async () => ({ presentation_id: "doc_blank", version_id: "ver_initial" }) };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<Home />, { wrapper: withWorkspaceClient(client()) });
  await screen.findByText("test@example.com");
  if (entry === "generation failure") {
    fireEvent.change(screen.getByLabelText("What should the deck be about?"), { target: { value: "Retain my brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate deck" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start from a blank deck" }));
  } else fireEvent.click(screen.getByRole("button", { name: "Start blank" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/edit/doc_blank"));
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/v1/presentations"))).toHaveLength(1);
});

it("reports failed blank creation and allows retry without losing the brief", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/health")) return { ok: true, json: async () => ({ generation: "stub" }) };
    if (url.endsWith("/v1/account")) return account;
    attempts += 1;
    return attempts === 1
      ? { ok: false, status: 503, json: async () => ({ detail: "Storage unavailable" }) }
      : { ok: true, json: async () => ({ presentation_id: "doc_retry" }) };
  }));
  render(<Home />, { wrapper: withWorkspaceClient(client()) });
  await screen.findByText("test@example.com");
  fireEvent.change(screen.getByLabelText("What should the deck be about?"), { target: { value: "Keep this brief" } });
  fireEvent.click(screen.getByRole("button", { name: "Start blank" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Storage unavailable");
  expect((screen.getByLabelText("What should the deck be about?") as HTMLTextAreaElement).value).toBe("Keep this brief");
  expect(push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start blank" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/edit/doc_retry"));
});
