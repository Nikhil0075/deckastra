import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { findPreset, ThemeDefinitionSchema, type PresentationDocument } from "@deckastra/presentation-schema";
import { makeStarterElement } from "@deckastra/presentation-core";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { ThemePanel } from "../src/components/ThemePanel";
import { applyThemeOperations, isCard } from "../src/lib/theme-apply";
import { useEditor, type EditorApi } from "../src/lib/useEditor";

/**
 * The theme gallery and theme files (Design tab review). What a preset does to
 * a deck is checked on the document, and each apply is one undo step.
 */

vi.mock("../src/lib/measurer", () => ({ useBrowserMeasurer: () => undefined }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ themes: [], version_id: "v1" }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let editor: EditorApi;

function Harness({ doc }: { doc: PresentationDocument }) {
  editor = useEditor({ initialDocument: doc, presentationId: "prs_gallery", initialVersionId: "v0" });
  return <ThemePanel editor={editor} presentationId="prs_gallery" />;
}

/** The technical fixture, with a card (a filled rectangle) on the second slide. */
function deckWithCard(): PresentationDocument {
  const doc = structuredClone(loadFixture("technical"));
  const card = makeStarterElement({ kind: "shape", shape: "rectangle", viewport: doc.viewport });
  card.style = { ...(card.style ?? {}), fill: { type: "solid", color: "token:colors.surface" } };
  doc.slides[1]!.elements.push(card);
  return doc;
}

async function mount(doc = deckWithCard()) {
  render(<Harness doc={doc} />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  return structuredClone(doc);
}

it("applies a style preset with its look, in one undo step", async () => {
  const original = await mount();
  fireEvent.click(screen.getByTestId("preset-glassmorphism"));
  fireEvent.click(screen.getByTestId("theme-apply-preset"));

  const glass = findPreset("glassmorphism")!;
  expect(editor.document.theme).toEqual(glass.theme);
  // Every slide takes the style's background.
  expect(editor.document.slides.every((slide) => slide.background?.paint?.type === "linearGradient")).toBe(true);
  // And the card becomes frosted glass.
  const card = editor.document.slides[1]!.elements.at(-1)!;
  expect(card.style?.backdropFilters).toEqual([{ type: "blur", radius: 18 }]);
  expect(card.style?.cornerRadius).toBe(20);

  act(() => editor.undo());
  expect(editor.document).toEqual(original);
});

it("applies only the theme when restyling is turned off", async () => {
  const original = await mount();
  fireEvent.click(screen.getByTestId("preset-neo-brutalism"));
  fireEvent.click(screen.getByTestId("theme-restyle"));
  fireEvent.click(screen.getByTestId("theme-apply-preset"));
  expect(editor.document.theme.name).toBe("Neo-Brutalism");
  expect(editor.document.slides.map((slide) => slide.background)).toEqual(original.slides.map((slide) => slide.background));
  expect(editor.document.slides[1]!.elements.at(-1)!.style).toEqual(original.slides[1]!.elements.at(-1)!.style);
});

it("leaves lines, text and locked cards alone when restyling", () => {
  const doc = deckWithCard();
  const locked = structuredClone(doc.slides[1]!.elements.at(-1)!);
  locked.id = "el_01JB8Z9K2QW4RN7F3XG5HTM777";
  locked.locked = true;
  doc.slides[1]!.elements.push(locked);
  const operations = applyThemeOperations(doc, findPreset("bento")!.theme, { restyle: findPreset("bento")!.kit });
  const styled = operations.filter((operation) => operation.path.endsWith("/style")).map((operation) => operation.path);
  // A path ends at the element it restyles; a card inside a group has the
  // group's id earlier in its path.
  const restyled = (id: string) => styled.some((path) => path.endsWith(`id:${id}/style`));
  expect(restyled(locked.id)).toBe(false);
  expect(restyled(doc.slides[1]!.elements.at(-2)!.id)).toBe(true);
  for (const slide of doc.slides) {
    for (const element of slide.elements) {
      if (!isCard(element)) expect(restyled(element.id)).toBe(false);
    }
  }
});

it("imports a theme file, and refuses one that is not a theme", async () => {
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "File" }));
  const input = screen.getByTestId("theme-import-input") as HTMLInputElement;

  const bad = new File(["{\"name\": 3}"], "bad.json", { type: "application/json" });
  fireEvent.change(input, { target: { files: [bad] } });
  expect(await screen.findByText(/not a theme this app can use/)).toBeTruthy();

  const pastel = findPreset("playful-pastel")!.theme;
  const good = new File([JSON.stringify({ kind: "deckastra.theme", version: 1, theme: pastel })], "pastel.theme.json", { type: "application/json" });
  fireEvent.change(input, { target: { files: [good] } });
  expect(await screen.findByText(/Imported Playful Pastel/)).toBeTruthy();
  expect(editor.document.theme.colors).toEqual(pastel.colors);
  // A fresh id: two decks that imported one file are not one saved theme.
  expect(editor.document.theme.id).not.toBe(pastel.id);
  expect(ThemeDefinitionSchema.safeParse(editor.document.theme).success).toBe(true);
});
