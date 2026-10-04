import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { newId, plainText, textContent, validateDocument, type PresentationDocument } from "@deckastra/presentation-schema";
import { setProperty } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";

import { canonicalPath, localizeDocument, localizeWrite } from "../src/lib/locale-lens";

const deck = () => loadFixture("multilingual");
/** What the editor does: author against the copy, apply the lens's patch to the deck. */
function edit(source: PresentationDocument, author: (view: PresentationDocument) => Parameters<typeof applyPatch>[1]) {
  const view = localizeDocument(source, "hi-IN");
  const operations = localizeWrite(source, "hi-IN", author(view));
  const after = applyPatch(source, operations);
  return { operations, after: after.document, inverse: after.inverse };
}
const title = (doc: PresentationDocument) => doc.slides[0]!.elements[0]! as unknown as { id: string; content: ReturnType<typeof plainText>; transform: { x: number } };

describe("editing in a language", () => {
  it("writes typed words to the overlay and leaves the source sentence alone", () => {
    const source = deck();
    const id = title(source).id;
    const { after, operations } = edit(source, (view) => setProperty(view, id, "content", plainText("एक डेक, सारी भाषाएँ", title(view).content.blocks[0]!.id)));
    expect(operations.every((operation) => operation.path.startsWith("/locales/hi-IN/entries/"))).toBe(true);
    expect(textContent(title(after).content)).toBe("One deck, every language");
    expect(textContent(title(localizeDocument(after, "hi-IN")).content)).toBe("एक डेक, सारी भाषाएँ");
    expect(validateDocument(after).errors).toEqual([]);
  });

  it("an edit inside the rich text (one span) also goes to the overlay", () => {
    const source = deck();
    const { id } = title(source);
    const { after } = edit(source, () => [
      { op: "replace", path: `/slides/id:${source.slides[0]!.id}/elements/id:${id}/content/blocks/0/spans/0/text`, value: "बदला हुआ" },
    ]);
    expect(textContent(title(after).content)).toBe("One deck, every language");
    expect(textContent(title(localizeDocument(after, "hi-IN")).content)).toBe("बदला हुआ");
  });

  it("re-stamps an outdated entry when a person edits it, so it is current again", () => {
    const source = deck();
    const element = title(source);
    element.content = plainText("One deck, many languages", element.content.blocks[0]!.id);
    const hindiOutdated = (doc: PresentationDocument) =>
      validateDocument(doc).warnings.filter((issue) => issue.code === "W321" && issue.path.startsWith("/locales/hi-IN/"));
    expect(hindiOutdated(source)).toHaveLength(1);
    const { after } = edit(source, (view) => setProperty(view, element.id, "content", plainText("एक डेक, अनेक भाषाएँ", element.content.blocks[0]!.id)));
    expect(hindiOutdated(after)).toHaveLength(0);
  });

  it("moves are shared: one geometry for every language", () => {
    const source = deck();
    const { id } = title(source);
    const { after, operations } = edit(source, (view) => setProperty(view, id, "transform.x", 300));
    expect(operations).toEqual(setProperty(source, id, "transform.x", 300));
    expect(title(after).transform.x).toBe(300);
  });

  it("undoes like any other edit", () => {
    const source = deck();
    const { id } = title(source);
    const { after, inverse } = edit(source, (view) => setProperty(view, id, "content", plainText("x", title(view).content.blocks[0]!.id)));
    expect(applyPatch(after, inverse).document).toEqual(source);
  });

  it("clearing a field in a language is an empty translation, not the source showing through", () => {
    const source = deck();
    const slide = source.slides[0]!.id;
    const { after } = edit(source, () => [{ op: "remove", path: `/slides/id:${slide}/speakerNotes` }]);
    expect(after.slides[0]!.speakerNotes).toBe(source.slides[0]!.speakerNotes);
    expect(localizeDocument(after, "hi-IN").slides[0]!.speakerNotes).toBe("");
  });

  it("a duplicated text box keeps English in the source and carries its Hindi", () => {
    const source = deck();
    const view = localizeDocument(source, "hi-IN");
    const copy = structuredClone(title(view)) as unknown as { id: string; content: ReturnType<typeof plainText> };
    copy.id = newId("el");
    copy.content = { ...copy.content, blocks: copy.content.blocks.map((block) => ({ ...block, id: newId("blk") })) };
    const { after } = edit(source, () => [{ op: "add", path: `/slides/id:${source.slides[0]!.id}/elements/-`, value: copy }]);
    const added = after.slides[0]!.elements.at(-1)! as unknown as { content: ReturnType<typeof plainText> };
    expect(textContent(added.content)).toBe("One deck, every language");
    expect(textContent((localizeDocument(after, "hi-IN").slides[0]!.elements.at(-1)! as unknown as { content: never }).content)).toBe("एक डेक, हर भाषा");
    // The carried translation keeps the new box's own block ids.
    expect(added.content.blocks[0]!.id).toBe(copy.content.blocks[0]!.id);
    expect(validateDocument(after).errors).toEqual([]);
  });

  it("replacing a whole element from the copy does not leak the translation into the source", () => {
    const source = deck();
    const view = localizeDocument(source, "hi-IN");
    const element = structuredClone(title(view));
    element.transform.x = 400;
    const { after } = edit(source, () => [
      { op: "replace", path: `/slides/id:${source.slides[0]!.id}/elements/id:${element.id}`, value: element },
    ]);
    expect(title(after).transform.x).toBe(400);
    expect(textContent(title(after).content)).toBe("One deck, every language");
  });

  it("never writes the copy's language marker back into the deck", () => {
    const source = deck();
    expect(localizeWrite(source, "hi-IN", [{ op: "replace", path: "/metadata/language", value: "hi-IN" }])).toEqual([]);
    const view = localizeDocument(source, "hi-IN");
    const { after } = edit(source, () => [{ op: "replace", path: "/metadata", value: { ...view.metadata, description: "x" } }]);
    expect(after.metadata.language).toBe("en");
    expect(after.metadata.title).toBe("Multilingual Narrated Deck");
    expect(after.metadata.description).toBe("x");
  });

  it("names a slot the same way whether a path uses indices or ids", () => {
    const source = deck();
    const slide = source.slides[0]!;
    expect(canonicalPath(source, "/slides/0/elements/0/content")).toBe(`/slides/id:${slide.id}/elements/id:${slide.elements[0]!.id}/content`);
    // Blocks carry ids too, so they are named by id; a span (no id) keeps its index.
    expect(canonicalPath(source, "/slides/0/elements/0/content/blocks/0/spans/0")).toMatch(/\/content\/blocks\/id:blk_[^/]+\/spans\/0$/);
  });

  it("passes everything through in the deck's own language", () => {
    const source = deck();
    const operations = setProperty(source, title(source).id, "content", plainText("x", "blk_01JB8Z9K2QW4RN7F3XZZZZZZZZ"));
    expect(localizeWrite(source, "en", operations)).toEqual(operations);
  });
});
