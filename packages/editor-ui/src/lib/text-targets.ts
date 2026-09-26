import { emptyRichText } from "@deckastra/editor";
import type { PresentationElement, RichTextDocument } from "@deckastra/presentation-schema";

/**
 * What an element offers for in-place text editing, and where it is stored.
 *
 * One answer shared by double-click and Enter, so the two ways into editing
 * cannot disagree about which objects have text. A shape's label is as editable
 * as a standalone text box (MA-20): the schema makes a labelled shape one
 * element precisely so it moves, animates and exports as one, and an editor
 * that could only reach its words through JSON would undo that.
 *
 * A shape with no label yet offers an empty one — typing into a rectangle is
 * how every slide tool adds a caption to a box.
 */
export type TextTarget = {
  kind: "text" | "shapeLabel";
  /** The element property the edited document is written to. */
  property: "content" | "text";
  value: RichTextDocument;
};

export function textTargetOf(element: PresentationElement | undefined): TextTarget | undefined {
  if (!element) return undefined;
  if (element.type === "text") {
    return { kind: "text", property: "content", value: (element as { content: RichTextDocument }).content };
  }
  if (element.type === "shape") {
    const label = (element as { text?: RichTextDocument }).text;
    return { kind: "shapeLabel", property: "text", value: label ?? emptyRichText() };
  }
  return undefined;
}

/** Why an object cannot be edited in place, in words a person can act on. */
export function textEditRefusal(element: PresentationElement | undefined): string | undefined {
  if (!element) return "Select a text box or a shape to edit its text.";
  if (element.locked === true) return "This object is locked. Unlock it to edit its text.";
  if (element.type === "group") return undefined;
  if (!textTargetOf(element)) {
    return `A ${element.type} has no text to edit in place. Its content is in the inspector on the right.`;
  }
  return undefined;
}
