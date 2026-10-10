/**
 * The resizable workspace, in the real shell (UI audit 2026-10-10, unit 3):
 * splitters between the panes, remembered sizes, Focus and Reset in the bar,
 * and a narrow window that puts the strip away without forgetting it.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { EditorShell } from "../src/components/EditorShell";

vi.mock("../src/lib/measurer", () => ({ useBrowserMeasurer: () => undefined }));

const width = Object.getOwnPropertyDescriptor(window, "innerWidth");

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version_id: "v1" }) })));
  setWindowWidth(1440);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (width) Object.defineProperty(window, "innerWidth", width);
});

function setWindowWidth(value: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value });
}

async function mountShell() {
  const view = render(
    <EditorShell initialDocument={structuredClone(loadFixture("technical"))} presentationId="prs_layout" initialVersionId="v0" />,
    { wrapper: withWorkspaceClient() },
  );
  await waitFor(() => {
    if (!view.container.querySelector("[data-editor-canvas]")) throw new Error("canvas not mounted");
  });
  const shell = view.container.querySelector<HTMLElement>(".dk-shell")!;
  return { view, shell };
}

const region = (name: string) => document.querySelector(`[data-region="${name}"]`);

describe("the resizable workspace", () => {
  it("draws a named splitter beside the strip and the side panel, at the default sizes", async () => {
    const { shell } = await mountShell();
    expect(screen.getByRole("separator", { name: "Slides width" }).getAttribute("aria-valuenow")).toBe("176");
    expect(screen.getByRole("separator", { name: "Side panel width" }).getAttribute("aria-valuenow")).toBe("288");
    expect(shell.style.getPropertyValue("--dk-strip-width")).toBe("176px");
    expect(shell.style.getPropertyValue("--dk-inspector-width")).toBe("288px");
  });

  it("resizes the strip from the keyboard and remembers it", async () => {
    const { shell } = await mountShell();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Slides width" }), { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(shell.style.getPropertyValue("--dk-strip-width")).toBe("240px"));
    expect(JSON.parse(localStorage.getItem("deckastra.layout")!)).toMatchObject({ strip: 240 });

    // A new editor (the next deck, or a relaunch) opens at that width.
    cleanup();
    const again = await mountShell();
    expect(again.shell.style.getPropertyValue("--dk-strip-width")).toBe("240px");
  });

  it("resizes the side panel the other way: left makes it wider", async () => {
    const { shell } = await mountShell();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Side panel width" }), { key: "ArrowLeft" });
    await waitFor(() => expect(shell.style.getPropertyValue("--dk-inspector-width")).toBe("304px"));
  });

  it("focuses on the slide from the bar, and brings the panes back", async () => {
    await mountShell();
    const focus = screen.getByTestId("focus-toggle");
    expect(focus.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(focus);
    await waitFor(() => expect(region("slides")).toBeNull());
    expect(region("tools")).toBeNull();
    expect(region("panel")).toBeNull();
    expect(screen.getByTestId("focus-toggle").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("focus-toggle"));
    await waitFor(() => expect(region("slides")).toBeTruthy());
    expect(region("panel")).toBeTruthy();
  });

  it("resets every pane and size from the Layout menu", async () => {
    const { shell } = await mountShell();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Slides width" }), { key: "End" });
    await waitFor(() => expect(shell.style.getPropertyValue("--dk-strip-width")).toBe("320px"));
    fireEvent.click(screen.getByTestId("focus-toggle"));
    await waitFor(() => expect(region("slides")).toBeNull());

    fireEvent.click(screen.getByTestId("layout-menu"));
    const menu = await screen.findByRole("menu", { name: "Layout" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Reset workspace/ }));
    await waitFor(() => expect(region("slides")).toBeTruthy());
    expect(shell.style.getPropertyValue("--dk-strip-width")).toBe("176px");
    expect(JSON.parse(localStorage.getItem("deckastra.layout")!)).toMatchObject({ strip: 176, inspector: 288 });
  });

  it("lists the panels in the Layout menu with their shortcuts, checked as they are", async () => {
    await mountShell();
    fireEvent.click(screen.getByTestId("layout-menu"));
    const menu = await screen.findByRole("menu", { name: "Layout" });
    const slides = within(menu).getByRole("menuitemcheckbox", { name: /Slides/ });
    expect(slides.getAttribute("aria-checked")).toBe("true");
    expect(slides.textContent).toContain("Ctrl+Alt+2");
    fireEvent.click(slides);
    await waitFor(() => expect(region("slides")).toBeNull());
  });

  it("puts the strip away in a window too narrow for it, and brings it back at its chosen width", async () => {
    const { shell } = await mountShell();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Slides width" }), { key: "ArrowRight" });
    await waitFor(() => expect(shell.style.getPropertyValue("--dk-strip-width")).toBe("192px"));

    act(() => {
      setWindowWidth(760);
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(shell.getAttribute("data-strip-collapsed")).toBe("true"));
    expect(region("slides")).toBeNull();
    // The side panel stays: it holds the controls being used.
    expect(region("panel")).toBeTruthy();
    // Nothing chosen was forgotten.
    expect(JSON.parse(localStorage.getItem("deckastra.layout")!)).toMatchObject({ strip: 192 });

    act(() => {
      setWindowWidth(1440);
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(region("slides")).toBeTruthy());
    expect(shell.style.getPropertyValue("--dk-strip-width")).toBe("192px");
  });

  it("puts the side panel away while the Assistant is open in a narrow window, and brings it back", async () => {
    await mountShell();
    expect(region("panel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("open-assistant"));
    await waitFor(() => expect(region("assistant")).toBeTruthy());
    expect(region("panel")).toBeNull();
    fireEvent.click(screen.getByTestId("close-assistant"));
    await waitFor(() => expect(region("assistant")).toBeNull());
    expect(region("panel")).toBeTruthy();
    // Nothing about the side panel was changed or saved by that.
    expect(JSON.parse(localStorage.getItem("deckastra.panels") ?? "{}").inspector ?? true).toBe(true);
  });

  it("shows the Assistant beside the side panel in a wide window, with its own splitter", async () => {
    setWindowWidth(1920);
    await mountShell();
    fireEvent.click(screen.getByTestId("open-assistant"));
    await waitFor(() => expect(region("assistant")).toBeTruthy());
    expect(region("panel")).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Assistant width" }).getAttribute("aria-valuenow")).toBe("360");
  });
});

describe("the Review button", () => {
  const waiting = [
    { id: "txn_a", status: "pending", intent: "Rename", reason: null, risk_tier: "high", agent_id: "mcp:codex", run_id: null, created_at: "2026-10-10T00:00:00Z", expires_at: null, operation_count: 1 },
  ];

  it("is absent while nothing waits", async () => {
    await mountShell();
    expect(screen.queryByTestId("open-review")).toBeNull();
  });

  it("shows what waits, opens Review in place of the canvas, and closes on Escape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(String(url), "http://x").pathname;
        if (path.endsWith("/proposals")) return { ok: true, status: 200, json: async () => waiting };
        return { ok: true, status: 200, json: async () => ({ version_id: "v1" }) };
      }),
    );
    await mountShell();
    const button = await screen.findByTestId("open-review");
    expect(button.getAttribute("aria-label")).toBe("Review, 1 waiting");
    fireEvent.click(button);
    expect(await screen.findByTestId("review-workspace")).toBeTruthy();
    expect(document.querySelector("[data-editor-canvas]")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-editor-canvas]")).toBeTruthy());
    expect(screen.queryByTestId("review-workspace")).toBeNull();
  });
});

