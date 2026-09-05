import {
  isGroup,
  walkElements,
  type PresentationDocument,
  type PresentationElement,
} from "@deckastra/presentation-schema";

/**
 * Reference integrity (doc 05 §10).
 *
 * The schema's validator checks a whole document. This checks the things that
 * specifically break when a document is *edited*: deleting an element that an
 * animation targets, moving one out of the group its constraint referenced,
 * duplicating a slide without remapping ids.
 *
 * It runs after a patch and before a commit, which is the moment a broken
 * reference is still cheap to reject.
 */

export interface BrokenReference {
  /** Catalog code from doc 02 §42, so callers route on the same rule ids. */
  code: string;
  /** What holds the dangling reference. */
  holder: string;
  /** The id that no longer resolves. */
  missing: string;
  path: string;
  message: string;
  /** Whether the document is unusable, or merely degraded. */
  severity: "error" | "warning";
}

export function validateReferences(document: PresentationDocument): BrokenReference[] {
  const problems: BrokenReference[] = [];

  const elementIds = new Set<string>();
  const slideIds = new Set(document.slides.map((slide) => slide.id));
  const assetIds = new Set(document.assets.map((asset) => asset.id));
  const componentIds = new Set(document.components.map((component) => component.id));
  const dataSourceIds = new Set(document.dataSources.map((source) => source.id));

  for (const slide of document.slides) {
    for (const { element } of walkElements(slide.elements)) elementIds.add(element.id);
  }

  for (const slide of document.slides) {
    const base = `/slides/id:${slide.id}`;

    for (const track of slide.animations ?? []) {
      if (!elementIds.has(track.targetId)) {
        problems.push({
          code: "E101",
          holder: track.id,
          missing: track.targetId,
          path: `${base}/animations/id:${track.id}/targetId`,
          message: `Animation targets element "${track.targetId}", which no longer exists.`,
          severity: "error",
        });
      }
    }

    for (const interaction of slide.interactions ?? []) {
      if (interaction.action.type === "goToSlide" && !slideIds.has(interaction.action.slideId)) {
        problems.push({
          code: "E105",
          holder: interaction.id,
          missing: interaction.action.slideId,
          path: `${base}/interactions/id:${interaction.id}`,
          message: `Interaction jumps to slide "${interaction.action.slideId}", which no longer exists.`,
          severity: "error",
        });
      }
    }

    for (const mapping of slide.transition?.sharedElements ?? []) {
      for (const key of ["sourceElementId", "destinationElementId"] as const) {
        if (!elementIds.has(mapping[key])) {
          problems.push({
            code: "E104",
            holder: slide.id,
            missing: mapping[key],
            path: `${base}/transition/sharedElements`,
            message: `Morph pairing references element "${mapping[key]}", which no longer exists.`,
            severity: "error",
          });
        }
      }
    }

    for (const { element } of walkElements(slide.elements)) {
      problems.push(
        ...checkElement(element, {
          base: `${base}/elements/id:${element.id}`,
          elementIds,
          assetIds,
          componentIds,
          dataSourceIds,
        }),
      );
    }
  }

  return problems;
}

interface CheckContext {
  base: string;
  elementIds: ReadonlySet<string>;
  assetIds: ReadonlySet<string>;
  componentIds: ReadonlySet<string>;
  dataSourceIds: ReadonlySet<string>;
}

const RESERVED_CONSTRAINT_TARGETS = new Set(["slide", "safeArea", "parent"]);

