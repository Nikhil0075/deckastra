/**
 * Speaker notes as rich text (audit P2, 2026-09-19).
 *
 * Phase 2 edited notes in a textarea and warned that existing formatting would
 * be lost on the first keystroke. The plan asked for the canvas text editor's
 * contract instead, and this is its model half: notes render into a
 * contenteditable, are read back with the same `readEditable` the canvas uses,
 * and reach the document only as a patch. Pure apart from building DOM nodes,
 * which jsdom can do, so the round trip is testable without a browser.
 */
import { newId, type PatchOperation, type PresentationDocument, type RichTextDocument } from "@deckastra/presentation-schema";
import { preserveBlockStyles, richTextToPlain, textChanged } from "@deckastra/editor";
import { renderRichText } from "./rich-dom";

type Notes = RichTextDocument | string | undefined;

/** Marks the notes field can show and write back. Anything else is only kept if nobody edits. */
const EDITABLE_SPAN_KEYS = new Set(["text", "bold", "italic", "underline", "strike", "code", "link"]);
const EDITABLE_BLOCK_TYPES = new Set(["paragraph", "bullet", "numbered", "heading", "quote"]);

/** Notes as a document, whatever form they are stored in. Plain notes are one paragraph per line. */
export function notesDocument(notes: Notes): RichTextDocument {
  if (notes !== undefined && typeof notes !== "string") return notes;
  const lines = (notes ?? "").split("\n");
  return {
    version: 1,
    blocks: lines.map((line) => ({ id: newId("blk"), type: "paragraph" as const, spans: [{ text: line }] })),
  };
}

/** Whether a document needs rich text to hold it: a list, a heading, or a marked span. */
export function hasFormatting(document: RichTextDocument): boolean {
  return document.blocks.some(
    (block) => block.type !== "paragraph" || block.spans.some((span) => Object.keys(span).some((key) => key !== "text")),
  );
}

/**
 * Formatting the field cannot show — a colour, a highlight, superscript, a
 * font override, a block kind it has no element for. Editing reads the field
 * back, so that formatting would go; the field says so rather than dropping it
 * silently. Rare in notes, which is why this is a warning and not a feature.
 */
export function notesHaveUnsupportedFormatting(notes: Notes): boolean {
  if (notes === undefined || typeof notes === "string") return false;
  return notes.blocks.some(
    (block) =>
      !EDITABLE_BLOCK_TYPES.has(block.type) ||
      block.spans.some((span) => Object.keys(span).some((key) => !EDITABLE_SPAN_KEYS.has(key))),
  );
}

/** Words only, for the speaking estimate and the character count. */
export function notesPlainText(notes: Notes): string {
  return richTextToPlain(notesDocument(notes));
}

// ------------------------------------------------------------------- render

/**
 * Build the DOM for a notes document, for the editable and for a paste. The
 * same builder the canvas text editor uses (`rich-dom.ts`), so rendering and
 * reading are inverses in both fields.
 */
export function renderNotes(doc: Document, notes: RichTextDocument): DocumentFragment {
  return renderRichText(doc, notes);
}

// ------------------------------------------------------------------- commit

/**
 * The operations that make a slide's notes `next`, read back from the field.
 * `[]` when nothing a reader would see changed, so clicking in and out of the
 * notes puts nothing in the undo history.
 *
 * Plain stays plain: notes with no formatting are stored as a string, which is
 * what most decks hold and what every other reader expects. The moment
 * something is bolded or listed they become rich text. Rich notes keep each
 * surviving block's id and paragraph style, so a version diff shows the lines
 * that changed rather than every block renamed. Emptying the field removes the
 * property rather than storing "".
 */
export function notesEditOperations(
  document: PresentationDocument,
  slideId: string,
  next: RichTextDocument,
): PatchOperation[] {
  const slide = document.slides.find((candidate) => candidate.id === slideId);
  if (!slide) return [];
  const current = slide.speakerNotes;
  const path = `/slides/id:${slideId}/speakerNotes`;

  if (next.blocks.every((block) => block.spans.every((span) => span.text === ""))) {
    return current === undefined ? [] : [{ op: "remove", path }];
  }
  const edited = next;

  let value: RichTextDocument | string;
  if (!hasFormatting(edited) && (current === undefined || typeof current === "string")) {
    value = richTextToPlain(edited);
  } else {
    const base = current !== undefined && typeof current !== "string" ? current : undefined;
    const styled = base ? preserveBlockStyles(base, edited) : edited;
    value = {
      ...(base ?? {}),
      version: 1,
      blocks: styled.blocks.map((block, index) => ({ ...block, id: base?.blocks[index]?.id ?? block.id })),
    };
  }

  if (current !== undefined && sameNotes(current, value)) return [];
  return [{ op: current === undefined ? "add" : "replace", path, value }];
}

/** Plain-text entry point, kept for callers that have words rather than a field. */
export function notesTextOperations(document: PresentationDocument, slideId: string, text: string): PatchOperation[] {
  return notesEditOperations(document, slideId, notesDocument(text));
}

function sameNotes(a: RichTextDocument | string, b: RichTextDocument | string): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return !textChanged(a, b);
}
