import type {
  ContainerLayout,
  GroupElement,
  Insets,
  PresentationElement,
  Rect,
} from "@deckastra/presentation-schema";

/**
 * Container layout resolution — pipeline stage 6 (doc 04 §6.1, §15.3).
 *
 * This is the mechanism that keeps generated content robust. Four KPI cards
 * emitted as a horizontal container survive a longer label; the same four emitted
 * as absolute boxes overlap. It is also why the Layout Agent is told to emit a
 * container for anything repeated (doc 04 §15.4).
 *
 * Children's `x`/`y` become **advisory** while a container lays out (doc 02
 * §16.2) — retained in the document so pulling a child out restores a sensible
 * position, ignored here.
 */

export interface LayoutBox {
  id: string;
  /** Position within the container's coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContainerResult {
  children: LayoutBox[];
  /** Size the container needs to hold its children, including padding. */
  contentWidth: number;
  contentHeight: number;
  overflow: boolean;
}

const NO_PADDING: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

function padding(layout: ContainerLayout, fallback?: Insets): Insets {
  return layout.padding ?? fallback ?? NO_PADDING;
}

function gaps(layout: ContainerLayout, base: number): { row: number; column: number } {
  const gap = layout.gap ?? base;
  return { row: layout.rowGap ?? gap, column: layout.columnGap ?? gap };
}

export interface ResolveContainerInput {
  layout: ContainerLayout;
  /** The container's own box. */
  box: { width: number; height: number };
  /** Children at their natural sizes, in document order. */
  children: { id: string; width: number; height: number }[];
  /** Default gap, from `theme.spacing.base`. */
  baseGap?: number;
  padding?: Insets;
}

/**
 * Lay out a container's children.
 *
 * Pure and deterministic: same inputs, same boxes, every time. Document order is
 * the only ordering authority — no sorting by size, no `Object.keys()`.
 */
export function resolveContainer(input: ResolveContainerInput): ContainerResult {
  const { layout, box, children } = input;
  const pad = padding(layout, input.padding);
  const gap = gaps(layout, input.baseGap ?? 8);

  const inner = {
    width: Math.max(0, box.width - pad.left - pad.right),
    height: Math.max(0, box.height - pad.top - pad.bottom),
  };

  switch (layout.type) {
    case "horizontal":
      return axis(input, "horizontal", inner, pad, gap.column);
    case "vertical":
      return axis(input, "vertical", inner, pad, gap.row);
    case "grid":
      return grid(input, inner, pad, gap);
    case "stack":
      return stack(input, inner, pad);
    case "free":
    default:
      // The escape hatch: children keep their authored positions.
      return {
        children: children.map((child) => ({
          id: child.id,
          x: 0,
          y: 0,
          width: child.width,
          height: child.height,
        })),
        contentWidth: box.width,
        contentHeight: box.height,
        overflow: false,
      };
  }
}

function axis(
  input: ResolveContainerInput,
  direction: "horizontal" | "vertical",
  inner: { width: number; height: number },
  pad: Insets,
  gap: number,
): ContainerResult {
  const { layout, children } = input;
  const horizontal = direction === "horizontal";

  const mainOf = (c: { width: number; height: number }) => (horizontal ? c.width : c.height);
  const crossOf = (c: { width: number; height: number }) => (horizontal ? c.height : c.width);
  const mainSpace = horizontal ? inner.width : inner.height;
  const crossSpace = horizontal ? inner.height : inner.width;

  const count = children.length;
  if (count === 0) {
    return { children: [], contentWidth: pad.left + pad.right, contentHeight: pad.top + pad.bottom, overflow: false };
  }

  const totalGap = gap * (count - 1);

  // "equal" divides the main axis evenly, which is what makes a row of cards a
  // row of cards rather than a row of differently-sized cards.
  const equal = layout.distribute === "equal";
  const sizes = equal
    ? children.map(() => Math.max(0, (mainSpace - totalGap) / count))
    : children.map(mainOf);

  const used = sizes.reduce((sum, size) => sum + size, 0) + totalGap;
  const slack = mainSpace - used;

  let cursor = 0;
  let between = gap;

  switch (layout.justify) {
    case "center":
      cursor = slack / 2;
      break;
    case "end":
      cursor = slack;
      break;
    case "spaceBetween":
      between = count > 1 ? gap + slack / (count - 1) : gap;
      break;
    case "spaceAround": {
      const unit = slack / (count * 2);
      cursor = unit;
      between = gap + unit * 2;
      break;
    }
    case "spaceEvenly": {
      const unit = slack / (count + 1);
      cursor = unit;
      between = gap + unit;
      break;
    }
    default:
      break;
  }

  const boxes: LayoutBox[] = [];

  for (let i = 0; i < count; i += 1) {
    const child = children[i]!;
    const main = sizes[i]!;
    const naturalCross = crossOf(child);

    // "stretch" fills the cross axis; everything else keeps the natural size and
    // positions within it.
    const cross = layout.align === "stretch" ? crossSpace : naturalCross;
    let crossOffset = 0;
    if (layout.align === "center") crossOffset = (crossSpace - cross) / 2;
    else if (layout.align === "end") crossOffset = crossSpace - cross;

    boxes.push({
      id: child.id,
      x: round(pad.left + (horizontal ? cursor : crossOffset)),
      y: round(pad.top + (horizontal ? crossOffset : cursor)),
      width: round(horizontal ? main : cross),
      height: round(horizontal ? cross : main),
    });

    cursor += main + between;
  }

  const contentMain = used;
  const contentCross = Math.max(0, ...children.map(crossOf));

  return {
    children: boxes,
    contentWidth: round(pad.left + pad.right + (horizontal ? contentMain : contentCross)),
    contentHeight: round(pad.top + pad.bottom + (horizontal ? contentCross : contentMain)),
    overflow: used > mainSpace + 0.5,
  };
}

