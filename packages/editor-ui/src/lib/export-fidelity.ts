/**
 * What each kind of object becomes in PowerPoint, said before anyone exports
 * (design review, 2026-09-27). The stress deck looked right in the editor and
 * arrived in PowerPoint with its icons as labelled boxes; the report said so,
 * after the fact. The same words now appear where the object is inserted and in
 * the Design Check.
 *
 * This mirrors `packages/export-pptx/src/shapes.ts` and its degradation ledger.
 * It is a description, not a second implementation: when the exporter changes
 * what it does with a kind, change the row here in the same commit.
 */

export type Fidelity = "native" | "approximated" | "picture" | "placeholder";

export interface FidelityRow {
  fidelity: Fidelity;
  /** Short, for a badge. */
  label: string;
  /** One sentence, for a tooltip or the Check panel. */
  detail: string;
}

const ROWS: Record<string, FidelityRow> = {
  text: { fidelity: "native", label: "Native", detail: "Becomes an editable PowerPoint text box." },
  shape: { fidelity: "native", label: "Native", detail: "Becomes an editable PowerPoint shape." },
  line: { fidelity: "native", label: "Native", detail: "Becomes an editable PowerPoint line." },
  image: { fidelity: "native", label: "Native", detail: "Becomes a PowerPoint picture." },
  table: { fidelity: "native", label: "Native", detail: "Becomes an editable PowerPoint table." },
  icon: { fidelity: "placeholder", label: "Placeholder", detail: "PowerPoint gets a labelled box in its place." },
  chart: { fidelity: "approximated", label: "Drawn", detail: "Drawn as shapes with editable labels, not as a PowerPoint chart object." },
  diagram: { fidelity: "approximated", label: "Drawn", detail: "Drawn as shapes and connectors with editable labels." },
  code: { fidelity: "approximated", label: "Text", detail: "Becomes a monospaced text box; colours are kept, highlighting logic is not." },
  group: { fidelity: "approximated", label: "Flattened", detail: "Its objects are placed individually; a layout will not re-flow in PowerPoint." },
  equation: { fidelity: "picture", label: "Picture", detail: "Becomes a picture of the formula, described by its LaTeX." },
};

const UNKNOWN: FidelityRow = { fidelity: "placeholder", label: "Placeholder", detail: "PowerPoint gets a labelled box in its place." };

export function pptxFidelity(kind: string): FidelityRow {
  return ROWS[kind] ?? UNKNOWN;
}
