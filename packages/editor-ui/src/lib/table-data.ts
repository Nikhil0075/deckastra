import {
  newId,
  type PatchOperation,
  type PresentationDocument,
  type RichTextDocument,
  type TableElement,
} from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";
import { applyPlainTextEdit, richTextToPlain } from "@deckastra/editor";

/**
 * Table content as operations (manual-authoring review MA-18).
 *
 * A starter table with only geometry controls cannot say anything about the
 * user's data. These are the edits a table needs — a cell, a row, a column, a
 * pasted range — each producing one patch so each is one undo step, and each
 * keeping the table's parallel arrays in step: a row's `cells`, the `columns`,
 * and the optional `columnWidths` / `rowHeights`. A column added to `columns`
 * but not to every row's cells is a table whose last column is blank in one
 * renderer and missing in another.
 *
 * The header is the columns' labels (the renderer draws `columns[].label` as
 * the header row), so "edit a header cell" is a column rename.
 */

type Cell = TableElement["rows"][number]["cells"][number];

/** A cell's words, whatever form they are stored in. */
export function cellText(cell: Cell | undefined): string {
  if (!cell) return "";
  return typeof cell.content === "string" ? cell.content : richTextToPlain(cell.content as RichTextDocument);
}

/**
 * Set one cell's words. A plain cell stays a plain string; a formatted cell is
 * edited through `applyPlainTextEdit`, so its bold total keeps its bold.
 */
export function setCellOperations(
  document: PresentationDocument,
  table: TableElement,
  row: number,
  column: number,
  text: string,
): PatchOperation[] {
  const target = table.rows[row];
  if (!target || column < 0 || column >= table.columns.length) return [];
  const cell = target.cells[column];
  if (cellText(cell) === text) return [];
  const content =
    cell && typeof cell.content !== "string" ? applyPlainTextEdit(cell.content as RichTextDocument, text) : text;
  const cells = padCells(target.cells, table.columns.length);
  cells[column] = { ...(cells[column] ?? {}), content };
  return setPropertyDeep(document, table.id, "rows", table.rows.map((r, i) => (i === row ? { ...r, cells } : r)));
}

export function setHeaderOperations(
  document: PresentationDocument,
  table: TableElement,
  column: number,
  label: string,
): PatchOperation[] {
  const current = table.columns[column];
  if (!current || (current.label ?? "") === label) return [];
  return setPropertyDeep(
    document,
    table.id,
    "columns",
    table.columns.map((c, i) => (i === column ? { ...c, label } : c)),
  );
}

/** Insert an empty row after `after` (or at the end). */
export function addRowOperations(document: PresentationDocument, table: TableElement, after?: number): PatchOperation[] {
  const at = after === undefined ? table.rows.length : after + 1;
  const template = table.rows[Math.min(at, table.rows.length) - 1];
  const row = {
    id: newId("el"),
    cells: table.columns.map((column, index) => ({
      content: "",
      // New cells align like the column above them, so a numeric column stays right-aligned.
      ...(template?.cells[index]?.align ? { align: template.cells[index]!.align } : column.align ? { align: column.align } : {}),
    })),
  };
  const rows = [...table.rows.slice(0, at), row, ...table.rows.slice(at)];
  const operations = setPropertyDeep(document, table.id, "rows", rows);
  if (table.rowHeights) {
    const heights = [...table.rowHeights];
    heights.splice(at, 0, heights[Math.max(0, at - 1)] ?? heights[0] ?? 48);
    operations.push(...setPropertyDeep(document, table.id, "rowHeights", heights));
  }
  return operations;
}

export function removeRowOperations(document: PresentationDocument, table: TableElement, row: number): PatchOperation[] {
  if (table.rows.length <= 1 || !table.rows[row]) return [];
  const operations = setPropertyDeep(document, table.id, "rows", table.rows.filter((_, i) => i !== row));
  if (table.rowHeights) {
    operations.push(...setPropertyDeep(document, table.id, "rowHeights", table.rowHeights.filter((_, i) => i !== row)));
  }
  return operations;
}

/** Insert an empty column after `after` (or at the end). */
export function addColumnOperations(document: PresentationDocument, table: TableElement, after?: number): PatchOperation[] {
  const at = after === undefined ? table.columns.length : after + 1;
  const label = uniqueLabel(`Column ${table.columns.length + 1}`, table.columns.map((c) => c.label ?? ""));
  const columns = [...table.columns.slice(0, at), { id: newId("el"), label }, ...table.columns.slice(at)];
  const rows = table.rows.map((row) => {
    const cells = padCells(row.cells, table.columns.length);
    cells.splice(at, 0, { content: "" });
    return { ...row, cells };
  });
  const operations = [
    ...setPropertyDeep(document, table.id, "columns", columns),
    ...setPropertyDeep(document, table.id, "rows", rows),
  ];
  if (table.columnWidths) operations.push(...setPropertyDeep(document, table.id, "columnWidths", rebalance(table.columnWidths, at, "add")));
  return operations;
}

