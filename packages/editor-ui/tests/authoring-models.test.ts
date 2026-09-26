import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import {
  newId,
  validateDocument,
  type ChartElement,
  type DiagramElement,
  type PresentationDocument,
  type PresentationElement,
  type TableElement,
} from "@deckastra/presentation-schema";
import { addElement, makeStarterElement, resolveElementById } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";
import { buildDocumentScene, flattenScene } from "@deckastra/renderer";

import {
  addRow,
  addSeries,
  chartGrid,
  chartGridOperations,
  parseChartValue,
  pasteRange,
  removeSeries,
  renameSeries,
  setValue,
} from "../src/lib/chart-data";
import {
  addColumnOperations,
  addRowOperations,
  cellText,
  pasteRangeOperations,
  removeColumnOperations,
  setCellOperations,
  setHeaderOperations,
} from "../src/lib/table-data";
import {
  addEdgeOperations,
  addNodeOperations,
  removeNodeOperations,
  rerouteEdgeOperations,
  setNodeLabelOperations,
} from "../src/lib/diagram-data";
import { alignOperations, distributeOperations } from "../src/lib/align";
import { fitImageBox, insertImageOperations, replaceImageOperations } from "../src/lib/insert-image";

/**
 * The pure halves of the manual-authoring controls (MA-13, MA-16 to MA-19,
 * MA-21). Each case applies the operations through the real applier, checks
 * the result validates, and undoes it — because "one change is one patch with
 * one exact inverse" is the property the controls rely on.
 */

function withStarter(kind: "chart" | "table" | "diagram"): { doc: PresentationDocument; element: PresentationElement } {
  const base = structuredClone(loadFixture("technical"));
  const element = makeStarterElement({ kind, viewport: base.viewport });
  const doc = applyPatch(base, addElement(base, { slideId: base.slides[0]!.id, element })).document;
  return { doc, element: resolveElementById(doc, element.id)!.element };
}

function applyAndCheck(doc: PresentationDocument, operations: ReturnType<typeof chartGridOperations>) {
  const result = applyPatch(doc, operations);
  expect(validateDocument(result.document).errors).toEqual([]);
  expect(applyPatch(result.document, result.inverse).document).toEqual(doc);
  return result.document;
}

describe("chart data (MA-17)", () => {
  it("replaces values, adds and renames a series, and the chart draws what the grid says", () => {
    const { doc, element } = withStarter("chart");
    const chart = element as ChartElement;
    const grid = chartGrid(chart);
    if (!grid.editable) throw new Error("starter chart should be editable");
    expect(grid.grid.rows.map((row) => row.category)).toEqual(["Q1", "Q2", "Q3", "Q4"]);

    let next = setValue(grid.grid, 0, 0, 99);
    next = addSeries(next);
    const renamed = renameSeries(next, 1, "Target");
    if (typeof renamed === "string") throw new Error(renamed);
    next = setValue(renamed, 0, 1, 50);
    const after = applyAndCheck(doc, chartGridOperations(doc, chart, next));

    const updated = resolveElementById(after, chart.id)!.element as ChartElement;
    expect(updated.encoding.value).toEqual(["value", "Target"]);
    expect((updated.data as { rows: Record<string, unknown>[] }).rows[0]).toEqual({ category: "Q1", value: 99, Target: 50 });

    // What the renderer draws, not just what the document says.
    const scene = buildDocumentScene(after);
    const node = flattenScene(scene.slides[0]!).find((candidate) => candidate.id === chart.id)!;
    expect(JSON.stringify(node.renderPayload)).toContain("Target");
  });

  it("refuses a value that is not a number, with a reason, and treats empty as a gap", () => {
    expect(parseChartValue("12,400")).toEqual({ ok: true, value: 12400 });
    expect(parseChartValue("35%")).toEqual({ ok: true, value: 35 });
    expect(parseChartValue("")).toEqual({ ok: true, value: null });
    expect(parseChartValue("lots")).toEqual({ ok: false, message: '"lots" is not a number.' });
  });

  it("pastes a spreadsheet range, growing the grid, and refuses a range with text in a value cell", () => {
    const { element } = withStarter("chart");
    const result = chartGrid(element as ChartElement);
    if (!result.editable) throw new Error("editable");
    const pasted = pasteRange(result.grid, { row: 3, column: 0 }, "Q4\t70\t65\nQ5\t80\t72\n");
    expect(pasted.ok && pasted.grid.rows.map((row) => [row.category, ...row.values])).toEqual([
      ["Q1", 24, null],
      ["Q2", 38, null],
      ["Q3", 51, null],
      ["Q4", 70, 65],
      ["Q5", 80, 72],
    ]);
    expect(pasteRange(result.grid, { row: 0, column: 1 }, "1\tlots").ok).toBe(false);
  });

  it("a renamed series cannot collide, and the last series cannot be removed", () => {
    const { element } = withStarter("chart");
    const result = chartGrid(element as ChartElement);
    if (!result.editable) throw new Error("editable");
    const two = addSeries(result.grid);
    expect(renameSeries(two, 1, "value")).toMatch(/already a column/);
    expect(removeSeries(result.grid, 0)).toBe(result.grid);
    expect(addRow(result.grid).rows).toHaveLength(5);
  });

  it("shows a long-form chart pivoted and writes it back wide", () => {
    const { doc, element } = withStarter("chart");
    const chart = structuredClone(element) as ChartElement;
    chart.data = { type: "inline", rows: [
      { quarter: "Q1", team: "A", amount: 1 }, { quarter: "Q1", team: "B", amount: 2 },
      { quarter: "Q2", team: "A", amount: 3 }, { quarter: "Q2", team: "B", amount: 4 },
    ] };
    chart.encoding = { category: "quarter", value: "amount", series: "team" };
    const result = chartGrid(chart);
    if (!result.editable) throw new Error("editable");
    expect(result.grid.series).toEqual(["A", "B"]);
    expect(result.grid.rows).toEqual([{ category: "Q1", values: [1, 2] }, { category: "Q2", values: [3, 4] }]);
    const operations = chartGridOperations(doc, chart, result.grid);
    const encoding = operations.find((op) => op.path.endsWith("/encoding")) as { value: Record<string, unknown> };
    expect(encoding.value).toEqual({ category: "quarter", value: ["A", "B"] });
  });

  it("a chart that reads a table says to edit the table instead", () => {
    const { element } = withStarter("chart");
    const chart = { ...(element as ChartElement), data: { type: "table" as const, elementId: newId("el") } };
    expect(chartGrid(chart)).toMatchObject({ editable: false, source: "table" });
  });
});

