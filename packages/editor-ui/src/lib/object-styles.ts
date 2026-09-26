import type { ObjectStyle, PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { resolveElementById, setPropertyDeep } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";

/**
 * Reusable object styles (design review, 2026-09-27): save a card's look once
 * as "Metric card", apply it to others, change it and have every card follow.
 *
 * A style is applied by copying its values onto the element and naming it in
 * `styleRef` (see `ObjectStyleSchema`). So:
 * - applying writes the style's properties and removes the element's own
 *   values for the properties a style governs, so the result looks like the
 *   style and not a blend;
 * - updating a style rewrites its definition and then re-applies it to every
 *   element that names it, in the same patch, so one Undo reverses both;
 * - detaching only removes the name: the object keeps its look;
 * - renaming and deleting rewrite every `styleRef` in the same patch, the way
 *   named colours are renamed, so nothing is left naming a style that is gone.
 */

/** The `style` properties a style owns. Blend mode and filters stay the element's own. */
export const STYLE_KEYS = ["fill", "stroke", "cornerRadius", "shadow", "backdropFilters"] as const;
/** The `typography` properties a style owns. Alignment and lists stay with the text. */
export const TYPOGRAPHY_KEYS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "color", "lineHeight", "letterSpacing", "textTransform"] as const;

const REQUIRED_TYPOGRAPHY = new Set<string>(["fontFamily", "fontSize"]);

export interface StyleEntry {
  name: string;
  style: ObjectStyle;
  /** How many elements in the deck name it. */
  uses: number;
}

