import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { TemplatesView, matchesLook } from "../src/components/TemplatesView";

/** Filtering the gallery by design language and by look (UI audit 2026-10-10, unit 7b). */

const axes = (expression: string, density: string, imagery: string, motion: string, tone: string) => ({ expression, density, imagery, motion, tone });

const catalog = {
  description: "reviewed",
  purposeGroups: ["business", "technical"],
  slidePatterns: ["title"],
  patternDefinitions: { title: { name: "Title", summary: "", composerLayout: "title", slots: {}, exampleSlots: {} } },
  themes: [{ key: "flat", name: "Flat", summary: "", preview: { background: "#fff", foreground: "#111", accent: "#00f", surface: "#eee" } }],
  designLanguages: {
    neutral: { id: "neutral", name: "Neutral", version: 1, summary: "", axes: axes("editorial", "dense", "graphic", "calm", "formal"), rules: [], forbid: [] },
    "swiss-signal": { id: "swiss-signal", name: "Swiss Signal", version: 1, summary: "", axes: axes("expressive", "spacious", "graphic", "calm", "formal"), rules: [], forbid: [] },
    "play-lab": { id: "play-lab", name: "Play Lab", version: 1, summary: "", axes: axes("expressive", "spacious", "graphic", "kinetic", "playful"), rules: [], forbid: [] },
  },
  presets: [
    { id: "quarterly-review", name: "Quarterly review", summary: "Ops", purpose: "business", designLanguage: "swiss-signal", tags: [], themeKey: "flat", motionStyle: "restrained", transitionStyle: "cut", voiceStyle: "direct", reviewed: true, slides: [{ key: "opening", pattern: "title", purpose: "Open", slots: { headline: "Q3" } }] },
    { id: "onboarding", name: "Team onboarding", summary: "Welcome", purpose: "business", designLanguage: "play-lab", tags: [], themeKey: "flat", motionStyle: "playful", transitionStyle: "push", voiceStyle: "warm", reviewed: true, slides: [{ key: "opening", pattern: "title", purpose: "Open", slots: { headline: "Hi" } }] },
  ],
};

function serve() {
  globalThis.fetch = vi.fn(async (input: string) => {
    if (input.endsWith("/v1/presets")) return { ok: true, status: 200, json: async () => catalog } as Response;
    throw new Error(`Unexpected ${input}`);
  }) as typeof fetch;
}

afterEach(cleanup);

describe("design-language filters", () => {
  it("offers only the languages templates use, and filters by one", async () => {
    serve();
    render(<TemplatesView projectId="prj" query="" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    expect(await screen.findByRole("heading", { name: "Quarterly review" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("template-language"));
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    // Neutral has no templates, so it is not a choice.
    expect(options).toEqual(["Any language", "Swiss Signal", "Play Lab"]);
    fireEvent.click(screen.getByRole("option", { name: "Play Lab" }));
    expect(screen.queryByRole("heading", { name: "Quarterly review" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Team onboarding" })).toBeTruthy();
  });

  it("filters by look, and Clear filters brings everything back", async () => {
    serve();
    render(<TemplatesView projectId="prj" query="" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    await screen.findByRole("heading", { name: "Quarterly review" });

    fireEvent.click(screen.getByTestId("template-look-kinetic"));
    expect(screen.queryByRole("heading", { name: "Quarterly review" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Team onboarding" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("heading", { name: "Quarterly review" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Team onboarding" })).toBeTruthy();
  });

  it("finds a template by its language's name in the search", async () => {
    serve();
    render(<TemplatesView projectId="prj" query="swiss" onCreated={() => {}} />, { wrapper: withWorkspaceClient() });
    expect(await screen.findByRole("heading", { name: "Quarterly review" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Team onboarding" })).toBeNull();
  });
});

describe("matchesLook", () => {
  const play = axes("expressive", "spacious", "graphic", "kinetic", "playful") as never;

  it("matches every chosen axis, and both poles of one axis means either", () => {
    expect(matchesLook(play, new Set(["motion:kinetic", "tone:playful"]))).toBe(true);
    expect(matchesLook(play, new Set(["motion:kinetic", "tone:formal"]))).toBe(false);
    expect(matchesLook(play, new Set(["tone:formal", "tone:playful"]))).toBe(true);
    expect(matchesLook(undefined, new Set(["tone:formal"]))).toBe(false);
  });
});