describe("table data (MA-18)", () => {
  it("edits a cell and a heading, adds and removes a column, keeping every row in step", () => {
    const { doc, element } = withStarter("table");
    let table = element as TableElement;
    let current = applyAndCheck(doc, setCellOperations(doc, table, 0, 1, "4,200"));
    table = resolveElementById(current, table.id)!.element as TableElement;
    expect(cellText(table.rows[0]!.cells[1])).toBe("4,200");

    const beforeHeading = current;
    current = applyAndCheck(beforeHeading, setHeaderOperations(beforeHeading, table, 0, "Region"));
    table = resolveElementById(current, table.id)!.element as TableElement;
    expect(table.columns[0]!.label).toBe("Region");

    const beforeColumn = current;
    current = applyAndCheck(beforeColumn, addColumnOperations(beforeColumn, table, 0));
    table = resolveElementById(current, table.id)!.element as TableElement;
    expect(table.columns).toHaveLength(3);
    expect(table.rows.every((row) => row.cells.length === 3)).toBe(true);
    expect(cellText(table.rows[0]!.cells[2])).toBe("4,200");

    const beforeRemove = current;
    current = applyAndCheck(beforeRemove, removeColumnOperations(beforeRemove, table, 1));
    table = resolveElementById(current, table.id)!.element as TableElement;
    expect(table.columns.map((c) => c.label)).toEqual(["Region", "Value"]);
  });

  it("keeps explicit column widths summing to the same total", () => {
    const { doc, element } = withStarter("table");
    const withWidths = applyPatch(doc, [{ op: "add", path: `${resolveElementById(doc, element.id)!.path}/columnWidths`, value: [400, 240] }]).document;
    const table = resolveElementById(withWidths, element.id)!.element as TableElement;
    const after = applyAndCheck(withWidths, addColumnOperations(withWidths, table));
    const widths = (resolveElementById(after, element.id)!.element as TableElement).columnWidths!;
    expect(widths).toHaveLength(3);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(640, 0);
  });

  it("pastes a rectangular range, adding rows and columns past the edge", () => {
    const { doc, element } = withStarter("table");
    const table = element as TableElement;
    const after = applyAndCheck(doc, pasteRangeOperations(doc, table, { row: 1, column: 0 }, "North\t10\t12\nSouth\t8\t9\n"));
    const pasted = resolveElementById(after, table.id)!.element as TableElement;
    expect(pasted.columns).toHaveLength(3);
    expect(pasted.rows.map((row) => row.cells.map(cellText))).toEqual([
      ["Alpha", "42", ""],
      ["North", "10", "12"],
      ["South", "8", "9"],
    ]);
  });

  it("adds a row that inherits the column alignment", () => {
    const { doc, element } = withStarter("table");
    const after = applyAndCheck(doc, addRowOperations(doc, element as TableElement));
    const table = resolveElementById(after, element.id)!.element as TableElement;
    expect(table.rows).toHaveLength(3);
    expect(table.rows[2]!.cells[1]!.align).toBe("right");
  });
});

