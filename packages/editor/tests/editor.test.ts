import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { isGroup, walkElements, type PresentationDocument, type Rect, type Transform } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";
import { resolveElementById } from "@deckastra/presentation-core";

import {
  EMPTY_SELECTION,
  SNAP_THRESHOLD,
  SpatialIndex,
  anchorPoint,
  buildIndex,
  buildSelectableNodes,
  click,
  collectSnapLines,
  constrainToAxis,
  copy,
  commitTransform,
  cycleSelection,
  cycleLeavesScope,
  commandScope,
  describeBinding,
  duplicate,
  editScope,
  enterGroup,
  escape,
  findEqualSpacing,
  hitTolerance,
  isAllowedWhileTyping,
  marqueeSelect,
  minSizeFor,
  move,
  normalizeAngle,
  nudgeDistance,
  paste,
  pointInEllipse,
  distanceToPolyline,
  remapSelection,
  resize,
  resizeGroup,
  resolveClickTarget,
  resolveCommand,
  rotate,
  rotateAbout,
  selectAll,
  selectionBounds,
  snapRect,
  worldBounds,
  type SelectableNode,
} from "../src/index";

// A small scene: two loose elements and a group holding two children.
const nodes: SelectableNode[] = [
  { id: "a", isGroup: false, locked: false, hidden: false, bounds: { x: 0, y: 0, width: 100, height: 100 } },
  { id: "b", isGroup: false, locked: false, hidden: false, bounds: { x: 200, y: 0, width: 100, height: 100 } },
  { id: "g", isGroup: true, locked: false, hidden: false, bounds: { x: 400, y: 0, width: 300, height: 200 } },
  { id: "g1", parentId: "g", isGroup: false, locked: false, hidden: false, bounds: { x: 400, y: 0, width: 100, height: 100 } },
  { id: "g2", parentId: "g", isGroup: false, locked: false, hidden: false, bounds: { x: 550, y: 0, width: 100, height: 100 } },
  { id: "locked", isGroup: false, locked: true, hidden: false, bounds: { x: 800, y: 0, width: 100, height: 100 } },
  { id: "hidden", isGroup: false, locked: false, hidden: true, bounds: { x: 900, y: 0, width: 100, height: 100 } },
];

const index = buildIndex(nodes);
const order = nodes.map((node) => node.id);

describe("buildSelectableNodes", () => {
  const groupSlide = loadFixture("technical").slides.find((slide) =>
    slide.elements.some(isGroup),
  )!;
  const built = buildSelectableNodes(groupSlide);
  const group = groupSlide.elements.find(isGroup)!;
  const child = group.children[0]!;

  it("publishes a grouped child's bounds in world space", () => {
    // The child's own transform is local to the group. Publishing it unchanged
    // put the selection box, the hit test and the snap neighbours at the slide
    // origin instead of where the child actually is.
    const node = built.find((n) => n.id === child.id)!;
    expect(node.bounds.x).toBe(group.transform.x + child.transform.x);
    expect(node.bounds.y).toBe(group.transform.y + child.transform.y);
    expect(node.bounds.x).not.toBe(child.transform.x);
  });

  it("carries the parent origin so a gesture can be written back as a local value", () => {
    const node = built.find((n) => n.id === child.id)!;
    expect(node.offset).toEqual({ x: group.transform.x, y: group.transform.y });
    expect(node.bounds.x - node.offset!.x).toBe(child.transform.x);
  });

  it("leaves a top-level element's two spaces identical", () => {
    const node = built.find((n) => n.id === group.id)!;
    expect(node.offset).toEqual({ x: 0, y: 0 });
    expect(node.bounds.x).toBe(group.transform.x);
    expect(node.parentId).toBeUndefined();
  });

  it("emits every element in document order, groups before their children", () => {
    expect(built.map((n) => n.id)).toEqual(
      [...walkElements(groupSlide.elements)].map(({ element }) => element.id),
    );
  });
});

// ------------------------------------------------------------------ selection

