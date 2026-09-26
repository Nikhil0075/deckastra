import { useState } from "react";
import type { ChartElement, PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";

import {
  addRow,
  addSeries,
  chartGrid,
  chartGridOperations,
  parseChartValue,
  pasteRange,
  removeRow,
  removeSeries,
  renameSeries,
  setCategory,
  setValue,
  type ChartGrid,
} from "../../lib/chart-data";
import { Button, IconButton, Section, Segmented, Select, TextField } from "../../ui";
import { CellInput, Hint } from "./controls";

/**
 * A chart's data and labels, edited by hand (manual-authoring review MA-17).
 *
 * The grid is the chart: categories down the side, one column per series.
 * Every change is one patch — a cell, a new row, a pasted range — so each undoes
 * in one step. A value that is not a number is refused in its cell with the
 * reason shown, never plotted as zero.
 */

type Edit = (operations: PatchOperation[], label: string, coalesceKey?: string) => void;

const CHARTS: { value: string; label: string }[] = [
  { value: "column", label: "Column" },
  { value: "bar", label: "Bar" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "pie", label: "Pie" },
  { value: "donut", label: "Donut" },
  { value: "scatter", label: "Scatter" },
  { value: "stackedColumn", label: "Stacked column" },
  { value: "stackedBar", label: "Stacked bar" },
  { value: "combo", label: "Combo" },
];

export function ChartSection({
  document,
  element,
  edit,
  disabled,
}: {
  document: PresentationDocument;
  element: ChartElement;
  edit: Edit;
  disabled: boolean;
}) {
  const [message, setMessage] = useState<string | undefined>();
  const result = chartGrid(element);
  const style = element.chartStyle ?? {};
  const set = (property: string, value: unknown, label: string) =>
    edit(setPropertyDeep(document, element.id, property, value), label, `inspector:${element.id}:${property}`);
  const commit = (grid: ChartGrid, label: string) => {
    setMessage(undefined);
    edit(chartGridOperations(document, element, grid), label);
  };

  const chartTypes = CHARTS.some((c) => c.value === element.chartType)
    ? CHARTS
    : [{ value: element.chartType, label: element.chartType }, ...CHARTS];

  return (
    <>
      <Section title="Chart" defaultOpen meta={CHARTS.find((c) => c.value === element.chartType)?.label ?? element.chartType}>
        <Select label="Type" value={element.chartType} options={chartTypes} disabled={disabled} onChange={(v) => set("chartType", v, "Change chart type")} />
        <TextField
          label="Horizontal axis title"
          value={style.axisX?.title ?? ""}
          disabled={disabled}
          onChange={(v) => set("chartStyle.axisX.title", v === "" ? undefined : v, "Edit axis title")}
        />
        <TextField
          label="Vertical axis title"
          value={style.axisY?.title ?? ""}
          disabled={disabled}
          onChange={(v) => set("chartStyle.axisY.title", v === "" ? undefined : v, "Edit axis title")}
        />
        <span className="dk-label">Legend</span>
        <Segmented
          label="Legend"
          size="sm"
          value={style.showLegend === false ? "off" : "on"}
          onChange={(v) => set("chartStyle.showLegend", v === "on", "Toggle legend")}
          items={[{ value: "on", label: "Show", disabled }, { value: "off", label: "Hide", disabled }]}
        />
        <span className="dk-label">Data labels</span>
        <Segmented
          label="Data labels"
          size="sm"
          value={style.showDataLabels ? "on" : "off"}
          onChange={(v) => set("chartStyle.showDataLabels", v === "on", "Toggle data labels")}
          items={[{ value: "on", label: "Show", disabled }, { value: "off", label: "Hide", disabled }]}
        />
      </Section>

      <Section title="Data" defaultOpen meta={result.editable ? `${result.grid.rows.length} × ${result.grid.series.length}` : "linked"}>
        {!result.editable ? (
          <Hint>{result.reason}</Hint>
        ) : (
          <ChartGridEditor grid={result.grid} disabled={disabled} onCommit={commit} onMessage={setMessage} />
        )}
        {message ? (
          <p className="dk-field__hint dk-field__hint--error" role="alert">
            {message}
          </p>
        ) : null}
      </Section>
    </>
  );
}

function ChartGridEditor({
  grid,
  disabled,
  onCommit,
  onMessage,
}: {
  grid: ChartGrid;
  disabled: boolean;
  onCommit: (grid: ChartGrid, label: string) => void;
  onMessage: (message: string | undefined) => void;
}) {
  const paste = (row: number, column: number) => (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text/plain");
    // A single value pastes into the cell like typing; a range fills the grid.
    if (!text.includes("\t") && !text.replace(/\n$/, "").includes("\n")) return;
    event.preventDefault();
    const pasted = pasteRange(grid, { row, column }, text);
    if (pasted.ok) onCommit(pasted.grid, "Paste chart data");
    else onMessage(pasted.message);
  };

  return (
    <div className="dk-datagrid" data-testid="chart-grid">
      <table>
        <thead>
          <tr>
            <th scope="col" className="dk-datagrid__corner">
              Category
            </th>
            {grid.series.map((name, index) => (
              <th scope="col" key={`${index}:${name}`}>
                <span className="dk-datagrid__head">
                  <CellInput
                    header
                    label={`Series ${index + 1} name`}
                    value={name}
                    disabled={disabled}
                    onCommit={(text) => {
                      const next = renameSeries(grid, index, text);
                      if (typeof next === "string") return next;
                      onCommit(next, "Rename series");
                    }}
                  />
                  {grid.series.length > 1 ? (
                    <IconButton icon="close" label={`Remove series ${name}`} size="sm" disabled={disabled} onClick={() => onCommit(removeSeries(grid, index), "Remove series")} />
                  ) : null}
                </span>
              </th>
            ))}
            <th scope="col">
              <IconButton icon="plus" label="Add series" size="sm" disabled={disabled} onClick={() => onCommit(addSeries(grid), "Add series")} />
            </th>
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th scope="row">
                <CellInput
                  label={`Category ${rowIndex + 1}`}
                  value={row.category}
                  disabled={disabled}
                  onPaste={paste(rowIndex, 0)}
                  onCommit={(text) => onCommit(setCategory(grid, rowIndex, text), "Edit category")}
                />
              </th>
              {row.values.map((value, seriesIndex) => (
                <td key={seriesIndex}>
                  <CellInput
                    label={`${row.category || `Row ${rowIndex + 1}`}, ${grid.series[seriesIndex]}`}
                    value={value === null ? "" : String(value)}
                    align="right"
                    disabled={disabled}
                    onPaste={paste(rowIndex, seriesIndex + 1)}
                    onCommit={(text) => {
                      const parsed = parseChartValue(text);
                      if (!parsed.ok) {
                        onMessage(parsed.message);
                        return parsed.message;
                      }
                      onMessage(undefined);
                      onCommit(setValue(grid, rowIndex, seriesIndex, parsed.value), "Edit chart value");
                    }}
                  />
                </td>
              ))}
              <td>
                {grid.rows.length > 1 ? (
                  <IconButton icon="close" label={`Remove row ${row.category}`} size="sm" disabled={disabled} onClick={() => onCommit(removeRow(grid, rowIndex), "Remove chart row")} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onCommit(addRow(grid), "Add chart row")} data-testid="chart-add-row">
        Add row
      </Button>
      <p className="dk-field__hint">Paste a range from a spreadsheet into any cell to fill the grid. Empty cells are gaps.</p>
    </div>
  );
}
