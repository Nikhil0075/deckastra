/**
 * Diagrams with depth (image-led visual systems, item 6, 2026-10-13):
 * isometric blocks, an exploded stack, an orbit.
 */
import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { validateDocument, type DiagramElement } from "@deckastra/presentation-schema";

import { buildDiagramPayload, type DiagramNodeMark, type DiagramPayload } from "../src/diagram";
import { resolveTheme } from "../src/theme";

const theme = resolveTheme(loadFixture("technical").theme);
const id = (n: number) => `dn_01JB8Z9K2QW4RN7F3XG5HTM${String(n).padStart(3, "0")}`;
const edgeId = (n: number) => `de_01JB8Z9K2QW4RN7F3XG5HTM${String(n).padStart(3, "0")}`;
const groupId = (n: number) => `dg_01JB8Z9K2QW4RN7F3XG5HTM${String(n).padStart(3, "0")}`;

function diagram(
  labels: string[],
  links: [number, number][],
  layoutHint: Record<string, unknown>,
  groups: { label: string; members: number[] }[] = [],
  width = 1200,
  height = 700,
): DiagramPayload {
  const element = {
    id: "el_01JB8Z9K2QW4RN7F3XG5HTMD01",
    type: "diagram",
    diagramType: "architecture",
    transform: { x: 0, y: 0, width, height, rotation: 0 },
    nodes: labels.map((label, index) => ({ id: id(index), label })),
    edges: links.map(([from, to], index) => ({ id: edgeId(index), from: id(from), to: id(to) })),
    groups: groups.map((group, index) => ({ id: groupId(index), label: group.label, nodeIds: group.members.map(id) })),
    layoutHint,
  } as unknown as DiagramElement;
  return buildDiagramPayload(element, width, height, theme);
}

const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const node = (payload: DiagramPayload, index: number) => payload.nodes.find((mark) => mark.id === id(index))!;
const centre = (mark: { x: number; y: number; width: number; height: number }) => ({ x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 });
const overlap = (a: DiagramNodeMark, b: DiagramNodeMark) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function insideBox(payload: DiagramPayload, width = 1200, height = 700) {
  const all = [
    ...payload.nodes.flatMap((mark) => [mark.outline ?? "", ...(mark.sides ?? []).map((side) => side.d)]),
    ...payload.groups.flatMap((group) => [group.outline ?? "", ...(group.sides ?? []).map((side) => side.d)]),
    ...payload.edges.map((edge) => edge.d),
  ].flatMap(numbers);
  for (let i = 0; i < all.length; i += 2) {
    expect(all[i]!).toBeGreaterThanOrEqual(-0.01);
    expect(all[i]!).toBeLessThanOrEqual(width + 0.01);
    expect(all[i + 1]!).toBeGreaterThanOrEqual(-0.01);
    expect(all[i + 1]!).toBeLessThanOrEqual(height + 0.01);
  }
}

describe("isometric blocks", () => {
  const chain = diagram(["Web app", "API", "Database"], [[0, 1], [1, 2]], { projection: "isometric" });

  it("draws every box as a top face with two faces beneath it, edges above", () => {
    for (const mark of chain.nodes) {
      expect(mark.outline).toMatch(/^M .* Z$/);
      expect(mark.sides).toHaveLength(2);
      // The faces are darker than the top.
      expect(mark.sides![0]!.fill).not.toBe(mark.fill);
    }
    expect(chain.edgesAbove).toBe(true);
    expect(chain.algorithm).toBe("layered:isometric");
    insideBox(chain);
  });

  it("keeps a left-to-right flow running left to right", () => {
    const [a, b, c] = [0, 1, 2].map((index) => centre(node(chain, index)));
    expect(a!.x).toBeLessThan(b!.x);
    expect(b!.x).toBeLessThan(c!.x);
    expect(Math.abs(a!.y - c!.y)).toBeLessThan(2);
  });

  it("joins blocks at their tops, not their centres", () => {
    for (const edge of chain.edges) {
      const points = numbers(edge.d);
      const [sx, sy, ex, ey] = [points[0]!, points[1]!, points.at(-2)!, points.at(-1)!];
      const near = (mark: DiagramNodeMark, x: number, y: number) =>
        x >= mark.x - 1 && x <= mark.x + mark.width + 1 && y >= mark.y - 1 && y <= mark.y + mark.height + 1;
      expect(chain.nodes.some((mark) => near(mark, sx, sy))).toBe(true);
      expect(chain.nodes.some((mark) => near(mark, ex, ey))).toBe(true);
    }
  });

  it("draws a group as a region on the ground, named where no block stands", () => {
    const grouped = diagram(["Web", "API", "Queue", "Cache", "DB"], [[0, 1], [1, 2], [1, 3], [2, 4]], { projection: "isometric" }, [
      { label: "BACKEND", members: [1, 2, 3] },
    ]);
    const region = grouped.groups[0]!;
    expect(region.outline).toBeDefined();
    const label = region.label!;
    const box = { x: label.x, y: label.y - label.size, width: label.text.length * label.size * 0.6, height: label.size, radius: 0 } as unknown as DiagramNodeMark;
    expect(grouped.nodes.some((mark) => overlap(mark, box))).toBe(false);
    // The region does not reach the block outside the group.
    const outside = centre(node(grouped, 0));
    expect(outside.x).toBeLessThan(region.x);
  });

  it("is the same every time", () => {
    expect(JSON.stringify(diagram(["A", "B"], [[0, 1]], { projection: "isometric" }))).toBe(
      JSON.stringify(diagram(["A", "B"], [[0, 1]], { projection: "isometric" })),
    );
  });
});