describe("selection", () => {
  it("clicking a child of a group selects the group", () => {
    // The Figma behaviour everyone expects; getting it wrong makes nested content
    // feel impossible to touch.
    expect(resolveClickTarget(index, "g1")).toBe("g");
  });

  it("alt-click reaches the child directly", () => {
    expect(resolveClickTarget(index, "g1", { deep: true })).toBe("g1");
  });

  it("inside an entered group, clicks select children", () => {
    expect(resolveClickTarget(index, "g1", { isolationGroupId: "g" })).toBe("g1");
  });

  it("never selects a locked or hidden element by click", () => {
    expect(resolveClickTarget(index, "locked")).toBeUndefined();
    expect(resolveClickTarget(index, "hidden")).toBeUndefined();
  });

  it("shift-click toggles membership", () => {
    let state = click(EMPTY_SELECTION, index, "a");
    state = click(state, index, "b", { additive: true });
    expect(state.selectedIds).toEqual(["a", "b"]);
    expect(state.primaryId).toBe("b");

    state = click(state, index, "a", { additive: true });
    expect(state.selectedIds).toEqual(["b"]);
  });

  it("clicking empty canvas clears selection but stays in the group", () => {
    // Leaving isolation on every stray click makes nested editing maddening.
    const entered = enterGroup(click(EMPTY_SELECTION, index, "g1"), "g");
    const cleared = click(entered, index, undefined);
    expect(cleared.selectedIds).toEqual([]);
    expect(cleared.isolationGroupId).toBe("g");
  });

  it("marquee selects intersecting elements and resolves them to groups", () => {
    const state = marqueeSelect(EMPTY_SELECTION, index, { x: -10, y: -10, width: 500, height: 300 });
    expect(state.selectedIds).toContain("a");
    expect(state.selectedIds).toContain("b");
    expect(state.selectedIds).toContain("g");
    expect(state.selectedIds).not.toContain("g1");
  });

  it("marquee skips locked and hidden elements", () => {
    const state = marqueeSelect(EMPTY_SELECTION, index, { x: 0, y: 0, width: 2000, height: 2000 });
    expect(state.selectedIds).not.toContain("locked");
    expect(state.selectedIds).not.toContain("hidden");
  });

  it("marquee in contained mode requires full enclosure", () => {
    const partial = marqueeSelect(EMPTY_SELECTION, index, { x: 0, y: 0, width: 50, height: 50 }, { contained: true });
    expect(partial.selectedIds).not.toContain("a");

    const full = marqueeSelect(EMPTY_SELECTION, index, { x: -5, y: -5, width: 120, height: 120 }, { contained: true });
    expect(full.selectedIds).toContain("a");
  });

  it("escape backs out one level at a time", () => {
    // Collapsing these into one action makes Escape unpredictable — the user
    // cannot tell what they are about to lose.
    let state = enterGroup(EMPTY_SELECTION, "g");
    state = click(state, index, "g1");
    state = { ...state, editingTextId: "g1" };

    state = escape(state, index);
    expect(state.editingTextId).toBeUndefined();
    expect(state.isolationGroupId).toBe("g");

    state = escape(state, index);
    expect(state.isolationGroupId).toBeUndefined();
    expect(state.selectedIds).toEqual(["g"]);

    state = escape(state, index);
    expect(state.selectedIds).toEqual([]);
  });

  it("tab cycles siblings within the current scope", () => {
    let state = click(EMPTY_SELECTION, index, "a");
    state = cycleSelection(state, index, order, 1);
    expect(state.primaryId).toBe("b");

    state = cycleSelection(state, index, order, -1);
    expect(state.primaryId).toBe("a");
  });

  it("tab leaves the canvas past the last object instead of wrapping (no keyboard trap)", () => {
    // In this scope the siblings are a, b, g.
    expect(cycleLeavesScope(EMPTY_SELECTION, index, order, 1)).toBe(false);
    expect(cycleLeavesScope(EMPTY_SELECTION, index, order, -1)).toBe(true);
    const first = click(EMPTY_SELECTION, index, "a");
    expect(cycleLeavesScope(first, index, order, 1)).toBe(false);
    expect(cycleLeavesScope(first, index, order, -1)).toBe(true);
    const last = click(EMPTY_SELECTION, index, "g");
    expect(cycleLeavesScope(last, index, order, 1)).toBe(true);
    expect(cycleLeavesScope(last, index, order, -1)).toBe(false);
  });

  it("only undo, redo and present act wherever focus is; the rest need the canvas", () => {
    expect(commandScope("undo")).toBe("global");
    expect(commandScope("redo")).toBe("global");
    expect(commandScope("present")).toBe("global");
    for (const command of ["cycleNext", "nudgeLeft", "delete", "selectAll", "copy", "group"] as const) {
      expect(commandScope(command), command).toBe("canvas");
    }
  });

  it("select-all respects the isolation scope and skips locked and hidden", () => {
    const all = selectAll(EMPTY_SELECTION, index, order);
    expect(all.selectedIds).toEqual(["a", "b", "g"]);

    const inside = selectAll(enterGroup(EMPTY_SELECTION, "g"), index, order);
    expect(inside.selectedIds).toEqual(["g1", "g2"]);
  });
});

