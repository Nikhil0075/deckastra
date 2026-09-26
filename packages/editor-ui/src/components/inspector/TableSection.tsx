import type { PatchOperation, PresentationDocument, TableElement } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";

import {
  addColumnOperations,
  addRowOperations,
  cellText,
  pasteRangeOperations,
  removeColumnOperations,
  removeRowOperations,
  setCellOperations,
  setHeaderOperations,
} from "../../lib/table-data";
import { Button, IconButton, Section, Segmented } from "../../ui";
import { CellInput, Hint } from "./controls";

/**
 * A table's cells, rows and columns, edited by hand (manual-authoring review
 * MA-18). The header row is the columns' names. Each change — a cell, a row, a
 * column, a pasted range — is one patch and one undo step. A chart that reads
 * this table redraws from it, so editing the table is editing that chart too.
 */

type Edit = (operations: PatchOperation[], label: string, coalesceKey?: string) => void;

export function TableSection({
  document,
  element,
  edit,
  disabled,
}: {
  document: PresentationDocument;
  element: TableElement;
  edit: Edit;
  disabled: boolean;
}) {
  const paste = (row: number, column: number) => (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.replace(/\n$/, "").includes("\n")) return;
    event.preventDefault();
    edit(pasteRangeOperations(document, element, { row, column }, text), "Paste into table");
  };
  const headerRow = element.headerRow ?? true;

  return (
    <Section title="Table" defaultOpen meta={`${element.rows.length} × ${element.columns.length}`}>
      <div className="dk-datagrid" data-testid="table-grid">
        <table>
          <thead>
            <tr>
              {element.columns.map((column, index) => (
                <th scope="col" key={column.id}>
                  <span className="dk-datagrid__head">
                    <CellInput
                      header
                      label={`Column ${index + 1} heading`}
                      value={column.label ?? ""}
                      disabled={disabled}
                      onPaste={paste(-1, index)}
                      onCommit={(text) => edit(setHeaderOperations(document, element, index, text), "Edit table heading")}
                    />
                    {element.columns.length > 1 ? (
                      <IconButton
                        icon="close"
                        label={`Remove column ${column.label ?? index + 1}`}
                        size="sm"
                        disabled={disabled}
                        onClick={() => edit(removeColumnOperations(document, element, index), "Remove table column")}
                      />
                    ) : null}
                  </span>
                </th>
              ))}
              <th scope="col">
                <IconButton icon="plus" label="Add column" size="sm" disabled={disabled} onClick={() => edit(addColumnOperations(document, element), "Add table column")} />
              </th>
            </tr>
          </thead>
          <tbody>
            {element.rows.map((row, rowIndex) => (
              <tr key={row.id}>
                {element.columns.map((column, columnIndex) => {
                  const cell = row.cells[columnIndex];
                  return (
                    <td key={column.id}>
                      <CellInput
                        label={`Row ${rowIndex + 1}, ${column.label ?? `column ${columnIndex + 1}`}`}
                        value={cellText(cell)}
                        align={(cell?.align ?? column.align) === "right" ? "right" : "left"}
                        disabled={disabled}
                        onPaste={paste(rowIndex, columnIndex)}
                        onCommit={(text) => edit(setCellOperations(document, element, rowIndex, columnIndex, text), "Edit table cell")}
                      />
                    </td>
                  );
                })}
                <td>
                  {element.rows.length > 1 ? (
                    <IconButton icon="close" label={`Remove row ${rowIndex + 1}`} size="sm" disabled={disabled} onClick={() => edit(removeRowOperations(document, element, rowIndex), "Remove table row")} />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => edit(addRowOperations(document, element), "Add table row")} data-testid="table-add-row">
          Add row
        </Button>
      </div>
      <Hint>Paste a range copied from a spreadsheet into any cell; the table grows to fit it.</Hint>
      <span className="dk-label">Heading row</span>
      <Segmented
        label="Heading row"
        size="sm"
        value={headerRow ? "on" : "off"}
        onChange={(v) => edit(setPropertyDeep(document, element.id, "headerRow", v === "on"), "Toggle heading row")}
        items={[{ value: "on", label: "Show", disabled }, { value: "off", label: "Hide", disabled }]}
      />
    </Section>
  );
}
