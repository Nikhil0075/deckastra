import {
  isGroup,
  newId,
  plainText,
  walkElements,
  type IdPrefix,
  type PatchOperation,
  type PresentationDocument,
  type PresentationElement,
  type Slide,
} from "@deckastra/presentation-schema";

import {
  containerPath,
  elementPath,
  resolveElementById,
  resolveSlideById,
  slidePath,
} from "./find";

/**
 * Document operations (doc 05 §10).
 *
 * Every operation here returns `PatchOperation[]` rather than a modified
 * document. That is the central design decision in this package, and it is worth
 * stating why:
 *
 * * A returned document would be a *second* way to change a deck, alongside the
 *   patch path agents use. Two mutation paths means two places for undo,
 *   validation, provenance and autosave to be wired up, and one of them will
 *   eventually be missed.
 * * With one path, "add a text box" from the toolbar and "add a text box" from an
 *   agent are literally the same operations — which is what makes doc 01 §4.7's
 *   "human and AI editing are equal citizens" true rather than aspirational.
 * * Everything becomes undoable and auditable for free, because
 *   `@deckastra/transactions` computes the inverse of whatever it is handed.
 *
 * `createPresentation` is the exception: there is no document yet to patch.
 */

export class OperationError extends Error {
  readonly code: string;

  constructor(message: string, code = "E301") {
    super(message);
    this.name = "OperationError";
    this.code = code;
  }
}

// ------------------------------------------------------------------- creation

export interface CreatePresentationInput {
  title: string;
  theme: PresentationDocument["theme"];
  schemaVersion: string;
  audience?: string;
  objective?: string;
  viewport?: PresentationDocument["viewport"];
  now?: () => Date;
}

const DEFAULT_VIEWPORT: PresentationDocument["viewport"] = {
  width: 1920,
  height: 1080,
  unit: "px",
  aspectRatio: "16:9",
  safeArea: { top: 80, right: 120, bottom: 80, left: 120 },
};

/**
 * A new, empty presentation.
 *
 * Zero slides is valid (doc 02 §4.2) — a new project genuinely has none, and
 * inventing a blank first slide means every caller has to decide whether to keep
 * it.
 */
export function createPresentation(input: CreatePresentationInput): PresentationDocument {
  const now = (input.now ?? (() => new Date()))().toISOString().replace(/\.\d+Z$/, "Z");

  return {
    schemaVersion: input.schemaVersion,
    id: newId("doc"),
    metadata: {
      title: input.title,
      language: "en",
      ...(input.audience ? { audience: input.audience } : {}),
      ...(input.objective ? { objective: input.objective } : {}),
    },
    viewport: input.viewport ?? DEFAULT_VIEWPORT,
    theme: input.theme,
    slides: [],
    assets: [],
    components: [],
    dataSources: [],
    variables: {},
    createdAt: now,
    updatedAt: now,
  };
}

export interface CreateSlideInput {
  name?: string;
  semanticIntent?: string;
  keyMessage?: string;
  /** Insert before this index. Appends when omitted. */
  atIndex?: number;
  elements?: PresentationElement[];
}

export function createSlide(
  document: PresentationDocument,
  input: CreateSlideInput = {},
): { operations: PatchOperation[]; slide: Slide } {
  const slide: Slide = {
    id: newId("sld"),
    elements: input.elements ?? [],
    ...(input.name ? { name: input.name } : {}),
    ...(input.semanticIntent ? { semanticIntent: input.semanticIntent } : {}),
    ...(input.keyMessage ? { keyMessage: input.keyMessage } : {}),
  };

  const path =
    input.atIndex === undefined ? "/slides/-" : `/slides/${clampIndex(input.atIndex, document.slides.length)}`;

  return { operations: [{ op: "add", path, value: slide }], slide };
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Math.trunc(index), length));
}

// -------------------------------------------------------------------- slides

export function removeSlide(
  document: PresentationDocument,
  slideId: string,
): PatchOperation[] {
  requireSlide(document, slideId);
  return [{ op: "remove", path: slidePath(slideId) }];
}

/**
 * Move a slide to a new position.
 *
 * A single `move`, not a remove plus an add. The difference matters for undo:
 * one operation inverts to one operation, while a remove/add pair inverts to two
 * that must be replayed in the right order against the right intermediate state.
 */
export function moveSlide(
  document: PresentationDocument,
  slideId: string,
  toIndex: number,
): PatchOperation[] {
  const { index } = requireSlide(document, slideId);
  const target = clampIndex(toIndex, document.slides.length - 1);
  if (target === index) return [];

  return [{ op: "move", from: slidePath(slideId), path: `/slides/${target}` }];
}

