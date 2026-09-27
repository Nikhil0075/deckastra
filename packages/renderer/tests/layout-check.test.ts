import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { describe, expect, it } from "vitest";

import { buildDocumentScene, checkLayout, readableColor } from "../src/index";

/** The layout half of the Design Check (design review, 2026-09-27). */

let seq = 0;
const id = () => `el_01JB8Z9K2QW4RN7F3X9${String(++seq).padStart(7, "0")}`;

function text(x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): PresentationElement {
  return {
    id: id(),
    type: "text",
    transform: { x, y, width: w, height: h },
    content: { version: 1, blocks: [{ id: `blk_01JB8Z9K2QW4RN7F3X9${String(++seq).padStart(7, "0")}`, type: "paragraph", spans: [{ text: "Quarterly revenue" }] }] },
    typography: { fontSize: 32, color: "#111111", ...(extra.typography as object) },
    ...extra,
  } as unknown as PresentationElement;
}

function box(x: number, y: number, w: number, h: number, fill = "#FFFFFF", extra: Record<string, unknown> = {}): PresentationElement {
  return { id: id(), type: "shape", shape: "rectangle", transform: { x, y, width: w, height: h }, style: { fill: { type: "solid", color: fill } }, ...extra } as unknown as PresentationElement;
}

function slideWith(elements: PresentationElement[]) {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const slide = document.slides[0]!;
  slide.elements = elements;
  slide.background = { paint: { type: "solid", color: "#FFFFFF" } } as never;
  document.slides = [slide];
  return buildDocumentScene(document).slides[0]!;
}

describe("checkLayout", () => {
  it("finds two objects colliding, names the upper one and proposes the shortest move clear", () => {
    const under = text(200, 200, 400, 60);
    const over = text(560, 210, 300, 60);
    const issues = checkLayout(slideWith([under, over])).filter((i) => i.code === "W110");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.elementId).toBe(over.id);
    expect(issues[0]!.detail).toEqual({ kind: "overlap", otherId: under.id, dx: 44, dy: 0 });
  });

  it("does not call a card holding its text a collision", () => {
    const card = box(200, 200, 600, 300, "#1E4BD2");
    const label = text(240, 240, 300, 60, { typography: { color: "#FFFFFF", fontSize: 32 } });
    expect(checkLayout(slideWith([card, label])).filter((i) => i.code === "W110")).toEqual([]);
  });

  it("ignores decoration and objects that only touch", () => {
    const a = text(200, 200, 400, 60);
    const touching = text(602, 200, 300, 60);
    const decoration = box(250, 210, 100, 100, "#EEEEEE", { semanticRole: "decoration" });
    expect(checkLayout(slideWith([a, touching, decoration])).filter((i) => i.code === "W110")).toEqual([]);
  });

  it("says how far an object must move to come back inside the safe area", () => {
    const outside = text(60, 200, 400, 60);
    const [issue] = checkLayout(slideWith([outside])).filter((i) => i.code === "W104");
    expect(issue?.detail).toEqual({ kind: "safeArea", dx: 60, dy: 0 });
  });

  it("flags text below the readable minimum, and not text at it", () => {
    const small = text(200, 200, 400, 60, { typography: { fontSize: 12, color: "#111111" } });
    const fine = text(200, 400, 400, 60, { typography: { fontSize: 16, color: "#111111" } });
    const issues = checkLayout(slideWith([small, fine])).filter((i) => i.code === "W216");
    expect(issues.map((i) => i.elementId)).toEqual([small.id]);
  });

  it("measures contrast against the card actually painted behind the text", () => {
    const card = box(200, 200, 600, 300, "#1E4BD2");
    const dark = text(240, 240, 300, 60, { typography: { color: "#111111", fontSize: 20 } });
    const [issue] = checkLayout(slideWith([card, dark])).filter((i) => i.code === "A102");
    expect(issue?.elementId).toBe(dark.id);
    expect(issue?.detail).toMatchObject({ kind: "contrast", behind: "#1E4BD2", target: "text" });
  });

  it("chooses the candidate that reads on a background", () => {
    expect(readableColor("#1E4BD2", ["#111111", "#FFFFFF"])).toBe("#FFFFFF");
    expect(readableColor("#F4EFE3", ["#FFFFFF", "#111111"])).toBe("#111111");
  });

  it("reports a diagram whose boxes use a corner of its frame", () => {
    const document = structuredClone(loadFixture("technical")) as PresentationDocument;
    const slide = document.slides.find((s) => s.elements.some((e) => e.type === "diagram"))!;
    const diagram = slide.elements.find((e) => e.type === "diagram")!;
    diagram.transform = { ...diagram.transform, width: diagram.transform.width * 4, height: diagram.transform.height * 4 };
    const scene = buildDocumentScene(document).slides.find((s) => s.slideId === slide.id)!;
    const found = checkLayout(scene).filter((i) => i.code === "W217");
    expect(found.map((i) => i.elementId)).toContain(diagram.id);
  });

  it("finds nothing wrong with the seed decks' own layout that a person would have to fix", () => {
    for (const name of ["technical", "animation", "repository"] as const) {
      const scene = buildDocumentScene(loadFixture(name));
      const overlaps = scene.slides.flatMap((s) => checkLayout(s)).filter((i) => i.code === "W110");
      // Printed on failure so a regression names what collided.
      expect(overlaps.map((i) => i.message)).toEqual([]);
    }
  });
});

