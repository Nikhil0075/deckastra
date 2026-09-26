import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { EquationElement, PresentationDocument } from "@deckastra/presentation-schema";
import { validateDocument } from "@deckastra/presentation-schema";
import { makeStarterElement, resolveElementById } from "@deckastra/presentation-core";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { Inspector } from "../src/components/inspector/Inspector";
import { useEditor, type EditorApi } from "../src/lib/useEditor";

/**
 * The Equation section (Design tab review, 2026-09-26): a draft with a live
 * preview, committed once per intent, with structures inserted at the caret.
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

function Harness({ doc, id }: { doc: PresentationDocument; id: string }) {
  editor = useEditor({ initialDocument: doc, presentationId: "prs_eq", initialVersionId: "v0" });
  const selected = resolveElementById(editor.document, id)?.element;
  return (
    <Inspector
      editor={editor}
      presentationId="prs_eq"
      selected={selected}
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
  const doc = structuredClone(loadFixture("technical"));
  const element = makeStarterElement({ kind: "equation", viewport: doc.viewport });
  doc.slides[0]!.elements.push(element);
  expect(validateDocument(doc).errors).toEqual([]);
  render(<Harness doc={doc} id={element.id} />, { wrapper: withWorkspaceClient() });
  // Edits are held until the recovery journal has been checked.
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  const equation = () => resolveElementById(editor.document, element.id)!.element as EquationElement;
  return { element, equation };
}

it("starts with a formula that typesets", async () => {
  const { equation } = await mount();
  expect(equation().latex).toContain(String.raw`\frac`);
  expect(screen.getByTestId("equation-preview").innerHTML).toContain("katex");
  expect(screen.queryByTestId("equation-error")).toBeNull();
});

it("previews while typing and commits once, on leaving the field", async () => {
  const { equation, element } = await mount();
  const field = screen.getByTestId("equation-latex");
  const before = (element as EquationElement).latex;

  fireEvent.change(field, { target: { value: String.raw`\frac{1}{` } });
  // Half-typed: named in the section, not put on the slide.
  expect(screen.getByTestId("equation-error").textContent).toMatch(/expected/i);
  expect(equation().latex).toBe(before);

  fireEvent.change(field, { target: { value: String.raw`\frac{1}{2}` } });
  expect(screen.queryByTestId("equation-error")).toBeNull();
  fireEvent.blur(field);
  expect(equation().latex).toBe(String.raw`\frac{1}{2}`);

  act(() => editor.undo());
  expect(equation().latex).toBe(before);
  // Undo reaches the draft as well as the slide.
  expect((screen.getByTestId("equation-latex") as HTMLTextAreaElement).value).toBe(before);
});

it("inserts a structure at the caret, and Ctrl+Enter puts it on the slide", async () => {
  const { equation } = await mount();
  const field = screen.getByTestId("equation-latex") as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "x = " } });
  field.setSelectionRange(4, 4);
  fireEvent.click(screen.getByRole("button", { name: "Square root" }));
  expect(field.value).toBe(String.raw`x = \sqrt{}`);
  fireEvent.click(screen.getByRole("button", { name: String.raw`Insert \pi` }));
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
  expect(equation().latex).toBe(String.raw`x = \sqrt{}\pi `);
});

it("switches to inline style and back, as one property", async () => {
  const { equation } = await mount();
  fireEvent.click(screen.getByRole("radio", { name: "Inline" }));
  expect(equation().display).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: "Display" }));
  expect(equation().display).toBeUndefined();
});
