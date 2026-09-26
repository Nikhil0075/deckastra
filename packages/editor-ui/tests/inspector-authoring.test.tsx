import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type {
  ChartElement,
  DiagramElement,
  PresentationDocument,
  PresentationElement,
  TableElement,
  TextElement,
} from "@deckastra/presentation-schema";
import { makeStarterElement, resolveElementById } from "@deckastra/presentation-core";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { Inspector } from "../src/components/inspector/Inspector";
import { useEditor, type EditorApi } from "../src/lib/useEditor";

/**
 * The inspector's authoring controls (manual-authoring review MA-14, MA-15,
 * MA-17 to MA-19), each checked against the document it wrote and undone.
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
  editor = useEditor({ initialDocument: doc, presentationId: "prs_inspector", initialVersionId: "v0" });
  const selected = resolveElementById(editor.document, id)?.element;
  return (
    <Inspector
      editor={editor}
      presentationId="prs_inspector"
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

async function mountWith(kind: "text" | "shape" | "line" | "chart" | "table" | "diagram") {
  const doc = structuredClone(loadFixture("technical"));
  const element = makeStarterElement({ kind, viewport: doc.viewport });
  doc.slides[0]!.elements.push(element);
  const view = render(<Harness doc={doc} id={element.id} />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  const current = () => resolveElementById(editor.document, element.id)!.element;
  return { view, current, original: structuredClone(doc) };
}

/** Choose an option from one of the product's own Select controls. */
function choose(label: string | RegExp, option: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

it("styles a text box's own font, weight, colour and alignment, without touching the theme (MA-14)", async () => {
  const { current, original } = await mountWith("text");
  choose(/^Font/, "Georgia");
  choose(/^Weight/, "Bold");
  choose(/^Colour/, "Accent");
  fireEvent.click(screen.getByRole("radio", { name: "Centre" }));
  fireEvent.click(screen.getByRole("radio", { name: "Italic" }));

  const text = current() as TextElement;
  expect(text.typography).toMatchObject({ fontFamily: "Georgia", fontWeight: 700, color: "token:colors.accent", fontStyle: "italic" });
  expect(text.paragraph?.align).toBe("center");
  expect(editor.document.theme).toEqual(original.theme);

  for (let i = 0; i < 5; i += 1) act(() => editor.undo());
  expect(editor.document).toEqual(original);
});

it("applies a text style preset as the element's own values", async () => {
  const { current } = await mountWith("text");
  fireEvent.click(within(screen.getByTestId("text-style")).getByRole("button", { name: "Title" }));
  const typography = (current() as TextElement).typography;
  expect(typography.fontFamily).toBe("token:typography.h1.fontFamily");
  expect(typography.fontSize).toBe((editor.document.theme.typography as { h1: { fontSize: number } }).h1.fontSize);
});

it("recolours a shape's fill, adds and dashes an outline, and removes the fill (MA-15)", async () => {
  const { current, original } = await mountWith("shape");
  choose(/^Fill colour/, "Secondary");
  choose(/^Outline/, "Text");
  choose(/^Dash/, "Dashed");
  expect(current().style).toMatchObject({
    fill: { type: "solid", color: "token:colors.secondary" },
    stroke: { paint: { type: "solid", color: "token:colors.foreground" }, width: 2, dash: [8, 6] },
  });
  fireEvent.click(screen.getByRole("radio", { name: "None" }));
  expect(current().style?.fill).toEqual({ type: "none" });
  for (let i = 0; i < 4; i += 1) act(() => editor.undo());
  expect(editor.document).toEqual(original);
});

it("a custom fill colour commits once, when it is a whole valid hex", async () => {
  const { current } = await mountWith("shape");
  choose(/^Fill colour/, "Custom colour…");
  const hex = screen.getByLabelText("Fill colour hex value");
  fireEvent.change(hex, { target: { value: "#1e4" } });
  fireEvent.change(hex, { target: { value: "#zzzzzz" } });
  fireEvent.blur(hex);
  expect(await screen.findByText(/Use a hex colour/)).toBeTruthy();
  expect(current().style?.fill).toEqual({ type: "solid", color: "token:colors.accent" });
  fireEvent.change(hex, { target: { value: "#1E4BD2" } });
  fireEvent.keyDown(hex, { key: "Enter" });
  expect(current().style?.fill).toEqual({ type: "solid", color: "#1E4BD2" });
});

it("turns a fill into a gradient and edits its stops, each as one undo step", async () => {
  const { current, original } = await mountWith("shape");
  fireEvent.click(screen.getByRole("radio", { name: "Gradient" }));
  const fill = current().style?.fill as { type: string; angle: number; stops: { offset: number; color: string }[] };
  expect(fill.type).toBe("linearGradient");
  expect(fill.stops).toHaveLength(2);
  // The colour it had becomes the first stop, so the gradient starts from the object.
  expect(fill.stops[0]).toEqual({ offset: 0, color: "token:colors.accent" });

  fireEvent.click(screen.getByRole("button", { name: /Add stop/ }));
  expect((current().style?.fill as typeof fill).stops).toHaveLength(3);
  fireEvent.click(screen.getByRole("radio", { name: "Radial" }));
  expect(current().style?.fill?.type).toBe("radialGradient");

  for (let i = 0; i < 3; i += 1) act(() => editor.undo());
  expect(editor.document).toEqual(original);
});

it("gives a card a named shadow and a frosted-glass blur", async () => {
  const { current, original } = await mountWith("shape");
  // Closed until an object has an effect, like any section with nothing in it.
  fireEvent.click(screen.getByRole("button", { name: /^Effects/ }));
  choose(/^Shadow/, "Neumorphic");
  expect(current().style?.shadow).toHaveLength(2);
  const blur = screen.getByLabelText("Background blur");
  fireEvent.change(blur, { target: { value: "16" } });
  fireEvent.keyDown(blur, { key: "Enter" });
  expect(current().style?.backdropFilters).toEqual([{ type: "blur", radius: 16 }]);
  choose(/^Shadow(?! colour)/, "None");
  expect(current().style?.shadow).toBeUndefined();
  for (let i = 0; i < 3; i += 1) act(() => editor.undo());
  expect(editor.document).toEqual(original);
});

it("changes a line's colour, width and arrowheads", async () => {
  const { current } = await mountWith("line");
  choose(/^Start/, "Dot");
  choose(/^End/, "None");
  const width = screen.getByLabelText("Line width");
  fireEvent.change(width, { target: { value: "6" } });
  fireEvent.keyDown(width, { key: "Enter" });
  const line = current() as PresentationElement & { startMarker?: string; endMarker?: string };
  expect(line.startMarker).toBe("dot");
  expect(line.endMarker).toBeUndefined();
  expect(line.style?.stroke?.width).toBe(6);
});

it("edits chart values, refuses text visibly, and adds a series (MA-17)", async () => {
  const { current } = await mountWith("chart");
  const grid = screen.getByTestId("chart-grid");
  const q1 = within(grid).getByLabelText("Q1, value");
  fireEvent.change(q1, { target: { value: "lots" } });
  fireEvent.blur(q1);
  expect((await screen.findByRole("alert")).textContent).toBe('"lots" is not a number.');
  expect(((current() as ChartElement).data as unknown as { rows: { value: unknown }[] }).rows[0]!.value).toBe(24);

  fireEvent.change(q1, { target: { value: "99" } });
  fireEvent.blur(q1);
  expect(((current() as ChartElement).data as unknown as { rows: { value: unknown }[] }).rows[0]!.value).toBe(99);

  fireEvent.click(within(grid).getByRole("button", { name: "Add series" }));
  expect((current() as ChartElement).encoding.value).toEqual(["value", "Series 2"]);
  fireEvent.click(screen.getByTestId("chart-add-row"));
  expect(((current() as ChartElement).data as { rows: unknown[] }).rows).toHaveLength(5);

  const title = screen.getByLabelText("Vertical axis title");
  fireEvent.change(title, { target: { value: "Revenue ($m)" } });
  expect((current() as ChartElement).chartStyle?.axisY?.title).toBe("Revenue ($m)");
});

it("pastes a range copied from a spreadsheet into the chart", async () => {
  const { current } = await mountWith("chart");
  const cell = within(screen.getByTestId("chart-grid")).getByLabelText("Category 1");
  fireEvent.paste(cell, { clipboardData: { getData: () => "Jan\t5\nFeb\t6" } });
  const rows = ((current() as ChartElement).data as { rows: Record<string, unknown>[] }).rows;
  expect(rows.slice(0, 2)).toEqual([{ category: "Jan", value: 5 }, { category: "Feb", value: 6 }]);
});

it("edits a table cell and a heading, adds a row and a column (MA-18)", async () => {
  const { current } = await mountWith("table");
  const grid = screen.getByTestId("table-grid");
  const cell = within(grid).getByLabelText("Row 1, Value");
  fireEvent.change(cell, { target: { value: "100" } });
  fireEvent.keyDown(cell, { key: "Enter" });
  const heading = within(grid).getByLabelText("Column 1 heading");
  fireEvent.change(heading, { target: { value: "Region" } });
  fireEvent.blur(heading);
  fireEvent.click(within(grid).getByRole("button", { name: "Add column" }));
  fireEvent.click(screen.getByTestId("table-add-row"));

  const table = current() as TableElement;
  expect(table.rows[0]!.cells[1]!.content).toBe("100");
  expect(table.columns.map((c) => c.label)).toEqual(["Region", "Value", "Column 3"]);
  expect(table.rows).toHaveLength(3);
  expect(table.rows.every((row) => row.cells.length === 3)).toBe(true);
});

it("relabels a diagram box, adds one after it, and connects two boxes (MA-19)", async () => {
  const { current } = await mountWith("diagram");
  const nodes = screen.getByTestId("diagram-nodes");
  const first = within(nodes).getByLabelText("Box 1 label");
  fireEvent.change(first, { target: { value: "Request" } });
  fireEvent.blur(first);
  fireEvent.click(within(nodes).getByRole("button", { name: "Add a box after Next step" }));

  const diagram = current() as DiagramElement;
  expect(diagram.nodes.map((n) => n.label)).toEqual(["Request", "Next step", "New step"]);
  expect(diagram.edges).toHaveLength(2);
  expect(diagram.edges[1]).toMatchObject({ from: diagram.nodes[1]!.id, to: diagram.nodes[2]!.id });
});