describe("an exploded stack", () => {
  const layers = diagram(
    ["Interface", "Editor", "Engines", "Store", "Files"],
    [[0, 1], [0, 2], [1, 3], [2, 3], [2, 4]],
    { algorithm: "stack" },
    [
      { label: "PRESENTATION", members: [0] },
      { label: "LOGIC", members: [1, 2] },
      { label: "DATA", members: [3, 4] },
    ],
    740,
    1000,
  );

  it("puts the first rank on top and names each layer by its group", () => {
    const top = centre(node(layers, 0)).y;
    const middle = centre(node(layers, 1)).y;
    const bottom = centre(node(layers, 3)).y;
    expect(top).toBeLessThan(middle);
    expect(middle).toBeLessThan(bottom);
    expect(layers.groups.map((plate) => plate.label?.text).sort()).toEqual(["DATA", "LOGIC", "PRESENTATION"]);
    insideBox(layers, 740, 1000);
  });

  it("raises each layer clear of the one below", () => {
    const plates = [...layers.groups].sort((a, b) => a.y - b.y);
    for (let i = 1; i < plates.length; i += 1) {
      // A block on a higher plate never reaches into a lower plate.
      const lowerTop = plates[i]!.y;
      const higher = layers.nodes.filter((mark) => centre(mark).y < lowerTop - 1);
      for (const mark of higher) expect(mark.y + mark.height).toBeLessThanOrEqual(lowerTop + 1);
    }
  });

  it("says so when the groups do not match the layers", () => {
    const mismatched = diagram(["A", "B", "C"], [[0, 1], [1, 2]], { algorithm: "stack" }, [{ label: "MIXED", members: [0, 1] }]);
    expect(mismatched.warnings.some((warning) => warning.includes("1 group does not match the layers"))).toBe(true);
  });
});

describe("an orbit", () => {
  const solar = diagram(["Deckastra", "Templates", "Agents", "Exports", "Languages", "Narration"], [[0, 1], [0, 2], [0, 3], [2, 4], [3, 5]], {
    algorithm: "orbit",
  });

  it("puts the first node in the middle and the rest on rings by distance", () => {
    const middle = centre(node(solar, 0));
    expect(Math.abs(middle.x - 600)).toBeLessThan(60);
    const distance = (index: number) => {
      const c = centre(node(solar, index));
      return Math.hypot((c.x - middle.x) / 1, (c.y - middle.y) / 0.38);
    };
    expect(distance(4)).toBeGreaterThan(distance(2));
    expect(solar.groups.filter((ring) => ring.outline)).toHaveLength(2);
  });

  it("draws nearer nodes larger, and no node over another", () => {
    const front = solar.nodes.filter((mark) => mark.id !== id(0)).sort((a, b) => centre(b).y - centre(a).y);
    expect(front[0]!.labelSize).toBeGreaterThanOrEqual(front.at(-1)!.labelSize);
    for (let i = 0; i < solar.nodes.length; i += 1) {
      for (let j = i + 1; j < solar.nodes.length; j += 1) expect(overlap(solar.nodes[i]!, solar.nodes[j]!)).toBe(false);
    }
    insideBox(solar);
  });

  it("places a node joined to nothing on the outermost ring, and says so", () => {
    const lonely = diagram(["Hub", "A", "Alone"], [[0, 1]], { algorithm: "orbit" });
    expect(lonely.warnings).toContain("Nodes with no connection to the centre are placed on the outermost ring.");
  });
});

describe("arrangements this build does not know", () => {
  it("lays out in layers, flat, and says so", () => {
    const future = diagram(["A", "B"], [[0, 1]], { algorithm: "helix", projection: "dimetric" });
    expect(future.algorithm).toBe("layered");
    expect(future.nodes.every((mark) => mark.outline === undefined)).toBe(true);
    expect(future.warnings).toEqual(['Layout "helix" is not known here; laid out in layers instead.', 'Projection "dimetric" is not known here; drawn flat.']);
  });

  it("are kept by the schema with a warning, not refused", () => {
    const document = structuredClone(loadFixture("technical"));
    const element = document.slides.flatMap((slide) => slide.elements).find((one) => one.type === "diagram") as DiagramElement;
    element.layoutHint = { ...((element.layoutHint ?? {}) as object), algorithm: "helix", projection: "dimetric" } as never;
    const result = validateDocument(document);
    expect(result.errors).toEqual([]);
    expect(result.warnings.filter((issue) => issue.code === "W241").map((issue) => issue.path.split("/").slice(-2).join("/"))).toEqual(
      ["layoutHint/algorithm", "layoutHint/projection"],
    );
    element.layoutHint = { ...((element.layoutHint ?? {}) as object), algorithm: "orbit", projection: "isometric" } as never;
    expect(validateDocument(document).warnings.filter((issue) => issue.code === "W241")).toEqual([]);
  });
});

describe("a flat diagram", () => {
  it("carries nothing new", () => {
    const flat = diagram(["A", "B"], [[0, 1]], {});
    expect(flat.edgesAbove).toBeUndefined();
    expect(flat.nodes.every((mark) => mark.outline === undefined && mark.sides === undefined)).toBe(true);
  });
});
