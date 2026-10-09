import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Session } from "@deckastra/workspace-contracts";

import { testWorkspaceClient, withWorkspaceClient } from "@deckastra/workspace-client/testing";

import Home from "../app/page";

/**
 * The web home is the shared home (roadmap 08 §1.3). What this route owns is
 * what opening a deck means; these cases hold it to that, and to the two things
 * the old page promised and the shared one must keep: blank and template decks
 * both open only after the workspace service has saved them.
 */

/** Seeded with the token these cases assert reaches the server. */
const client = () => {
  const store: { current: Session } = {
    current: { token: "test-token", userId: "usr_test", workspaceId: "wsp_test", projectId: "prj_test" },
  };
  return testWorkspaceClient({
    sessionStore: {
      read: () => store.current,
      write: (session) => {
        store.current = session;
      },
      clear: () => {},
    },
  });
};

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
// Real apart from browser text measurement, which would
// issue its own requests and say nothing about these journeys.
vi.mock("@deckastra/editor-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@deckastra/editor-ui")>()),
  useBrowserMeasurer: () => undefined,
}));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const account = ok({
  user: { id: "usr_test", email: "test@example.com", name: "Test" },
  workspaces: [
    {
      id: "wsp_test",
      name: "Test",
      role: "owner",
      origin: "local",
      projects: [{ id: "prj_test", name: "Test project", description: null }],
    },
  ],
  capabilities: { sharing: true },
});

function route(url: string) {
  if (url.endsWith("/v1/account")) return account;
  if (url.includes("/v1/projects/prj_test/presentations")) return ok({ presentations: [] });
  if (url.endsWith("/v1/presets")) return ok({
    description: "reviewed",
    purposeGroups: ["business"],
    slidePatterns: ["title"],
    themes: [{ key: "flat", name: "Flat", summary: "", preview: {} }],
    presets: [{ id: "business-pitch", name: "Sharp pitch", summary: "Pitch", purpose: "business", tags: [], themeKey: "flat", motionStyle: "measured", transitionStyle: "fade", voiceStyle: "clear", reviewed: true, slides: [{ key: "opening", pattern: "title", purpose: "Open", slots: { headline: "Hello" } }] }],
  });
  // The home's plan card reads the account's credits on arrival.
  if (url.endsWith("/v1/account/credits")) {
    return ok({ plan: "free", monthly_allowance: 60, remaining_credits: 60, period_start: "2026-10-01T00:00:00+00:00", period_end: "2026-11-01T00:00:00+00:00" });
  }
  return null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockClear();
});

it("creates a blank deck from the home and opens its saved editor", async () => {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const known = route(url);
    if (known) return known;
    expect(url).toMatch(/\/v1\/presentations$/);
    expect(options?.method).toBe("POST");
    expect(options?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    return ok({ presentation_id: "doc_blank", version_id: "ver_initial" });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<Home />, { wrapper: withWorkspaceClient(client()) });
  const blank = await screen.findByTestId("new-deck");
  await waitFor(() => expect((blank as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(blank);
  await waitFor(() => expect(push).toHaveBeenCalledWith("/edit/doc_blank"));
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/v1/presentations"))).toHaveLength(1);
});

it("shows a template failure, and a blank deck still opens", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const known = route(url);
      if (known) return known;
      if (url.endsWith("/v1/decks/from-template")) {
        return { ok: false, status: 502, json: async () => ({ detail: "Template failed" }) };
      }
      return ok({ presentation_id: "doc_after_failure" });
    }),
  );
  render(<Home />, { wrapper: withWorkspaceClient(client()) });
  fireEvent.click(await screen.findByTestId("use-template-business-pitch"));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Template failed/);
  fireEvent.click(screen.getByTestId("new-deck"));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/edit/doc_after_failure"));
});

it("reports a blank deck that could not be made, and makes it on a retry", async () => {
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const known = route(url);
      if (known) return known;
      attempts += 1;
      return attempts === 1
        ? { ok: false, status: 503, json: async () => ({ detail: "Storage unavailable" }) }
        : ok({ presentation_id: "doc_retry" });
    }),
  );
  render(<Home />, { wrapper: withWorkspaceClient(client()) });
  const blank = await screen.findByTestId("new-deck");
  await waitFor(() => expect((blank as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(blank);
  expect((await screen.findByText(/Storage unavailable/)).textContent).toMatch(/Storage unavailable/);
  expect(push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("new-deck"));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/edit/doc_retry"));
});
