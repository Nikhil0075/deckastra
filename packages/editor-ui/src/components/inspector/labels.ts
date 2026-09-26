import { textContent, type PresentationElement } from "@deckastra/presentation-schema";

/** A short human name for an element: its own name, its text, or its type. */
export function labelFor(element: PresentationElement): string {
  if (element.name) return element.name;
  if (element.type === "text") {
    const content = (element as { content?: unknown }).content;
    const text = content ? textContent(content as never) : "";
    return text.slice(0, 24) || "Empty text";
  }
  return `${element.type} ${element.id.slice(4, 10)}`;
}