describe("selection bounds", () => {
  it("unions the selected elements", () => {
    const bounds = selectionBounds(index, ["a", "b"])!;
    expect(bounds.rect).toEqual({ x: 0, y: 0, width: 300, height: 100 });
  });

  it("adopts a shared rotation and allows rotating", () => {
    const rotations = new Map([["a", 30], ["b", 30]]);
    const bounds = selectionBounds(index, ["a", "b"], rotations)!;
    expect(bounds.rotation).toBe(30);
    expect(bounds.canRotate).toBe(true);
  });

  it("disables rotation when rotations differ", () => {
    // Rotating a mixed set about a shared origin is ambiguous and is a common
    // source of "my layout exploded".
    const rotations = new Map([["a", 0], ["b", 45]]);
    const bounds = selectionBounds(index, ["a", "b"], rotations)!;
    expect(bounds.rotation).toBeUndefined();
    expect(bounds.canRotate).toBe(false);
  });
});

describe("selection after a patch", () => {
  it("keeps survivors, drops removals, and follows replacements", () => {
    // Without the replacement rule, an AI edit that swaps an element leaves the
    // user with nothing selected and no idea what happened.
    const state = { ...EMPTY_SELECTION, selectedIds: ["a", "b", "g"], primaryId: "b" };
    const surviving = new Set(["a", "g", "b2"]);
    const replacements = new Map([["b", "b2"]]);

    const next = remapSelection(state, surviving, replacements);
    expect(next.selectedIds).toEqual(["a", "b2", "g"]);
    expect(next.primaryId).toBe("b2");
  });

  it("clears text editing and isolation when their targets are gone", () => {
    const state = {
      ...EMPTY_SELECTION,
      selectedIds: ["g1"],
      editingTextId: "g1",
      isolationGroupId: "g",
    };
    const next = remapSelection(state, new Set(["a"]), new Map());
    expect(next.editingTextId).toBeUndefined();
    expect(next.isolationGroupId).toBeUndefined();
  });
});

describe("edit scope", () => {
  it("sends the selection when there is one", () => {
    const state = { ...EMPTY_SELECTION, selectedIds: ["a", "b"] };
    expect(editScope(state, "sld_1")).toEqual({ type: "selection", targetIds: ["a", "b"] });
  });

  it("falls back to the slide, never the presentation", () => {
    // Defaulting to the whole deck turns "make this clearer" into a deck-wide
    // rewrite nobody asked for.
    expect(editScope(EMPTY_SELECTION, "sld_1")).toEqual({ type: "slide", targetIds: ["sld_1"] });
  });
});

// ------------------------------------------------------------------ transforms

const base: Transform = { x: 100, y: 100, width: 200, height: 100 };