export function cloneSlide(
  document: PresentationDocument,
  slideId: string,
  options: { atIndex?: number } = {},
): { operations: PatchOperation[]; slide: Slide } {
  const { slide, index } = requireSlide(document, slideId);

  // Fresh ids throughout. Reusing them would make the copy indistinguishable
  // from the original to every animation target, constraint and provenance
  // record in the document — duplicate ids are error E001 for exactly this
  // reason.
  const copy = withFreshIds(slide);
  copy.name = slide.name ? `${slide.name} copy` : undefined;
  if (!copy.name) delete copy.name;

  const at = options.atIndex ?? index + 1;
  return {
    operations: [{ op: "add", path: `/slides/${clampIndex(at, document.slides.length)}`, value: copy }],
    slide: copy,
  };
}

/**
 * Deep-copy a slide with new ids everywhere, rewriting internal references.
 *
 * The rewrite is the part that is easy to forget: an animation track pointing at
 * the *original* element id would leave the duplicated slide animating its
 * neighbour's contents.
 */
export function withFreshIds(slide: Slide): Slide {
  const copy = structuredClone(slide) as Slide;
  const remap = new Map<string, string>();

  const remapId = (oldId: string, prefix: IdPrefix): string => {
    const existing = remap.get(oldId);
    if (existing) return existing;
    const fresh = newId(prefix);
    remap.set(oldId, fresh);
    return fresh;
  };

  copy.id = remapId(slide.id, "sld");

  for (const { element } of walkElements(copy.elements)) {
    element.id = remapId(element.id, "el");
  }

  for (const track of copy.animations ?? []) {
    track.id = remapId(track.id, "anm");
    for (const clip of track.clips) clip.id = remapId(clip.id, "clp");
  }

  // Second pass: rewrite every reference now that the whole map is known. Doing
  // this inline during the first pass would miss forward references.
  rewriteReferences(copy, remap);

  return copy;
}

function rewriteReferences(slide: Slide, remap: ReadonlyMap<string, string>): void {
  const swap = (value: unknown): unknown =>
    typeof value === "string" && remap.has(value) ? remap.get(value) : value;

  for (const track of slide.animations ?? []) {
    track.targetId = swap(track.targetId) as string;
  }

  for (const interaction of slide.interactions ?? []) {
    const trigger = interaction.trigger as { targetId?: string };
    if (trigger.targetId) trigger.targetId = swap(trigger.targetId) as string;

    const action = interaction.action as { targetId?: string; trackId?: string };
    if (action.targetId) action.targetId = swap(action.targetId) as string;
    if (action.trackId) action.trackId = swap(action.trackId) as string;
  }

  for (const { element } of walkElements(slide.elements)) {
    for (const constraint of element.constraints ?? []) {
      const c = constraint as { targetId?: string; containerId?: string };
      if (c.targetId) c.targetId = swap(c.targetId) as string;
      if (c.containerId) c.containerId = swap(c.containerId) as string;
    }

    // Connector anchors: a duplicated diagram must connect to its own nodes.
    for (const end of ["from", "to"] as const) {
      const endpoint = (element as Record<string, unknown>)[end];
      if (endpoint && typeof endpoint === "object" && "elementId" in endpoint) {
        const anchor = endpoint as { elementId: string };
        anchor.elementId = swap(anchor.elementId) as string;
      }
    }
  }
}

// ------------------------------------------------------------------ elements

export interface AddElementInput {
  slideId: string;
  element: PresentationElement;
  /** Add inside this group instead of at slide level. */
  parentGroupId?: string;
  /** Insert before this index. Appends when omitted. */
  atIndex?: number;
}

export function addElement(
  document: PresentationDocument,
  input: AddElementInput,
): PatchOperation[] {
  const { slide } = requireSlide(document, input.slideId);

  let ancestors: PresentationElement[] = [];
  let siblings: readonly PresentationElement[] = slide.elements;

  if (input.parentGroupId) {
    const parent = resolveElementById(document, input.parentGroupId);
    if (!parent) {
      throw new OperationError(`No group with id "${input.parentGroupId}".`);
    }
    if (!isGroup(parent.element)) {
      throw new OperationError(
        `Element "${input.parentGroupId}" is a ${parent.element.type}, not a group.`,
        "E303",
      );
    }
    ancestors = [...parent.ancestors, parent.element];
    siblings = parent.element.children;
  }

  const base = containerPath(slide.id, ancestors);
  const path = input.atIndex === undefined ? `${base}/-` : `${base}/${clampIndex(input.atIndex, siblings.length)}`;

  return [{ op: "add", path, value: input.element }];
}

