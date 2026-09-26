import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { validateDocument, type PresentationDocument } from "@deckastra/presentation-schema";
import { makeStarterElement, resolveElementById } from "@deckastra/presentation-core";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { ColorStudioPanel } from "../src/components/ColorStudioPanel";
import { Inspector } from "../src/components/inspector/Inspector";
import { ColorStudioProvider } from "../src/lib/color-studio";
import { namedColors } from "../src/lib/colors";
import { useEditor, type EditorApi } from "../src/lib/useEditor";

/**
 * The Colours panel and the colour controls it feeds (colour wizard,
 * 2026-09-26), driven through the real editor so every assertion is about the
 * document the person would save.
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
let opened: (string | undefined)[] = [];

function Harness({ doc, id, panel }: { doc: PresentationDocument; id?: string; panel?: boolean }) {
  editor = useEditor({ initialDocument: doc, presentationId: "prs_colors", initialVersionId: "v0" });
  const selected = id ? resolveElementById(editor.document, id)?.element : undefined;
  return (
    <ColorStudioProvider
      value={{
        document: editor.document,
        apply: (operations, label) => editor.apply(operations, { label }),
        open: (focus) => opened.push(focus),
      }}
    >
      {panel ? <ColorStudioPanel editor={editor} open onClose={() => {}} /> : null}
      {id ? (
        <Inspector
          editor={editor}
          presentationId="prs_colors"
          selected={selected}
          onReorder={() => {}}
          onToggle={() => {}}
          onGroup={() => {}}
          onUngroup={() => {}}
          onDelete={() => {}}
          onOpenHistory={() => {}}
        />
      ) : null}
    </ColorStudioProvider>
  );
}

async function mount(options: { kind?: "text" | "shape" | "chart" | "table" | "diagram"; panel?: boolean } = {}) {
  opened = [];
  const doc = structuredClone(loadFixture("technical"));
  let id: string | undefined;
  if (options.kind) {
    const element = makeStarterElement({ kind: options.kind, viewport: doc.viewport });
    doc.slides[0]!.elements.push(element);
    id = element.id;
  }
  render(<Harness doc={doc} id={id} panel={options.panel} />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  const element = () => (id ? (resolveElementById(editor.document, id)!.element as Record<string, any>) : undefined);
  return { element, original: structuredClone(doc) };
}

it("creates a named colour, uses it from any picker, and changes every use when it changes", async () => {
  const { element, original } = await mount({ kind: "shape", panel: true });
  const panel = screen.getByTestId("color-studio");
  fireEvent.click(within(panel).getByRole("tab", { name: /^Named/ }));
  fireEvent.change(within(panel).getByTestId("named-color-name"), { target: { value: "Brand red" } });
  fireEvent.change(within(panel).getByLabelText("New colour hex value"), { target: { value: "#D2001E" } });
  fireEvent.click(within(panel).getByTestId("named-color-add"));
  expect(namedColors(editor.document)).toEqual([{ name: "Brand red", value: "#D2001E", token: "token:colors.custom.Brand red" }]);

  // The shape's fill picker now offers it.
  fireEvent.click(screen.getByRole("button", { name: /^Fill colour: / }));
  fireEvent.click(screen.getByRole("option", { name: "Brand red" }));
  expect(element()!.style.fill).toEqual({ type: "solid", color: "token:colors.custom.Brand red" });

  // Changing the colour in the panel changes the colour, not the reference.
  const hex = within(panel).getByLabelText("Brand red hex value");
  fireEvent.change(hex, { target: { value: "#00A36C" } });
  fireEvent.keyDown(hex, { key: "Enter" });
  expect(namedColors(editor.document)[0]!.value).toBe("#00A36C");
  expect(element()!.style.fill.color).toBe("token:colors.custom.Brand red");

  // Renaming rewrites the shape's reference in the same step.
  const name = within(panel).getByLabelText("Name of Brand red");
  fireEvent.change(name, { target: { value: "Go green" } });
  fireEvent.keyDown(name, { key: "Enter" });
  expect(element()!.style.fill.color).toBe("token:colors.custom.Go green");
  expect(validateDocument(editor.document).errors).toEqual([]);

  // Deleting keeps the shape the colour it was.
  fireEvent.click(within(panel).getByRole("button", { name: "Delete Go green" }));
  fireEvent.click(within(panel).getByTestId("named-color-delete"));
  expect(element()!.style.fill.color).toBe("#00A36C");
  expect(namedColors(editor.document)).toEqual([]);

  // Each of those was one step, so undoing them returns the deck exactly.
  for (let i = 0; i < 6; i += 1) act(() => editor.undo());
  expect(editor.document).toEqual(original);
});

it("saves a custom colour as a named colour from the picker, converting its other uses", async () => {
  const { element } = await mount({ kind: "shape" });
  fireEvent.click(screen.getByRole("button", { name: /^Fill colour: / }));
  fireEvent.click(screen.getByRole("option", { name: "Custom colour…" }));
  const hex = screen.getByLabelText("Fill colour hex value");
  fireEvent.change(hex, { target: { value: "#123456" } });
  fireEvent.keyDown(hex, { key: "Enter" });
  expect(element()!.style.fill.color).toBe("#123456");

  fireEvent.click(screen.getByTestId("color-save-named"));
  const name = screen.getByLabelText("Colour name");
  fireEvent.change(name, { target: { value: "Ink" } });
  fireEvent.click(screen.getByTestId("color-save-named-confirm"));
  expect(element()!.style.fill.color).toBe("token:colors.custom.Ink");
  expect(namedColors(editor.document)[0]).toMatchObject({ name: "Ink", value: "#123456" });

  // "Edit colours…" opens the panel at that colour; the picker is still open.
  fireEvent.click(screen.getByTestId("open-colors"));
  expect(opened).toEqual(["Ink"]);
});

it("edits a theme colour, and shows its contrast against what it is read on", async () => {
  await mount({ panel: true });
  const panel = screen.getByTestId("color-studio");
  // Pick "Text" from the list; it is then the colour being edited at the top.
  fireEvent.click(within(panel).getByRole("button", { name: "Edit Text" }));
  const text = within(panel).getByTestId("theme-color-foreground");
  fireEvent.change(text, { target: { value: "#777777" } });
  fireEvent.keyDown(text, { key: "Enter" });
  expect((editor.document.theme.colors as { foreground: string }).foreground).toBe("#777777");
  expect(within(panel).getByTitle(/Contrast/).textContent).toMatch(/:1/);
});

it("gives a chart its own colours, one per series, and hands them back to the theme", async () => {
  const { element } = await mount({ kind: "chart" });
  fireEvent.click(screen.getByRole("button", { name: /^Chart colours/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Own colours" }));
  const palette = element()!.chartStyle.palette as string[];
  expect(palette[0]).toBe("token:colors.chartSeries.0");
  const [first] = screen.getAllByTestId("chart-series-color");
  fireEvent.click(within(first!).getByRole("button"));
  fireEvent.click(screen.getByRole("option", { name: "Danger" }));
  expect(element()!.chartStyle.palette[0]).toBe("token:colors.danger");
  fireEvent.click(screen.getByRole("radio", { name: "Theme" }));
  expect(element()!.chartStyle?.palette).toBeUndefined();
  expect(validateDocument(editor.document).errors).toEqual([]);
});

it("colours a table's heading and a whole row, each as one undo step", async () => {
  const { element } = await mount({ kind: "table" });
  fireEvent.click(within(screen.getByTestId("table-heading-fill")).getByRole("button"));
  fireEvent.click(screen.getByRole("option", { name: "Accent" }));
  expect(element()!.tableStyle.headerFill).toEqual({ type: "solid", color: "token:colors.accent" });

  fireEvent.click(within(screen.getByTestId("table-highlight-fill")).getByRole("button"));
  fireEvent.click(screen.getByRole("option", { name: "Warning" }));
  const cells = element()!.rows[0].cells as { style?: { fill?: unknown } }[];
  expect(cells.every((cell) => JSON.stringify(cell.style?.fill) === JSON.stringify({ type: "solid", color: "token:colors.warning" }))).toBe(true);
  act(() => editor.undo());
  expect((element()!.rows[0].cells as { style?: unknown }[]).every((cell) => !cell.style)).toBe(true);
  expect(validateDocument(editor.document).errors).toEqual([]);
});

it("colours every box of a diagram at once, and one connection", async () => {
  const { element } = await mount({ kind: "diagram" });
  fireEvent.click(screen.getByRole("button", { name: /^Colour a box/ }));
  fireEvent.click(screen.getByRole("option", { name: "Every box" }));
  fireEvent.click(within(screen.getByTestId("diagram-node-fill")).getByRole("button"));
  fireEvent.click(screen.getByRole("option", { name: "Accent" }));
  const nodes = element()!.nodes as { style?: { fill?: unknown } }[];
  expect(nodes.length).toBeGreaterThan(1);
  expect(nodes.every((node) => JSON.stringify(node.style?.fill) === JSON.stringify({ type: "solid", color: "token:colors.accent" }))).toBe(true);

  fireEvent.click(within(screen.getByTestId("diagram-edge-color")).getByRole("button"));
  fireEvent.click(screen.getByRole("option", { name: "Danger" }));
  expect(element()!.edges[0].style.stroke.paint).toEqual({ type: "solid", color: "token:colors.danger" });
  expect(validateDocument(editor.document).errors).toEqual([]);
});
