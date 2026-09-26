import type { ChartElement, PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";

/**
 * A chart's data as a grid a person can edit (manual-authoring review MA-17).
 *
 * Changing `chartType` is not chart authoring: someone who inserts a chart has
 * to be able to put their own numbers in it, name the series and the axes,
 * without an agent or the JSON view. The document keeps data and intent only
 * (doc 02 §17) — rows plus an encoding naming which fields are the category and
 * which are values — and this is a view of exactly that, written back as one
 * patch so each edit is one undo step.
 *
 * The grid is always *wide*: one category column, one column per series. A
 * chart authored long-form (one row per category × series, with
 * `encoding.series`) is shown pivoted, and the first edit writes it back wide —
 * the same chart, in the one shape a grid can edit without guessing.
 */

export interface ChartGrid {
  /** The row field holding each category's label. */
  categoryField: string;
  /** One per series, in order; each is a row field holding numbers. */
  series: string[];
  rows: { category: string; values: (number | null)[] }[];
}

export type ChartGridResult =
  | { editable: true; grid: ChartGrid }
  | { editable: false; reason: string; source: "table" | "dataSource" };

export function chartGrid(element: ChartElement): ChartGridResult {
  const data = element.data;
  if (data.type === "table") {
    return {
      editable: false,
      source: "table",
      reason: "This chart draws its numbers from a table on this slide. Edit the table and the chart follows.",
    };
  }
  if (data.type !== "inline") {
    return {
      editable: false,
      source: "dataSource",
      reason: "This chart reads a connected data source, so its numbers are changed at that source rather than here.",
    };
  }

  const encoding = element.encoding;
  const categoryField = encoding.category;
  const rows = data.rows;

  if (encoding.series && typeof encoding.value === "string") {
    // Long form: pivot to one column per series, first appearance order.
    const valueField = encoding.value;
    const seriesField = encoding.series;
    const series: string[] = [];
    const categories: string[] = [];
    const cells = new Map<string, Map<string, number | null>>();
    for (const row of rows) {
      const category = label(row[categoryField]);
      const name = label(row[seriesField]);
      if (!series.includes(name)) series.push(name);
      if (!categories.includes(category)) categories.push(category);
      if (!cells.has(category)) cells.set(category, new Map());
      cells.get(category)!.set(name, toNumber(row[valueField]));
    }
    return {
      editable: true,
      grid: {
        categoryField,
        series,
        rows: categories.map((category) => ({
          category,
          values: series.map((name) => cells.get(category)?.get(name) ?? null),
        })),
      },
    };
  }

  const series = Array.isArray(encoding.value) ? [...encoding.value] : [encoding.value];
  return {
    editable: true,
    grid: {
      categoryField,
      series,
      rows: rows.map((row) => ({
        category: label(row[categoryField]),
        values: series.map((field) => toNumber(row[field])),
      })),
    },
  };
}

/**
 * The patch that makes the chart hold `grid`: its rows and its encoding
 * together, so the chart can never be left naming a series its rows lack.
 */
export function chartGridOperations(
  document: PresentationDocument,
  element: ChartElement,
  grid: ChartGrid,
): PatchOperation[] {
  const rows = grid.rows.map((row) => {
    const record: Record<string, unknown> = { [grid.categoryField]: row.category };
    grid.series.forEach((field, index) => {
      const value = row.values[index];
      // A gap stays a gap: null draws no bar, where 0 would draw a claim.
      record[field] = value === undefined ? null : value;
    });
    return record;
  });
  const encoding: Record<string, unknown> = {
    ...element.encoding,
    category: grid.categoryField,
    value: grid.series.length === 1 ? grid.series[0]! : [...grid.series],
  };
  delete encoding.series;
  return [
    ...setPropertyDeep(document, element.id, "data", { type: "inline", rows }),
    ...setPropertyDeep(document, element.id, "encoding", encoding),
  ];
}

// --------------------------------------------------------------- grid edits

export function setCategory(grid: ChartGrid, row: number, category: string): ChartGrid {
  return { ...grid, rows: grid.rows.map((r, i) => (i === row ? { ...r, category } : r)) };
}

export function setValue(grid: ChartGrid, row: number, series: number, value: number | null): ChartGrid {
  return {
    ...grid,
    rows: grid.rows.map((r, i) => (i === row ? { ...r, values: r.values.map((v, j) => (j === series ? value : v)) } : r)),
  };
}

export function addRow(grid: ChartGrid): ChartGrid {
  const category = uniqueName(`Item ${grid.rows.length + 1}`, grid.rows.map((row) => row.category));
  return { ...grid, rows: [...grid.rows, { category, values: grid.series.map(() => null) }] };
}

export function removeRow(grid: ChartGrid, row: number): ChartGrid {
  return { ...grid, rows: grid.rows.filter((_, i) => i !== row) };
}

export function addSeries(grid: ChartGrid): ChartGrid {
  const name = uniqueName(`Series ${grid.series.length + 1}`, [...grid.series, grid.categoryField]);
  return { ...grid, series: [...grid.series, name], rows: grid.rows.map((row) => ({ ...row, values: [...row.values, null] })) };
}

export function removeSeries(grid: ChartGrid, series: number): ChartGrid {
  if (grid.series.length <= 1) return grid;
  return {
    ...grid,
    series: grid.series.filter((_, i) => i !== series),
    rows: grid.rows.map((row) => ({ ...row, values: row.values.filter((_, i) => i !== series) })),
  };
}

/**
 * Rename a series. The name is the field the rows are keyed by, which is also
 * what the legend shows, so a rename is both at once. A name that collides with
 * another column is refused rather than merged.
 */
export function renameSeries(grid: ChartGrid, series: number, name: string): ChartGrid | string {
  const trimmed = name.trim();
  if (trimmed === "") return "A series needs a name.";
  if (trimmed === grid.categoryField || grid.series.some((other, i) => i !== series && other === trimmed)) {
    return `"${trimmed}" is already a column in this chart.`;
  }
  return { ...grid, series: grid.series.map((current, i) => (i === series ? trimmed : current)) };
}

/**
 * Read what someone typed into a value cell. Empty is a gap. Thousands
 * separators and a trailing percent sign are accepted because that is how
 * people copy numbers; anything else is refused with a reason rather than
 * silently plotted as zero.
 */
export function parseChartValue(text: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  const cleaned = trimmed.replace(/,/g, "").replace(/%$/, "");
  const value = Number(cleaned);
  if (cleaned === "" || !Number.isFinite(value)) return { ok: false, message: `"${trimmed}" is not a number.` };
  return { ok: true, value };
}

/**
 * Paste a rectangular range (tab-separated, as every spreadsheet copies) at a
 * cell. The first column of the range lands on the column pasted into; rows
 * and series are added as needed. Cells that are not numbers are refused as a
 * whole paste, naming the first one, so a half-applied paste never happens.
 */
export function pasteRange(
  grid: ChartGrid,
  at: { row: number; column: number },
  text: string,
): { ok: true; grid: ChartGrid } | { ok: false; message: string } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
  let next = grid;
  for (const [offsetRow, cells] of lines.entries()) {
    const row = at.row + offsetRow;
    while (next.rows.length <= row) next = addRow(next);
    for (const [offsetColumn, cell] of cells.entries()) {
      const column = at.column + offsetColumn;
      if (column === 0) {
        next = setCategory(next, row, cell.trim());
        continue;
      }
      while (next.series.length < column) next = addSeries(next);
      const parsed = parseChartValue(cell);
      if (!parsed.ok) return { ok: false, message: `Row ${row + 1}: ${parsed.message}` };
      next = setValue(next, row, column - 1, parsed.value);
    }
  }
  return { ok: true, grid: next };
}

// ------------------------------------------------------------------- helpers

function label(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function uniqueName(wanted: string, taken: readonly string[]): string {
  if (!taken.includes(wanted)) return wanted;
  for (let n = 2; ; n += 1) if (!taken.includes(`${wanted} (${n})`)) return `${wanted} (${n})`;
}