describe("transforms", () => {
  it("moves by a delta", () => {
    expect(move(base, { x: 10, y: -5 })).toMatchObject({ x: 110, y: 95 });
  });

  it("resizes from a corner, keeping the opposite corner fixed", () => {
    const next = resize(base, "se", { x: 50, y: 25 });
    expect(next.width).toBe(250);
    expect(next.height).toBe(125);
    // The north-west corner did not move.
    expect(next.x).toBeCloseTo(100, 1);
    expect(next.y).toBeCloseTo(100, 1);
  });

  it("resizes from the top-left, moving the origin", () => {
    const next = resize(base, "nw", { x: 20, y: 10 });
    expect(next.width).toBe(180);
    expect(next.height).toBe(90);
    expect(next.x).toBeCloseTo(120, 1);
    expect(next.y).toBeCloseTo(110, 1);
  });

  it("rounds geometry only when a gesture commits", () => {
    // Rounding every intermediate step accumulates error: a rotated element
    // resized across a hundred pointer events drifts visibly from the anchor that
    // was supposed to stay fixed.
    const messy = resize({ ...base, rotation: 33 }, "se", { x: 13.3333, y: 7.7777 });
    const committed = commitTransform(messy);

    expect(committed.x).toBe(Math.round(messy.x * 100) / 100);
    expect(String(committed.width).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("keeps the opposite corner fixed in world space while rotated", () => {
    // The classic bug: naive width += dx makes a rotated element drift as it
    // grows, because rotation happens about the centre and changing the size
    // moves the centre (doc 04 §12.3).
    const rotated: Transform = { ...base, rotation: 37 };
    const before = anchorPoint(rotated, "nw");

    const next = resize(rotated, "se", { x: 60, y: 30 });
    const after = anchorPoint(next, "nw");

    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it("keeps the anchor fixed for every handle, at every angle", () => {
    for (const angle of [0, 15, 45, 90, 137, 270, 359]) {
      const rotated: Transform = { ...base, rotation: angle };
      for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const) {
        const opposite = {
          nw: "se", n: "s", ne: "sw", e: "w", se: "nw", s: "n", sw: "ne", w: "e",
        }[handle] as "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

        const before = anchorPoint(rotated, opposite);
        const after = anchorPoint(resize(rotated, handle, { x: 25, y: 15 }), opposite);

        expect(after.x, `${handle} @ ${angle}deg`).toBeCloseTo(before.x, 3);
        expect(after.y, `${handle} @ ${angle}deg`).toBeCloseTo(before.y, 3);
      }
    }
  });

  it("keeps the aspect ratio when asked", () => {
    const next = resize(base, "se", { x: 100, y: 5 }, { uniform: true });
    expect(next.width / next.height).toBeCloseTo(base.width / base.height, 3);
  });

  it("stops at the minimum size rather than inverting", () => {
    const next = resize(base, "e", { x: -1000, y: 0 }, { elementType: "text" });
    expect(next.width).toBe(minSizeFor("text"));
  });

  it("flips a shape dragged past its opposite edge", () => {
    // Flip is negative scale, not a separate property (doc 04 §12.6).
    const next = resize(base, "e", { x: -1000, y: 0 }, { elementType: "shape" });
    expect(next.scaleX).toBe(-1);
  });

  it("never flips text", () => {
    // Mirrored glyphs are never what anyone wants.
    const next = resize(base, "e", { x: -1000, y: 0 }, { elementType: "text" });
    expect(next.scaleX ?? 1).toBe(1);
  });

  it("changes width only for a side handle on text", () => {
    const next = resize(base, "e", { x: 40, y: 40 }, { widthOnly: true });
    expect(next.width).toBe(240);
    expect(next.height).toBe(base.height);
  });

  it("resizes about the centre when asked", () => {
    const next = resize(base, "se", { x: 40, y: 20 }, { fromCenter: true });
    const centreBefore = { x: base.x + base.width / 2, y: base.y + base.height / 2 };
    const centreAfter = { x: next.x + next.width / 2, y: next.y + next.height / 2 };
    expect(centreAfter.x).toBeCloseTo(centreBefore.x, 3);
    expect(centreAfter.y).toBeCloseTo(centreBefore.y, 3);
  });
});

describe("rotation", () => {
  it("normalizes to [0, 360)", () => {
    expect(normalizeAngle(-30)).toBe(330);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(360)).toBe(0);
  });

  it("snaps to 15 degrees while shift is held", () => {
    expect(rotate({ ...base, rotation: 0 }, 7, { snap: true }).rotation).toBe(0);
    expect(rotate({ ...base, rotation: 0 }, 11, { snap: true }).rotation).toBe(15);
  });

  it("rotates a multi-selection about the selection centre", () => {
    // Rotating each element in place instead is what makes a group of objects
    // appear to scatter.
    const centre = { x: 0, y: 0 };
    // Centred on (100, 0), so a quarter turn about the origin lands it on (0, 100).
    const element: Transform = { x: 90, y: -10, width: 20, height: 20 };

    const next = rotateAbout(element, 90, centre);
    const centreOf = (t: Transform) => ({ x: t.x + t.width / 2, y: t.y + t.height / 2 });

    expect(centreOf(next).x).toBeCloseTo(0, 3);
    expect(centreOf(next).y).toBeCloseTo(100, 3);
    expect(next.rotation).toBe(90);
  });

  it("moves each element and its own angle together", () => {
    // Two elements a quarter turn apart stay a quarter turn apart.
    const centre = { x: 0, y: 0 };
    const a = rotateAbout({ x: 90, y: -10, width: 20, height: 20 }, 45, centre);
    const b = rotateAbout({ x: -10, y: 90, width: 20, height: 20 }, 45, centre);

    const distance = (t: Transform) => Math.hypot(t.x + 10, t.y + 10);
    expect(distance(a)).toBeCloseTo(100, 3);
    expect(distance(b)).toBeCloseTo(100, 3);
    expect(a.rotation).toBe(45);
    expect(b.rotation).toBe(45);
  });
});

describe("group resize", () => {
  const group: Transform = { x: 0, y: 0, width: 400, height: 200 };
  const children = [
    { id: "c1", transform: { x: 0, y: 0, width: 100, height: 50 }, type: "text", fontSize: 20 },
    { id: "c2", transform: { x: 200, y: 100, width: 100, height: 50 }, type: "shape" },
  ];

  it("scaleChildren multiplies geometry and type size", () => {
    const result = resizeGroup({ group, next: { width: 800, height: 400 }, mode: "scaleChildren", children });
    expect(result.children[0]!.transform.width).toBe(200);
    expect(result.children[0]!.fontSize).toBe(40);
  });

  it("scales type by the smaller axis so glyphs are never stretched", () => {
    // Scaling text by both axes independently produces stretched glyphs, which
    // looks like a rendering bug rather than a resize (doc 04 §12.4).
    const result = resizeGroup({ group, next: { width: 800, height: 200 }, mode: "scaleChildren", children });
    expect(result.children[0]!.transform.width).toBe(200);
    expect(result.children[0]!.fontSize).toBe(20);
  });

  it("resizeContainer leaves children alone for the container to re-lay out", () => {
    const result = resizeGroup({ group, next: { width: 800, height: 400 }, mode: "resizeContainer", children });
    expect(result.group.width).toBe(800);
    expect(result.children[0]!.transform).toEqual(children[0]!.transform);
  });
});

describe("world bounds", () => {
  it("expands under rotation", () => {
    const square: Transform = { x: 0, y: 0, width: 100, height: 100, rotation: 45 };
    expect(worldBounds(square).width).toBeCloseTo(141.42, 1);
  });
});

// ------------------------------------------------------------------- snapping

const slide: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

describe("snapping", () => {
  const lines = collectSnapLines({
    slide,
    safeArea: { top: 80, right: 120, bottom: 80, left: 120 },
    neighbours: [{ id: "n", bounds: { x: 500, y: 300, width: 200, height: 100 } }],
  });

  it("snaps a near-miss to the slide centre", () => {
    // Positioned so the element's own centre is the nearest candidate: at
    // x = 905 the centre is 5px from the slide centre while both edges are 45px
    // or more away. Any edge may snap, so the test has to be unambiguous about
    // which one it expects.
    const rect: Rect = { x: 905, y: 500, width: 100, height: 50 };
    const result = snapRect(rect, lines, { zoom: 1 });

    expect(rect.x + result.delta.x + 50).toBeCloseTo(960, 1);
    expect(result.guides.some((g) => g.kind === "slideCenter")).toBe(true);
  });

  it("snaps whichever edge is nearest, not only the centre", () => {
    const rect: Rect = { x: 955, y: 500, width: 100, height: 50 };
    const result = snapRect(rect, lines, { zoom: 1 });
    // Left edge is 5px from the slide centre line; it wins over the centre at 45px.
    expect(rect.x + result.delta.x).toBeCloseTo(960, 1);
  });

  it("ignores candidates beyond the threshold", () => {
    const rect: Rect = { x: 300, y: 700, width: 100, height: 50 };
    expect(snapRect(rect, lines, { zoom: 1 }).delta).toEqual({ x: 0, y: 0 });
  });

  it("keeps the threshold constant on screen as zoom changes", () => {
    // A fixed world-space threshold snaps from a mile away when zoomed out and is
    // unusable when zoomed in.
    const rect: Rect = { x: 0, y: 0, width: 100, height: 50 };
    const near: Rect = { ...rect, x: 20 };

    // At 25% zoom, 20 world px is 5 screen px — inside the 8px threshold.
    expect(snapRect(near, [{ axis: "x", position: 0, kind: "slideEdge" }], { zoom: 0.25 }).delta.x).toBeCloseTo(-20, 1);
    // At 100% it is 20 screen px — outside it.
    expect(snapRect(near, [{ axis: "x", position: 0, kind: "slideEdge" }], { zoom: 1 }).delta.x).toBe(0);
  });

  it("applies at most one candidate per axis", () => {
    // Applying two means the second overrides the first and the element lands
    // where neither guide showed.
    const crowded = [
      { axis: "x" as const, position: 100, kind: "neighbourEdge" as const },
      { axis: "x" as const, position: 103, kind: "neighbourCenter" as const },
    ];
    const result = snapRect({ x: 101, y: 0, width: 50, height: 50 }, crowded, { zoom: 1 });
    expect(result.guides.filter((g) => g.axis === "x")).toHaveLength(1);
  });

  it("prefers the slide centre over a neighbour on the same line", () => {
    const tied = [
      { axis: "x" as const, position: 960, kind: "neighbourEdge" as const },
      { axis: "x" as const, position: 960, kind: "slideCenter" as const },
    ];
    const result = snapRect({ x: 958, y: 0, width: 0, height: 0 }, tied, { zoom: 1 });
    expect(result.guides[0]!.kind).toBe("slideCenter");
  });

  it("does nothing when snapping is disabled", () => {
    const rect: Rect = { x: 955, y: 500, width: 100, height: 50 };
    const result = snapRect(rect, lines, { zoom: 1, disabled: true });
    expect(result.delta).toEqual({ x: 0, y: 0 });
    expect(result.guides).toEqual([]);
  });

  it("snaps to the grid only when nothing better claimed the axis", () => {
    const result = snapRect({ x: 103, y: 205, width: 50, height: 50 }, [], {
      zoom: 1,
      gridEnabled: true,
      gridUnit: 8,
    });
    expect(result.delta.x).toBeCloseTo(1, 1);
    expect(result.guides.every((g) => g.kind === "grid")).toBe(true);
  });

  it("never shows more than four guides", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      axis: (i % 2 === 0 ? "x" : "y") as "x" | "y",
      position: i,
      kind: "neighbourEdge" as const,
    }));
    expect(snapRect({ x: 0, y: 0, width: 10, height: 10 }, many, { zoom: 1 }).guides.length).toBeLessThanOrEqual(4);
  });
});

