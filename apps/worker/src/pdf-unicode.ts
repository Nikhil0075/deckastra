/**
 * Text you can copy out of a PDF in Hindi, Arabic and the rest (plan 01
 * recheck, 2026-10-03).
 *
 * Chromium writes a PDF font's ToUnicode map from the font's cmap only: a glyph
 * the cmap names maps to its character, and any other glyph maps to nothing.
 * Shaping makes many glyphs the cmap does not name — Devanagari's vowel sign in
 * its width variants, conjuncts, Arabic's initial, medial and final forms, the
 * lam-alef ligature — and every one of those came out of a copy, a search or a
 * screen reader as U+0000, although the page looked right.
 *
 * Each such glyph exists because a substitution in the font's GSUB table made
 * it from glyphs that do have characters. So the characters are recoverable
 * from the font itself, not guessed: walk every single, alternate, multiple and
 * ligature substitution backwards from the cmap until nothing new is learned,
 * and add what was learned to the map. Contextual lookups only *choose* among
 * those substitutions, and the lookups they point at are in the same list, so
 * walking the list covers them.
 *
 * Chromium's subsets keep the original glyph ids (`CIDToGIDMap /Identity`) and
 * drop the GSUB table, so the walk runs on the full font file the render page
 * was given, found by its PostScript name. A font that cannot be found, or a
 * PDF that cannot be read is left as Chromium wrote it. Font-derived repair
 * fills missing mappings. Chromium's exact ActualText clusters then resolve
 * ambiguous shaped glyphs using occurrence-specific CIDs with identical glyph
 * IDs and advances. Tagged paragraphs carry the DOM's logical source text;
 * drawing operators and positions remain unchanged.
 */

import { inflateSync } from "node:zlib";

// Static imports, so the exporter bundle carries both: an installed app has no
// node_modules, and a runtime require of either would fail every PDF export.
import { create as createFont } from "fontkit";
import { PDFDict, PDFName, PDFRawStream, PDFDocument, PDFArray, PDFRef } from "pdf-lib";
import { materializeClusters } from "./pdf-clusters";
import { paragraphText, type PdfParagraph } from "./pdf-paragraphs";


interface FontkitFont {
  postscriptName: string;
  numGlyphs: number;
  characterSet: number[];
  glyphForCodePoint(codePoint: number): { id: number };
  GSUB?: { lookupList: Iterable<unknown> | { toArray(): unknown[] } };
}

type Lazy<T> = T[] | { toArray(): T[] } | undefined;
const all = <T>(value: Lazy<T>): T[] => (!value ? [] : Array.isArray(value) ? value : value.toArray());

function coverageGlyphs(coverage: { version: number; glyphs?: Lazy<number>; rangeRecords?: Lazy<{ start: number; end: number }> }): number[] {
  if (coverage.version === 1) return all(coverage.glyphs);
  const out: number[] = [];
  for (const range of all(coverage.rangeRecords)) for (let glyph = range.start; glyph <= range.end; glyph += 1) out.push(glyph);
  return out;
}

/**
 * Every glyph's characters: the cmap, then GSUB walked backwards to a fixed
 * point. A glyph keeps the first answer it gets, so a mapping from the cmap is
 * never overwritten by one derived from a substitution.
 */