export function removeElement(
  document: PresentationDocument,
  elementId: string,
): PatchOperation[] {
  const found = resolveElementById(document, elementId);
  if (!found) throw new OperationError(`No element with id "${elementId}".`);
  return [{ op: "remove", path: found.path }];
}

export interface MoveElementInput {
  elementId: string;
  /** Defaults to the slide it is already on. */
  toSlideId?: string;
  /** Move into this group. Omit to move to slide level. */
  toGroupId?: string;
  /** Position among the destination's children. Appends when omitted. */
  toIndex?: number;
}

/**
 * Move an element, within a slide or between slides.
 *
 * Reordering within a parent — "bring to front" — is this operation, not a
 * `zIndex` increment: array position is the ordering authority and `zIndex` is an
 * override that exists for pinning (doc 02 §8.4).
 */
export function moveElement(
  document: PresentationDocument,
  input: MoveElementInput,
): PatchOperation[] {
  const found = resolveElementById(document, input.elementId);
  if (!found) throw new OperationError(`No element with id "${input.elementId}".`);

  const targetSlideId = input.toSlideId ?? found.slide.id;
  const { slide: targetSlide } = requireSlide(document, targetSlideId);

  let ancestors: PresentationElement[] = [];
  let siblings: readonly PresentationElement[] = targetSlide.elements;

  if (input.toGroupId) {
    const parent = resolveElementById(document, input.toGroupId);
    if (!parent || !isGroup(parent.element)) {
      throw new OperationError(`No group with id "${input.toGroupId}".`);
    }
    // A group cannot contain itself or one of its own descendants. Without this
    // check the move "succeeds" and detaches the whole subtree from the document.
    if (parent.element.id === input.elementId || contains(found.element, parent.element.id)) {
      throw new OperationError("A group cannot be moved into itself.", "E303");
    }
    ancestors = [...parent.ancestors, parent.element];
    siblings = parent.element.children;
  }

  const base = containerPath(targetSlideId, ancestors);
  const sameParent =
    targetSlideId === found.slide.id &&
    ancestors.length === found.ancestors.length &&
    ancestors.every((a, i) => a.id === found.ancestors[i]?.id);

  /*
   * `toIndex` is the position the element should END UP at, which is also exactly
   * what the applier produces: it detaches the element first, then resolves the
   * destination against the already-shortened array. So no off-by-one adjustment
   * belongs here — an earlier version subtracted one for forward moves and landed
   * everything one slot short.
   *
   * Within a parent the last valid final position is length - 1; moving into a
   * different parent can append, so there it is length.
   */
  const limit = sameParent ? siblings.length - 1 : siblings.length;
  const index = Math.max(0, Math.min(input.toIndex ?? limit, limit));

  if (sameParent && index === found.index) return [];

  return [{ op: "move", from: found.path, path: `${base}/${index}` }];
}

/** True when `candidateId` is somewhere inside `element`'s subtree. */
function contains(element: PresentationElement, candidateId: string): boolean {
  if (!isGroup(element)) return false;
  for (const { element: descendant } of walkElements(element.children)) {
    if (descendant.id === candidateId) return true;
  }
  return false;
}

/** Change one property. The narrowest possible patch (doc 02 §31.8). */
export function setProperty(
  document: PresentationDocument,
  elementId: string,
  property: string,
  value: unknown,
): PatchOperation[] {
  const found = resolveElementById(document, elementId);
  if (!found) throw new OperationError(`No element with id "${elementId}".`);

  const target = property.split(".").reduce<unknown>((cursor, key) => {
    if (cursor === null || typeof cursor !== "object") return undefined;
    return (cursor as Record<string, unknown>)[key];
  }, found.element);

  const path = `${found.path}/${property.split(".").join("/")}`;
  // `add` creates a key that does not exist yet; `replace` requires one. Choosing
  // wrong makes the patch fail on an optional property that has never been set.
  return [{ op: target === undefined ? "add" : "replace", path, value }];
}

/**
 * Set a nested property, creating whatever parents it needs, or remove it.
 *
 * `setProperty` writes one path and assumes its parent exists — right for
 * `transform.x`, wrong for an optional object nobody has set yet: aligning a
 * text box whose `paragraph` is absent, or giving a shape its first stroke.
 * There the narrowest correct patch adds the *outermost missing* object with
 * the value inside it, so the inverse removes exactly what was added.
 *
 * `undefined` removes the property (and nothing else); removing one that is not
 * there is no operation at all, so "set to the default" never fails.
 */
