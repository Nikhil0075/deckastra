/**
 * A diagram's view in the editor (image-led visual systems, item 6, 2026-10-13).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { validateDocument, type DiagramElement, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";
import { resolveElementById } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";

import { diagramView, diagramViewOperations } from "../src/lib/diagram-view";
import { DiagramSection } from "../src/components/inspector/DiagramSection";

afterEach(cleanup);

function withDiagram(): { doc: PresentationDocument; diagram: DiagramElement } {
  const doc = structuredClone(loadFixture("technical"));
  const diagram = doc.slides.flatMap((slide) => slide.elements).find((one) => one.type === "diagram") as DiagramElement;
  return { doc, diagram };
}

const after = (doc: PresentationDocument, operations: PatchOperation[], id: string) => {
  const result = applyPatch(doc, operations);
  expect(validateDocument(result.document).errors).toEqual([]);
  expect(applyPatch(result.document, result.inverse).document).toEqual(doc);
  return resolveElementById(result.document, id)!.element as DiagramElement;
};

describe("diagram views", () => {
  it("writes each view as one change and reads it back", () => {
    const { doc, diagram } = withDiagram();
    for (const view of ["isometric", "stack", "orbit", "flat"] as const) {
      const changed = after(doc, diagramViewOperations(doc, diagram, view), diagram.id);
      expect(diagramView(changed)).toBe(view);
    }
  });

  it("never leaves a projection and an arrangement fighting each other", () => {
    const { doc, diagram } = withDiagram();
    const iso = after(doc, diagramViewOperations(doc, diagram, "isometric"), diagram.id);
    const isoDoc = applyPatch(doc, diagramViewOperations(doc, diagram, "isometric")).document;
    const orbit = after(isoDoc, diagramViewOperations(isoDoc, iso, "orbit"), diagram.id);
    expect(orbit.layoutHint?.projection).toBeUndefined();
    expect(orbit.layoutHint?.algorithm).toBe("orbit");
    // Back to flat keeps the rest of the hint (direction, mode) as it was.
    const flat = after(isoDoc, diagramViewOperations(isoDoc, iso, "flat"), diagram.id);
    expect(flat.layoutHint).toEqual(diagram.layoutHint);
  });

  it("offers the views in the inspector", () => {
    const { doc, diagram } = withDiagram();
    const edits: { operations: PatchOperation[]; label: string }[] = [];
    render(<DiagramSection document={doc} element={diagram} edit={(operations, label) => edits.push({ operations, label })} disabled={false} />);
    fireEvent.click(screen.getByTestId("diagram-view"));
    fireEvent.click(screen.getByRole("option", { name: "Exploded layers" }));
    expect(edits.map((one) => one.label)).toEqual(["Change diagram view"]);
    expect(after(doc, edits[0]!.operations, diagram.id).layoutHint?.algorithm).toBe("stack");
  });
});
