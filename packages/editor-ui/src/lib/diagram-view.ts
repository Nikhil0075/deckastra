import type { DiagramElement, PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";

/**
 * How a diagram is seen (2026-10-13): flat, as isometric blocks, as an
 * exploded stack of layers, or as an orbit around its first node. The first is
 * a projection over whatever layout the diagram has; the last two are layouts
 * of their own. One choice here, one change to `layoutHint`, so a view never
 * leaves a projection and an arrangement fighting each other.
 */
export type DiagramView = "flat" | "isometric" | "stack" | "orbit";

export const DIAGRAM_VIEWS: readonly { value: DiagramView; label: string }[] = [
  { value: "flat", label: "Flat" },
  { value: "isometric", label: "Isometric blocks" },
  { value: "stack", label: "Exploded layers" },
  { value: "orbit", label: "Orbit" },
];

export function diagramView(element: DiagramElement): DiagramView {
  const hint = element.layoutHint ?? {};
  if (hint.algorithm === "stack" || hint.algorithm === "orbit") return hint.algorithm;
  return hint.projection === "isometric" ? "isometric" : "flat";
}

export function diagramViewOperations(document: PresentationDocument, element: DiagramElement, view: DiagramView): PatchOperation[] {
  const hint: Record<string, unknown> = { ...(element.layoutHint ?? {}) };
  delete hint.projection;
  if (hint.algorithm === "stack" || hint.algorithm === "orbit") delete hint.algorithm;
  if (view === "isometric") hint.projection = "isometric";
  if (view === "stack" || view === "orbit") hint.algorithm = view;
  return setPropertyDeep(document, element.id, "layoutHint", Object.keys(hint).length ? hint : undefined);
}

/** What a view does with the diagram, in a sentence. */
export const DIAGRAM_VIEW_HINTS: Record<DiagramView, string> = {
  flat: "The diagram lays itself out again after each change.",
  isometric: "Each box stands as a block; the layout is the flat one, seen from above.",
  stack: "Each rank is a layer, the first on top. A layer is named by the group all its boxes share.",
  orbit: "The first box sits in the middle; the rest circle it by how far they are from it.",
};
