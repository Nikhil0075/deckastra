import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ICON_NAMES } from "@deckastra/renderer";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { AddLibrary, type LibraryItem, type LibraryTab } from "../src/components/shell/AddLibrary";
import { forgetPatternPreviews } from "../src/components/shell/PatternPreview";
import { ToolRail } from "../src/components/shell/ToolRail";

/**
 * The Add library and the labelled rail (design review, 2026-09-26): every
 * shape and icon the product has is visible, searchable, and one click away.
 */

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(tab: LibraryTab = "shapes") {
  const added: LibraryItem[] = [];
  let current = tab;
  const view = render(<AddLibrary tab={current} onTab={(next) => (current = next)} onClose={() => {}} onAdd={(item) => added.push(item)} onAddImage={() => {}} />);
  return { added, view, tab: () => current };
}

it("shows every shape as a drawing, filters by category and search, and adds on click", () => {
  const { added } = mount();
  const grid = screen.getByTestId("library-shapes");
  expect(within(grid).getAllByRole("button", { name: /^Add (?!.*favourites)/ }).length).toBe(12);
  expect(grid.querySelectorAll("svg path, svg rect").length).toBeGreaterThanOrEqual(12);

  fireEvent.click(screen.getByRole("button", { name: "Flowchart" }));
  expect(within(screen.getByTestId("library-shapes")).getAllByRole("button", { name: /^Add (?!.*favourites)/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
    "Add rectangle",
    "Add diamond",
    "Add pill",
    "Add parallelogram",
    "Add chevron",
  ]);

  fireEvent.click(screen.getByRole("button", { name: "All" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "callout" } });
  fireEvent.click(within(screen.getByTestId("library-shapes")).getByRole("button", { name: "Add speech bubble" }));
  expect(added).toEqual([{ kind: "shape", shape: "speechBubble" }]);
});

it("shows every curated icon, searchable by keyword, and adds the one chosen", () => {
  const { added } = mount("icons");
  expect(within(screen.getByTestId("library-icons")).getAllByRole("button", { name: /^Add (?!.*favourites)/ }).length).toBe(ICON_NAMES.length);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "postgres" } });
  const found = within(screen.getByTestId("library-icons")).getAllByRole("button", { name: /^Add (?!.*favourites)/ });
  expect(found.map((b) => b.getAttribute("aria-label"))).toEqual(["Add database"]);
  fireEvent.click(found[0]!);
  expect(added).toEqual([{ kind: "icon", name: "database" }]);
});

it("remembers what was added and what was starred, across a remount", () => {
  const first = mount();
  fireEvent.click(screen.getByTestId("library-shape-star"));
  fireEvent.click(screen.getByRole("button", { name: "Add arrow to favourites" }));
  first.view.unmount();

  mount();
  const recent = screen.getByRole("heading", { name: "Recent" }).parentElement!;
  expect(within(recent).getByRole("button", { name: "Add star" })).toBeTruthy();
  const favourites = screen.getByRole("heading", { name: "Favourites" }).parentElement!;
  expect(within(favourites).getByRole("button", { name: "Add arrow" })).toBeTruthy();
});

it("names every rail button, opens the library at a tab, and inserts text in one click", () => {
  const onPanel = vi.fn();
  const onAdd = vi.fn();
  render(<ToolRail onAdd={onAdd} onAddImage={() => {}} onPanel={onPanel} />);
  for (const label of ["Add", "Text", "Patterns", "Shapes", "Icons", "Image", "Chart", "Table", "Diagram", "Equation", "Code", "Layers", "Check"]) {
    expect(screen.getByText(label, { selector: ".dk-railbutton__label" })).toBeTruthy();
  }
  fireEvent.click(screen.getByTestId("tool-icons"));
  expect(onPanel).toHaveBeenLastCalledWith("library", "icons");
  fireEvent.click(screen.getByTestId("tool-add"));
  expect(onPanel).toHaveBeenLastCalledWith("library");
  fireEvent.click(screen.getByTestId("tool-text"));
  expect(onAdd).toHaveBeenLastCalledWith("text");
  fireEvent.click(screen.getByTestId("tool-layers"));
  expect(onPanel).toHaveBeenLastCalledWith("layers");
});

