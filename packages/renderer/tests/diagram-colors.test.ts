import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { expect, it } from "vitest";

import { buildDocumentScene } from "../src/index";

/**
 * A diagram box given its own fill gets a label it can be read on (colour
 * wizard, 2026-09-26); a themed box is drawn exactly as before.
 */

function diagramNodes(fill?: string) {
  const document = structuredClone(loadFixture("technical"));
  for (const slide of document.slides) {
    for (const element of slide.elements) {
      if (element.type !== "diagram") continue;
      const diagram = element as unknown as { nodes: { style?: unknown }[] };
      if (fill) diagram.nodes[0]!.style = { fill: { type: "solid", color: fill } };
      const scene = buildDocumentScene(document);
      const node = scene.slides.flatMap((s) => s.nodes).find((n) => n.id === element.id)!;
      return (node.renderPayload as unknown as { nodes: { fill: string; labelColor: string }[] }).nodes;
    }
  }
  throw new Error("The technical fixture has no diagram.");
}

it("keeps the theme's label colour on a themed box", () => {
  const themed = diagramNodes();
  const again = diagramNodes();
  expect(themed[0]!.labelColor).toBe(again[0]!.labelColor);
});

it("picks a readable label for a box filled light and for one filled dark", () => {
  const light = diagramNodes("#FFFFFF")[0]!;
  const dark = diagramNodes("#0A0A0A")[0]!;
  expect(light.labelColor).not.toBe(dark.labelColor);
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    return 0.299 * r! + 0.587 * g! + 0.114 * b!;
  };
  expect(lum(light.labelColor)).toBeLessThan(128);
  expect(lum(dark.labelColor)).toBeGreaterThan(128);
});