export function glyphText(font: FontkitFont): Map<number, string> {
  const text = new Map<number, string>();
  for (const codePoint of font.characterSet) {
    const glyph = font.glyphForCodePoint(codePoint).id;
    if (glyph && !text.has(glyph)) text.set(glyph, String.fromCodePoint(codePoint));
  }
  const lookups = all(font.GSUB?.lookupList as Lazy<{ lookupType: number; subTables: Lazy<Record<string, unknown>> }>);
  const subtables: { type: number; table: Record<string, unknown> }[] = [];
  for (const lookup of lookups) {
    for (const table of all(lookup.subTables)) {
      if (lookup.lookupType === 7) {
        const extension = table as { extensionLookupType: number; extension: Record<string, unknown> };
        subtables.push({ type: extension.extensionLookupType, table: extension.extension });
      } else {
        subtables.push({ type: lookup.lookupType, table });
      }
    }
  }
  const learn = (glyph: number, value: string | undefined): boolean => {
    if (value === undefined || value === "" || text.has(glyph)) return false;
    text.set(glyph, value);
    return true;
  };

  // Bounded: each pass can only add, and there are finitely many glyphs.
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    for (const { type, table } of subtables) {
      const coverage = table.coverage ? coverageGlyphs(table.coverage as never) : [];
      if (type === 1) {
        coverage.forEach((input, index) => {
          const output = table.deltaGlyphID !== undefined ? (input + (table.deltaGlyphID as number)) & 0xffff : all(table.substitute as Lazy<number>)[index];
          if (output !== undefined) changed = learn(output, text.get(input)) || changed;
        });
      } else if (type === 2) {
        const sequences = all(table.sequences as Lazy<Lazy<number>>);
        coverage.forEach((input, index) => {
          // One character becoming several glyphs: the first carries it.
          // The rest stay unnamed on purpose. Noto Arabic draws ض as the glyph
          // for ص plus a dot: only the pair says which letter it is, and a
          // per-glyph map cannot. Naming the dot "nothing" would turn ض into ص
          // for every reader of this map — a wrong letter, worse than a blank.
          // Chromium already writes the exact cluster text as /ActualText
          // around each such pair, which Acrobat, Poppler and pdf.js read.
          const [first] = all(sequences[index]);
          if (first !== undefined) changed = learn(first, text.get(input)) || changed;
        });
      } else if (type === 3) {
        const sets = all(table.alternateSet as Lazy<Lazy<number>>);
        coverage.forEach((input, index) => {
          for (const output of all(sets[index])) changed = learn(output, text.get(input)) || changed;
        });
      } else if (type === 4) {
        const sets = all(table.ligatureSets as Lazy<Lazy<{ glyph: number; components: Lazy<number> }>>);
        coverage.forEach((input, index) => {
          for (const ligature of all(sets[index])) {
            const parts = [input, ...all(ligature.components)].map((glyph) => text.get(glyph));
            if (parts.every((part) => part !== undefined)) changed = learn(ligature.glyph, parts.join("")) || changed;
          }
        });
      }
    }
    if (!changed) break;
  }
  return text;
}

/** What a ToUnicode CMap already maps, glyph id to text (both bfchar and bfrange forms). */
function mappedGlyphs(cmap: string): Map<number, string> {
  const mapped = new Map<number, string>();
  const decode = (hex: string): string => {
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  };
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      // Chromium writes `<glyph> <0000>` for a glyph it could not name: that is
      // the blank this exists to fill, not a mapping.
      if (pair[2] && !/^0+$/.test(pair[2])) mapped.set(parseInt(pair[1]!, 16), decode(pair[2]));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const first = parseInt(range[1]!, 16);
      const start = parseInt(range[3]!, 16);
      for (let glyph = first; glyph <= parseInt(range[2]!, 16); glyph += 1) mapped.set(glyph, String.fromCharCode(start + glyph - first));
    }
  }
  return mapped;
}

function utf16Hex(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) out += value.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return out;
}

function streamText(stream: PDFRawStream): string {
  const filter = stream.dict.get(PDFName.of("Filter"));
  const bytes = filter && filter.toString() === "/FlateDecode" ? inflateSync(stream.contents) : stream.contents;
  return Buffer.from(bytes).toString("latin1");
}

/**
 * Add the characters Chromium left out of every embedded font's ToUnicode map.
 * `fontFiles` are the font files the render page declared (woff2 or sfnt).
 * Returns the repaired bytes and how many glyph mappings were added; the input
 * itself when nothing could be added.
 */
