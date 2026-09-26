import { isGroup, type PresentationElement, type Rect, type Slide } from "@deckastra/presentation-schema";

/**
 * Selection (doc 04 §10).
 *
 * Selection is editor state and never touches the document (doc 02 §4.1): two
 * people opening the same deck must not fight over what is selected.
 *
 * It is also the bridge to agent edits (doc 01 §7.3) — when an AI request is
 * issued, `selectedIds` becomes an explicit `EditScope`, which is what stops an
 * agent guessing at the intended target.
 */

export interface SelectionState {
  selectedIds: string[];
  /** Last clicked. Drives the inspector and is the align-to target. */
  primaryId?: string;
  editingTextId?: string;
  /** The "entered" group; clicks resolve within it. */
  isolationGroupId?: string;
  hoverId?: string;
  /** World space, live during a marquee drag. */
  marquee?: Rect;
}

export const EMPTY_SELECTION: SelectionState = { selectedIds: [] };

/** What the selection model needs to know about an element. */
export interface SelectableNode {
  id: string;
  parentId?: string;
  isGroup: boolean;
  locked: boolean;
  hidden: boolean;
  /**
   * World space, like `marquee` and everything else the selection model
   * compares against. A child of a group carries its transform in the group's
   * local space, so callers building the index must add the accumulated parent
   * origin — otherwise a grouped element hit-tests and draws its selection box
   * at the slide origin instead of where it is on screen.
   */
  bounds: Rect;
  /**
   * The accumulated origin of this node's parents in world space. Add it to a
   * local transform to get world coordinates; subtract it from a world
   * coordinate to get the value that belongs in the document. Absent means
   * `{ x: 0, y: 0 }` — a top-level element, where the two spaces coincide.
   */
  offset?: { x: number; y: number };
}

export type NodeIndex = ReadonlyMap<string, SelectableNode>;

export function buildIndex(nodes: readonly SelectableNode[]): NodeIndex {
  return new Map(nodes.map((node) => [node.id, node]));
}

/**
 * Flatten a slide into selectable nodes, in document order.
 *
 * The whole point of doing this here rather than inline in the canvas is the
 * offset accumulation: an element's `transform` is local to its parent group,
 * while every consumer of a `SelectableNode` — hit testing, the marquee, the
 * spatial index, the selection overlay — works in world space. Publishing local
 * coordinates as if they were world coordinates puts a grouped element's
 * selection box at the slide origin.
 */
export function buildSelectableNodes(slide: Slide): SelectableNode[] {
  const out: SelectableNode[] = [];

  const walk = (
    elements: readonly PresentationElement[],
    parentId: string | undefined,
    offset: { x: number; y: number },
  ): void => {
    for (const element of elements) {
      const t = element.transform;
      out.push({
        id: element.id,
        parentId,
        isGroup: isGroup(element),
        locked: element.locked === true,
        hidden: element.visible === false,
        bounds: { x: offset.x + t.x, y: offset.y + t.y, width: t.width, height: t.height },
        offset,
      });

      if (isGroup(element)) {
        walk(element.children, element.id, { x: offset.x + t.x, y: offset.y + t.y });
      }
    }
  };

  walk(slide.elements, undefined, { x: 0, y: 0 });
  return out;
}

function ancestorsOf(index: NodeIndex, id: string): string[] {
  const chain: string[] = [];
  let cursor = index.get(id)?.parentId;

  while (cursor) {
    chain.push(cursor);
    cursor = index.get(cursor)?.parentId;
  }

  return chain;
}

/**
 * Group click resolution (doc 04 §10.2).
 *
 * Clicking a node inside a group selects the group; double-clicking enters it and
 * subsequent clicks select children. This is the behaviour every design tool has,
 * and getting it wrong makes nested content feel impossible to touch.
 */
export function resolveClickTarget(
  index: NodeIndex,
  hitId: string,
  options: { isolationGroupId?: string; deep?: boolean } = {},
): string | undefined {
  const hit = index.get(hitId);
  if (!hit || hit.hidden) return undefined;

  // Alt-click bypasses group resolution entirely and takes the deepest node.
  if (options.deep) return hit.locked ? undefined : hitId;

  const ancestors = ancestorsOf(index, hitId);
  const isolationIndex = options.isolationGroupId
    ? ancestors.indexOf(options.isolationGroupId)
    : -1;

  // Only consider ancestors *inside* the isolation scope. Without this, clicking
  // a child of an entered group re-selects the group you just entered.
  const candidates = isolationIndex === -1 ? ancestors : ancestors.slice(0, isolationIndex);

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = index.get(candidates[i]!);
    if (candidate?.isGroup && !candidate.locked && !candidate.hidden) return candidate.id;
  }

  return hit.locked ? undefined : hitId;
}

