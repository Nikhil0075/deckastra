// @vitest-environment jsdom
/**
 * Speaker notes as rich text (audit P2, 2026-09-19). The field renders a
 * document into a contenteditable and reads it back with the canvas editor's
 * `readEditable`; these check that the two are inverses and that what reaches
 * the document is the smallest correct patch.
 */
import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import {
  serializeDocument,
  validateDocument,
  type PatchOperation,
  type PresentationDocument,
  type RichTextDocument,
} from "@deckastra/presentation-schema";
import { readEditable, sanitizePastedHtml, textChanged } from "@deckastra/editor";
import { applyPatch } from "@deckastra/transactions";

import {
  notesDocument,
  notesEditOperations,
  notesHaveUnsupportedFormatting,
  notesPlainText,
  notesTextOperations,
  renderNotes,
} from "../src/lib/notes-rich";

const deck = loadFixture("technical");
const slideId = deck.slides[0]!.id;

const withNotes = (notes: unknown): PresentationDocument => ({
  ...deck,
  slides: deck.slides.map((slide, i) => (i === 0 ? { ...slide, speakerNotes: notes as never } : slide)),
});

function roundTrips(document: PresentationDocument, operations: PatchOperation[]) {
  const { document: after, inverse } = applyPatch(document, operations);
  expect(serializeDocument(applyPatch(after, inverse).document)).toBe(serializeDocument(document));
  expect(validateDocument(after).valid).toBe(true);
  return after;
}

/** Render into a host and read it straight back, as opening and leaving the field does. */
function throughTheField(notes: RichTextDocument): RichTextDocument {
  const host = document.createElement("div");
  host.appendChild(renderNotes(document, notes));
  return readEditable(host);
}

const rich: RichTextDocument = {
  version: 1,
  blocks: [
    { id: "blk_01JAAAAAAAAAAAAAAAAAAAAAAA", type: "paragraph", spans: [{ text: "Open with " }, { text: "the cost", bold: true }] },
    { id: "blk_01JBBBBBBBBBBBBBBBBBBBBBBB", type: "paragraph", spans: [{ text: "" }] },
    { id: "blk_01JCCCCCCCCCCCCCCCCCCCCCCC", type: "bullet", spans: [{ text: "latency", italic: true }] },
    { id: "blk_01JDDDDDDDDDDDDDDDDDDDDDDD", type: "bullet", spans: [{ text: "errors" }] },
    { id: "blk_01JEEEEEEEEEEEEEEEEEEEEEEE", type: "numbered", spans: [{ text: "ask", underline: true }] },
    { id: "blk_01JFFFFFFFFFFFFFFFFFFFFFFF", type: "paragraph", spans: [{ text: "docs", link: "https://example.com" }] },
  ],
};

describe("the notes field", () => {
  it("renders and reads back to the same notes: lists, marks, links and a blank line", () => {
    const read = throughTheField(rich);
    expect(textChanged(rich, read)).toBe(false);
    expect(read.blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "bullet", "bullet", "numbered", "paragraph"]);
  });

  it("round-trips plain notes, blank lines included, as plain", () => {
    const read = throughTheField(notesDocument("One\n\nTwo"));
    expect(notesPlainText(read)).toBe("One\n\nTwo");
    expect(notesEditOperations(withNotes("One\n\nTwo"), slideId, read)).toEqual([]);
  });

  it("never renders an unsafe link as a link", () => {
    const host = document.createElement("div");
    host.appendChild(
      renderNotes(document, {
        version: 1,
        blocks: [{ id: "blk_01JAAAAAAAAAAAAAAAAAAAAAAA", type: "paragraph", spans: [{ text: "x", link: "javascript:alert(1)" }] }],
      }),
    );
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe("x");
  });

  it("keeps the marks of a paste and nothing else", () => {
    const pasted = sanitizePastedHtml(
      '<p onclick="x()"><b>Bold</b> <span style="color:red">red</span> <a href="javascript:x()">link</a></p><script>x()</script>',
      (markup) => {
        const host = document.createElement("div");
        host.innerHTML = markup;
        return host;
      },
    );
    const host = document.createElement("div");
    host.appendChild(renderNotes(document, pasted));
    expect(host.innerHTML).toBe("<div><strong>Bold</strong> red link</div>");
  });
});

describe("committing notes", () => {
  it("adds plain notes as a string", () => {
    const after = roundTrips(deck, notesTextOperations(deck, slideId, "Open with the cost."));
    expect(after.slides[0]!.speakerNotes).toBe("Open with the cost.");
  });

  it("commits nothing when nothing changed", () => {
    expect(notesTextOperations(withNotes("Same"), slideId, "Same")).toEqual([]);
    expect(notesTextOperations(deck, slideId, "")).toEqual([]);
    expect(notesEditOperations(withNotes(rich), slideId, throughTheField(rich))).toEqual([]);
  });

  it("removes the property when cleared, rather than storing an empty string", () => {
    expect(notesTextOperations(withNotes("Something"), slideId, "")).toEqual([
      { op: "remove", path: `/slides/id:${slideId}/speakerNotes` },
    ]);
    expect(notesEditOperations(withNotes(rich), slideId, throughTheField(notesDocument("")))).toEqual([
      { op: "remove", path: `/slides/id:${slideId}/speakerNotes` },
    ]);
  });

  it("turns plain notes rich the moment something is formatted", () => {
    const bolded: RichTextDocument = {
      version: 1,
      blocks: [{ id: "blk_01JAAAAAAAAAAAAAAAAAAAAAAA", type: "paragraph", spans: [{ text: "Now", bold: true }] }],
    };
    const after = roundTrips(withNotes("Now"), notesEditOperations(withNotes("Now"), slideId, bolded));
    expect(after.slides[0]!.speakerNotes).toMatchObject({ version: 1, blocks: [{ spans: [{ text: "Now", bold: true }] }] });
  });

  it("keeps rich notes rich, reusing block ids and paragraph styles for the lines that survive", () => {
    const styled = {
      ...rich,
      blocks: rich.blocks.map((block, i) => (i === 0 ? { ...block, style: { spaceAfter: 12 } } : block)),
    } as RichTextDocument;
    const document = withNotes(styled);
    const edited = throughTheField(styled);
    edited.blocks[3] = { ...edited.blocks[3]!, spans: [{ text: "errors, edited" }] };
    edited.blocks.push({ id: "blk_01JGGGGGGGGGGGGGGGGGGGGGGG", type: "paragraph", spans: [{ text: "New" }] });

    const after = roundTrips(document, notesEditOperations(document, slideId, edited));
    const notes = after.slides[0]!.speakerNotes as RichTextDocument;
    expect(notes.blocks.slice(0, 6).map((block) => block.id)).toEqual(styled.blocks.map((block) => block.id));
    expect(notes.blocks[0]!.style).toEqual({ spaceAfter: 12 });
    expect(notes.blocks[3]!.spans[0]!.text).toBe("errors, edited");
    expect(notes.blocks).toHaveLength(7);
  });

  it("says when the notes hold formatting the field cannot show", () => {
    expect(notesHaveUnsupportedFormatting("plain")).toBe(false);
    expect(notesHaveUnsupportedFormatting(rich)).toBe(false);
    expect(
      notesHaveUnsupportedFormatting({
        version: 1,
        blocks: [{ id: "blk_01JAAAAAAAAAAAAAAAAAAAAAAA", type: "paragraph", spans: [{ text: "x", color: "#ff0000" }] }],
      }),
    ).toBe(true);
  });
});