function checkElement(element: PresentationElement, ctx: CheckContext): BrokenReference[] {
  const problems: BrokenReference[] = [];

  if (element.type === "image") {
    const assetId = (element as { assetId?: string }).assetId;
    if (assetId && !ctx.assetIds.has(assetId)) {
      problems.push({
        code: "E102",
        holder: element.id,
        missing: assetId,
        path: `${ctx.base}/assetId`,
        message: `Image references asset "${assetId}", which is not in the manifest.`,
        severity: "error",
      });
    }
  }

  if (element.type === "componentInstance") {
    const componentId = (element as { componentId?: string }).componentId;
    if (componentId && !ctx.componentIds.has(componentId)) {
      problems.push({
        code: "E107",
        holder: element.id,
        missing: componentId,
        path: `${ctx.base}/componentId`,
        message: `Instance references component "${componentId}", which no longer exists.`,
        severity: "error",
      });
    }
  }

  if (element.type === "line") {
    for (const end of ["from", "to"] as const) {
      const endpoint = (element as Record<string, unknown>)[end];
      if (endpoint && typeof endpoint === "object" && "elementId" in endpoint) {
        const anchor = endpoint as { elementId: string };
        if (!ctx.elementIds.has(anchor.elementId)) {
          // A warning, not an error. Deleting a node must never silently delete
          // its connectors — the user loses work they did not ask to lose
          // (doc 02 §14.2). The endpoint falls back to its last point.
          problems.push({
            code: "W105",
            holder: element.id,
            missing: anchor.elementId,
            path: `${ctx.base}/${end}`,
            message:
              `Connector was anchored to "${anchor.elementId}", which has been deleted. ` +
              `The endpoint keeps its last position; re-attach it or move it.`,
            severity: "warning",
          });
        }
      }
    }
  }

  if (element.type === "diagram") {
    const nodes = (element as { nodes?: { id: string }[] }).nodes ?? [];
    const edges = (element as { edges?: { id: string; from: string; to: string }[] }).edges ?? [];
    const nodeIds = new Set(nodes.map((node) => node.id));

    for (const edge of edges) {
      for (const end of ["from", "to"] as const) {
        if (!nodeIds.has(edge[end])) {
          problems.push({
            code: "E106",
            holder: edge.id,
            missing: edge[end],
            path: `${ctx.base}/edges/id:${edge.id}/${end}`,
            message: `Diagram edge ${end} "${edge[end]}" is not a node in this diagram.`,
            severity: "error",
          });
        }
      }
    }
  }

  if (element.type === "chart") {
    const data = (element as { data?: { type: string; elementId?: string; sourceId?: string } }).data;
    if (data?.type === "table" && data.elementId && !ctx.elementIds.has(data.elementId)) {
      problems.push({
        code: "E110",
        holder: element.id,
        missing: data.elementId,
        path: `${ctx.base}/data/elementId`,
        message: `Chart is driven by table "${data.elementId}", which no longer exists.`,
        severity: "error",
      });
    }
    if (data?.type === "dataSource" && data.sourceId && !ctx.dataSourceIds.has(data.sourceId)) {
      problems.push({
        code: "E108",
        holder: element.id,
        missing: data.sourceId,
        path: `${ctx.base}/data/sourceId`,
        message: `Chart reads data source "${data.sourceId}", which no longer exists.`,
        severity: "error",
      });
    }
  }

  for (const constraint of element.constraints ?? []) {
    const target =
      "targetId" in constraint
        ? constraint.targetId
        : "containerId" in constraint
          ? constraint.containerId
          : undefined;

    if (target && !RESERVED_CONSTRAINT_TARGETS.has(target) && !ctx.elementIds.has(target)) {
      problems.push({
        code: "E103",
        holder: element.id,
        missing: target,
        path: `${ctx.base}/constraints`,
        message: `Constraint references "${target}", which no longer exists.`,
        severity: "error",
      });
    }
  }

  for (const binding of element.bindings ?? []) {
    if (!ctx.dataSourceIds.has(binding.sourceId)) {
      problems.push({
        code: "E108",
        holder: element.id,
        missing: binding.sourceId,
        path: `${ctx.base}/bindings`,
        message: `Binding reads data source "${binding.sourceId}", which no longer exists.`,
        severity: "error",
      });
    }
  }

  return problems;
}

/**
 * Operations that clean up references a deletion would strand.
 *
 * Called *before* the deletion so the whole thing commits as one transaction:
 * deleting an element and orphaning its animation in two separate steps leaves a
 * window where the document is invalid, and an undo of only the first half is
 * worse than either.
 */
export function cleanupOperationsForDeletion(
  document: PresentationDocument,
  elementIds: readonly string[],
): { path: string; op: "remove" }[] {
  const doomed = new Set(elementIds);

  // Deleting a group deletes its children, so they count as doomed too.
  for (const slide of document.slides) {
    for (const { element } of walkElements(slide.elements)) {
      if (!doomed.has(element.id) || !isGroup(element)) continue;
      for (const { element: child } of walkElements(element.children)) doomed.add(child.id);
    }
  }

  const operations: { path: string; op: "remove" }[] = [];

  for (const slide of document.slides) {
    const base = `/slides/id:${slide.id}`;

    for (const track of slide.animations ?? []) {
      if (doomed.has(track.targetId)) {
        operations.push({ op: "remove", path: `${base}/animations/id:${track.id}` });
      }
    }

    for (const interaction of slide.interactions ?? []) {
      const trigger = interaction.trigger as { targetId?: string };
      const action = interaction.action as { targetId?: string };
      if (
        (trigger.targetId && doomed.has(trigger.targetId)) ||
        (action.targetId && doomed.has(action.targetId))
      ) {
        operations.push({ op: "remove", path: `${base}/interactions/id:${interaction.id}` });
      }
    }
  }

  return operations;
}
