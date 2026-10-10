// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccountSettings,
  LanguageVoiceSettings,
  SETTINGS_SECTIONS,
  SettingsShell,
  WorkspaceSettings,
  isSettingsSection,
  type SettingsSectionId,
} from "../src/components/SettingsShell";

const session = vi.hoisted(() => ({
  account: vi.fn(),
  readPreference: vi.fn(),
  writePreference: vi.fn(),
}));
const client = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@deckastra/workspace-client/react", () => ({
  useWorkspaceClient: () => Object.assign(client, { session }),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function Harness({ start = "account" as SettingsSectionId, placement }: { start?: SettingsSectionId; placement?: "center" | "full" }) {
  const [section, setSection] = useState<SettingsSectionId>(start);
  return (
    <SettingsShell
      open
      onClose={() => {}}
      section={section}
      onSection={setSection}
      placement={placement}
      content={{ account: <p>account body</p>, ai: <p>ai body</p>, agents: <p>agents body</p> }}
    />
  );
}

describe("Settings", () => {
  it("names its sections in the order Unit 8 gives them", () => {
    expect(SETTINGS_SECTIONS.map(({ label }) => label)).toEqual([
      "Profile",
      "Plan & credits",
      "Workspaces",
      "Agents & services",
      "Languages & voice",
      "Appearance",
      "Privacy & data",
      "About",
    ]);
  });

  it("offers only the sections the host gives it, in that order", () => {
    render(<Harness />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Profile", "Agents & services", "Privacy & data"]);
    // Plan & credits is absent, not an empty page, until there is a plan.
    expect(screen.queryByText("Plan & credits")).toBeNull();
    expect(screen.getByRole("tabpanel").textContent).toBe("account body");
  });

  it("shows a section on click and follows the arrow keys", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("settings-tab-agents"));
    expect(screen.getByRole("tabpanel").textContent).toBe("agents body");
    fireEvent.keyDown(screen.getByTestId("settings-tab-agents"), { key: "ArrowDown" });
    expect(screen.getByRole("tabpanel").textContent).toBe("ai body");
    expect(document.activeElement).toBe(screen.getByTestId("settings-tab-ai"));
  });

  it("fills the window on the desktop and is a wide dialog on the web", () => {
    const { unmount } = render(<Harness placement="full" />);
    expect(screen.getByTestId("settings").getAttribute("data-placement")).toBe("full");
    unmount();
    render(<Harness />);
    expect(screen.getByTestId("settings").getAttribute("data-placement")).toBe("center");
  });

  it("knows a section from a click event someone wired in its place", () => {
    expect(isSettingsSection("appearance")).toBe(true);
    expect(isSettingsSection(new Event("click"))).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
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
    expect(session.account).toHaveBeenCalledWith({ fresh: true });
  });

  it("says when the account could not be read, and what to do", async () => {
    session.account.mockRejectedValue(new Error("offline"));
    render(<AccountSettings />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be read/);
  });
});

describe("the workspaces section", () => {
  it("says where each workspace lives and what the person may do there, in words", async () => {
    session.account.mockResolvedValue({
      user: { id: "usr_1", email: "local@deckastra", name: null },
      workspaces: [
        { id: "ws_1", name: "Your workspace", role: "owner", origin: "local", access: "authoritative", confirmed_at: null, projects: [{}] },
        { id: "ws_2", name: "Team", role: "editor", origin: "cloud", access: "stale", confirmed_at: "2026-10-01T00:00:00Z", projects: [{}, {}] },
      ],
      capabilities: {},
    });
    render(<WorkspaceSettings />);
    expect(await screen.findByText(/On this computer · Owner · 1 project$/)).toBeTruthy();
    expect(screen.getByText(/Online · Can edit · 2 projects$/)).toBeTruthy();
    expect(screen.getByText(/Not checked online for a while/)).toBeTruthy();
    // The ids and raw states are there for a bug report, folded away.
    const advanced = screen.getByTestId("settings-workspaces-advanced");
    expect(advanced.tagName).toBe("DETAILS");
    expect(advanced.hasAttribute("open")).toBe(false);
    expect(advanced.textContent).toContain("ws_2 · cloud · stale");
  });
});

describe("the languages and voice section", () => {
  it("reads and writes the same preferences the editor's panels use", async () => {
    session.readPreference.mockImplementation(async (key: string) =>
      key === "translation" ? { glossary: ["Deckastra"] } : key === "speech" ? { rate: 1.25 } : { list: [{ term: "GCP", say: "G C P" }] },
    );
    session.writePreference.mockResolvedValue(undefined);
    render(<LanguageVoiceSettings />);
    const glossary = (await screen.findByDisplayValue("Deckastra")) as HTMLInputElement;
    expect(await screen.findByDisplayValue("GCP = G C P")).toBeTruthy();

    fireEvent.change(glossary, { target: { value: "Deckastra, OKR" } });
    fireEvent.blur(glossary);
    expect(session.writePreference).toHaveBeenCalledWith("translation", { glossary: ["Deckastra", "OKR"] });
    expect(await screen.findByText("Words to keep saved.")).toBeTruthy();
  });

  it("is absent where nothing keeps preferences", () => {
    const { readPreference, writePreference } = session;
    Object.assign(session, { readPreference: undefined, writePreference: undefined });
    try {
      const { container } = render(<LanguageVoiceSettings />);
      expect(container.textContent).toBe("");
    } finally {
      Object.assign(session, { readPreference, writePreference });
    }
  });
});
