import type {
  ConstraintPriority,
  Insets,
  LayoutConstraint,
  Rect,
} from "@deckastra/presentation-schema";

/**
 * Constraint resolution (doc 04 §16).
 *
 * A dependency-ordered single-pass evaluator, not a general solver. That is a
 * deliberate MVP choice: bounded iteration guarantees termination and predictable
 * cost, and the constraint *schema* is solver-agnostic, so swapping in Cassowary
 * later does not touch `.mydeck`.
 *
 * Three determinism rules, all of which have bitten real layout engines:
 *
 * * Evaluation order is document array order, never `Object.keys()` order.
 * * Topological ties break on element id, lexicographically, not insertion time.
 * * Geometry is recomputed from the base each pass — never accumulated across
 *   passes, which drifts.
 */

export const MAX_ITERATIONS = 3;

const PRIORITY_RANK: Record<ConstraintPriority, number> = {
  required: 3,
  strong: 2,
  medium: 1,
  weak: 0,
};

export interface ConstrainedElement {
  id: string;
  /** Base geometry, before constraints. */
  rect: Rect;
  constraints?: readonly LayoutConstraint[];
  /** Minimum size, so a constraint cannot collapse an element to nothing. */
  minWidth?: number;
  minHeight?: number;
}

export interface ConstraintContext {
  slide: Rect;
  safeArea?: Rect;
  /** Container rect for elements whose constraints reference "parent". */
  parent?: Rect;
}

export interface ConstraintWarning {
  code: "cycle-broken" | "unresolved-target" | "not-converged" | "conflicting-required";
  elementId: string;
  message: string;
  droppedConstraint?: LayoutConstraint;
}

export interface ConstraintResult {
  rects: Map<string, Rect>;
  warnings: ConstraintWarning[];
  /** Constraints dropped to break a cycle, so the UI can explain the suspension. */
  brokenConstraintIds: string[];
  iterations: number;
}

function targetOf(constraint: LayoutConstraint): string | undefined {
  if ("targetId" in constraint) return constraint.targetId;
  if ("containerId" in constraint) return constraint.containerId;
  if (constraint.type === "anchor") return constraint.anchor;
  return undefined;
}

const RESERVED = new Set(["slide", "safeArea", "parent"]);

/**
 * Tarjan's strongly-connected components.
 *
 * A cycle means two elements each want to be positioned relative to the other.
 * There is no correct answer, so one constraint has to go — and *which* one must
 * be predictable, which is what priorities are for (doc 02 §20.2). Without them
 * the choice is arbitrary and the user cannot be told why their rule stopped
 * applying.
 */
function findCycles(
  elements: readonly ConstrainedElement[],
  edges: ReadonlyMap<string, Set<string>>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let counter = 0;

  // Iterative rather than recursive: a deep dependency chain would blow the stack
  // on a document that is otherwise perfectly legal.
  const order = elements.map((element) => element.id);

  for (const root of order) {
    if (index.has(root)) continue;

    const work: { node: string; children: string[]; cursor: number }[] = [
      { node: root, children: [...(edges.get(root) ?? [])].sort(), cursor: 0 },
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;

      if (frame.cursor < frame.children.length) {
        const child = frame.children[frame.cursor]!;
        frame.cursor += 1;

        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, children: [...(edges.get(child) ?? [])].sort(), cursor: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);

        if (component.length > 1) components.push(component.sort());
      }
    }
  }

  return components;
}