function grid(
  input: ResolveContainerInput,
  inner: { width: number; height: number },
  pad: Insets,
  gap: { row: number; column: number },
): ContainerResult {
  const { layout, children } = input;
  const columns = Math.max(1, layout.columns ?? Math.ceil(Math.sqrt(children.length || 1)));
  const rows = Math.ceil(children.length / columns);

  const cellWidth = (inner.width - gap.column * (columns - 1)) / columns;

  // Row heights come from the tallest child in each row, so a grid of cards with
  // different amounts of text still aligns.
  const rowHeights: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    const slice = children.slice(row * columns, (row + 1) * columns);
    rowHeights.push(Math.max(0, ...slice.map((child) => child.height)));
  }

  const boxes: LayoutBox[] = [];
  let y = pad.top;

  for (let row = 0; row < rows; row += 1) {
    let x = pad.left;
    for (let column = 0; column < columns; column += 1) {
      const child = children[row * columns + column];
      if (!child) break;

      const height = layout.align === "stretch" ? rowHeights[row]! : child.height;
      boxes.push({
        id: child.id,
        x: round(x),
        y: round(y),
        width: round(cellWidth),
        height: round(height),
      });
      x += cellWidth + gap.column;
    }
    y += rowHeights[row]! + gap.row;
  }

  const contentHeight =
    rowHeights.reduce((sum, height) => sum + height, 0) + gap.row * Math.max(0, rows - 1);

  return {
    children: boxes,
    contentWidth: round(pad.left + pad.right + inner.width),
    contentHeight: round(pad.top + pad.bottom + contentHeight),
    overflow: contentHeight > inner.height + 0.5,
  };
}

/** Every child fills the container and overlaps — a scrim over an image, a badge
 *  on a card (doc 02 §21.1). */
function stack(
  input: ResolveContainerInput,
  inner: { width: number; height: number },
  pad: Insets,
): ContainerResult {
  const boxes = input.children.map((child) => {
    const width = input.layout.align === "stretch" ? inner.width : child.width;
    const height = input.layout.align === "stretch" ? inner.height : child.height;

    let x = pad.left;
    let y = pad.top;
    if (input.layout.align === "center") {
      x += (inner.width - width) / 2;
      y += (inner.height - height) / 2;
    }

    return { id: child.id, x: round(x), y: round(y), width: round(width), height: round(height) };
  });

  return {
    children: boxes,
    contentWidth: round(pad.left + pad.right + inner.width),
    contentHeight: round(pad.top + pad.bottom + inner.height),
    overflow: false,
  };
}

/** Persist geometry rounded to 2 decimals (doc 04 §4.4) — float noise produces
 *  spurious diffs and transactions. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isContainer(element: PresentationElement): element is GroupElement {
  if (element.type !== "group") return false;
  const layout = (element as GroupElement).containerLayout;
  return layout !== undefined && layout.type !== "free";
}

/** Bounds of a set of boxes, for sizing a container to its content. */
export function unionBounds(boxes: readonly LayoutBox[]): Rect {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
