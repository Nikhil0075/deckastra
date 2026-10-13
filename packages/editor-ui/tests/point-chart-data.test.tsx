/**
 * Scatter, bubble and bubble map in the editor (image-led visual systems,
 * item 5, 2026-10-13): changing to them, and editing their numbers.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { validateDocument, type ChartElement, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";
import { addElement, makeStarterElement, resolveElementById } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";
import { buildDocumentScene, flattenScene, type ChartPayload } from "@deckastra/renderer";

import { chartGrid, chartGridOperations, chartTypeOperations, pasteRange, setValue } from "../src/lib/chart-data";
import { ChartSection } from "../src/components/inspector/ChartSection";

afterEach(cleanup);

function withChart(change?: (chart: ChartElement) => void): { doc: PresentationDocument; chart: ChartElement } {
  const base = structuredClone(loadFixture("technical"));
  const element = makeStarterElement({ kind: "chart", viewport: base.viewport }) as ChartElement;
  change?.(element);
  const doc = applyPatch(base, addElement(base, { slideId: base.slides[0]!.id, element })).document;
  return { doc, chart: resolveElementById(doc, element.id)!.element as ChartElement };
}

function apply(doc: PresentationDocument, operations: PatchOperation[]) {
  const result = applyPatch(doc, operations);
  expect(validateDocument(result.document).errors).toEqual([]);
  expect(applyPatch(result.document, result.inverse).document).toEqual(doc);
  return result.document;
}

const chartIn = (doc: PresentationDocument, id: string) => resolveElementById(doc, id)!.element as ChartElement;
const drawn = (doc: PresentationDocument, id: string) =>
  flattenScene(buildDocumentScene(doc).slides[0]!).find((node) => node.id === id)!.renderPayload as ChartPayload;

describe("changing to a point chart", () => {
  it("makes a bubble map with empty latitude and longitude columns to fill in", () => {
    const { doc, chart } = withChart();
    const after = apply(doc, chartTypeOperations(doc, chart, "bubbleMap"));
    const map = chartIn(after, chart.id);
    expect(map.chartType).toBe("bubbleMap");
    expect(map.encoding).toMatchObject({ latitude: "Latitude", longitude: "Longitude", size: "value", value: "value" });
    const grid = chartGrid(map);
    if (!grid.editable) throw new Error("editable");
    expect(grid.grid.roles).toEqual(["latitude", "longitude", "size"]);
    expect(grid.grid.rows[0]!.values).toEqual([null, null, expect.any(Number)]);
    // Nothing placeable yet, so the chart says what it needs rather than drawing.
    expect(drawn(after, chart.id).points).toEqual([]);
  });

  it("makes a bubble chart from two series and a new size column", () => {
    const { doc, chart } = withChart((element) => {
      element.data = { type: "inline", rows: [{ category: "A", sales: 10, margin: 4 }, { category: "B", sales: 30, margin: 9 }] };
      element.encoding = { category: "category", value: ["sales", "margin"] };
    });
    const after = apply(doc, chartTypeOperations(doc, chart, "bubble"));
    const bubble = chartIn(after, chart.id);
    expect(bubble.encoding).toMatchObject({ x: "sales", value: "margin", size: "Size" });
    expect((bubble.data as { rows: Record<string, unknown>[] }).rows[0]).toEqual({ category: "A", sales: 10, margin: 4, Size: null });
  });

  it("changes nothing else for a category chart", () => {
    const { doc, chart } = withChart();
    expect(chartTypeOperations(doc, chart, "line")).toHaveLength(1);
  });
});

describe("editing a point chart's numbers", () => {
  const places = (element: ChartElement) => {
    element.chartType = "bubbleMap";
    element.data = {
      type: "inline",
      rows: [
        { city: "London", lat: 51.5, lon: -0.13, revenue: 42, region: "Europe" },
        { city: "Tokyo", lat: 35.68, lon: 139.69, revenue: 47, region: "Asia" },
      ],
    };
    element.encoding = { category: "city", value: "revenue", latitude: "lat", longitude: "lon", series: "region" };
  };

  it("keeps the region column it does not show, and draws the new number", () => {
    const { doc, chart } = withChart(places);
    const grid = chartGrid(chart);
    if (!grid.editable) throw new Error("editable");
    expect(grid.grid.series).toEqual(["lat", "lon", "revenue"]);
    const after = apply(doc, chartGridOperations(doc, chart, setValue(grid.grid, 1, 2, 94)));
    const rows = (chartIn(after, chart.id).data as { rows: Record<string, unknown>[] }).rows;
    expect(rows[1]).toEqual({ city: "Tokyo", lat: 35.68, lon: 139.69, revenue: 94, region: "Asia" });
    expect(chartIn(after, chart.id).encoding.series).toBe("region");
    const payload = drawn(after, chart.id);
    expect(payload.points).toHaveLength(2);
    // Tokyo is now the larger bubble, so it is drawn first.
    expect(payload.points[0]!.id).toContain(":Asia:");
  });

  it("refuses a paste wider than its columns", () => {
    const { chart } = withChart(places);
    const grid = chartGrid(chart);
    if (!grid.editable) throw new Error("editable");
    const pasted = pasteRange(grid.grid, { row: 0, column: 1 }, "1\t2\t3\t4");
    expect(pasted).toEqual({ ok: false, message: "This chart has 3 number columns; the paste is wider than that." });
  });

  it("labels each column by its role, offers the map's extent, and no series buttons", () => {
    const { doc, chart } = withChart(places);
    const edits: { operations: PatchOperation[]; label: string }[] = [];
    render(<ChartSection document={doc} element={chart} edit={(operations, label) => edits.push({ operations, label })} disabled={false} />);
    for (const role of ["Latitude", "Longitude", "Size"]) expect(screen.getByText(role)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add series" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "The whole world" }));
    expect(edits.map((one) => one.label)).toEqual(["Change map extent"]);
    expect(chartIn(apply(doc, edits[0]!.operations), chart.id).chartStyle?.mapExtent).toBe("world");
  });
});
