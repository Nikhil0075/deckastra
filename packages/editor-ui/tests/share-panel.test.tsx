/**
 * Sharing can be absent, and absent is not broken (2026-09-17).
 *
 * A local install refuses sharing wholesale — a link that machine mints leads
 * nowhere — and this panel used to find that out by calling the route and
 * rendering its 404 as "Not found.", which reads as a failure in a feature that
 * was never there. A packaged-runtime check caught it on screen: a Share heading,
 * a live "Create view link" button, and a red error underneath.
 *
 * The fix is an explicit capability rather than a cleverer reading of the error,
 * and the second test here is the reason. A 404 is not a capability signal: a
 * missing deck and a deck you may not see answer 404 too, *by design*, because a
 * 403 on something you cannot see confirms it exists. Inferring from one would
 * tell someone their workspace cannot share when what actually happened is that
 * their access was revoked.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { SharePanel } from "../src/components/SharePanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A fetch stub that answers the account with a stated capability. */
function server({ sharing, shares = [] }: { sharing: boolean; shares?: unknown[] }) {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/v1/account")) {
      return {
        ok: true,
        json: async () => ({
          user: { id: "usr_1", email: "me@local", name: "Me" },
          workspaces: [],
          capabilities: { sharing },
        }),
      };
    }
    if (String(url).includes("/shares")) {
      return { ok: true, json: async () => ({ shares }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

it("says sharing is unavailable rather than showing a failed request", async () => {
  const fetcher = server({ sharing: false });
  vi.stubGlobal("fetch", fetcher);

  render(<SharePanel presentationId="doc_1" />, { wrapper: withWorkspaceClient() });

  expect(await screen.findByText(/Online sharing isn.t available here/)).toBeTruthy();
  expect(screen.getByText(/This workspace is local/)).toBeTruthy();
  expect(screen.getByText(/export a copy to share/)).toBeTruthy();

  // No error, because nothing failed.
  expect(screen.queryByRole("alert")).toBeNull();
  // And no control that cannot work.
  expect(screen.queryByRole("button", { name: "Create view link" })).toBeNull();
});

it("never asks for links on an install that has none", async () => {
  // The request whose only possible answer was the 404 people were shown.
  const fetcher = server({ sharing: false });
  vi.stubGlobal("fetch", fetcher);

  render(<SharePanel presentationId="doc_1" />, { wrapper: withWorkspaceClient() });
  await screen.findByText(/Online sharing isn.t available here/);

  const asked = fetcher.mock.calls.map(([url]) => String(url));
  expect(asked.some((one) => one.includes("/v1/account"))).toBe(true);
  expect(asked.some((one) => one.includes("/shares"))).toBe(false);
});

it("offers sharing where the deployment supports it", async () => {
  // The control for both cases above: without it, "no button" would be true of a
  // panel that never works anywhere.
  const fetcher = server({
    sharing: true,
    shares: [
      {
        id: "shr_1",
        role: "viewer",
        label: null,
        version_id: null,
        created_at: null,
        expires_at: null,
        revoked_at: null,
        view_count: 0,
        last_viewed_at: null,
        status: "active",
      },
    ],
  });
  vi.stubGlobal("fetch", fetcher);

  render(<SharePanel presentationId="doc_1" />, { wrapper: withWorkspaceClient() });

  // Plain DOM rather than `toBeDisabled`: this package has no jest-dom, and the
  // missing matcher fails as "Invalid Chai property", which reads like the
  // component being wrong rather than the assertion being unavailable.
  await screen.findByRole("button", { name: "Create view link" });
  await waitFor(() => {
    const button = screen.getByRole("button", { name: "Create view link" });
    expect(button.hasAttribute("disabled")).toBe(false);
  });
  expect(screen.queryByText(/Online sharing isn.t available here/)).toBeNull();

  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/shares"))).toBe(true),
  );
});

it("does not read a refused account as a workspace that cannot share", async () => {
  // The case the review warned about, and the one my first attempt got wrong.
  //
  // A 404 is not a capability signal: a missing deck and a deck you may not see
  // answer the same, by design. So an account that could not be read leaves the
  // controls off — offering a button against a server nobody could reach is
  // worse than not offering one — while claiming **nothing** about what this
  // workspace supports. Telling someone whose access was just revoked that their
  // workspace is local would be a confident wrong answer.
  const fetcher = vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({ detail: "Not found." }),
  }));
  vi.stubGlobal("fetch", fetcher);

  render(<SharePanel presentationId="doc_1" />, { wrapper: withWorkspaceClient() });

  expect(await screen.findByText(/could not be checked/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create view link" })).toBeNull();
  // The load-bearing assertion: no claim about this workspace being local.
  expect(screen.queryByText(/This workspace is local/)).toBeNull();
});
