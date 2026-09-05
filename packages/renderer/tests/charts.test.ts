import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { ChartElement, PresentationDocument } from "@deckastra/presentation-schema";

import { buildDocumentScene, flattenScene } from "../src/scene";
import { buildChartPayload, type ChartPayload } from "../src/charts";
import { formatNumber, toLabel, toNumber } from "../src/format";
import { bandScale, linearScale, round } from "../src/scale";
import { resolveTheme } from "../src/theme";

const repository = loadFixture("repository");
const theme = resolveTheme(repository.theme);

function chartOf(element: Partial<ChartElement>): ChartPayload {
  const full = {
    id: "el_01JB8Z9K2QW4RN7F3XG5HTMD01",
    type: "chart",
    transform: { x: 0, y: 0, width: 1000, height: 500 },
    chartType: "column",
    data: { type: "inline", rows: [] },
    encoding: { category: "c", value: "v" },
    ...element,
  } as ChartElement;

  return buildChartPayload(full, full.transform.width, full.transform.height, { theme });
}

const ROWS = [
  { c: "A", v: 10 },
  { c: "B", v: 30 },
  { c: "C", v: 20 },
];

// ------------------------------------------------------------------ formatting

describe("number formatting", () => {
  it("is independent of the host's locale data", () => {
    // Intl output depends on the ICU compiled into the runtime, which would make
    // the same document format differently in Node, a browser and the export
    // container — and byte-identical rendering impossible.
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(0.4212, { style: "percent" })).toBe("42.1%");
    expect(formatNumber(0.4212, { style: "percent", decimals: 2 })).toBe("42.12%");
    expect(formatNumber(1500.5, { style: "currency", currency: "EUR" })).toBe("€1,500.50");
    expect(formatNumber(-42.5, { style: "currency", currency: "USD" })).toBe("-$42.50");
  });

  it("keeps compact labels short", () => {
    expect(formatNumber(24100, { style: "compact" })).toBe("24.1K");
    expect(formatNumber(240000, { style: "compact" })).toBe("240K");
    expect(formatNumber(1_000_000, { style: "compact" })).toBe("1M");
    expect(formatNumber(999, { style: "compact" })).toBe("999");
    expect(formatNumber(-2_500_000_000, { style: "compact" })).toBe("-2.5B");
  });

  it("never emits a negative zero", () => {
    // "-0" on an axis is noise, and it also compares unequal in a snapshot.
    expect(formatNumber(-0.0001, { decimals: 2 })).toBe("0.00");
    expect(formatNumber(-0)).toBe("0");
  });

  it("distinguishes an unusable value from a real zero", () => {
    expect(toNumber("")).toBeUndefined();
    expect(toNumber("n/a")).toBeUndefined();
    expect(toNumber(0)).toBe(0);
    expect(toNumber("1,234")).toBe(1234);
    expect(toNumber(Number.NaN)).toBeUndefined();
    expect(toLabel({ a: 1 })).toBe('{"a":1}');
  });
});

// ---------------------------------------------------------------------- scales

