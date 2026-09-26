import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { Inspector } from "../src/components/inspector/Inspector";
import { useEditor, type EditorApi } from "../src/lib/useEditor";

/**
 * The slide background (Design tab review): set from the inspector when nothing
 * is selected, each change one undo step, and "every slide" one patch.
 */

vi.mock("../src/lib/measurer", () => ({ useBrowserMeasurer: () => undefined }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version_id: "v1" }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let editor: EditorApi;

function Harness({ doc }: { doc: PresentationDocument }) {
  editor = useEditor({ initialDocument: doc, presentationId: "prs_background", initialVersionId: "v0" });
  return (
    <Inspector
      editor={editor}
      presentationId="prs_background"
      selected={undefined}
      onReorder={() => {}}
      onToggle={() => {}}
      onGroup={() => {}}
      onUngroup={() => {}}
      onDelete={() => {}}
      onOpenHistory={() => {}}
    />
  );
}

async function mount() {
  // The animation fixture: four slides, none with a background of its own.
  const doc = structuredClone(loadFixture("animation"));
  render(<Harness doc={doc} />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  return structuredClone(doc);
}

it("gives the slide a colour, then a gradient, then hands it back to the theme", async () => {
  const original = await mount();
  const slide = () => editor.document.slides[0]!;
  expect(slide().background).toBeUndefined();

  fireEvent.click(screen.getByRole("radio", { name: "Colour" }));
  expect(slide().background).toEqual({ paint: { type: "solid", color: "token:colors.surface" } });

  fireEvent.click(screen.getByRole("radio", { name: "Gradient" }));
  expect(slide().background?.paint?.type).toBe("linearGradient");

  fireEvent.click(screen.getByRole("radio", { name: "Theme" }));
  expect(slide().background).toBeUndefined();

  for (let i = 0; i < 3; i += 1) act(() => editor.undo());
  expect(editor.document).toEqual(original);
});

it("puts one background on every slide in one undo step", async () => {
  const original = await mount();
  fireEvent.click(screen.getByRole("radio", { name: "Colour" }));
  fireEvent.click(screen.getByTestId("background-apply-all"));
  expect(editor.document.slides.every((slide) => slide.background?.paint?.type === "solid")).toBe(true);
  expect(await screen.findByText(/Applied to 3 other slides/)).toBeTruthy();

  act(() => editor.undo());
  expect(editor.document.slides.slice(1).every((slide) => slide.background === undefined)).toBe(true);
  act(() => editor.undo());
  expect(editor.document).toEqual(original);
});