export function objectStyles(document: PresentationDocument): StyleEntry[] {
  const styles = (document.theme.objectStyles ?? {}) as Record<string, ObjectStyle>;
  const counts = new Map<string, number>();
  for (const element of allElements(document)) {
    if (element.styleRef) counts.set(element.styleRef, (counts.get(element.styleRef) ?? 0) + 1);
  }
  return Object.entries(styles)
    .map(([name, style]) => ({ name, style, uses: counts.get(name) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Why a name cannot be used for a new style, or undefined when it can. */
export function styleNameProblem(document: PresentationDocument, name: string, except?: string): string | undefined {
  const trimmed = tidy(name);
  if (!trimmed) return "Give the style a name.";
  if (trimmed.length > 60) return "Keep the name under 60 characters.";
  if (trimmed.includes(".")) return "A style name cannot contain a full stop.";
  const taken = Object.keys(document.theme.objectStyles ?? {}).some((existing) => existing.toLowerCase() === trimmed.toLowerCase() && existing !== except);
  return taken ? `There is already a style called "${trimmed}".` : undefined;
}

/** What an element looks like, as a style: the owned properties it actually sets. */
export function captureStyle(element: PresentationElement): ObjectStyle {
  const style = pick(element.style as Record<string, unknown> | undefined, STYLE_KEYS);
  const typography = hasTypography(element) ? pick((element as { typography?: Record<string, unknown> }).typography, TYPOGRAPHY_KEYS) : undefined;
  const captured: ObjectStyle = { appliesTo: kindOf(element) };
  if (style) captured.style = style as ObjectStyle["style"];
  if (typography) captured.typography = typography as ObjectStyle["typography"];
  if (element.opacity !== undefined && element.opacity !== 1) captured.opacity = element.opacity;
  return captured;
}

/** Whether an element still looks like the style it names. */
export function drifted(document: PresentationDocument, element: PresentationElement): boolean {
  if (!element.styleRef) return false;
  const style = (document.theme.objectStyles ?? {})[element.styleRef] as ObjectStyle | undefined;
  if (!style) return false;
  const captured = captureStyle(element);
  // The family and size a text box kept because the style sets neither are not drift.
  if (captured.typography) {
    const own = { ...captured.typography } as Record<string, unknown>;
    for (const key of REQUIRED_TYPOGRAPHY) if ((style.typography as Record<string, unknown> | undefined)?.[key] === undefined) delete own[key];
    captured.typography = own as ObjectStyle["typography"];
  }
  return JSON.stringify(normalise(captured, element)) !== JSON.stringify(normalise(style, element));
}

/** Save the look of `from` as a new style, and make `applyTo` (which may include it) use it. */
export function saveStyleOperations(document: PresentationDocument, name: string, from: PresentationElement, applyTo: readonly PresentationElement[]): PatchOperation[] {
  const trimmed = tidy(name);
  const problem = styleNameProblem(document, trimmed);
  if (problem) throw new Error(problem);
  const style = captureStyle(from);
  const define: PatchOperation[] = document.theme.objectStyles
    ? [{ op: "add", path: `/theme/objectStyles/${escape(trimmed)}`, value: style }]
    : [{ op: "add", path: "/theme/objectStyles", value: { [trimmed]: style } }];
  return chain(document, define, (working) => applyStyleOperations(working, trimmed, applyTo));
}

/** Give each element the style's look and name. */
export function applyStyleOperations(document: PresentationDocument, name: string, elements: readonly PresentationElement[]): PatchOperation[] {
  const style = (document.theme.objectStyles ?? {})[name] as ObjectStyle | undefined;
  if (!style) return [];
  let working = document;
  const operations: PatchOperation[] = [];
  for (const target of elements) {
    const element = resolveElementById(working, target.id)?.element;
    if (!element || element.locked === true) continue;
    const writes = elementWrites(element, style, name);
    for (const [property, value] of writes) {
      const next = setPropertyDeep(working, element.id, property, value);
      if (next.length === 0) continue;
      working = applyPatch(working, next).document;
      operations.push(...next);
    }
  }
  return operations;
}

/** Take the look of `from` into the style, and bring every element using it into line. */
export function updateStyleOperations(document: PresentationDocument, name: string, from: PresentationElement): PatchOperation[] {
  if (!(document.theme.objectStyles ?? {})[name]) return [];
  const style = captureStyle(from);
  const define: PatchOperation[] = [{ op: "replace", path: `/theme/objectStyles/${escape(name)}`, value: style }];
  return chain(document, define, (working) => applyStyleOperations(working, name, allElements(working).filter((element) => element.styleRef === name)));
}

/** Stop following a style; the objects keep how they look. */
export function detachOperations(document: PresentationDocument, elements: readonly PresentationElement[]): PatchOperation[] {
  return chainEach(document, elements.filter((element) => element.styleRef), (working, element) => setPropertyDeep(working, element.id, "styleRef", undefined));
}

export function renameStyleOperations(document: PresentationDocument, name: string, next: string): PatchOperation[] {
  const trimmed = tidy(next);
  const problem = styleNameProblem(document, trimmed, name);
  if (problem) throw new Error(problem);
  const style = (document.theme.objectStyles ?? {})[name];
  if (!style || trimmed === name) return [];
  const define: PatchOperation[] = [
    { op: "add", path: `/theme/objectStyles/${escape(trimmed)}`, value: style },
    { op: "remove", path: `/theme/objectStyles/${escape(name)}` },
  ];
  return chain(document, define, (working) =>
    chainEach(working, allElements(working).filter((element) => element.styleRef === name), (w, element) => setPropertyDeep(w, element.id, "styleRef", trimmed)),
  );
}

/** Delete a style. Its users keep their look and lose the name, first, in the same patch. */
export function deleteStyleOperations(document: PresentationDocument, name: string): PatchOperation[] {
  if (!(document.theme.objectStyles ?? {})[name]) return [];
  const users = allElements(document).filter((element) => element.styleRef === name);
  const detach = detachOperations(document, users);
  const after = detach.length ? applyPatch(document, detach).document : document;
  const remaining = Object.keys(after.theme.objectStyles ?? {});
  const remove: PatchOperation[] =
    remaining.length === 1 ? [{ op: "remove", path: "/theme/objectStyles" }] : [{ op: "remove", path: `/theme/objectStyles/${escape(name)}` }];
  return [...detach, ...remove];
}

// ------------------------------------------------------------------ helpers

/** The property writes that make `element` look like `style`. */
function elementWrites(element: PresentationElement, style: ObjectStyle, name: string): Array<[string, unknown]> {
  const writes: Array<[string, unknown]> = [];
  const own = { ...((element.style as Record<string, unknown> | undefined) ?? {}) };
  for (const key of STYLE_KEYS) delete own[key];
  const nextStyle = { ...own, ...((style.style as Record<string, unknown> | undefined) ?? {}) };
  if (JSON.stringify(nextStyle) !== JSON.stringify(element.style ?? {})) writes.push(["style", Object.keys(nextStyle).length ? nextStyle : undefined]);

  if (hasTypography(element)) {
    const current = (element as { typography?: Record<string, unknown> }).typography;
    const ownType = { ...(current ?? {}) };
    // A text box must always have a family and a size, so a style that sets
    // neither leaves the element's own rather than removing them.
    for (const key of TYPOGRAPHY_KEYS) if (!(REQUIRED_TYPOGRAPHY.has(key) && element.type === "text")) delete ownType[key];
    const nextType = { ...ownType, ...((style.typography as Record<string, unknown> | undefined) ?? {}) };
    if (JSON.stringify(nextType) !== JSON.stringify(current ?? {})) writes.push(["typography", Object.keys(nextType).length ? nextType : undefined]);
  }

  const opacity = style.opacity ?? undefined;
  if ((element.opacity ?? undefined) !== opacity) writes.push(["opacity", opacity]);
  if (element.styleRef !== name) writes.push(["styleRef", name]);
  return writes;
}

function hasTypography(element: PresentationElement): boolean {
  return element.type === "text" || element.type === "shape";
}

function kindOf(element: PresentationElement): ObjectStyle["appliesTo"] {
  return element.type === "shape" || element.type === "text" || element.type === "icon" || element.type === "group" ? element.type : "any";
}

/** Drop what cannot apply to this element, so a shape is not "drifted" for lacking a text colour it never had. */
function normalise(style: ObjectStyle, element: PresentationElement): unknown {
  return {
    style: sortKeys(style.style ?? {}),
    typography: hasTypography(element) ? sortKeys(style.typography ?? {}) : {},
    opacity: style.opacity ?? 1,
  };
}

function sortKeys(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function pick(source: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!source) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = structuredClone(source[key]);
  return Object.keys(out).length ? out : undefined;
}

function chain(document: PresentationDocument, first: PatchOperation[], then: (working: PresentationDocument) => PatchOperation[]): PatchOperation[] {
  const working = applyPatch(document, first).document;
  return [...first, ...then(working)];
}

function chainEach<T>(document: PresentationDocument, items: readonly T[], write: (working: PresentationDocument, item: T) => PatchOperation[]): PatchOperation[] {
  let working = document;
  const operations: PatchOperation[] = [];
  for (const item of items) {
    const next = write(working, item);
    if (next.length === 0) continue;
    working = applyPatch(working, next).document;
    operations.push(...next);
  }
  return operations;
}

export function allElements(document: PresentationDocument): PresentationElement[] {
  const out: PresentationElement[] = [];
  const visit = (list: readonly PresentationElement[]) => {
    for (const element of list) {
      out.push(element);
      const children = (element as { children?: PresentationElement[] }).children;
      if (Array.isArray(children)) visit(children);
    }
  };
  for (const slide of document.slides) visit(slide.elements);
  return out;
}

function tidy(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function escape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
