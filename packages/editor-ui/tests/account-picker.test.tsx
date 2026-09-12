import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AccountPicker } from "../src/components/AccountPicker";
import { browserSessionStore } from "@deckastra/workspace-client";

import { testWorkspaceClient, withWorkspaceClient } from "@deckastra/workspace-client/testing";

// The browser store, because these cases seed the session through localStorage
// exactly as a returning visitor would.
const seededClient = () => testWorkspaceClient({ sessionStore: browserSessionStore() });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("selects and creates projects in the explicitly named workspace", async () => {
  localStorage.setItem(
    "deckastra.session",
    JSON.stringify({ token: "token", userId: "usr_1", workspaceId: "wsp_a", projectId: "prj_a" }),
  );
  let accountCalls = 0;
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/account")) {
      accountCalls += 1;
      return {
        ok: true,
        json: async () => ({
          user: { id: "usr_1", email: "owner@example.com", name: "Owner" },
          workspaces: [
            { id: "wsp_a", name: "Alpha", role: "owner", projects: [{ id: "prj_a", name: "A", description: null }] },
            {
              id: "wsp_b",
              name: "Beta",
              role: "editor",
              projects:
                accountCalls > 1
                  ? [
                      { id: "prj_b", name: "B", description: null },
                      { id: "prj_new", name: "Launch", description: null },
                    ]
                  : [{ id: "prj_b", name: "B", description: null }],
            },
          ],
        }),
      };
    }
    if (url.endsWith("/v1/workspaces/wsp_b/projects") && init?.method === "POST") {
      expect(JSON.parse(init.body as string)).toEqual({ name: "Launch", description: null });
      return { ok: true, json: async () => ({ id: "prj_new", name: "Launch", description: null }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const selected = vi.fn();

  render(<AccountPicker onSelectionChange={selected} />, { wrapper: withWorkspaceClient(seededClient()) });
  await screen.findByText("owner@example.com");
  fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "wsp_b" } });
  expect(selected).toHaveBeenLastCalledWith({ workspaceId: "wsp_b", projectId: "prj_b" });

  fireEvent.click(screen.getByText("Create workspace or project"));
  fireEvent.change(screen.getByLabelText("New project name"), { target: { value: "Launch" } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));

  await waitFor(() =>
    expect(selected).toHaveBeenLastCalledWith({ workspaceId: "wsp_b", projectId: "prj_new" }),
  );
  expect(JSON.parse(localStorage.getItem("deckastra.session")!)).toMatchObject({
    workspaceId: "wsp_b",
    projectId: "prj_new",
  });
});
