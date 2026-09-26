/**
 * Applying a theme, and optionally its look, to a deck (Design tab review).
 *
 * The theme is one `replace` of `/theme`, so every element that refers to a
 * token (`token:colors.accent`, a theme font) follows it. A look like glass or
 * neumorphism does not live in the theme — it is a blur behind a card, a pair
 * of shadows — so "restyle" also rewrites the cards and the slide backgrounds,
 * in the same patch: one change, one undo step, previewed as one thing.
 *
 * Pure, like every other operation builder here: it reads a document and
 * returns operations, and the editor applies them through the one mutation path.
 */

import type {
  BackgroundDefinition,
  PatchOperation,
  PresentationDocument,
  PresentationElement,
  StyleKit,
  ThemeDefinition,
} from "@deckastra/presentation-schema";
import { isGroup } from "@deckastra/presentation-schema";

/** Shapes that read as a card: a filled box, not a line, an arrow or a decorative dot. */
const CARD_SHAPES = new Set(["rectangle", "pill"]);

export function isCard(element: PresentationElement): boolean {
  const style = element.style;
  const filled = style?.fill !== undefined && style.fill.type !== "none";
  if (element.type === "shape") {
    const shape = (element as { shape?: string }).shape ?? "rectangle";
    return filled && CARD_SHAPES.has(shape);
  }
  // A styled group is how a generated card is built: the box is the group.
  return isGroup(element) && filled;
}

export interface ApplyThemeOptions {
  /** Also restyle cards and slide backgrounds with this kit. */
  restyle?: StyleKit;
}

export function applyThemeOperations(
  document: PresentationDocument,
  theme: ThemeDefinition,
  options: ApplyThemeOptions = {},
): PatchOperation[] {
  const operations: PatchOperation[] = [{ op: "replace", path: "/theme", value: structuredClone(theme) }];

  // A deck that was following a workspace theme no longer is: re-applying the
  // workspace brand later must not silently undo a look someone chose here.
  const metadata = document.metadata as { themeId?: string };
  if (metadata.themeId !== undefined) operations.push({ op: "remove", path: "/metadata/themeId" });

  const kit = options.restyle;
  if (!kit) return operations;

  for (const slide of document.slides) {
    const path = `/slides/id:${slide.id}/background`;
    if (kit.background) {
      operations.push({ op: slide.background === undefined ? "add" : "replace", path, value: structuredClone(kit.background) as BackgroundDefinition });
    } else if (slide.background !== undefined) {
      // No background of the style's own means the theme's colour, which is
      // what an absent background draws.
      operations.push({ op: "remove", path });
    }

    const visit = (elements: readonly PresentationElement[], base: string) => {
      for (const element of elements) {
        const at = `${base}/id:${element.id}`;
        if (isCard(element) && element.locked !== true) {
          operations.push({ op: "replace", path: `${at}/style`, value: cardStyle(element, kit) });
        }
        if (isGroup(element)) visit(element.children, `${at}/children`);
      }
    };
    visit(slide.elements, `/slides/id:${slide.id}/elements`);
  }

  return operations;
}

/** The card's style with the kit's look, keeping what the kit does not speak to (a blend mode, filters). */
function cardStyle(element: PresentationElement, kit: StyleKit): NonNullable<PresentationElement["style"]> {
  const next = { ...(element.style ?? {}) } as Record<string, unknown>;
  const card = kit.card as Record<string, unknown>;
  for (const key of ["fill", "stroke", "cornerRadius", "shadow", "backdropFilters"]) {
    const value = card[key];
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (empty) delete next[key];
    else next[key] = structuredClone(value);
  }
  return next as NonNullable<PresentationElement["style"]>;
}

/** How many cards and slides a restyle would touch, for the confirmation line. */
export function restyleReach(document: PresentationDocument): { cards: number; slides: number } {
  let cards = 0;
  const count = (elements: readonly PresentationElement[]) => {
    for (const element of elements) {
      if (isCard(element) && element.locked !== true) cards += 1;
      if (isGroup(element)) count(element.children);
    }
  };
  for (const slide of document.slides) count(slide.elements);
  return { cards, slides: document.slides.length };
}
