import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { TemplatesView, agentPrompt } from "../src/components/TemplatesView";

const catalog = {
  description: "reviewed",
  purposeGroups: ["business", "technical"],
  slidePatterns: ["title", "statement"],
  patternDefinitions: {
    title: {
      name: "Title",
      summary: "",
      composerLayout: "title",
      slots: {
        headline: { kind: "text", label: "Headline", description: "", required: true },
        points: { kind: "text-list", label: "Points", description: "" },
        figures: { kind: "metrics", label: "Figures", description: "" },
      },
      exampleSlots: {},
    },
  },
  themes: [
    { key: "flat", name: "Flat", summary: "", preview: { background: "#fff", foreground: "#111", accent: "#00f", surface: "#eee" } },
    { key: "midnight", name: "Midnight", summary: "", preview: { background: "#111", foreground: "#fff", accent: "#0ff", surface: "#222" } },
  ],
  presets: [
    { id: "business-pitch", name: "Sharp pitch", summary: "Pitch", purpose: "business", tags: [], themeKey: "flat", motionStyle: "measured", transitionStyle: "fade", voiceStyle: "clear", reviewed: true, slides: [{ key: "opening", pattern: "title", purpose: "Open", slots: { headline: "Hello" } }] },
    { id: "technical-review", name: "Architecture review", summary: "Review", purpose: "technical", tags: [], themeKey: "midnight", motionStyle: "precise", transitionStyle: "cut", voiceStyle: "direct", reviewed: true, slides: [{ key: "opening", pattern: "title", purpose: "Open", slots: { headline: "System" } }] },
    { id: "business-update", name: "Board update", summary: "Quarterly", purpose: "business", tags: ["board"], themeKey: "flat", motionStyle: "measured", transitionStyle: "fade", voiceStyle: "clear", reviewed: true, slides: [{ key: "opening", pattern: "title", purpose: "Open", slots: { headline: "Q3" } }] },
  ],
};

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function serve() {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith("/v1/presets")) return response(catalog);
    if (input.endsWith("/v1/decks/from-template")) return response({ presentation_id: "doc_new", version_id: "ver_1", document: {} });
    throw new Error(`Unexpected ${input} ${init?.method ?? "GET"}`);
  });
  globalThis.fetch = fetcher as typeof fetch;
  return fetcher;
}

const sent = (fetcher: ReturnType<typeof serve>) => {
  const request = fetcher.mock.calls.find(([url]) => String(url).endsWith("/v1/decks/from-template"));
  return JSON.parse(String(request?.[1]?.body));
};

afterEach(cleanup);