describe("equal spacing", () => {
  it("finds a position that equalizes the gaps", () => {
    const left: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const right: Rect = { x: 500, y: 0, width: 100, height: 100 };
    const dragged: Rect = { x: 245, y: 0, width: 100, height: 100 };

    const found = findEqualSpacing(dragged, [left, right], "x", 20)!;
    expect(dragged.x + found.delta).toBeCloseTo(250, 1);
    expect(found.guide.gap).toBeCloseTo(150, 1);
  });

  it("ignores neighbours that are not in the same row", () => {
    // Otherwise "equal spacing" relates elements that are nowhere near each other.
    const left: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const right: Rect = { x: 500, y: 900, width: 100, height: 100 };
    const dragged: Rect = { x: 245, y: 0, width: 100, height: 100 };

    expect(findEqualSpacing(dragged, [left, right], "x", 20)).toBeUndefined();
  });
});

describe("drag modifiers", () => {
  it("constrains to the axis of greatest movement, measured over the gesture", () => {
    // Using the last frame's delta makes the axis flip whenever the pointer wobbles.
    expect(constrainToAxis({ x: 100, y: 12 })).toEqual({ x: 100, y: 0 });
    expect(constrainToAxis({ x: 8, y: -60 })).toEqual({ x: 0, y: -60 });
  });

  it("nudges one pixel, or one grid unit with shift", () => {
    expect(nudgeDistance(false)).toBe(1);
    expect(nudgeDistance(true, 8)).toBe(8);
  });
});