export interface ClickOptions {
  /** Shift: toggle membership. */
  additive?: boolean;
  /** Alt/Option: select the deepest child. */
  deep?: boolean;
}

export function click(
  state: SelectionState,
  index: NodeIndex,
  hitId: string | undefined,
  options: ClickOptions = {},
): SelectionState {
  if (hitId === undefined) {
    // A click on empty canvas clears the selection but stays inside the group the
    // user entered — leaving isolation on every stray click makes nested editing
    // maddening.
    return { ...EMPTY_SELECTION, isolationGroupId: state.isolationGroupId };
  }

  const target = resolveClickTarget(index, hitId, {
    isolationGroupId: state.isolationGroupId,
    deep: options.deep,
  });
  if (target === undefined) return state;

  if (options.additive) {
    const selected = new Set(state.selectedIds);
    if (selected.has(target)) {
      selected.delete(target);
      const remaining = [...selected];
      return {
        ...state,
        selectedIds: remaining,
        primaryId: remaining.at(-1),
        editingTextId: undefined,
      };
    }
    return {
      ...state,
      selectedIds: [...state.selectedIds, target],
      primaryId: target,
      editingTextId: undefined,
    };
  }

  return { ...state, selectedIds: [target], primaryId: target, editingTextId: undefined };
}

export interface MarqueeOptions {
  /** Alt: require full containment rather than intersection. */
  contained?: boolean;
  additive?: boolean;
}

export function marqueeSelect(
  state: SelectionState,
  index: NodeIndex,
  rect: Rect,
  options: MarqueeOptions = {},
): SelectionState {
  const scope = state.isolationGroupId;
  const hits: string[] = [];

  for (const node of index.values()) {
    // Locked and hidden elements are not marquee-selectable (doc 04 §10.1);
    // locked ones remain reachable through the layers panel.
    if (node.locked || node.hidden) continue;
    if (!inScope(index, node, scope)) continue;

    const inside = options.contained
      ? containsRect(rect, node.bounds)
      : intersectsRect(rect, node.bounds);
    if (inside) hits.push(node.id);
  }

  // Resolve each hit to what a click would select, so a marquee over a group's
  // children selects the group rather than its parts.
  const resolved = new Set<string>();
  for (const id of hits) {
    const target = resolveClickTarget(index, id, { isolationGroupId: scope });
    if (target) resolved.add(target);
  }

  const next = options.additive
    ? [...new Set([...state.selectedIds, ...resolved])]
    : [...resolved];

  return { ...state, selectedIds: next, primaryId: next.at(-1), marquee: undefined };
}

/** True when a node is a direct or indirect child of the isolation scope. */
function inScope(index: NodeIndex, node: SelectableNode, scope: string | undefined): boolean {
  if (!scope) return node.parentId === undefined;
  return node.parentId === scope || ancestorsOf(index, node.id).includes(scope);
}

export function enterGroup(state: SelectionState, groupId: string): SelectionState {
  return { ...state, isolationGroupId: groupId, selectedIds: [], primaryId: undefined };
}

/**
 * Escape backs out one level at a time (doc 04 §10.1).
 *
 * Text edit, then isolation, then selection. Collapsing these into one action
 * makes Escape unpredictable — the user cannot tell what they are about to lose.
 */
export function escape(state: SelectionState, index: NodeIndex): SelectionState {
  if (state.editingTextId) return { ...state, editingTextId: undefined };

  if (state.isolationGroupId) {
    const group = index.get(state.isolationGroupId);
    return {
      ...state,
      isolationGroupId: group?.parentId,
      // Leaving a group selects it, which is where the user's attention already is.
      selectedIds: state.isolationGroupId ? [state.isolationGroupId] : [],
      primaryId: state.isolationGroupId,
    };
  }

  if (state.selectedIds.length > 0) return { ...EMPTY_SELECTION };
  return state;
}

/** Siblings within the current isolation scope, in document order. */
export function siblingsInScope(
  index: NodeIndex,
  order: readonly string[],
  scope: string | undefined,
): string[] {
  return order.filter((id) => {
    const node = index.get(id);
    if (!node || node.hidden || node.locked) return false;
    return node.parentId === scope;
  });
}

/** Tab / Shift+Tab cycle siblings within the current scope. */
export function cycleSelection(
  state: SelectionState,
  index: NodeIndex,
  order: readonly string[],
  direction: 1 | -1,
): SelectionState {
  const siblings = siblingsInScope(index, order, state.isolationGroupId);
  if (siblings.length === 0) return state;

  const current = state.primaryId ? siblings.indexOf(state.primaryId) : -1;
  const next = siblings[(current + direction + siblings.length) % siblings.length]!;

  return { ...state, selectedIds: [next], primaryId: next, editingTextId: undefined };
}

