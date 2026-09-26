import { useState } from "react";
import type { ContainerLayout, PresentationElement } from "@deckastra/presentation-schema";
import { isGroup } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";

import {
  distributeWithGapOperations,
  fitOperations,
  removeLayoutOperations,
  repeatAsGridOperations,
  stackOperations,
  updateLayoutOperations,
  type StackKind,
} from "../../lib/layout-actions";
import type { EditorApi } from "../../lib/useEditor";
import { Button, NumberField, Section, Segmented, Select } from "../../ui";
import { Hint } from "./controls";

const KINDS: { value: StackKind; label: string }[] = [
  { value: "horizontal", label: "Row" },
  { value: "vertical", label: "Column" },
  { value: "grid", label: "Grid" },
];

/**
 * Layout (design review, 2026-09-27): make a row, a column or a grid that
 * keeps itself tidy, set its gap, padding and columns, repeat one card into a
 * grid, and fit a group to what it holds. Every button is one patch.
 */
export function LayoutSection({ editor, elements }: { editor: EditorApi; elements: readonly PresentationElement[] }) {
  const doc = editor.document;
  const [gap, setGap] = useState(24);
  const [columns, setColumns] = useState(3);
  const [rows, setRows] = useState(2);

  const run = (operations: ReturnType<typeof removeLayoutOperations>, label: string, select?: string) => {
    if (operations.length === 0) return;
    editor.apply(operations, { label });
    if (select) editor.setSelection((current) => ({ ...current, selectedIds: [select], primaryId: select }));
  };

  const unlocked = elements.filter((element) => element.locked !== true);
  const single = unlocked.length === 1 ? unlocked[0] : undefined;
  const container = single && isGroup(single) && single.containerLayout && single.containerLayout.type !== "free" ? single : undefined;

  if (container && isGroup(container)) {
    const layout = container.containerLayout as ContainerLayout;
    const pad = layout.padding?.top ?? 0;
    const set = (change: Partial<ContainerLayout>, label: string) => run(updateLayoutOperations(doc, container.id, change), label);
    return (
      <Section title="Layout" meta={KINDS.find((kind) => kind.value === layout.type)?.label ?? layout.type} defaultOpen>
        <Segmented
          label="Arrange as"
          size="sm"
          value={(KINDS.some((kind) => kind.value === layout.type) ? layout.type : "horizontal") as StackKind}
          items={KINDS}
          onChange={(type) => set({ type, ...(type === "grid" && !layout.columns ? { columns: Math.ceil(Math.sqrt(container.children.length)) } : {}) }, "Change layout")}
        />
        <div className="dk-grid2">
          <NumberField label="Gap" ariaLabel="Gap between objects" value={layout.gap ?? 0} min={0} max={400} onCommit={(value) => set({ gap: value }, "Change gap")} data-testid="layout-gap" />
          <NumberField
            label="Padding"
            ariaLabel="Padding inside"
            value={pad}
            min={0}
            max={400}
            onCommit={(value) => set({ padding: value ? { top: value, right: value, bottom: value, left: value } : undefined }, "Change padding")}
          />
          {layout.type === "grid" ? (
            <NumberField label="Columns" ariaLabel="Columns" integer value={layout.columns ?? 2} min={1} max={12} onCommit={(value) => set({ columns: value }, "Change columns")} />
          ) : null}
        </div>
        <Select
          label="Align"
          value={layout.align ?? "start"}
          options={[
            { value: "start", label: layout.type === "horizontal" ? "Top" : "Left" },
            { value: "center", label: "Centre" },
            { value: "end", label: layout.type === "horizontal" ? "Bottom" : "Right" },
            { value: "stretch", label: "Stretch" },
          ]}
          onChange={(align) => set({ align: align as ContainerLayout["align"] }, "Change alignment")}
        />
        <Select
          label="Sizes"
          value={layout.distribute ?? "none"}
          options={[
            { value: "none", label: "As they are" },
            { value: "equal", label: "All the same" },
          ]}
          onChange={(distribute) => set({ distribute: distribute as ContainerLayout["distribute"] }, "Change sizes")}
        />
        <div className="dk-styles__actions">
          <Button size="sm" onClick={() => run(fitOperations(doc, container.id), "Fit to contents")}>
            Fit to contents
          </Button>
          <Button size="sm" onClick={() => run(removeLayoutOperations(doc, container.id), "Remove layout")} data-testid="layout-remove">
            Remove layout
          </Button>
        </div>
        <Hint>Objects keep this spacing when one of them grows. Remove the layout to place them by hand again.</Hint>
      </Section>
    );
  }

  if (unlocked.length >= 2) {
    const ids = unlocked.map((element) => element.id);
    return (
      <Section title="Layout" defaultOpen>
        <div className="dk-styles__actions" role="group" aria-label="Arrange the selection as">
          {KINDS.map((kind) => (
            <Button
              key={kind.value}
              size="sm"
              data-testid={`layout-${kind.value}`}
              onClick={() => {
                const made = stackOperations(doc, ids, kind.value, { gap, columns: kind.value === "grid" ? columns : undefined });
                run(made.operations, kind.value === "grid" ? "Make a grid" : `Make a ${kind.label.toLowerCase()}`, made.groupId);
              }}
            >
              {kind.label}
            </Button>
          ))}
        </div>
        <div className="dk-grid2">
          <NumberField label="Gap" ariaLabel="Gap for a new layout" value={gap} min={0} max={400} onCommit={setGap} />
          <NumberField label="Columns" ariaLabel="Columns for a new grid" integer value={columns} min={1} max={12} onCommit={setColumns} />
        </div>
        <div className="dk-styles__actions">
          <Button size="sm" onClick={() => run(distributeWithGapOperations(doc, ids, "x", gap), `Space ${ids.length} objects across`)}>
            Space across
          </Button>
          <Button size="sm" onClick={() => run(distributeWithGapOperations(doc, ids, "y", gap), `Space ${ids.length} objects down`)}>
            Space down
          </Button>
        </div>
        <Hint>A row, column or grid keeps its spacing as its objects change. "Space" only moves them once.</Hint>
      </Section>
    );
  }

  if (single) {
    return (
      <Section title="Layout">
        {isGroup(single) ? (
          <>
            <div className="dk-styles__actions">
              {KINDS.map((kind) => (
                <Button
                  key={kind.value}
                  size="sm"
                  onClick={() => {
                    const layout: ContainerLayout = { type: kind.value, gap, align: "start", ...(kind.value === "grid" ? { columns } : {}) };
                    const first = setPropertyDeep(doc, single.id, "containerLayout", layout);
                    run([...first, ...fitOperations(applyPatch(doc, first).document, single.id)], `Lay out as a ${kind.label.toLowerCase()}`);
                  }}
                >
                  {kind.label}
                </Button>
              ))}
            </div>
            <Button size="sm" onClick={() => run(fitOperations(doc, single.id), "Fit to contents")}>
              Fit to contents
            </Button>
          </>
        ) : (
          <>
            <div className="dk-grid2">
              <NumberField label="Columns" ariaLabel="Columns to repeat into" integer value={columns} min={1} max={12} onCommit={setColumns} />
              <NumberField label="Rows" ariaLabel="Rows to repeat into" integer value={rows} min={1} max={12} onCommit={setRows} />
            </div>
            <Button
              size="sm"
              data-testid="layout-repeat"
              disabled={columns * rows < 2}
              onClick={() => {
                const made = repeatAsGridOperations(doc, single.id, columns, rows, gap);
                run(made.operations, `Repeat as ${columns} × ${rows} grid`, made.groupId);
              }}
            >
              Repeat as {columns} × {rows} grid
            </Button>
            <Hint>Copies this object into a grid that keeps its spacing.</Hint>
          </>
        )}
      </Section>
    );
  }
  return null;
}