export function setPropertyDeep(
  document: PresentationDocument,
  elementId: string,
  property: string,
  value: unknown,
): PatchOperation[] {
  const found = resolveElementById(document, elementId);
  if (!found) throw new OperationError(`No element with id "${elementId}".`);
  const keys = property.split(".");
  let cursor: unknown = found.element;
  for (let depth = 0; depth < keys.length; depth += 1) {
    const key = keys[depth]!;
    const container = cursor as Record<string, unknown>;
    const exists = container !== null && typeof container === "object" && key in container && container[key] !== undefined;
    const path = `${found.path}/${keys.slice(0, depth + 1).join("/")}`;
    const last = depth === keys.length - 1;
    if (!exists) {
      if (value === undefined) return [];
      // Build the missing tail around the value: { a: { b: value } }.
      let built: unknown = value;
      for (let inner = keys.length - 1; inner > depth; inner -= 1) built = { [keys[inner]!]: built };
      return [{ op: "add", path, value: built }];
    }
    if (last) {
      if (value === undefined) return [{ op: "remove", path }];
      return [{ op: "replace", path, value }];
    }
    cursor = container[key];
    if (cursor === null || typeof cursor !== "object") {
      throw new OperationError(`"${keys.slice(0, depth + 1).join(".")}" is not an object on "${elementId}".`);
    }
  }
  return [];
}

export function setSlideProperty(
  document: PresentationDocument,
  slideId: string,
  property: string,
  value: unknown,
): PatchOperation[] {
  const { slide } = requireSlide(document, slideId);
  const exists = property.split(".").reduce<unknown>((cursor, key) => {
    if (cursor === null || typeof cursor !== "object") return undefined;
    return (cursor as Record<string, unknown>)[key];
  }, slide);

  return [
    {
      op: exists === undefined ? "add" : "replace",
      path: `${slidePath(slideId)}/${property.split(".").join("/")}`,
      value,
    },
  ];
}

/** Group existing elements into a new group, preserving their order. */
export function groupElements(
  document: PresentationDocument,
  elementIds: readonly string[],
  options: { name?: string; groupRole?: string } = {},
): { operations: PatchOperation[]; groupId: string } {
  if (elementIds.length < 2) {
    throw new OperationError("Grouping needs at least two elements.", "E303");
  }

  const found = elementIds.map((id) => {
    const location = resolveElementById(document, id);
    if (!location) throw new OperationError(`No element with id "${id}".`);
    return location;
  });

  const slideId = found[0]!.slide.id;
  if (found.some((location) => location.slide.id !== slideId)) {
    throw new OperationError("Every element in a group must be on the same slide.", "E303");
  }

  // The group's box is the union of its children, and children are re-expressed
  // relative to it — a child's transform is in its parent's space (doc 02 §10.3),
  // so leaving world coordinates in place would displace every one of them.
  const boxes = found.map(({ element }) => element.transform);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));

  const children = found.map(({ element }) => {
    const child = structuredClone(element) as PresentationElement;
    child.transform = {
      ...child.transform,
      x: Number((child.transform.x - x).toFixed(2)),
      y: Number((child.transform.y - y).toFixed(2)),
    };
    return child;
  });

  const group = {
    id: newId("el"),
    type: "group" as const,
    children,
    transform: {
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      width: Number((right - x).toFixed(2)),
      height: Number((bottom - y).toFixed(2)),
    },
    ...(options.name ? { name: options.name } : {}),
    ...(options.groupRole ? { groupRole: options.groupRole } : {}),
  } as unknown as PresentationElement;

  // Remove deepest-last so earlier removals cannot shift the paths of later ones.
  const removals: PatchOperation[] = [...found]
    .sort((a, b) => b.index - a.index)
    .map(({ path }) => ({ op: "remove" as const, path }));

  return {
    operations: [
      ...removals,
      { op: "add", path: `${containerPath(slideId, [])}/-`, value: group },
    ],
    groupId: group.id,
  };
}

/** A minimal text element, for "add a text box" in the toolbar. */
export function makeTextElement(input: {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  semanticRole?: string;
  fontSize?: number;
}): PresentationElement {
  return {
    id: newId("el"),
    type: "text",
    transform: {
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
    },
    content: plainText(input.text, newId("blk")),
    typography: {
      fontFamily: "token:typography.body.fontFamily",
      fontSize: input.fontSize ?? 26,
      color: "token:colors.foreground",
    },
    fit: "autoHeight",
    ...(input.semanticRole ? { semanticRole: input.semanticRole } : {}),
  } as unknown as PresentationElement;
}

function requireSlide(
  document: PresentationDocument,
  slideId: string,
): { slide: Slide; index: number } {
  const found = resolveSlideById(document, slideId);
  if (!found) throw new OperationError(`No slide with id "${slideId}".`);
  return found;
}

export { elementPath, containerPath, slidePath };
