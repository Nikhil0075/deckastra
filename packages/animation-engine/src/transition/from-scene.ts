/**
 * A rendered slide, reduced to what a transition needs from it.
 *
 * The only file in this module that knows a renderer exists. The engine's own
 * types are deliberately minimal — an id, a type, a box, a few identity signals —
 * so pairing and deltas can be tested with object literals and could be driven
 * by something that is not this renderer. This is the adapter that keeps that
 * true, rather than a `SceneNode` import in five files.
 *
 * Two things it does that are not a rename:
 *
 * - **It flattens nested nodes.** A morph pairs the things an audience sees, and
 *   an element inside a group is one of those. Pairing only the roots would
 *   refuse to move a card's heading because its parent happens to be a group.
 * - **It reads identity out of the render payload.** The words in a text node
 *   and the asset behind an image are the strongest signals two elements are the
 *   same object, and both live in the payload rather than on the node.
 */

import type { SceneNode, SlideScene } from "@deckastra/renderer";

import type { TransitionNode, TransitionSlide } from "./types";

function textOf(node: SceneNode): string | undefined {
  const payload = node.renderPayload as { kind?: string; blocks?: unknown[] };
  if (payload?.kind !== "text" || !Array.isArray(payload.blocks)) return undefined;

  const spans: string[] = [];
  for (const block of payload.blocks as { spans?: { text?: unknown }[] }[]) {
    for (const span of block?.spans ?? []) {
      if (typeof span?.text === "string") spans.push(span.text);
    }
  }
  const text = spans.join(" ").trim();
  return text.length > 0 ? text : undefined;
}

function assetOf(node: SceneNode): string | undefined {
  const payload = node.renderPayload as { kind?: string; storageKey?: unknown; assetId?: unknown };
  if (payload?.kind !== "image") return undefined;
  // `storageKey` identifies the bytes; `assetId` only identifies the row. Two
  // elements pointing at one uploaded image are the same picture even when they
  // were placed separately.
  if (typeof payload.storageKey === "string") return payload.storageKey;
  return typeof payload.assetId === "string" ? payload.assetId : undefined;
}

/**
 * The node's rotation, in degrees, read out of its world matrix.
 *
 * `bounds` is axis-aligned post-rotation, so it cannot answer this — a rotated
 * element's box says nothing about the angle that produced it. `full` match mode
 * interpolates rotation, and without this every morph would quietly un-rotate to
 * zero and rotate back.
 */
function rotationOf(node: SceneNode): number | undefined {
  const { a, b } = node.worldTransform ?? { a: 1, b: 0 };
  if (a === 1 && b === 0) return undefined;
  return (Math.atan2(b, a) * 180) / Math.PI;
}

/**
 * A text node's type size and the world point its words hang from.
 *
 * The anchor is the alignment edge — left, centre or right; top, middle or
 * bottom — because that is what holds still when a text box is resized, and so
 * what a morph has to carry from one slide to the other.
 */
function typeOf(node: SceneNode): { fontSize?: number; anchor?: { x: number; y: number } } {
  const payload = node.renderPayload as {
    kind?: string;
    metrics?: { appliedFontSize?: number };
    align?: string;
    verticalAlign?: string;
  };
  if (payload?.kind !== "text") return {};
  const fontSize = payload.metrics?.appliedFontSize;
  if (typeof fontSize !== "number" || fontSize <= 0) return {};
  const { x, y, width, height } = node.bounds;
  const align = payload.align ?? "left";
  const vertical = payload.verticalAlign ?? "top";
  const ax = align === "center" ? x + width / 2 : align === "right" || align === "end" ? x + width : x;
  const ay = vertical === "middle" || vertical === "center" ? y + height / 2 : vertical === "bottom" ? y + height : y;
  return { fontSize, anchor: { x: ax, y: ay } };
}

function flatten(nodes: readonly SceneNode[], out: TransitionNode[], parentId?: string): void {
  for (const node of nodes) {
    out.push({
      ...typeOf(node),
      parentId,
      id: node.id,
      type: node.type,
      semanticRole: node.semanticRole,
      bounds: {
        x: node.bounds.x,
        y: node.bounds.y,
        width: node.bounds.width,
        height: node.bounds.height,
      },
      text: textOf(node),
      assetKey: assetOf(node),
      opacity: node.resolvedStyle?.opacity,
      rotation: rotationOf(node),
    });
    if (node.children?.length) flatten(node.children, out, node.id);
  }
}

export function transitionSlideFromScene(scene: SlideScene): TransitionSlide {
  const nodes: TransitionNode[] = [];
  flatten(scene.nodes, nodes);
  return { id: scene.slideId, nodes };
}