export function removeColumnOperations(document: PresentationDocument, table: TableElement, column: number): PatchOperation[] {
  if (table.columns.length <= 1 || !table.columns[column]) return [];
  const operations = [
    ...setPropertyDeep(document, table.id, "columns", table.columns.filter((_, i) => i !== column)),
    ...setPropertyDeep(
      document,
      table.id,
      "rows",
      table.rows.map((row) => ({ ...row, cells: padCells(row.cells, table.columns.length).filter((_, i) => i !== column) })),
    ),
  ];
  if (table.columnWidths) {
    operations.push(...setPropertyDeep(document, table.id, "columnWidths", rebalance(table.columnWidths, column, "remove")));
  }
  return operations;
}

/**
 * Paste a rectangular range — tab-separated, which is what every spreadsheet
 * puts on the clipboard — with its top-left cell at `at`. Rows and columns are
 * added when the range runs past the table's edge, so a pasted 3×4 range is a
 * 3×4 range in the table and not a truncated one. `row: -1` is the header row.
 */
export function pasteRangeOperations(
  document: PresentationDocument,
  table: TableElement,
  at: { row: number; column: number },
  text: string,
): PatchOperation[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
  if (lines.length === 0) return [];
  const width = Math.max(...lines.map((line) => line.length));

  let columns = table.columns.map((column) => ({ ...column }));
  while (columns.length < at.column + width) {
    columns.push({ id: newId("el"), label: uniqueLabel(`Column ${columns.length + 1}`, columns.map((c) => c.label ?? "")) });
  }
  let rows = table.rows.map((row) => ({ ...row, cells: padCells(row.cells, columns.length) }));

  for (const [offset, cells] of lines.entries()) {
    const row = at.row + offset;
    if (row < 0) {
      cells.forEach((value, index) => {
        const column = columns[at.column + index]!;
        columns[at.column + index] = { ...column, label: value.trim() };
      });
      continue;
    }
    while (rows.length <= row) {
      rows.push({ id: newId("el"), cells: columns.map(() => ({ content: "" })) });
    }
    const target = rows[row]!;
    const nextCells = [...target.cells];
    cells.forEach((value, index) => {
      const column = at.column + index;
      const existing = nextCells[column];
      const content =
        existing && typeof existing.content !== "string"
          ? applyPlainTextEdit(existing.content as RichTextDocument, value)
          : value;
      nextCells[column] = { ...(existing ?? {}), content };
    });
    rows[row] = { ...target, cells: nextCells };
  }
  rows = rows.map((row) => ({ ...row, cells: padCells(row.cells, columns.length) }));
  columns = columns.map((column) => column);

  const operations = [
    ...setPropertyDeep(document, table.id, "columns", columns),
    ...setPropertyDeep(document, table.id, "rows", rows),
  ];
  if (table.columnWidths && table.columnWidths.length !== columns.length) {
    let widths = [...table.columnWidths];
    while (widths.length < columns.length) widths = rebalance(widths, widths.length, "add");
    operations.push(...setPropertyDeep(document, table.id, "columnWidths", widths));
  }
  if (table.rowHeights && table.rowHeights.length !== rows.length) {
    const heights = [...table.rowHeights];
    while (heights.length < rows.length) heights.push(heights.at(-1) ?? 48);
    operations.push(...setPropertyDeep(document, table.id, "rowHeights", heights));
  }
  return operations;
}

// ------------------------------------------------------------------- helpers

function padCells(cells: readonly Cell[], length: number): Cell[] {
  const out = cells.slice(0, length).map((cell) => ({ ...cell }));
  while (out.length < length) out.push({ content: "" });
  return out;
}

/**
 * Keep explicit column widths summing to the same total, so adding a column
 * does not widen the table off the slide and removing one does not leave a gap.
 */
function rebalance(widths: readonly number[], at: number, change: "add" | "remove"): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  const next = [...widths];
  if (change === "add") next.splice(at, 0, total / Math.max(1, widths.length));
  else next.splice(at, 1);
  const sum = next.reduce((acc, width) => acc + width, 0);
  if (sum <= 0) return next.map(() => 1);
  return next.map((width) => Math.max(1, Math.round((width / sum) * total * 100) / 100));
}

function uniqueLabel(wanted: string, taken: readonly string[]): string {
  if (!taken.includes(wanted)) return wanted;
  for (let n = 2; ; n += 1) if (!taken.includes(`${wanted} (${n})`)) return `${wanted} (${n})`;
}