// -------------------------------------------------------------- spatial index

describe("spatial index", () => {
  const items = [
    { id: "a", bounds: { x: 0, y: 0, width: 100, height: 100 } },
    { id: "b", bounds: { x: 500, y: 500, width: 100, height: 100 } },
    { id: "c", bounds: { x: 520, y: 520, width: 100, height: 100 } },
  ];

  it("finds what intersects a rectangle", () => {
    const spatial = new SpatialIndex();
    spatial.rebuild(items);
    expect(spatial.search({ x: 490, y: 490, width: 50, height: 50 })).toEqual(["b", "c"]);
  });

  it("excludes the dragged element so it cannot snap to itself", () => {
    // It would match at zero distance on every axis, and therefore never move.
    const spatial = new SpatialIndex();
    spatial.rebuild(items);
    spatial.exclude("b");
    expect(spatial.search({ x: 490, y: 490, width: 50, height: 50 })).toEqual(["c"]);

    spatial.include("b");
    expect(spatial.search({ x: 490, y: 490, width: 50, height: 50 })).toEqual(["b", "c"]);
  });

  it("returns a stable order, so identical frames pick the same candidates", () => {
    const spatial = new SpatialIndex();
    spatial.rebuild(items);
    const query = { x: 0, y: 0, width: 2000, height: 2000 };
    expect(spatial.search(query)).toEqual(spatial.search(query));
  });

  it("updates and removes", () => {
    const spatial = new SpatialIndex();
    spatial.rebuild(items);

    spatial.update("a", { x: 1000, y: 1000, width: 50, height: 50 });
    expect(spatial.search({ x: 0, y: 0, width: 200, height: 200 })).toEqual([]);
    expect(spatial.search({ x: 990, y: 990, width: 100, height: 100 })).toEqual(["a"]);

    spatial.remove("a");
    expect(spatial.search({ x: 990, y: 990, width: 100, height: 100 })).toEqual([]);
  });

  it("finds the nearest within a radius, closest first", () => {
    const spatial = new SpatialIndex();
    spatial.rebuild(items);
    expect(spatial.nearest({ x: 505, y: 505 }, 40)[0]).toBe("b");
  });
});