describe("diagram data (MA-19)", () => {
  it("relabels, adds a connected box, reroutes and removes, keeping every id", () => {
    const { doc, element } = withStarter("diagram");
    let diagram = element as DiagramElement;
    const [first, second] = diagram.nodes;
    const edgeId = diagram.edges[0]!.id;

    let current = applyAndCheck(doc, setNodeLabelOperations(doc, diagram, first!.id, "Request"));
    diagram = resolveElementById(current, diagram.id)!.element as DiagramElement;
    expect(diagram.nodes[0]).toMatchObject({ id: first!.id, label: "Request" });

    const added = addNodeOperations(current, diagram, { label: "Store", connectFrom: second!.id });
    current = applyAndCheck(current, added.operations);
    diagram = resolveElementById(current, diagram.id)!.element as DiagramElement;
    expect(diagram.edges.some((edge) => edge.from === second!.id && edge.to === added.nodeId)).toBe(true);

    const rerouted = rerouteEdgeOperations(current, diagram, edgeId, { to: added.nodeId });
    current = applyAndCheck(current, rerouted.operations);
    diagram = resolveElementById(current, diagram.id)!.element as DiagramElement;
    expect(diagram.edges.find((edge) => edge.id === edgeId)).toMatchObject({ from: first!.id, to: added.nodeId });

    current = applyAndCheck(current, removeNodeOperations(current, diagram, added.nodeId));
    diagram = resolveElementById(current, diagram.id)!.element as DiagramElement;
    expect(diagram.edges.every((edge) => edge.to !== added.nodeId && edge.from !== added.nodeId)).toBe(true);
  });

  it("refuses a self-connection and a duplicate by name", () => {
    const { doc, element } = withStarter("diagram");
    const diagram = element as DiagramElement;
    const [a, b] = diagram.nodes;
    expect(addEdgeOperations(doc, diagram, a!.id, a!.id).refusal).toMatch(/two different/);
    expect(addEdgeOperations(doc, diagram, a!.id, b!.id).refusal).toMatch(/already connected/);
  });
});

describe("align and distribute (MA-16)", () => {
  function deck(...boxes: { x: number; y: number; w: number; h: number; locked?: boolean }[]) {
    const doc = structuredClone(loadFixture("technical"));
    const elements = boxes.map((box) => ({
      id: newId("el"), type: "shape", shape: "rectangle",
      transform: { x: box.x, y: box.y, width: box.w, height: box.h },
      ...(box.locked ? { locked: true } : {}),
    })) as unknown as PresentationElement[];
    doc.slides[0]!.elements = elements;
    return { doc, selected: elements.map((e) => ({ id: e.id, bounds: { x: e.transform.x, y: e.transform.y, width: e.transform.width, height: e.transform.height } })) };
  }

  it("aligns to the selection's edge in one patch, and a locked object anchors without moving", () => {
    const { doc, selected } = deck({ x: 100, y: 10, w: 50, h: 50 }, { x: 40, y: 100, w: 50, h: 50, locked: true }, { x: 300, y: 200, w: 80, h: 20 });
    const result = alignOperations(doc, selected, "left", doc.viewport);
    expect(result.relativeTo).toBe("selection");
    expect(result.locked).toEqual([]);
    const after = applyAndCheck(doc, result.operations);
    expect(after.slides[0]!.elements.map((e) => e.transform.x)).toEqual([40, 40, 40]);
  });

  it("reports a locked object that would have had to move", () => {
    const { doc, selected } = deck({ x: 100, y: 10, w: 50, h: 50 }, { x: 40, y: 100, w: 50, h: 50, locked: true });
    const result = alignOperations(doc, selected, "right", doc.viewport);
    expect(result.locked).toEqual([selected[1]!.id]);
  });

  it("with one object, aligns to the slide", () => {
    const { doc, selected } = deck({ x: 100, y: 10, w: 50, h: 50 });
    const result = alignOperations(doc, selected, "centerX", doc.viewport);
    expect(result.relativeTo).toBe("slide");
    const after = applyAndCheck(doc, result.operations);
    expect(after.slides[0]!.elements[0]!.transform.x).toBe(doc.viewport.width / 2 - 25);
  });

  it("distributes equal gaps and keeps the outermost objects still", () => {
    const { doc, selected } = deck({ x: 0, y: 0, w: 100, h: 10 }, { x: 150, y: 0, w: 50, h: 10 }, { x: 500, y: 0, w: 100, h: 10 });
    const result = distributeOperations(doc, selected, "x");
    if ("refusal" in result) throw new Error(result.refusal);
    const after = applyAndCheck(doc, result.operations);
    const [a, b, c] = after.slides[0]!.elements.map((e) => e.transform);
    expect(a!.x).toBe(0);
    expect(c!.x).toBe(500);
    expect(b!.x - (a!.x + a!.width)).toBeCloseTo(c!.x - (b!.x + b!.width), 5);
    expect(distributeOperations(doc, selected.slice(0, 2), "x")).toHaveProperty("refusal");
  });
});