export async function repairPdfText(pdf: Uint8Array, fontFiles: readonly Uint8Array[], paragraphs: readonly (readonly PdfParagraph[])[] = []): Promise<{ bytes: Uint8Array; added: number }> {
  const byName = new Map<string, FontkitFont>();
  for (const file of fontFiles) {
    try {
      const font = createFont(Buffer.from(file)) as unknown as FontkitFont;
      if (font.postscriptName && !byName.has(font.postscriptName)) byName.set(font.postscriptName, font);
    } catch {
      // Not a font fontkit reads: its glyphs keep Chromium's mapping.
    }
  }

  let document: PDFDocument;
  try {
    document = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch {
    return { bytes: pdf, added: 0 };
  }
  const texts = new Map<string, Map<number, string>>();
  const done = new Set<string>();
  let added = 0;

  for (const page of document.getPages()) {
    const resources = page.node.Resources();
    const fonts = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
    if (!fonts) continue;
    for (const [, ref] of fonts.entries()) {
      const font = document.context.lookup(ref, PDFDict);
      if (font.get(PDFName.of("Subtype"))?.toString() !== "/Type0") continue;
      const descendant = document.context.lookup(font.lookup(PDFName.of("DescendantFonts"), PDFArray).get(0), PDFDict);
      const descriptor = descendant.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
      const name = descriptor?.get(PDFName.of("FontName"))?.toString().replace(/^\/[A-Z]{6}\+/, "").replace(/^\//, "");
      const source = name ? byName.get(name) : undefined;
      const toUnicodeRef = font.get(PDFName.of("ToUnicode"));
      if (!source || !(toUnicodeRef instanceof PDFRef)) continue;
      if (done.has(toUnicodeRef.toString())) continue;
      done.add(toUnicodeRef.toString());
      const stream = document.context.lookup(toUnicodeRef);
      if (!(stream instanceof PDFRawStream)) continue;

      let glyphs = texts.get(name!);
      if (!glyphs) {
        glyphs = glyphText(source);
        texts.set(name!, glyphs);
      }
      const cmap = streamText(stream);
      const mapped = mappedGlyphs(cmap);
      // The guard: every glyph Chromium named must mean the same in the full
      // font. If the subset had renumbered its glyphs this would disagree, and
      // adding characters by the original numbering would write wrong text —
      // worse than the blanks it replaces. Then the font is left alone.
      let agree = 0;
      let disagree = 0;
      for (const [glyph, value] of mapped) {
        const known = glyphs.get(glyph);
        if (known === undefined || known === "") continue;
        // The same letter named two ways — a base letter and its presentation
        // form, which Arabic fonts map to one glyph — is agreement.
        if (known === value || known.normalize("NFKC") === value.normalize("NFKC")) agree += 1;
        else disagree += 1;
      }
      if (!agree || disagree) continue;
      // Every glyph the font can make that Chromium left unnamed. Ones this page
      // never drew cost a line of the map each and are otherwise inert.
      const missing = [...glyphs.keys()].filter((glyph) => !mapped.has(glyph)).sort((a, b) => a - b);
      if (!missing.length) continue;

      const hex = (glyph: number) => glyph.toString(16).padStart(4, "0").toUpperCase();
      // A blank Chromium wrote is filled where it stands, so its block's count
      // stays true and no code is mapped twice; the rest go in new blocks.
      const filled = new Set<number>();
      let repaired = cmap.replace(/<([0-9A-Fa-f]{4})>(\s*)<0000>/g, (line, code: string, gap: string) => {
        const glyph = parseInt(code, 16);
        const value = glyphs!.get(glyph);
        if (value === undefined) return line;
        filled.add(glyph);
        return `<${code}>${gap}<${utf16Hex(value)}>`;
      });
      const entries = missing.filter((glyph) => !filled.has(glyph)).map((glyph) => `<${hex(glyph)}> <${utf16Hex(glyphs!.get(glyph)!)}>`);
      const blocks: string[] = [];
      for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        blocks.push(`${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar`);
      }
      // A CMap may hold several bfchar blocks; the new ones go before `endcmap`.
      if (blocks.length) repaired = repaired.replace(/endcmap/, `${blocks.join("\n")}\nendcmap`);
      document.context.assign(toUnicodeRef, document.context.flateStream(Buffer.from(repaired, "latin1")));
      added += missing.length;
    }
  }
  added += materializeClusters(document);
  added += paragraphText(document, paragraphs);
  if (!added) return { bytes: pdf, added: 0 };
  return { bytes: await document.save({ useObjectStreams: false, updateFieldAppearances: false }), added };
}

/** The font files declared in a render page's stylesheet, from its `data:` URLs. */
export function fontFilesInCss(css: string): Uint8Array[] {
  return [...css.matchAll(/url\(data:font\/(?:woff2|ttf|otf|sfnt|woff);base64,([A-Za-z0-9+/=]+)\)/g)].map((match) => Buffer.from(match[1]!, "base64"));
}