describe("the Templates destination", () => {
  it("filters by purpose, switches theme, and creates through the preset endpoint", async () => {
    const fetcher = serve();
    const opened = vi.fn();
    render(<TemplatesView projectId="prj_one" query="" onCreated={opened} />, { wrapper: withWorkspaceClient() });

    expect(await screen.findByRole("heading", { name: "Sharp pitch" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Technical" }));
    expect(screen.queryByRole("heading", { name: "Sharp pitch" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Architecture review" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("template-theme"));
    fireEvent.click(screen.getByRole("option", { name: "Midnight" }));
    fireEvent.click(screen.getByTestId("use-template-technical-review"));

    await waitFor(() => expect(opened).toHaveBeenCalledWith("doc_new"));
    expect(sent(fetcher)).toMatchObject({ template_id: "technical-review", project_id: "prj_one", theme_key: "midnight" });
  });

  it("uses each template's own theme until a preview theme is chosen", async () => {
    const fetcher = serve();
    render(<TemplatesView projectId="prj_one" query="" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    fireEvent.click(await screen.findByTestId("use-template-technical-review"));
    await waitFor(() => expect(sent(fetcher).theme_key).toBe("midnight"));
  });

  it("searches by the text it is given: name, summary and tags", async () => {
    serve();
    const { rerender } = render(<TemplatesView projectId="prj_one" query="" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    await screen.findByRole("heading", { name: "Sharp pitch" });

    rerender(<TemplatesView projectId="prj_one" query="board" onCreated={() => {}} />);
    expect(screen.queryByRole("heading", { name: "Sharp pitch" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Board update" })).toBeTruthy();
    expect(screen.getByText(/1 reviewed template matching “board”/)).toBeTruthy();
  });

  it("features one template per purpose, and never shows it twice", async () => {
    serve();
    render(<TemplatesView projectId="prj_one" query="" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    const featured = await screen.findByRole("group", { name: "Featured templates" });
    expect(within(featured).getByRole("heading", { name: "Sharp pitch" })).toBeTruthy();
    expect(within(featured).getByRole("heading", { name: "Architecture review" })).toBeTruthy();
    expect(within(featured).queryByRole("heading", { name: "Board update" })).toBeNull();
    expect(screen.getAllByRole("heading", { name: "Sharp pitch" })).toHaveLength(1);
  });

  it("shows the three-step agent path", async () => {
    serve();
    render(<TemplatesView projectId="prj_one" query="" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    fireEvent.click(await screen.findByText("Build with your agent"));
    expect(screen.getByText(/preset_list/)).toBeTruthy();
    expect(screen.getByText(/deck_compose/)).toBeTruthy();
  });

  it("opens a template's details and creates it with the person's own words", async () => {
    const fetcher = serve();
    const opened = vi.fn();
    render(<TemplatesView projectId="prj_one" query="" onCreated={opened} />, { wrapper: withWorkspaceClient() });
    fireEvent.click(await screen.findByTestId("template-card-business-pitch"));

    const detail = await screen.findByTestId("template-detail");
    expect(within(detail).getByRole("list", { name: "Slides in this template" })).toBeTruthy();
    fireEvent.click(within(detail).getByTestId("template-write"));
    // Metric slots keep the template's example values; only words are asked for.
    expect(within(detail).queryByLabelText("Figures")).toBeNull();
    fireEvent.change(within(detail).getByLabelText("Headline"), { target: { value: "  Our launch  " } });
    fireEvent.change(within(detail).getByLabelText("Points"), { target: { value: "Fast\n\n Safe " } });
    fireEvent.click(within(detail).getByTestId("template-use-content"));

    await waitFor(() => expect(opened).toHaveBeenCalledWith("doc_new"));
    expect(sent(fetcher)).toMatchObject({
      template_id: "business-pitch",
      content: { opening: { headline: "Our launch", points: ["Fast", "Safe"] } },
    });
  });

  it("sends no content map when nothing was written", async () => {
    const fetcher = serve();
    render(<TemplatesView projectId="prj_one" query="" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    fireEvent.click(await screen.findByTestId("template-card-business-pitch"));
    fireEvent.click(within(await screen.findByTestId("template-detail")).getByTestId("template-use"));
    await waitFor(() => expect(sent(fetcher)).toBeTruthy());
    expect(sent(fetcher).content).toBeUndefined();
  });

  it("copies an agent prompt that names the template and asks for no geometry", async () => {
    serve();
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<TemplatesView projectId="prj_one" query="" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    fireEvent.click(await screen.findByTestId("template-card-technical-review"));
    fireEvent.click(within(await screen.findByTestId("template-detail")).getByTestId("template-ask-agent"));
    await screen.findByText(/Copied/);
    const prompt = writeText.mock.calls[0]![0] as string;
    expect(prompt).toContain("template_id: technical-review");
    expect(prompt).toContain("deck_from_template");
    expect(prompt).toMatch(/Do not supply coordinates/);
    expect(prompt).toBe(agentPrompt(catalog.presets[1] as never));
  });

  it("shows the prompt to select by hand when the clipboard refuses", async () => {
    serve();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => Promise.reject(new Error("denied")) }, configurable: true });
    render(<TemplatesView projectId="prj_one" query="" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    fireEvent.click(await screen.findByTestId("template-card-technical-review"));
    fireEvent.click(within(await screen.findByTestId("template-detail")).getByTestId("template-ask-agent"));
    expect(await screen.findByText(/could not copy/)).toBeTruthy();
    expect(screen.getByText(/template_id: technical-review/)).toBeTruthy();
  });

  it("offers nothing to create while there is no project to put it in", async () => {
    serve();
    render(<TemplatesView projectId={null} query="" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    const use = await screen.findByTestId("use-template-business-pitch");
    expect((use as HTMLButtonElement).disabled).toBe(true);
  });
});
