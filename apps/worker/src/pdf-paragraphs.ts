import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef } from "pdf-lib";

export interface PdfParagraph { kind: "P" | "LI" | "BlockQuote"; text: string }

function logicalMarkedContent(content: string): string {
  const removals: { start: number; end: number }[] = [];
  for (const mark of content.matchAll(/\/ReversedChars\s+BMC/g)) {
    let depth = 1;
    const start = mark.index! + mark[0].length;
    for (const token of content.slice(start).matchAll(/\b(BDC|BMC|EMC)\b/g)) {
      depth += token[1] === "EMC" ? -1 : 1;
      if (!depth) {
        removals.push({ start: mark.index!, end: start }, { start: start + token.index!, end: start + token.index! + 3 });
        break;
      }
    }
  }
  for (const removal of removals.sort((a, b) => b.start - a.start)) content = content.slice(0, removal.start) + content.slice(removal.end);
  return content;
}

/** Carry the DOM's logical paragraph order into PDF marked content. Glyph
 * positions are visual order (especially for RTL); even a correct ToUnicode
 * map cannot recover paragraph boundaries from positioned paint fragments.
 * Tagged Chromium PDFs identify those fragments by MCID. Only pages whose
 * structural paragraph roles exactly match the captured DOM are changed.
 */
export function paragraphText(document: PDFDocument, sources: readonly (readonly PdfParagraph[])[]): number {
  const root = document.catalog.lookupMaybe(PDFName.of("StructTreeRoot"), PDFDict);
  if (!root) return 0;
  const pages = document.getPages();
  const byPage = new Map(pages.map((page, index) => [page.ref.toString(), index]));
  const records = pages.map(() => [] as { kind: string; ids: number[] }[]);
  const mcids = (value: unknown, pageRef?: PDFRef): { index: number; id: number }[] => {
    const obj = value instanceof PDFRef ? document.context.lookup(value) : value;
    if (obj instanceof PDFNumber) {
      const index = pageRef ? byPage.get(pageRef.toString()) : undefined;
      return index === undefined ? [] : [{ index, id: obj.asNumber() }];
    }
    if (obj instanceof PDFArray) return obj.asArray().flatMap(item => mcids(item, pageRef));
    if (obj instanceof PDFDict) {
      const ownPage = obj.get(PDFName.of("Pg"));
      const inherited = ownPage instanceof PDFRef ? ownPage : pageRef;
      const id = obj.lookupMaybe(PDFName.of("MCID"), PDFNumber);
      if (id) return mcids(id, inherited);
      return mcids(obj.get(PDFName.of("K")), inherited);
    }
    return [];
  };
  const visit = (value: unknown, pageRef?: PDFRef): void => {
    const obj = value instanceof PDFRef ? document.context.lookup(value) : value;
    if (obj instanceof PDFArray) { obj.asArray().forEach(item => visit(item, pageRef)); return; }
    if (!(obj instanceof PDFDict)) return;
    const ownPage = obj.get(PDFName.of("Pg"));
    const inherited = ownPage instanceof PDFRef ? ownPage : pageRef;
    const kind = obj.get(PDFName.of("S"))?.toString().slice(1);
    if (kind === "P" || kind === "LI" || kind === "BlockQuote") {
      const ids = mcids(obj.get(PDFName.of("K")), inherited);
      if (!ids.length || ids.some(id => id.index !== ids[0]!.index)) return;
      records[ids[0]!.index]!.push({ kind, ids: ids.map(id => id.id) });
      return;
    }
    visit(obj.get(PDFName.of("K")), inherited);
  };
  visit(root.get(PDFName.of("K")));
  let changed = 0;
  pages.forEach((page, index) => {
    const source = sources[index], record = records[index]!;
    if (!source || source.length !== record.length || record.some((item, i) => item.kind !== source[i]!.kind)) return;
    const replacements = new Map<number, string>();
    record.forEach((item, i) => item.ids.forEach((id, j) => replacements.set(id, j === 0 ? source[i]!.text : "")));
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    for (const ref of refs) {
      const stream = document.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const bytes = stream.dict.get(PDFName.of("Filter"))?.toString() === "/FlateDecode" ? inflateSync(stream.contents) : stream.contents;
      const content = Buffer.from(bytes).toString("latin1");
      const edits: { start: number; end: number; value: string }[] = [];
      for (const mark of content.matchAll(/\/([A-Za-z0-9]+)\s*<<\s*\/MCID\s+(\d+)\s*>>\s*BDC/g)) {
        const id = Number(mark[2]);
        if (!replacements.has(id)) continue;
        const start = mark.index! + mark[0].length;
        let depth = 1, end = -1;
        for (const token of content.slice(start).matchAll(/\b(BDC|BMC|EMC)\b/g)) {
          depth += token[1] === "EMC" ? -1 : 1;
          if (!depth) { end = start + token.index!; break; }
        }
        if (end < 0) continue;
        const actual = PDFHexString.fromText(replacements.get(id)!).toString();
        // The paragraph's replacement covers its nested glyph-cluster spans.
        // ReversedChars describes visual-order glyph strings. The replacement
        // paragraph is already logical-order Unicode; reversing it again would
        // swap RTL phrases around punctuation in some readers.
        const body = logicalMarkedContent(content.slice(start, end)).replace(/\/ActualText\s*<[0-9A-Fa-f]+>/g, "");
        // Poppler honours replacement text on /Span, but ignores it on the
        // /NonStruct paint markers Chromium uses. MCID and structure roles
        // remain unchanged; only the marked-content tag becomes semantic.
        edits.push({ start: mark.index!, end, value: `/Span <</MCID ${id} /ActualText ${actual}>> BDC${body}` });
      }
      let repaired = content;
      for (const edit of edits.reverse()) repaired = repaired.slice(0, edit.start) + edit.value + repaired.slice(edit.end);
      if (repaired === content) continue;
      const output = document.context.flateStream(Buffer.from(repaired, "latin1"));
      if (ref instanceof PDFRef) document.context.assign(ref, output);
      else page.node.set(PDFName.of("Contents"), document.context.register(output));
      changed += edits.length;
    }
  });
  return changed;
}
