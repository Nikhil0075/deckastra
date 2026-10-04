import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef } from "pdf-lib";

const name = PDFName.of;
const decode = (stream: PDFRawStream): string => Buffer.from(
  stream.dict.get(name("Filter"))?.toString() === "/FlateDecode" ? inflateSync(stream.contents) : stream.contents,
).toString("latin1");
const hex = (value: number) => value.toString(16).padStart(4, "0").toUpperCase();
const textHex = (value: string) => Array.from({ length: value.length }, (_, i) => hex(value.charCodeAt(i))).join("");

interface FontEdit {
  font: PDFDict;
  descendant: PDFDict;
  cmapRef: PDFRef;
  cmap: string;
  next: number;
  entries: { cid: number; glyph: number; text: string; width: number }[];
  width: (cid: number) => number;
}

/** Give each shaped cluster its own character codes, without changing its glyphs.
 * A single Arabic base glyph can draw several different letters with a dot.
 * Only ActualText knows which letter that occurrence represents. Reusing a
 * glyph's code cannot express that, so assign occurrence-specific CIDs and
 * retain the original glyph id and advance in CIDToGIDMap/W. This also lets
 * map-only readers extract the logical cluster rather than its visual pieces.
 * Limited to Chromium's Identity-H/CIDFontType2 text; other encodings stay intact.
 */
