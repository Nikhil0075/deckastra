import { expect, it } from "vitest";
import { findEqualSpacing, snapRectWithSpacing, type SnapLine } from "../src/snapping";

const rect = { x: 246, y: 100, width: 100, height: 100 };
const neighbours = [{ x: 100, y: 100, width: 100, height: 100 }, { x: 400, y: 100, width: 100, height: 100 }];

it("rejects overlapping boxes rather than drawing negative gaps", () => {
  expect(findEqualSpacing({ x: 45, y: 0, width: 100, height: 100 }, [
    { x: 0, y: 0, width: 100, height: 100 }, { x: 90, y: 0, width: 100, height: 100 },
  ], "x", 8)).toBeUndefined();
});

it("chooses the nearer of alignment and spacing and draws only the winner", () => {
  const line: SnapLine = { axis: "x", position: 249, kind: "neighbourEdge" };
  expect(snapRectWithSpacing(rect, [line], neighbours, { zoom: 1 }).spacingGuides).toEqual([]);
  const spaced = snapRectWithSpacing(rect, [{ ...line, position: 253 }], neighbours, { zoom: 1 });
  expect(spaced.delta.x).toBe(4);
  expect(spaced.guides).toEqual([]);
  expect(spaced.spacingGuides[0]!.between[1]!.x).toBe(250);
});

it("preserves alignment priority on ties and uses a screen-space threshold", () => {
  const line: SnapLine = { axis: "x", position: 250, kind: "slideCenter" };
  expect(snapRectWithSpacing(rect, [line], neighbours, { zoom: 1 }).spacingGuides).toEqual([]);
  expect(snapRectWithSpacing(rect, [], neighbours, { zoom: 4 }).spacingGuides).toEqual([]);
  expect(snapRectWithSpacing(rect, [], neighbours, { zoom: 2 }).spacingGuides).toHaveLength(1);
});

it("supports vertical spacing and disabled snapping", () => {
  const transpose = (r: typeof rect) => ({ x: r.y, y: r.x, width: r.height, height: r.width });
  const result = snapRectWithSpacing(transpose(rect), [], neighbours.map(transpose), { zoom: 1 });
  expect(result.delta.y).toBe(4);
  expect(result.spacingGuides[0]!.gap).toBe(50);
  expect(snapRectWithSpacing(rect, [], neighbours, { zoom: 1, disabled: true }).spacingGuides).toEqual([]);
});