describe("contrast that can be trusted", () => {
  const pale = (y = 240) => text(240, y, 300, 60, { typography: { color: "#FFFFFF", fontSize: 20 } });

  it("judges text on a gradient at its weakest stop", () => {
    const card = box(200, 200, 600, 300, "#000000", { style: { fill: { type: "linearGradient", angle: 90, stops: [{ offset: 0, color: "#111111" }, { offset: 1, color: "#F4EFE3" }] } } });
    const label = pale();
    const [issue] = checkLayout(slideWith([card, label])).filter((i) => i.code === "A102");
    expect(issue?.elementId).toBe(label.id);
    expect(issue?.message).toMatch(/weakest part of the gradient/);
    expect(issue?.detail).toMatchObject({ behind: "#F4EFE3" });
  });

  it("blends a translucent card with what is beneath it", () => {
    // A barely-there blue over white is nearly white: white text on it fails,
    // where the opaque blue it names would have passed.
    const card = box(200, 200, 600, 300, "#1E4BD21A");
    expect(checkLayout(slideWith([card, pale()])).filter((i) => i.code === "A102")).toHaveLength(1);
    const solid = box(200, 200, 600, 300, "#1E4BD2");
    expect(checkLayout(slideWith([solid, pale()])).filter((i) => i.code === "A102")).toEqual([]);
  });

  it("says a picture makes contrast unmeasurable, and a solid card makes it measurable again", () => {
    const picture = { id: id(), type: "image", transform: { x: 100, y: 100, width: 900, height: 600 }, assetId: "ast_01JB8Z9K2QW4RN7F3X01006800", altText: "A photograph" } as unknown as PresentationElement;
    const words = pale(300);
    const unknown = checkLayout(slideWith([picture, words]));
    expect(unknown.filter((i) => i.code === "W218").map((i) => i.elementId)).toEqual([words.id]);
    expect(unknown.filter((i) => i.code === "A102")).toEqual([]);
    const backed = checkLayout(slideWith([picture, box(220, 280, 400, 120, "#1E4BD2"), pale(300)]));
    expect(backed.filter((i) => i.code === "W218" || i.code === "A102")).toEqual([]);
  });

  it("checks a table's heading on its heading fill", () => {
    const document = structuredClone(loadFixture("technical")) as PresentationDocument;
    const slide = document.slides.find((s) => s.elements.some((e) => e.type === "table"))!;
    const table = slide.elements.find((e) => e.type === "table")! as PresentationElement & { tableStyle?: Record<string, unknown> };
    table.tableStyle = { ...(table.tableStyle ?? {}), headerFill: { type: "solid", color: "#F4EFE3" }, headerColor: "#FFFFFF" };
    const scene = buildDocumentScene(document).slides.find((s) => s.slideId === slide.id)!;
    const found = checkLayout(scene).filter((i) => i.code === "A102" && i.elementId === table.id);
    expect(found.map((i) => (i.detail as { target: string }).target)).toContain("tableHeader");
  });

  it("reports an object larger than the safe area, which cannot be moved inside it", () => {
    const huge = box(0, 0, 1920, 1080, "#EEEEEE");
    const [issue] = checkLayout(slideWith([huge])).filter((i) => i.code === "W104");
    expect(issue?.message).toMatch(/larger than the slide's safe area/);
    expect(issue?.detail).toMatchObject({ kind: "safeArea", dx: 0, dy: 0 });
    expect((issue?.detail as { scale: number }).scale).toBeLessThan(1);
  });
});
