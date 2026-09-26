import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import {
  newId,
  type PresentationDocument,
  type PresentationElement,
  type RichTextDocument,
  type TextElement,
} from "@deckastra/presentation-schema";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { EditorShell } from "../src/components/EditorShell";
import { EditorCanvas } from "../src/components/EditorCanvas";
import { useEditor, type EditorApi } from "../src/lib/useEditor";

/**
 * The manual-authoring review's shell and inspector items, driven through the
 * real components: Enter to edit (MA-05), Ungroup (MA-06), inspector group
 * resize (MA-07), rich text through the inspector (MA-08), shape labels
 * (MA-20), and a click that does not dirty the deck (MA-01).
 */

vi.mock("../src/lib/measurer", () => ({ useBrowserMeasurer: () => undefined }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version_id: "v1" }) })));
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
});

const BULLETS: RichTextDocument = {
  version: 1,
  blocks: [
    { id: "blk_01JAAAAAAAAAAAAAAAAAAAAAA1", type: "bullet", spans: [{ text: "Revenue " }, { text: "up 12%", bold: true }] },
    { id: "blk_01JAAAAAAAAAAAAAAAAAAAAAA2", type: "bullet", spans: [{ text: "Costs flat" }], style: { paragraphSpacing: 8 } },
  ],
};

function deck(): { doc: PresentationDocument; textId: string; groupId: string; childIds: string[]; shapeId: string } {
  const doc = structuredClone(loadFixture("technical"));
  const text = doc.slides[0]!.elements.find((e) => e.type === "text") as TextElement;
  const textId = newId("el");
  const groupId = newId("el");
  const shapeId = newId("el");
  const childIds = [newId("el"), newId("el")];
  doc.slides[0]!.elements = [
    { ...text, id: textId, content: BULLETS, transform: { x: 100, y: 100, width: 600, height: 200 } } as PresentationElement,
    {
      id: groupId, type: "group", name: "Card", resizeMode: "scaleChildren",
      transform: { x: 800, y: 100, width: 400, height: 200 },
      children: [
        { id: childIds[0]!, type: "shape", shape: "rectangle", transform: { x: 0, y: 0, width: 200, height: 100 } },
        { ...text, id: childIds[1]!, content: { version: 1, blocks: [{ id: "blk_01JAAAAAAAAAAAAAAAAAAAAAA3", type: "paragraph", spans: [{ text: "Card" }] }] }, transform: { x: 20, y: 120, width: 200, height: 60 }, typography: { ...text.typography, fontSize: 20 } },
      ],
    } as unknown as PresentationElement,
    { id: shapeId, type: "shape", shape: "rectangle", transform: { x: 100, y: 500, width: 300, height: 160 } } as PresentationElement,
  ];
  return { doc, textId, groupId, childIds, shapeId };
}

async function mountShell() {
  const { doc, ...ids } = deck();
  const view = render(
    <EditorShell initialDocument={doc} presentationId="prs_manual" initialVersionId="v0" />,
    { wrapper: withWorkspaceClient() },
  );
  const canvas = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>("[data-editor-canvas]");
    if (!found) throw new Error("canvas not mounted");
    return found;
  });
  return { view, canvas, ...ids };
}

function select(canvas: HTMLElement, id: string) {
  const target = canvas.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!;
  fireEvent.pointerDown(target, { button: 0, clientX: 1, clientY: 1 });
  fireEvent.pointerUp(canvas, { clientX: 1, clientY: 1 });
}

it("Enter on a selected text box opens it for editing in place (MA-05)", async () => {
  const { canvas, textId } = await mountShell();
  select(canvas, textId);
  canvas.focus();
  fireEvent.keyDown(canvas, { key: "Enter" });
  const editable = await screen.findByRole("textbox", { name: "Edit text" });
  // Opened as a list, so the bullets survive the edit.
  expect(editable.querySelectorAll("ul > li")).toHaveLength(2);
});

