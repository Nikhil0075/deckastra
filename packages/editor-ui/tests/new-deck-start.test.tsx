import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { NewDeckStart } from "../src/components/NewDeckStart";

const catalog = {
  description: "reviewed",
  purposeGroups: ["business", "technical"],
  slidePatterns: ["title", "statement"],
  themes: [
    { key: "flat", name: "Flat", summary: "", preview: { background: "#fff", foreground: "#111", accent: "#00f", surface: "#eee" } },
    { key: "midnight", name: "Midnight", summary: "", preview: { background: "#111", foreground: "#fff", accent: "#0ff", surface: "#222" } },
  ],
  presets: [
    { id: "business-pitch", name: "Sharp pitch", summary: "Pitch", purpose: "business", tags: [], themeKey: "flat", motionStyle: "measured", transitionStyle: "fade", voiceStyle: "clear", reviewed: true, slides: [{ key: "opening", pattern: "title", purpose: "Open", slots: { headline: "Hello" } }] },
    { id: "technical-review", name: "Architecture review", summary: "Review", purpose: "technical", tags: [], themeKey: "midnight", motionStyle: "precise", transitionStyle: "cut", voiceStyle: "direct", reviewed: true, slides: [{ key: "opening", pattern: "title", purpose: "Open", slots: { headline: "System" } }] },
  ],
};

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(cleanup);

describe("template-first deck creation", () => {
  it("filters by purpose, switches theme, and creates through the preset endpoint", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/v1/presets")) return response(catalog);
      if (input.endsWith("/v1/decks/from-template")) return response({ presentation_id: "doc_new", version_id: "ver_1", document: {} });
      throw new Error(`Unexpected ${input} ${init?.method ?? "GET"}`);
    });
    const opened = vi.fn();
    globalThis.fetch = fetcher as typeof fetch;
    render(
      <NewDeckStart projectId="prj_one" onCreated={opened} onBlank={() => {}} />,
      { wrapper: withWorkspaceClient() },
    );

    expect(await screen.findByRole("heading", { name: "Sharp pitch" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Technical" }));
    expect(screen.queryByRole("heading", { name: "Sharp pitch" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Architecture review" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("template-theme"));
    fireEvent.click(screen.getByRole("option", { name: "Midnight" }));
    fireEvent.click(screen.getByTestId("use-template-technical-review"));

    await waitFor(() => expect(opened).toHaveBeenCalledWith("doc_new"));
    const request = fetcher.mock.calls.find(([url]) => String(url).endsWith("/v1/decks/from-template"));
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      template_id: "technical-review",
      project_id: "prj_one",
      theme_key: "midnight",
    });
  });

  it("shows the three-step agent path", async () => {
    globalThis.fetch = vi.fn(async () => response(catalog)) as typeof fetch;
    render(<NewDeckStart projectId="prj_one" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    fireEvent.click(await screen.findByText("Build with your agent"));
    expect(screen.getByText(/preset_list/)).toBeTruthy();
    expect(screen.getByText(/deck_compose/)).toBeTruthy();
  });

  it("searches reviewed templates by name, summary and tags", async () => {
    globalThis.fetch = vi.fn(async () => response(catalog)) as typeof fetch;
    render(<NewDeckStart projectId="prj_one" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    await screen.findByRole("heading", { name: "Sharp pitch" });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), { target: { value: "review" } });
    expect(screen.queryByRole("heading", { name: "Sharp pitch" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Architecture review" })).toBeTruthy();
    expect(screen.getByText("1 reviewed template")).toBeTruthy();
  });
});