it("inserts a reviewed slide pattern as one local editor change", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url.endsWith("/v1/presets")) return response({
      description: "Reviewed",
      purposeGroups: ["business"],
      slidePatterns: ["statement"],
      patternDefinitions: { statement: { name: "Statement", summary: "One strong idea", composerLayout: "statement", slots: {}, exampleSlots: { headline: "One idea" } } },
      motionStyles: {}, presets: [], themes: [],
    });
    if (url.endsWith("/patterns/insert")) return response({
      outcome: "planned", version_id: "ver_1", slide_id: "sld_new", pattern: "statement", warnings: [],
      operations: [{ op: "add", path: "/slides/1", value: { id: "sld_new", elements: [] } }],
    });
    return response(null);
  });
  vi.stubGlobal("fetch", fetcher);
  const apply = vi.fn();
  const saveNow = vi.fn(async () => true);
  render(
    <AddLibrary tab="patterns" onTab={() => {}} onClose={() => {}} onAdd={() => {}} onAddImage={() => {}}
      presentationId="pres_1" afterSlideId="sld_1" currentVersionId={() => "ver_1"} saveNow={saveNow} apply={apply} />,
    { wrapper: withWorkspaceClient() },
  );
  fireEvent.click(await screen.findByTestId("library-pattern-statement"));
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  const request = fetcher.mock.calls.find(([url]) => String(url).endsWith("/patterns/insert"))!;
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({
    expected_version_id: "ver_1", pattern: "statement", after_slide_id: "sld_1", dry_run: true, client_label: "editor",
  });
  expect(saveNow).toHaveBeenCalled();
  expect(apply.mock.calls[0]![1]).toBe("Insert Statement slide");
});

it("draws each pattern as the slide it adds, read once per design language", async () => {
  forgetPatternPreviews();
  const fetcher = vi.fn(async (url: string) => {
    const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url.endsWith("/v1/presets")) return response({
      description: "Reviewed",
      purposeGroups: ["business"],
      slidePatterns: ["statement", "quote"],
      patternDefinitions: {
        statement: { name: "Statement", summary: "One strong idea", composerLayout: "statement", slots: {}, exampleSlots: {} },
        quote: { name: "Customer quote", summary: "A quote", composerLayout: "quote", slots: {}, exampleSlots: {} },
      },
      motionStyles: {}, presets: [], themes: [],
    });
    if (url.includes("/v1/patterns/preview")) return response({ language: "swiss-signal", revision: "r1", slides: { statement: { id: "sld_p", elements: [] } } });
    return response(null);
  });
  vi.stubGlobal("fetch", fetcher);
  const document = { ...loadFixture("technical"), metadata: { ...loadFixture("technical").metadata, designLanguage: { id: "swiss-signal", version: 1 } } };
  const view = render(
    <AddLibrary tab="patterns" onTab={() => {}} onClose={() => {}} onAdd={() => {}} onAddImage={() => {}} document={document as never} presentationId="pres_1" />,
    { wrapper: withWorkspaceClient() },
  );
  // A pattern with a preview is drawn; one without keeps its icon and its name.
  await waitFor(() => expect(screen.getByTestId("library-pattern-statement").getAttribute("data-previewed")).toBe("true"));
  expect(screen.getByTestId("library-pattern-quote").getAttribute("data-previewed")).toBeNull();
  // The full name is shown, not cut to fit a square.
  expect(within(screen.getByTestId("library-pattern-quote")).getByText("Customer quote")).toBeTruthy();
  const asked = fetcher.mock.calls.filter(([url]) => String(url).includes("/v1/patterns/preview"));
  expect(asked).toHaveLength(1);
  expect(String(asked[0]![0])).toContain("language=swiss-signal");
  view.unmount();
});

it("refreshes Media when an externally generated asset arrives while the panel is open", async () => {
  let assetReads = 0;
  const fetcher = vi.fn(async (url: string) => {
    const path = String(url);
    const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (path.includes("/v1/assets?")) {
      assetReads += 1;
      return response({
        assets: assetReads > 1 ? [{ id: "ast_external", filename: "generated-scene.png", kind: "image", content_type: "image/png", tags: ["generated", "external-tool"], description: "Generated by openai-imagegen", metadata_version: 1 }] : [],
        next_cursor: null,
      });
    }
    if (path.includes("/v1/assets/ast_external/view")) return response({ asset_id: "ast_external", base64: "iVBORw0KGgo=", mime_type: "image/png", width: 32, height: 18 });
    if (path.includes("/v1/assistant/capabilities")) return response({ provider: "none", available: false, reason: "No provider", tasks: { image: { available: false, provider: "none", reason: "No provider" }, video: { available: false, provider: "none", reason: "No provider" } } });
    if (path.endsWith("/v1/presets")) return response({ description: "", purposeGroups: [], slidePatterns: [], patternDefinitions: {}, motionStyles: {}, presets: [], themes: [] });
    return response({});
  });
  vi.stubGlobal("fetch", fetcher);
  const document = loadFixture("technical");
  render(
    <AddLibrary tab="media" onTab={() => {}} onClose={() => {}} onAdd={() => {}} onAddImage={() => {}}
      document={document} presentationId="pres_1" afterSlideId={document.slides[0]!.id} currentVersionId={() => "ver_1"} />,
    { wrapper: withWorkspaceClient() },
  );
  expect(await screen.findByText("Uploaded and generated pictures and clips will appear here.")).toBeTruthy();
  window.dispatchEvent(new Event("focus"));
  expect(await screen.findByText("generated-scene.png")).toBeTruthy();
  expect(screen.getByText("Generated")).toBeTruthy();
  expect(assetReads).toBeGreaterThanOrEqual(2);
});