it("Enter on a shape opens its label; on a group it steps inside (MA-05, MA-20)", async () => {
  const { canvas, shapeId, groupId, view } = await mountShell();
  select(canvas, shapeId);
  canvas.focus();
  fireEvent.keyDown(canvas, { key: "Enter" });
  const editable = await screen.findByRole("textbox", { name: "Edit text" });
  editable.textContent = "Label";
  fireEvent.blur(editable);
  await waitFor(() => expect(view.container.querySelector(`[data-element-id="${shapeId}"]`)!.textContent).toContain("Label"));

  select(canvas, groupId);
  canvas.focus();
  fireEvent.keyDown(canvas, { key: "Enter" });
  // Inside the group, its first child — a shape — is what is selected now:
  // the inspector shows its fill and outline, and no longer offers to ungroup.
  await waitFor(() => expect(screen.queryByTestId("ungroup")).toBeNull());
  expect(screen.getByText("Fill & outline")).toBeTruthy();
});

it("Ctrl+Shift+G and the visible button ungroup, and one undo regroups (MA-06)", async () => {
  const { canvas, groupId, childIds, view } = await mountShell();
  select(canvas, groupId);
  canvas.focus();
  fireEvent.keyDown(canvas, { key: "G", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(view.container.querySelector(`[data-element-id="${groupId}"]`)).toBeNull());
  for (const id of childIds) expect(view.container.querySelector(`[data-element-id="${id}"]`)).not.toBeNull();

  fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
  await waitFor(() => expect(view.container.querySelector(`[data-element-id="${groupId}"]`)).not.toBeNull());

  select(canvas, groupId);
  fireEvent.click(await screen.findByTestId("ungroup"));
  await waitFor(() => expect(view.container.querySelector(`[data-element-id="${groupId}"]`)).toBeNull());
});

it("Enter on a locked text box says why instead of doing nothing", async () => {
  const { canvas, textId } = await mountShell();
  select(canvas, textId);
  fireEvent.keyDown(canvas, { key: "l", ctrlKey: true, shiftKey: true });
  canvas.focus();
  fireEvent.keyDown(canvas, { key: "Enter" });
  expect(await screen.findByText(/locked\. Unlock it/)).toBeTruthy();
});

// --- the inspector, against a live editor ------------------------------------

function Harness({ doc, onEditor }: { doc: PresentationDocument; onEditor: (editor: EditorApi) => void }) {
  const editor = useEditor({ initialDocument: doc, presentationId: "prs_inspector", initialVersionId: "v0" });
  onEditor(editor);
  return <EditorCanvas editor={editor} width={1920} />;
}

it("a click that does not move commits nothing, so selecting never dirties the deck (MA-01)", async () => {
  const { doc, textId } = deck();
  let editor: EditorApi | undefined;
  const view = render(<Harness doc={doc} onEditor={(e) => (editor = e)} />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(editor!.recoveryReady).toBe(true));
  const canvas = view.container.querySelector<HTMLElement>("[data-editor-canvas]")!;
  const target = canvas.querySelector<HTMLElement>(`[data-element-id="${textId}"]`)!;
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  fireEvent.pointerDown(target, { button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(canvas, { clientX: 202, clientY: 201 });
  fireEvent.pointerUp(canvas, { clientX: 202, clientY: 201 });
  expect(editor!.selection.selectedIds).toEqual([textId]);
  expect(editor!.historyEntries).toHaveLength(0);
});

it("typing one word in the inspector keeps the bullets, the bold and the block ids (MA-08)", async () => {
  const { canvas, textId } = await mountShell();
  select(canvas, textId);
  const content = (await screen.findByLabelText("Content")) as HTMLTextAreaElement;
  expect(content.value).toBe("Revenue up 12%\nCosts flat");
  fireEvent.change(content, { target: { value: "Revenue up 14%\nCosts flat" } });
  await waitFor(() => expect(content.value).toBe("Revenue up 14%\nCosts flat"));
  // Reopen from the canvas: still a list, still bold.
  canvas.focus();
  fireEvent.keyDown(canvas, { key: "Enter" });
  const editable = await screen.findByRole("textbox", { name: "Edit text" });
  expect(editable.querySelectorAll("li")).toHaveLength(2);
  expect(editable.querySelector("strong")?.textContent).toBe("up 14%");
});

it("W and H typed for a group scale its contents exactly as a drag would (MA-07)", async () => {
  const { canvas, groupId, childIds, view } = await mountShell();
  select(canvas, groupId);
  const width = (await screen.findByLabelText("Width")) as HTMLInputElement;
  fireEvent.change(width, { target: { value: "800" } });
  fireEvent.keyDown(width, { key: "Enter" });
  // The child box doubled with its group, as the canvas handle would make it.
  await waitFor(() => {
    const child = view.container.querySelector<HTMLElement>(`[data-element-id="${childIds[0]}"]`)!;
    expect(child.style.width).toBe("400px");
  });
});

// --- the system clipboard and file drop (MA-23) --------------------------------

function clipboard(store: Map<string, string> = new Map(), files: File[] = []) {
  return {
    store,
    data: {
      setData: (format: string, value: string) => store.set(format, value),
      getData: (format: string) => store.get(format) ?? "",
      files,
      items: [],
      types: [...store.keys(), ...(files.length ? ["Files"] : [])],
    },
  };
}

it("copy writes the system clipboard, and paste reads it back as new objects", async () => {
  const { canvas, shapeId, view } = await mountShell();
  select(canvas, shapeId);
  canvas.focus();
  const { store, data } = clipboard();
  fireEvent.copy(canvas, { clipboardData: data });
  expect(store.has("application/vnd.deckastra.elements+json")).toBe(true);

  const before = view.container.querySelectorAll("[data-editor-canvas] [data-element-id]").length;
  fireEvent.paste(canvas, { clipboardData: clipboard(store).data });
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-editor-canvas] [data-element-id]").length).toBe(before + 1),
  );
});

it("a picture copied from one deck pastes into another with its asset entry", async () => {
  const source = structuredClone(loadFixture("technical"));
  const image = source.slides.flatMap((slide) => slide.elements).find((e) => e.type === "image")!;
  const slideIndex = source.slides.findIndex((slide) => slide.elements.some((e) => e.id === image.id));
  const first = render(<EditorShell initialDocument={source} presentationId="prs_a" initialVersionId="v0" />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(first.container.querySelector("[data-editor-canvas]")).toBeTruthy());
  fireEvent.click(screen.getAllByTestId("slide-thumb")[slideIndex]!);
  const canvasA = first.container.querySelector<HTMLElement>("[data-editor-canvas]")!;
  await waitFor(() => expect(canvasA.querySelector(`[data-element-id="${image.id}"]`)).toBeTruthy());
  select(canvasA, image.id);
  canvasA.focus();
  const { store, data } = clipboard();
  fireEvent.copy(canvasA, { clipboardData: data });
  first.unmount();

  const target = structuredClone(loadFixture("technical"));
  target.assets = target.assets.filter((asset) => asset.id !== (image as { assetId: string }).assetId);
  target.slides.forEach((slide) => (slide.elements = slide.elements.filter((e) => e.type !== "image")));
  const second = render(<EditorShell initialDocument={target} presentationId="prs_b" initialVersionId="v0" />, { wrapper: withWorkspaceClient() });
  const canvasB = await waitFor(() => {
    const found = second.container.querySelector<HTMLElement>("[data-editor-canvas]");
    if (!found) throw new Error("not mounted");
    return found;
  });
  const before = canvasB.querySelectorAll("[data-element-id]").length;
  canvasB.focus();
  fireEvent.paste(canvasB, { clipboardData: clipboard(store).data });
  // The manifest entry travelling with it is asserted in the editor package's
  // clipboard tests, where the document is directly observable.
  await waitFor(() => expect(canvasB.querySelectorAll("[data-element-id]").length).toBe(before + 1));
  expect(JSON.parse(store.get("application/vnd.deckastra.elements+json")!).assets).toHaveLength(1);
});

it("pasted text from another program becomes a text box", async () => {
  const { canvas, view } = await mountShell();
  canvas.focus();
  const store = new Map([["text/plain", "Pasted from a mail"]]);
  fireEvent.paste(canvas, { clipboardData: clipboard(store).data });
  await waitFor(() => expect(view.container.querySelector("[data-editor-canvas]")!.textContent).toContain("Pasted from a mail"));
});

it("an unsupported file is refused by name, and nothing on the slide changes", async () => {
  const { canvas, view } = await mountShell();
  canvas.focus();
  const ids = () => [...view.container.querySelectorAll("[data-editor-canvas] [data-element-id]")].map((node) => node.getAttribute("data-element-id"));
  const before = ids();
  const pdf = new File(["%PDF"], "report.pdf", { type: "application/pdf" });
  fireEvent.paste(canvas, { clipboardData: clipboard(new Map(), [pdf]).data });
  expect(await screen.findByText(/report\.pdf cannot go on a slide/)).toBeTruthy();
  expect(ids()).toEqual(before);
});
