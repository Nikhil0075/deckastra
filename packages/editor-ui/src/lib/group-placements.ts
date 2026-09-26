import type { GroupElement, PresentationElement } from "@deckastra/presentation-schema";
import { flattenScene, type SlideScene } from "@deckastra/renderer";

/**
 * Where a container layout actually put each child of `group`, in the group's
 * local space — read back from the scene, which is where layout runs (pipeline
 * stage 6).
 *
 * Inside a container a child's own `x`/`y` are advisory (doc 02 §16.2), so
 * ungrouping by those would move every card's contents to wherever they were
 * before the container took over. Undefined for a free group, whose children's
 * coordinates are authoritative and need no help.
 */
export function containerPlacements(
  group: GroupElement,
  slideScene: SlideScene | undefined,
): Map<string, { x: number; y: number; width: number; height: number }> | undefined {
  const layout = group.containerLayout as { type?: string } | undefined;
  if (!layout || layout.type === "free" || !slideScene) return undefined;

  const nodes = new Map(flattenScene(slideScene).map((node) => [node.id, node]));
  const placements = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const child of group.children as PresentationElement[]) {
    const node = nodes.get(child.id);
    if (!node) continue;
    const { width, height } = node.localBounds;
    const ox = width * (child.transform.originX ?? 0.5);
    const oy = height * (child.transform.originY ?? 0.5);
    const m = node.localTransform;
    // Inverting the renderer's `localMatrix` for its translation: e = x + ox − (a·ox + c·oy).
    placements.set(child.id, {
      x: round(m.e - ox + m.a * ox + m.c * oy),
      y: round(m.f - oy + m.b * ox + m.d * oy),
      width,
      height,
    });
  }
  return placements;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