export function materializeClusters(document: PDFDocument): number {
  const edits = new Map<PDFDict, FontEdit>();
  const visited = new Set<PDFRawStream>();
  let clusters = 0;
  const getFont = (font: PDFDict): FontEdit | undefined => {
    const known = edits.get(font);
    if (known) return known;
    if (font.get(name("Encoding"))?.toString() !== "/Identity-H") return;
    const children = font.lookupMaybe(name("DescendantFonts"), PDFArray);
    if (!children) return;
    const descendant = document.context.lookup(children.get(0), PDFDict);
    if (descendant.get(name("Subtype"))?.toString() !== "/CIDFontType2" || descendant.get(name("CIDToGIDMap"))?.toString() !== "/Identity") return;
    const cmapRef = font.get(name("ToUnicode"));
    if (!(cmapRef instanceof PDFRef)) return;
    const stream = document.context.lookup(cmapRef);
    if (!(stream instanceof PDFRawStream)) return;
    const widths = new Map<number, number>();
    const w = descendant.lookupMaybe(name("W"), PDFArray);
    let max = 0;
    if (w) for (let i = 0; i < w.size();) {
      const first = w.lookup(i++, PDFNumber).asNumber();
      const item = w.lookup(i++);
      if (item instanceof PDFArray) {
        for (let j = 0; j < item.size(); j++) widths.set(first + j, item.lookup(j, PDFNumber).asNumber());
        max = Math.max(max, first + item.size() - 1);
      } else if (item instanceof PDFNumber) {
        const last = item.asNumber(), width = w.lookup(i++, PDFNumber).asNumber();
        for (let cid = first; cid <= last; cid++) widths.set(cid, width);
        max = Math.max(max, last);
      } else return;
    }
    const cmap = decode(stream);
    // bfchar/range source codes may name glyphs omitted from W (default width).
    for (const block of cmap.matchAll(/beginbf(?:char|range)([\s\S]*?)endbf(?:char|range)/g)) {
      for (const line of block[1]!.trim().split(/\r?\n/)) {
        const codes = [...line.matchAll(/<([0-9A-Fa-f]{4})>/g)];
        if (codes[0]) max = Math.max(max, parseInt(codes[0][1]!, 16));
        if (block[0].includes("beginbfrange") && codes[1]) max = Math.max(max, parseInt(codes[1][1]!, 16));
      }
    }
    const fallback = descendant.lookupMaybe(name("DW"), PDFNumber)?.asNumber() ?? 1000;
    const edit = { font, descendant, cmapRef, cmap, next: max + 1, entries: [], width: (cid: number) => widths.get(cid) ?? fallback };
    edits.set(font, edit);
    return edit;
  };

  for (const page of document.getPages()) {
    const resources = page.node.Resources();
    const streams: { stream: PDFRawStream; ref: unknown; fonts: PDFDict; form: boolean }[] = [];
    const forms = (resource: PDFDict | undefined, inherited?: PDFDict): void => {
      const fonts = resource?.lookupMaybe(name("Font"), PDFDict) ?? inherited;
      const objects = resource?.lookupMaybe(name("XObject"), PDFDict);
      if (!objects) return;
      for (const [, ref] of objects.entries()) {
        const stream = document.context.lookup(ref);
        if (!(stream instanceof PDFRawStream) || stream.dict.get(name("Subtype"))?.toString() !== "/Form" || visited.has(stream)) continue;
        visited.add(stream);
        const own = stream.dict.lookupMaybe(name("Resources"), PDFDict);
        const resolvedFonts = own?.lookupMaybe(name("Font"), PDFDict) ?? fonts;
        if (resolvedFonts) streams.push({ stream, ref, fonts: resolvedFonts, form: true });
        forms(own, fonts);
      }
    };
    forms(resources);
    const fonts = resources?.lookupMaybe(name("Font"), PDFDict);
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    for (const ref of refs) {
      const stream = document.context.lookup(ref);
      if (fonts && stream instanceof PDFRawStream && !visited.has(stream)) {
        visited.add(stream);
        streams.push({ stream, ref, fonts, form: false });
      }
    }
    for (const { stream, ref, fonts, form } of streams) {
      const original = decode(stream);
      let active = "", cursor = 0;
      const repaired = original.replace(/\/Span\s*<<\s*\/ActualText\s*<([0-9A-Fa-f]+)>\s*>>\s*BDC([\s\S]*?)\bEMC/g, (whole, unicode: string, body: string, offset: number) => {
        // Tf persists across marked-content and BT/ET boundaries.
        for (const tf of original.slice(cursor, offset).matchAll(/\/([^\s/]+)\s+[-.\d]+\s+Tf\b/g)) active = tf[1]!;
        cursor = offset + whole.length;
        const actual = PDFHexString.of(unicode).decodeText();
        const runs: { start: number; length: number; edit: FontEdit; glyphs: number[] }[] = [];
        let supported = true;
        for (const token of body.matchAll(/\/([^\s/]+)\s+[-.\d]+\s+Tf\b|<([0-9A-Fa-f\s]*)>\s*Tj\b/g)) {
          if (token[1]) { active = token[1]; continue; }
          const codes = token[2]!.replace(/\s/g, "");
          const font = fonts.lookupMaybe(name(active), PDFDict);
          const edit = font && getFont(font);
          if (!edit || codes.length % 4) { supported = false; continue; }
          const glyphs = codes.match(/.{4}/g)?.map(value => parseInt(value, 16)) ?? [];
          runs.push({ start: token.index!, length: token[0].length, edit, glyphs });
        }
        // Unsupported text-show operators must not be silently duplicated.
        if (!supported || !runs.length || /\bTJ\b|\([^)]*\)\s*Tj/.test(body)) return whole;
        const counts = new Map<FontEdit, number>();
        for (const run of runs) counts.set(run.edit, (counts.get(run.edit) ?? 0) + run.glyphs.length);
        if ([...counts].some(([edit, count]) => edit.next + count > 65536)) return whole;
        const glyphs = runs.flatMap(run => run.glyphs.map(glyph => ({ glyph, edit: run.edit })));
        if (!glyphs.length) return whole;
        // Dots/marks can be drawn first with zero advance. Associate the text
        // with the base glyph's advance, so readers do not invent word spaces.
        let anchor = 0;
        for (let i = 1; i < glyphs.length; i++) if (glyphs[i]!.edit.width(glyphs[i]!.glyph) > glyphs[anchor]!.edit.width(glyphs[anchor]!.glyph)) anchor = i;
        let index = 0, result = "", end = 0;
        for (const run of runs) {
          result += body.slice(end, run.start);
          const codes = run.glyphs.map(glyph => {
            const cid = run.edit.next++;
            run.edit.entries.push({ cid, glyph, text: index++ === anchor ? actual : "", width: run.edit.width(glyph) });
            return hex(cid);
          });
          result += `<${codes.join("")}> Tj`;
          end = run.start + run.length;
        }
        clusters++;
        return whole.slice(0, whole.indexOf("BDC") + 3) + result + body.slice(end) + "EMC";
      });
      if (repaired !== original) {
        const replacement = document.context.flateStream(Buffer.from(repaired, "latin1"));
        // Animated/clipped text is painted inside Form XObjects. Preserve their
        // resources, bounding box and matrix when replacing compressed bytes.
        for (const [key, value] of stream.dict.entries()) {
          if (!["/Length", "/Filter", "/DecodeParms"].includes(key.toString())) replacement.dict.set(key, value);
        }
        if (ref instanceof PDFRef) document.context.assign(ref, replacement);
        else if (!form) page.node.set(name("Contents"), document.context.register(replacement));
      }
    }
  }
  for (const edit of edits.values()) {
    if (!edit.entries.length) continue;
    const map = Buffer.alloc(edit.next * 2);
    for (let cid = 0; cid < edit.next; cid++) map.writeUInt16BE(cid, cid * 2);
    const widths = edit.descendant.lookupMaybe(name("W"), PDFArray) ?? document.context.obj([]);
    for (const entry of edit.entries) {
      map.writeUInt16BE(entry.glyph, entry.cid * 2);
      widths.push(PDFNumber.of(entry.cid));
      widths.push(document.context.obj([entry.width]));
    }
    edit.descendant.set(name("W"), widths);
    edit.descendant.set(name("CIDToGIDMap"), document.context.register(document.context.flateStream(map)));
    const blocks: string[] = [];
    for (let i = 0; i < edit.entries.length; i += 100) {
      const entries = edit.entries.slice(i, i + 100);
      blocks.push(`${entries.length} beginbfchar\n${entries.map(e => `<${hex(e.cid)}> <${textHex(e.text)}>`).join("\n")}\nendbfchar`);
    }
    document.context.assign(edit.cmapRef, document.context.flateStream(Buffer.from(edit.cmap.replace(/endcmap/, `${blocks.join("\n")}\nendcmap`), "latin1")));
  }
  return clusters;
}