/**
 * Whether Tab should leave the canvas rather than cycle (editor Phase 8).
 *
 * Tab walks the objects on the slide, and past the last one (Shift+Tab: before
 * the first) it hands focus on to the next control instead of wrapping. A cycle
 * that wraps forever is a keyboard trap: nothing on the canvas is ever the last
 * stop, so nothing after it can be reached. The selection is left as it is, so
 * the inspector after the canvas edits the object Tab ended on.
 */
export function cycleLeavesScope(
  state: SelectionState,
  index: NodeIndex,
  order: readonly string[],
  direction: 1 | -1,
): boolean {
  const siblings = siblingsInScope(index, order, state.isolationGroupId);
  if (siblings.length === 0) return true;
  const current = state.primaryId ? siblings.indexOf(state.primaryId) : -1;
  // Nothing selected: Tab enters at the first object, Shift+Tab goes back out.
  if (current < 0) return direction === -1;
  return direction === 1 ? current === siblings.length - 1 : current === 0;
}

export function selectAll(
  state: SelectionState,
  index: NodeIndex,
  order: readonly string[],
): SelectionState {
  const ids = siblingsInScope(index, order, state.isolationGroupId);
  return { ...state, selectedIds: ids, primaryId: ids.at(-1) };
}

export interface SelectionBounds {
  rect: Rect;
  /** Shared rotation, when every selected element agrees on one. */
  rotation?: number;
  /** False when rotations differ — rotating a mixed set about a shared origin is
   *  ambiguous and is a common source of "my layout exploded". */
  canRotate: boolean;
}

export function selectionBounds(
  index: NodeIndex,
  selectedIds: readonly string[],
  rotations: ReadonlyMap<string, number> = new Map(),
): SelectionBounds | undefined {
  const nodes = selectedIds
    .map((id) => index.get(id))
    .filter((node): node is SelectableNode => node !== undefined);

  if (nodes.length === 0) return undefined;

  const minX = Math.min(...nodes.map((n) => n.bounds.x));
  const minY = Math.min(...nodes.map((n) => n.bounds.y));
  const maxX = Math.max(...nodes.map((n) => n.bounds.x + n.bounds.width));
  const maxY = Math.max(...nodes.map((n) => n.bounds.y + n.bounds.height));

  const angles = nodes.map((node) => rotations.get(node.id) ?? 0);
  const shared = angles.every((angle) => Math.abs(angle - angles[0]!) < 0.01);

  return {
    rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    rotation: shared ? angles[0] : undefined,
    canRotate: shared || nodes.length === 1,
  };
}

/**
 * Remap selection after a patch (doc 04 §10.4).
 *
 * Ids that survive stay selected; ids that were removed drop out; and an element
 * added with `metadata.replacesId` pointing at a dropped id inherits its
 * selection. Without the last rule, an AI edit that swaps an element leaves the
 * user with nothing selected and no idea what happened.
 */
export function remapSelection(
  state: SelectionState,
  survivingIds: ReadonlySet<string>,
  replacements: ReadonlyMap<string, string>,
): SelectionState {
  const next: string[] = [];

  for (const id of state.selectedIds) {
    if (survivingIds.has(id)) {
      next.push(id);
      continue;
    }
    const replacement = replacements.get(id);
    if (replacement && survivingIds.has(replacement)) next.push(replacement);
  }

  const primary =
    state.primaryId && survivingIds.has(state.primaryId)
      ? state.primaryId
      : state.primaryId
        ? replacements.get(state.primaryId)
        : undefined;

  return {
    ...state,
    selectedIds: next,
    primaryId: primary && survivingIds.has(primary) ? primary : next.at(-1),
    editingTextId:
      state.editingTextId && survivingIds.has(state.editingTextId)
        ? state.editingTextId
        : undefined,
    isolationGroupId:
      state.isolationGroupId && survivingIds.has(state.isolationGroupId)
        ? state.isolationGroupId
        : undefined,
  };
}

/**
 * The scope to send with an AI request (doc 04 §10.4).
 *
 * An empty selection means the slide, never the presentation — defaulting to the
 * whole deck turns "make this clearer" into a deck-wide rewrite nobody asked for.
 */
export function editScope(
  state: SelectionState,
  slideId: string,
): { type: "selection" | "slide"; targetIds: string[] } {
  if (state.selectedIds.length > 0) {
    return { type: "selection", targetIds: [...state.selectedIds] };
  }
  return { type: "slide", targetIds: [slideId] };
}

function intersectsRect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}