describe("hit testing", () => {
  it("keeps tolerance constant on screen", () => {
    expect(hitTolerance(1)).toBe(6);
    expect(hitTolerance(0.5)).toBe(12);
    expect(hitTolerance(2)).toBe(3);
  });

  it("tests a point against an ellipse, not its bounding box", () => {
    const rect: Rect = { x: 0, y: 0, width: 100, height: 100 };
    expect(pointInEllipse({ x: 50, y: 50 }, rect)).toBe(true);
    // A corner is inside the box but outside the ellipse.
    expect(pointInEllipse({ x: 2, y: 2 }, rect)).toBe(false);
  });

  it("measures distance to a polyline, for connectors", () => {
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    expect(distanceToPolyline({ x: 50, y: 5 }, line)).toBeCloseTo(5, 3);
    expect(distanceToPolyline({ x: 150, y: 0 }, line)).toBeCloseTo(50, 3);
  });
});

// ------------------------------------------------------------------ clipboard

const doc: PresentationDocument = loadFixture("technical");
const slideId = doc.slides[0]!.id;
const elementId = doc.slides[0]!.elements[0]!.id;

describe("clipboard", () => {
  it("pastes with fresh ids", () => {
    // Reusing ids makes the paste indistinguishable from the original to every
    // animation target and connector, and duplicate ids are error E001.
    const payload = copy(doc, [elementId])!;
    const { operations, elementIds } = paste(doc, payload, { targetSlideId: slideId });
    const after = applyPatch(doc, operations).document;

    expect(elementIds[0]).not.toBe(elementId);
    expect(resolveElementById(after, elementIds[0]!)).toBeDefined();
    expect(resolveElementById(after, elementId)).toBeDefined();
  });

  it("offsets a paste into the same slide, so the copy is visible", () => {
    const payload = copy(doc, [elementId])!;
    const { operations, elementIds } = paste(doc, payload, { targetSlideId: slideId });
    const after = applyPatch(doc, operations).document;

    const original = resolveElementById(doc, elementId)!.element;
    const copyOf = resolveElementById(after, elementIds[0]!)!.element;

    expect(copyOf.transform.x).toBe(original.transform.x + 24);
    expect(copyOf.transform.y).toBe(original.transform.y + 24);
  });

  it("copies a group with all of its children, once", () => {
    const kpiSlide = doc.slides[1]!;
    const group = kpiSlide.elements.find((e) => isGroup(e))!;
    const child = (group as { children: { id: string }[] }).children[0]!;

    // Copying a group and one of its children must not paste the child twice.
    const payload = copy(doc, [group.id, child.id])!;
    expect(payload.elements).toHaveLength(1);

    const { operations } = paste(doc, payload, { targetSlideId: kpiSlide.id });
    const after = applyPatch(doc, operations).document;

    const originalCount = [...walkElements(kpiSlide.elements)].length;
    const afterCount = [...walkElements(after.slides[1]!.elements)].length;
    const groupSize = [...walkElements([group])].length;

    expect(afterCount).toBe(originalCount + groupSize);
  });

  it("gives every nested child a fresh id too", () => {
    const kpiSlide = doc.slides[1]!;
    const group = kpiSlide.elements.find((e) => isGroup(e))!;
    const originalIds = new Set([...walkElements([group])].map(({ element }) => element.id));

    const payload = copy(doc, [group.id])!;
    const { operations, elementIds } = paste(doc, payload, { targetSlideId: kpiSlide.id });
    const after = applyPatch(doc, operations).document;

    const pasted = resolveElementById(after, elementIds[0]!)!.element;
    for (const { element } of walkElements([pasted])) {
      expect(originalIds.has(element.id)).toBe(false);
    }
  });

  it("pastes into another slide without an offset", () => {
    const payload = copy(doc, [elementId])!;
    const target = doc.slides[2]!.id;
    const { operations, elementIds } = paste(doc, payload, { targetSlideId: target });
    const after = applyPatch(doc, operations).document;

    const original = resolveElementById(doc, elementId)!.element;
    const copyOf = resolveElementById(after, elementIds[0]!)!.element;
    expect(copyOf.transform.x).toBe(original.transform.x);
    expect(resolveElementById(after, elementIds[0]!)!.slide.id).toBe(target);
  });

  it("duplicates in one step", () => {
    const { operations, elementIds } = duplicate(doc, [elementId]);
    const after = applyPatch(doc, operations).document;
    expect(resolveElementById(after, elementIds[0]!)).toBeDefined();
  });

  it("produces operations that undo cleanly", () => {
    // Everything goes through the one mutation path, so paste is undoable for free.
    const { operations } = duplicate(doc, [elementId]);
    const forward = applyPatch(doc, operations);
    const back = applyPatch(forward.document, forward.inverse);
    expect(JSON.stringify(back.document)).toBe(JSON.stringify(doc));
  });
});