describe("scales", () => {
  it("picks ticks a reader can parse", () => {
    const scale = linearScale([0, 97], { rangeStart: 0, rangeEnd: 100, includeZero: true });
    expect(scale.ticks).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("gives a flat series an axis with extent", () => {
    // Every value equal would otherwise collapse the range to zero and put every
    // mark on one line.
    const scale = linearScale([5, 5, 5], { rangeStart: 0, rangeEnd: 100 });
    expect(scale.max).toBeGreaterThan(scale.min);
    expect(Number.isFinite(scale.project(5))).toBe(true);
  });

  it("honours an explicit min and max exactly", () => {
    const scale = linearScale([3, 4], { rangeStart: 0, rangeEnd: 10, min: 0, max: 8 });
    expect(scale.min).toBe(0);
    expect(scale.max).toBe(8);
  });

  it("leaves a gap between bands", () => {
    const bands = bandScale(4, 0, 400, 0.2);
    expect(bands.stepWidth).toBe(100);
    expect(bands.bandWidth).toBe(80);
    expect(bands.centre(0)).toBe(50);
    expect(bands.start(0)).toBe(10);
  });

  it("rounds geometry so two runs cannot differ in the fifteenth decimal", () => {
    expect(round(0.1 + 0.2)).toBe(0.3);
    expect(Object.is(round(-0), 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------- charts

describe("chart layout", () => {
  it("draws one bar per category", () => {
    const payload = chartOf({ chartType: "column", data: { type: "inline", rows: ROWS } });
    expect(payload.rects).toHaveLength(3);
    expect(payload.notice).toBeUndefined();
  });

  it("starts a bar axis at zero unless told otherwise", () => {
    // A truncated bar axis exaggerates every difference between the bars, which
    // is why doc 02 §17.4 defaults it on for bar and column.
    const payload = chartOf({
      chartType: "column",
      data: { type: "inline", rows: [{ c: "A", v: 1000 }, { c: "B", v: 1010 }] },
    });

    const heights = payload.rects.map((rect) => rect.height);
    // Both bars nearly full height means the axis includes zero.
    expect(Math.min(...heights) / Math.max(...heights)).toBeGreaterThan(0.9);
  });

  it("sorts and limits categories, folding the tail into Other", () => {
    const payload = chartOf({
      chartType: "bar",
      data: {
        type: "inline",
        rows: [
          { c: "A", v: 1 },
          { c: "B", v: 50 },
          { c: "C", v: 40 },
          { c: "D", v: 2 },
        ],
      },
      encoding: { category: "c", value: "v", sort: { by: "value", direction: "desc" }, limit: 2 },
    });

    const labels = payload.texts.filter((t) => t.id.includes(":ctick:")).map((t) => t.text);
    expect(labels).toEqual(["B", "C", "Other"]);
    // Dropping the tail silently would misrepresent the chart's own total.
    expect(payload.warnings.some((w) => w.includes("Other"))).toBe(true);
  });

  it("stacks a stacked chart rather than overlapping it", () => {
    const payload = chartOf({
      chartType: "stackedColumn",
      data: {
        type: "inline",
        rows: [
          { c: "A", s: "x", v: 10 },
          { c: "A", s: "y", v: 20 },
        ],
      },
      encoding: { category: "c", value: "v", series: "s" },
    });

    expect(payload.rects).toHaveLength(2);
    const [first, second] = payload.rects;
    expect(first!.x).toBe(second!.x);
    // The second segment sits on top of the first, not on the baseline.
    expect(second!.y + second!.height).toBeCloseTo(first!.y, 1);
  });

  it("draws a pie as arcs that close the circle", () => {
    const payload = chartOf({
      chartType: "pie",
      data: { type: "inline", rows: ROWS },
    });
    expect(payload.paths).toHaveLength(3);
    for (const path of payload.paths) expect(path.d).toMatch(/^M .* A .* Z$/);
  });

  it("refuses to invent a second series in a pie", () => {
    const payload = chartOf({
      chartType: "pie",
      data: {
        type: "inline",
        rows: [
          { c: "A", s: "x", v: 1 },
          { c: "A", s: "y", v: 2 },
        ],
      },
      encoding: { category: "c", value: "v", series: "s" },
    });
    expect(payload.warnings.some((w) => w.includes("one series"))).toBe(true);
  });

  it("says so instead of drawing an empty chart", () => {
    expect(chartOf({ data: { type: "inline", rows: [] } }).notice).toBeTruthy();
    expect(
      chartOf({ data: { type: "dataSource", sourceId: "src_01JB8Z9K2QW4RN7F3XG5HTMD02" } }).notice,
    ).toContain("server-side");
  });

  it("degrades an unknown chart type to a column chart and says so", () => {
    const payload = chartOf({
      chartType: "sunburst" as never,
      data: { type: "inline", rows: ROWS },
    });
    expect(payload.chartType).toBe("column");
    expect(payload.requestedType).toBe("sunburst");
    expect(payload.warnings[0]).toContain("sunburst");
  });

  it("is deterministic", () => {
    const a = chartOf({ chartType: "line", data: { type: "inline", rows: ROWS } });
    const b = chartOf({ chartType: "line", data: { type: "inline", rows: ROWS } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("draws the fixture chart with axis labels and gridlines", () => {
    const nodes = flattenScene(buildDocumentScene(repository).slides[1]!);
    const chart = nodes.find((node) => node.type === "chart")!;
    expect(chart.renderPayload.kind).toBe("chart");

    const payload = chart.renderPayload as ChartPayload;
    expect(payload.rects).toHaveLength(4);
    expect(payload.gridlines.length).toBeGreaterThan(0);
    // The document asked for compact numbers, so the axis must be compact.
    expect(payload.texts.some((text) => text.text.endsWith("K"))).toBe(true);
    expect(payload.texts.some((text) => text.text === "Python")).toBe(true);
  });

  it("reads a chart bound to a table on the same slide", () => {
    const doc = JSON.parse(JSON.stringify(repository)) as PresentationDocument;
    const slide = doc.slides[0]!;

    slide.elements.push({
      id: "el_01JB8Z9K2QW4RN7F3XG5HTMD03",
      type: "table",
      transform: { x: 0, y: 0, width: 400, height: 200 },
      columns: [{ id: "col_a", label: "Team" }, { id: "col_b", label: "Count" }],
      rows: [
        { id: "row_a", cells: [{ content: "Platform" }, { content: "12" }] },
        { id: "row_b", cells: [{ content: "Product" }, { content: "8" }] },
      ],
    } as never);

    slide.elements.push({
      id: "el_01JB8Z9K2QW4RN7F3XG5HTMD04",
      type: "chart",
      transform: { x: 0, y: 0, width: 800, height: 400 },
      chartType: "column",
      data: { type: "table", elementId: "el_01JB8Z9K2QW4RN7F3XG5HTMD03" },
      encoding: { category: "Team", value: "Count" },
    } as never);

    const nodes = flattenScene(buildDocumentScene(doc).slides[0]!);
    const payload = nodes.find((node) => node.id === "el_01JB8Z9K2QW4RN7F3XG5HTMD04")!
      .renderPayload as ChartPayload;

    expect(payload.rects).toHaveLength(2);
    expect(payload.notice).toBeUndefined();
  });

  it("says which table is missing rather than drawing nothing", () => {
    const payload = buildChartPayload(
      {
        id: "el_01JB8Z9K2QW4RN7F3XG5HTMD05",
        type: "chart",
        transform: { x: 0, y: 0, width: 400, height: 200 },
        chartType: "bar",
        data: { type: "table", elementId: "el_01JB8Z9K2QW4RN7F3XG5HTMD06" },
        encoding: { category: "a", value: "b" },
      } as ChartElement,
      400,
      200,
      { theme },
    );
    expect(payload.notice).toContain("not on this slide");
  });
});
