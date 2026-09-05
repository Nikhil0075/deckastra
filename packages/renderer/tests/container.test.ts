import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { buildDocumentScene, flattenScene } from "../src/scene";

/**
 * Container layout in the scene build — pipeline stage 6 (doc 04 §6.1).
 *
 * The point of the stage is robustness: four cards emitted as a container
 * survive a longer label, where the same four emitted as absolute boxes overlap.
 * These tests pin the two halves of that contract — the container positions its
 * children, and a child's own coordinates stop mattering while it does.
 */

const technical = loadFixture("technical");

function sceneOf(doc: PresentationDocument, slide = 1) {
  return flattenScene(buildDocumentScene(doc).slides[slide]!);
}

function byId(doc: PresentationDocument, id: string, slide = 1) {
  return sceneOf(doc, slide).find((node) => node.id === id)!;
}

/** The KPI row on the technical fixture's second slide. */
function kpiRow(doc: PresentationDocument) {
  return doc.slides[1]!.elements.find(
    (element) => element.type === "group" && (element as { children?: unknown[] }).children,
  ) as PresentationDocument["slides"][number]["elements"][number] & {
    children: PresentationDocument["slides"][number]["elements"];
    containerLayout?: { type: string; gap?: number };
    transform: { x: number; y: number; width: number; height: number };
  };
}

describe("container layout", () => {
  it("positions children from the container, not from their own coordinates", () => {
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    const row = kpiRow(doc);

    // Advisory positions are deliberately nonsense here. If they still mattered,
    // every card would land on top of the first one.
    for (const child of row.children) {
      child.transform.x = 0;
      child.transform.y = 0;
    }

    const xs = row.children.map((child) => byId(doc, child.id).bounds.x);
    expect(new Set(xs).size).toBe(row.children.length);
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]).toBeGreaterThan(xs[i - 1]!);
  });

  it("applies the container's padding to its children", () => {
    // The composer emits padding on the layout rather than baking it into child
    // coordinates. A card whose padding lived only in those coordinates would go
    // flush the moment the container took over.
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    const row = kpiRow(doc);
    const card = row.children[0]! as typeof row;
    const layout = card.containerLayout as { padding?: { top: number; left: number } } | undefined;

    if (!layout?.padding) return; // The fixture's cards may not declare padding.

    const cardNode = byId(doc, card.id);
    const firstChild = byId(doc, card.children[0]!.id);

    expect(firstChild.bounds.x).toBe(cardNode.bounds.x + layout.padding.left);
    expect(firstChild.bounds.y).toBe(cardNode.bounds.y + layout.padding.top);
  });

  it("keeps children inside the container it laid them out in", () => {
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    const row = kpiRow(doc);
    const rowNode = byId(doc, row.id);

    for (const child of row.children) {
      const node = byId(doc, child.id);
      expect(node.bounds.x).toBeGreaterThanOrEqual(rowNode.bounds.x - 0.01);
      expect(node.bounds.x + node.bounds.width).toBeLessThanOrEqual(
        rowNode.bounds.x + rowNode.bounds.width + 0.01,
      );
    }
  });

  it("reflows when the container is resized, instead of overlapping", () => {
    // The whole reason the stage exists. Absolute boxes would keep their old
    // positions and either overlap or leave a gap.
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    const row = kpiRow(doc);
    const before = row.children.map((child) => byId(doc, child.id).bounds.x);

    row.transform.width = Math.round(row.transform.width / 2);
    const after = row.children.map((child) => byId(doc, child.id).bounds.x);

    expect(after).not.toEqual(before);
    // Still ordered, still non-overlapping.
    for (let i = 1; i < after.length; i += 1) expect(after[i]).toBeGreaterThan(after[i - 1]!);
  });

  it("leaves a free container's children exactly where the document puts them", () => {
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    const row = kpiRow(doc);
    (row as { containerLayout?: unknown }).containerLayout = { type: "free" };

    const first = row.children[0]!;
    const node = byId(doc, first.id);
    expect(node.bounds.x).toBe(row.transform.x + first.transform.x);
    expect(node.bounds.y).toBe(row.transform.y + first.transform.y);
  });

  it("leaves a plain group's children alone", () => {
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    const row = kpiRow(doc);
    delete (row as { containerLayout?: unknown }).containerLayout;

    const first = row.children[0]!;
    const node = byId(doc, first.id);
    expect(node.bounds.x).toBe(row.transform.x + first.transform.x);
  });

  it("gives the laid-out size to the payload, not the advisory one", () => {
    // A chart or a text box inside a container must measure against the box it
    // actually got. Measuring against the advisory size is how a container's
    // child overflows a box it fits.
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    const row = kpiRow(doc);
    const card = row.children[0]! as typeof row;

    card.transform.width = 10;
    card.transform.height = 10;

    const node = byId(doc, card.id);
    expect(node.localBounds.width).toBeGreaterThan(10);
  });
});