function topologicalOrder(
  elements: readonly ConstrainedElement[],
  edges: ReadonlyMap<string, Set<string>>,
): string[] {
  const incoming = new Map<string, number>();
  const known = new Set(elements.map((element) => element.id));

  for (const element of elements) incoming.set(element.id, 0);
  for (const [from, targets] of edges) {
    if (!known.has(from)) continue;
    for (const target of targets) {
      if (known.has(target)) incoming.set(from, (incoming.get(from) ?? 0) + 1);
    }
  }

  // Dependencies first: an element is ready once everything it references is
  // placed. Ties break lexicographically so the order is reproducible.
  const ready = elements
    .filter((element) => (incoming.get(element.id) ?? 0) === 0)
    .map((element) => element.id)
    .sort();

  const dependents = new Map<string, string[]>();
  for (const [from, targets] of edges) {
    for (const target of targets) {
      if (!known.has(target)) continue;
      dependents.set(target, [...(dependents.get(target) ?? []), from]);
    }
  }

  const order: string[] = [];
  const queue = [...ready];

  while (queue.length > 0) {
    queue.sort();
    const id = queue.shift()!;
    order.push(id);

    for (const dependent of (dependents.get(id) ?? []).sort()) {
      const remaining = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  // Anything left is in a cycle that was not broken; append in document order so
  // it is still evaluated rather than silently dropped.
  for (const element of elements) {
    if (!order.includes(element.id)) order.push(element.id);
  }

  return order;
}

function applyInsets(rect: Rect, insets: Insets): Rect {
  return {
    x: rect.x + insets.left,
    y: rect.y + insets.top,
    width: Math.max(0, rect.width - insets.left - insets.right),
    height: Math.max(0, rect.height - insets.top - insets.bottom),
  };
}

export function resolveConstraints(
  elements: readonly ConstrainedElement[],
  context: ConstraintContext,
): ConstraintResult {
  const warnings: ConstraintWarning[] = [];
  const brokenConstraintIds: string[] = [];
  const suppressed = new Set<string>();

  const edges = new Map<string, Set<string>>();
  for (const element of elements) {
    const targets = new Set<string>();
    for (const constraint of element.constraints ?? []) {
      const target = targetOf(constraint);
      if (target && !RESERVED.has(target)) targets.add(target);
    }
    edges.set(element.id, targets);
  }

  const known = new Set(elements.map((element) => element.id));
  for (const element of elements) {
    for (const constraint of element.constraints ?? []) {
      const target = targetOf(constraint);
      if (target && !RESERVED.has(target) && !known.has(target)) {
        warnings.push({
          code: "unresolved-target",
          elementId: element.id,
          message: `Constraint references "${target}", which is not on this slide. Skipped.`,
          droppedConstraint: constraint,
        });
        suppressed.add(constraintKey(element.id, constraint));
      }
    }
  }

  for (const cycle of findCycles(elements, edges)) {
    const victim = lowestPriorityIn(cycle, elements);
    if (victim) {
      suppressed.add(victim.key);
      brokenConstraintIds.push(victim.key);
      warnings.push({
        code: "cycle-broken",
        elementId: victim.elementId,
        message:
          `These elements constrain each other (${cycle.join(", ")}), which has no solution. ` +
          `The lowest-priority rule on "${victim.elementId}" was suspended.`,
        droppedConstraint: victim.constraint,
      });
      edges.get(victim.elementId)?.delete(targetOf(victim.constraint) ?? "");
    } else {
      // Every constraint in the cycle is `required`, so none may be dropped
      // (doc 02 §20.2). That is a document error, not something to resolve
      // silently.
      warnings.push({
        code: "conflicting-required",
        elementId: cycle[0]!,
        message:
          `Required constraints on ${cycle.join(", ")} conflict irreconcilably. ` +
          `Lower the priority of one of them.`,
      });
    }
  }

  const order = topologicalOrder(elements, edges);
  const byId = new Map(elements.map((element) => [element.id, element]));

  let rects = new Map<string, Rect>(elements.map((element) => [element.id, { ...element.rect }]));
  let iterations = 0;

  for (let pass = 0; pass < MAX_ITERATIONS; pass += 1) {
    iterations = pass + 1;

    // Recompute from the base every pass. Accumulating across passes drifts, and
    // a drift that only appears after three passes is close to undebuggable.
    const next = new Map<string, Rect>(
      elements.map((element) => [element.id, { ...element.rect }]),
    );

    for (const id of order) {
      const element = byId.get(id);
      if (!element) continue;

      let rect = next.get(id)!;

      for (const constraint of element.constraints ?? []) {
        if (suppressed.has(constraintKey(id, constraint))) continue;
        rect = applyConstraint(rect, constraint, {
          resolve: (targetId) => resolveTarget(targetId, next, rects, context),
          context,
        });
      }

      rect = clamp(rect, element);
      next.set(id, rect);
    }

    const stable = [...next].every(([id, rect]) => rectsEqual(rect, rects.get(id)!));
    rects = next;
    if (stable) break;

    if (pass === MAX_ITERATIONS - 1) {
      warnings.push({
        code: "not-converged",
        elementId: order[0] ?? "",
        message:
          `Constraints did not settle after ${MAX_ITERATIONS} passes. ` +
          `The last result is used; check for rules that depend on each other's size.`,
      });
    }
  }

  return { rects, warnings, brokenConstraintIds, iterations };
}

function constraintKey(elementId: string, constraint: LayoutConstraint): string {
  return `${elementId}:${constraint.type}:${targetOf(constraint) ?? ""}`;
}

function lowestPriorityIn(
  cycle: readonly string[],
  elements: readonly ConstrainedElement[],
): { key: string; elementId: string; constraint: LayoutConstraint } | undefined {
  const members = new Set(cycle);
  let best: { key: string; elementId: string; constraint: LayoutConstraint; rank: number } | undefined;

  // Document order, so the same cycle always loses the same constraint.
  for (const element of elements) {
    if (!members.has(element.id)) continue;
    for (const constraint of element.constraints ?? []) {
      const target = targetOf(constraint);
      if (!target || !members.has(target)) continue;

      const rank = PRIORITY_RANK[constraint.priority ?? "strong"];
      if (rank === PRIORITY_RANK.required) continue;
      if (!best || rank < best.rank) {
        best = { key: constraintKey(element.id, constraint), elementId: element.id, constraint, rank };
      }
    }
  }

  return best;
}

function resolveTarget(
  targetId: string,
  current: ReadonlyMap<string, Rect>,
  previous: ReadonlyMap<string, Rect>,
  context: ConstraintContext,
): Rect | undefined {
  if (targetId === "slide") return context.slide;
  if (targetId === "safeArea") return context.safeArea ?? context.slide;
  if (targetId === "parent") return context.parent ?? context.slide;
  // Prefer this pass's value; fall back to the previous pass for a forward
  // reference the topological sort could not order.
  return current.get(targetId) ?? previous.get(targetId);
}

interface ApplyContext {
  resolve: (targetId: string) => Rect | undefined;
  context: ConstraintContext;
}

function applyConstraint(rect: Rect, constraint: LayoutConstraint, ctx: ApplyContext): Rect {
  switch (constraint.type) {
    case "align": {
      const target = ctx.resolve(constraint.targetId);
      if (!target) return rect;
      const offset = constraint.offset ?? 0;

      switch (constraint.axis) {
        case "left":
          return { ...rect, x: target.x + offset };
        case "right":
          return { ...rect, x: target.x + target.width - rect.width + offset };
        case "centerX":
          return { ...rect, x: target.x + (target.width - rect.width) / 2 + offset };
        case "top":
          return { ...rect, y: target.y + offset };
        case "bottom":
          return { ...rect, y: target.y + target.height - rect.height + offset };
        case "centerY":
          return { ...rect, y: target.y + (target.height - rect.height) / 2 + offset };
        default:
          return rect;
      }
    }

    case "distance": {
      const target = ctx.resolve(constraint.targetId);
      if (!target) return rect;

      const targetEdge = constraint.targetEdge ?? oppositeEdge(constraint.edge);
      const anchor = edgeValue(target, targetEdge);
      const current = edgeValue(rect, constraint.edge);

      /*
       * `value` is the gap between this element's `edge` and the target's
       * `targetEdge`, measured outward from the target.
       *
       * A "start" edge (left/top) sits after the anchor, so the gap adds; an
       * "end" edge (right/bottom) sits before it, so the gap subtracts. Reading
       * it the other way round puts a caption above its image instead of below.
       *
       *   my top    from target bottom -> targetBottom + value   (I am below)
       *   my bottom from target top    -> targetTop    - value   (I am above)
       *   my left   from target right  -> targetRight  + value   (I am right of)
       *   my left   from target left   -> targetLeft   + value   (a plain offset)
       */
      const outward = constraint.edge === "left" || constraint.edge === "top" ? 1 : -1;
      const desired = anchor + constraint.value * outward;

      // Positive when the element is on the expected side of the anchor.
      const gap = (current - anchor) * outward;

      // "min" and "max" are limits, not pins: they only move the element when the
      // gap is on the wrong side of the value.
      if (constraint.relation === "min" && gap >= constraint.value) return rect;
      if (constraint.relation === "max" && gap <= constraint.value) return rect;

      const delta = desired - current;
      return constraint.edge === "left" || constraint.edge === "right"
        ? { ...rect, x: round(rect.x + delta) }
        : { ...rect, y: round(rect.y + delta) };
    }

    case "anchor": {
      const target = ctx.resolve(constraint.anchor);
      if (!target) return rect;
      const inner = applyInsets(target, constraint.insets);
      const edges = new Set(constraint.edges);

      let { x, y, width, height } = rect;

      // Opposite edges pinned together means the element stretches; one edge
      // alone means it moves.
      if (edges.has("left") && edges.has("right")) {
        x = inner.x;
        width = inner.width;
      } else if (edges.has("left")) {
        x = inner.x;
      } else if (edges.has("right")) {
        x = inner.x + inner.width - width;
      }

      if (edges.has("top") && edges.has("bottom")) {
        y = inner.y;
        height = inner.height;
      } else if (edges.has("top")) {
        y = inner.y;
      } else if (edges.has("bottom")) {
        y = inner.y + inner.height - height;
      }

      return { x, y, width, height };
    }

    case "containment": {
      const container = ctx.resolve(constraint.containerId);
      if (!container) return rect;
      const inner = constraint.padding ? applyInsets(container, constraint.padding) : container;

      return {
        ...rect,
        x: Math.min(Math.max(rect.x, inner.x), Math.max(inner.x, inner.x + inner.width - rect.width)),
        y: Math.min(Math.max(rect.y, inner.y), Math.max(inner.y, inner.y + inner.height - rect.height)),
      };
    }

    case "equalSize": {
      const target = ctx.resolve(constraint.targetId);
      if (!target) return rect;
      return {
        ...rect,
        width: constraint.axis === "height" ? rect.width : target.width,
        height: constraint.axis === "width" ? rect.height : target.height,
      };
    }

    case "aspectRatio": {
      // Width is authoritative; height follows. Choosing the other way round makes
      // a ratio constraint fight autoHeight text on every pass.
      return { ...rect, height: rect.width / constraint.ratio };
    }

    default:
      return rect;
  }
}

function oppositeEdge(edge: "left" | "right" | "top" | "bottom"): "left" | "right" | "top" | "bottom" {
  switch (edge) {
    case "left":
      return "right";
    case "right":
      return "left";
    case "top":
      return "bottom";
    case "bottom":
      return "top";
  }
}

function edgeValue(rect: Rect, edge: "left" | "right" | "top" | "bottom"): number {
  switch (edge) {
    case "left":
      return rect.x;
    case "right":
      return rect.x + rect.width;
    case "top":
      return rect.y;
    case "bottom":
      return rect.y + rect.height;
  }
}

function clamp(rect: Rect, element: ConstrainedElement): Rect {
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(Math.max(element.minWidth ?? 1, rect.width)),
    height: round(Math.max(element.minHeight ?? 1, rect.height)),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function rectsEqual(a: Rect, b: Rect): boolean {
  const EPSILON = 0.01;
  return (
    Math.abs(a.x - b.x) < EPSILON &&
    Math.abs(a.y - b.y) < EPSILON &&
    Math.abs(a.width - b.width) < EPSILON &&
    Math.abs(a.height - b.height) < EPSILON
  );
}