// ------------------------------------------------------------------- keyboard

describe("keyboard", () => {
  it("resolves plain and modified shortcuts", () => {
    expect(resolveCommand({ key: "Backspace" })?.command).toBe("delete");
    expect(resolveCommand({ key: "d", metaKey: true })?.command).toBe("duplicate");
    expect(resolveCommand({ key: "z", ctrlKey: true })?.command).toBe("undo");
  });

  it("does not let a less specific binding swallow a more specific one", () => {
    // Cmd+Shift+Z must not match the Cmd+Z binding, which is what happens when a
    // handler tests modifiers loosely.
    expect(resolveCommand({ key: "z", metaKey: true, shiftKey: true })?.command).toBe("redo");
    expect(resolveCommand({ key: "z", metaKey: true, altKey: true })?.command).toBe("undoLastAgentChange");
    expect(resolveCommand({ key: "g", metaKey: true, shiftKey: true })?.command).toBe("ungroup");
  });

  it("ignores keys with no binding", () => {
    expect(resolveCommand({ key: "q" })).toBeUndefined();
  });

  it("has no duplicate bindings", () => {
    const seen = new Set<string>();
    for (const binding of [...(BINDINGS_FOR_TEST as typeof BINDINGS_FOR_TEST)]) {
      const signature = [binding.key.toLowerCase(), binding.mod, binding.shift, binding.alt].join("|");
      expect(seen.has(signature), `duplicate binding for ${signature}`).toBe(false);
      seen.add(signature);
    }
  });

  it("blocks destructive shortcuts while typing", () => {
    // Otherwise typing "d" in a text box duplicates the element — the classic way
    // an editor feels broken the first time someone writes a sentence in it.
    expect(isAllowedWhileTyping("duplicate")).toBe(false);
    expect(isAllowedWhileTyping("delete")).toBe(false);
    // A text field's own undo and clipboard, not the deck's.
    expect(isAllowedWhileTyping("undo")).toBe(false);
    expect(isAllowedWhileTyping("paste")).toBe(false);
    expect(isAllowedWhileTyping("escape")).toBe(true);
  });

  it("describes a binding for a help panel", () => {
    const duplicateBinding = { key: "d", mod: true, command: "duplicate" as const, label: "Duplicate" };
    expect(describeBinding(duplicateBinding, "mac")).toBe("⌘D");
    expect(describeBinding(duplicateBinding, "other")).toBe("Ctrl+D");
  });
});

// Imported separately so the duplicate check reads naturally above.
import { BINDINGS as BINDINGS_FOR_TEST } from "../src/keyboard";

describe("threshold constants", () => {
  it("snapping is 8 screen pixels", () => {
    expect(SNAP_THRESHOLD).toBe(8);
  });
});
