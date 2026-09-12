import { isGroup, type PatchOperation, type PresentationDocument, type PresentationElement, type TextElement, type Transform } from "@deckastra/presentation-schema";
import { resolveElementById, setProperty } from "@deckastra/presentation-core";
import { commitTransform, resizeGroup } from "@deckastra/editor";

/** The preview and committed resize use the same patch, including descendants. */
export function resizeOperations(document: PresentationDocument, id: string, next: Transform): PatchOperation[] {
  const element = resolveElementById(document, id)?.element;
  if (!element) return [];
  const operations: PatchOperation[] = [];
  function visit(element: PresentationElement, next: Transform, scaleDescendants = false) {
    operations.push(...setProperty(document, element.id, "transform", commitTransform(next)));
    if (!isGroup(element)) return;
    const mode = scaleDescendants ? "scaleChildren" : element.resizeMode ?? (element.containerLayout ? "resizeContainer" : "scaleChildren");
    if (mode === "resizeContainer") return;
    const resized = resizeGroup({
      group: element.transform, next, mode,
      children: element.children.map(child => ({
        id: child.id, type: child.type, transform: child.transform,
        fontSize: child.type === "text" ? (child as TextElement).typography.fontSize : undefined,
      })),
    });
    for (const [index, child] of element.children.entries()) {
      const result = resized.children[index]!;
      visit(child, result.transform, true);
      if (child.type === "text" && result.fontSize !== undefined) {
        const text = child as TextElement;
        const factor = result.fontSize / text.typography.fontSize;
        operations.push(...setProperty(document, child.id, "typography", {
          ...text.typography, fontSize: Math.max(0.01, result.fontSize),
          ...(text.typography.letterSpacing === undefined ? {} : { letterSpacing: text.typography.letterSpacing * factor }),
        }));
        for (const field of ["minFontSize", "maxFontSize"] as const) {
          if (text[field] !== undefined) operations.push(...setProperty(document, child.id, field, Math.max(0.01, text[field] * factor)));
        }
      }
    }
  }
  visit(element, next);
  return operations;
}