describe("pictures (MA-13, MA-21)", () => {
  const viewport = { width: 1920, height: 1080 };

  it.each([
    ["portrait", 100, 1000],
    ["panorama", 8000, 400],
    ["tiny", 8, 8],
    ["ordinary", 1600, 900],
    ["square", 3000, 3000],
  ])("fits a %s picture inside the slide at its own aspect ratio", (_name, width, height) => {
    const box = fitImageBox(viewport, width, height);
    expect(box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.height).toBeLessThanOrEqual(viewport.height);
    expect(box.width / box.height).toBeCloseTo(width / height, 1);
    expect(Math.max(box.width, box.height)).toBeGreaterThanOrEqual(Math.min(160, Math.max(width, height)));
  });

  it("a tall picture is inserted on the slide with its handles reachable", () => {
    const doc = structuredClone(loadFixture("technical"));
    const asset = { id: newId("ast"), kind: "image", storage_key: "k.png", width: 100, height: 1000 } as never;
    const { operations } = insertImageOperations(doc, { slideId: doc.slides[0]!.id, asset });
    const transform = (operations[1] as { value: { transform: { x: number; y: number; width: number; height: number } } }).value.transform;
    expect(transform.y).toBeGreaterThanOrEqual(0);
    expect(transform.y + transform.height).toBeLessThanOrEqual(doc.viewport.height);
  });

  it("replaces the picture in place, keeping the element, and one undo restores the original", () => {
    const doc = structuredClone(loadFixture("technical"));
    const image = doc.slides.flatMap((slide) => slide.elements).find((e) => e.type === "image")!;
    const asset = { id: newId("ast"), kind: "image", storage_key: "new.png", filename: "new.png", width: 400, height: 800 } as never;
    const keep = replaceImageOperations(doc, { elementId: image.id, asset, box: "keep" });
    const kept = applyAndCheck(doc, keep.operations);
    const after = resolveElementById(kept, image.id)!.element as { assetId: string; transform: unknown };
    expect(after.assetId).toBe((asset as { id: string }).id);
    expect(after.transform).toEqual(image.transform);

    const match = replaceImageOperations(doc, { elementId: image.id, asset, box: "match" });
    const matched = resolveElementById(applyAndCheck(doc, match.operations), image.id)!.element;
    expect(matched.transform.width).toBe(image.transform.width);
    expect(matched.transform.height).toBe(image.transform.width * 2);
  });
});

describe("what the clipboard and a drop can put on a slide (MA-23)", () => {
  const parse = (markup: string) => {
    const scratch = document.createElement("div");
    scratch.innerHTML = markup;
    return scratch;
  };
  const data = (formats: Record<string, string>, files: File[] = [], items: File[] = []) => ({
    getData: (format: string) => formats[format] ?? "",
    files,
    items: items.map((file) => ({ kind: "file", type: file.type, getAsFile: () => new File([file], file.name, { type: file.type }) })),
  });

  it("prefers Deckastra objects, then pictures, then text", async () => {
    const { classifyTransfer } = await import("../src/lib/external-clipboard");
    const png = new File(["x"], "shot.png", { type: "image/png" });
    const payload = JSON.stringify({ version: 1, sourceSlideId: "sld_x", elements: [{ type: "shape", transform: { x: 0, y: 0, width: 1, height: 1 } }] });
    expect(classifyTransfer(data({ "application/vnd.deckastra.elements+json": payload, "text/plain": "x" }, [png]), parse).kind).toBe("objects");
    expect(classifyTransfer(data({ "text/plain": "x" }, [png]), parse).kind).toBe("images");
    expect(classifyTransfer(data({ "text/html": "<b>Hi</b>", "text/plain": "Hi" }), parse)).toMatchObject({ kind: "text" });
    expect(classifyTransfer(data({}), parse).kind).toBe("empty");
  });

  it("counts a screenshot once when it arrives as both a file and an item", async () => {
    const { classifyTransfer } = await import("../src/lib/external-clipboard");
    const png = new File(["x"], "image.png", { type: "image/png" });
    const result = classifyTransfer(data({}, [png], [png]), parse);
    expect(result.kind === "images" && result.files).toHaveLength(1);
  });

  it("keeps pasted bold and drops a script", async () => {
    const { classifyTransfer } = await import("../src/lib/external-clipboard");
    const result = classifyTransfer(data({ "text/html": "<p><b>Bold</b><script>alert(1)</script></p>" }), parse);
    expect(result.kind === "text" && result.content.blocks[0]!.spans).toEqual([{ text: "Bold", bold: true }]);
  });
});
