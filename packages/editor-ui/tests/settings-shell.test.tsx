// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountSettings, SettingsShell, type SettingsSectionId } from "../src/components/SettingsShell";

const session = vi.hoisted(() => ({ account: vi.fn() }));
const client = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@deckastra/workspace-client/react", () => ({
  useWorkspaceClient: () => Object.assign(client, { session }),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function Harness({ start = "account" as SettingsSectionId }) {
  const [section, setSection] = useState<SettingsSectionId>(start);
  return (
    <SettingsShell
      open
      onClose={() => {}}
      section={section}
      onSection={setSection}
      content={{ account: <p>account body</p>, ai: <p>ai body</p>, agents: <p>agents body</p> }}
    />
  );
}

describe("Settings", () => {
  it("offers only the sections the host gives it, in the roadmap's order", () => {
    render(<Harness />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Account", "AI and privacy", "Agents"]);
    // Plans and billing is absent, not an empty page, until there is a plan.
    expect(screen.queryByText("Plans and billing")).toBeNull();
    expect(screen.getByRole("tabpanel").textContent).toBe("account body");
  });

  it("shows a section on click and follows the arrow keys", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("settings-tab-agents"));
    expect(screen.getByRole("tabpanel").textContent).toBe("agents body");
    fireEvent.keyDown(screen.getByTestId("settings-tab-agents"), { key: "ArrowUp" });
    expect(screen.getByRole("tabpanel").textContent).toBe("ai body");
    expect(document.activeElement).toBe(screen.getByTestId("settings-tab-ai"));
  });

  it("falls back to the first section when asked for one it does not have", () => {
    render(<Harness start="plans" />);
    expect(screen.getByRole("tabpanel").textContent).toBe("account body");
  });
});

describe("the account section", () => {
  it("says a local install keeps decks on this computer", async () => {
    session.account.mockResolvedValue({
      user: { id: "usr_1", email: "local@deckastra", name: null },
      workspaces: [{ id: "ws_1", name: "Your workspace", origin: "local", projects: [{}] }],
      capabilities: {},
    });
    render(<AccountSettings />);
    expect(await screen.findByText(/kept on this computer/)).toBeTruthy();
    expect(screen.getByText(/On this computer · 1 project$/)).toBeTruthy();
    expect(session.account).toHaveBeenCalledWith({ fresh: true });
  });

  it("says when the account could not be read, and what to do", async () => {
    session.account.mockRejectedValue(new Error("offline"));
    render(<AccountSettings />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be read/);
  });
});
