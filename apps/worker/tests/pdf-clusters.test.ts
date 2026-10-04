import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFRawStream } from "pdf-lib";
import { materializeClusters } from "../src/pdf-clusters";

const text = (stream: PDFRawStream) => inflateSync(stream.contents).toString("latin1");
function raw(document: PDFDocument, ref: PDFObject | undefined): PDFRawStream {
  const stream = document.context.lookup(ref);
  if (!(stream instanceof PDFRawStream)) throw new Error("Expected a raw PDF stream");
  return stream;
}

it.each([false, true])("maps a dotted Arabic cluster and retains its glyphs/advances (Form=%s)", async (form) => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const descendant = document.context.obj({ Type: "Font", Subtype: "CIDFontType2", CIDToGIDMap: "Identity", W: [1, [600, 0]] });
  const cmap = document.context.register(document.context.flateStream(Buffer.from("2 beginbfchar\n<0001> <0635>\n<0002> <0000>\nendbfchar\nendcmap")));
  const font = document.context.obj({ Type: "Font", Subtype: "Type0", Encoding: "Identity-H", DescendantFonts: [descendant], ToUnicode: cmap });
  page.node.set(PDFName.of("Resources"), document.context.obj({ Font: { F0: font } }));
  const content = document.context.register(document.context.flateStream(Buffer.from("BT /F0 32 Tf /Span<</ActualText <FEFF0636>>> BDC <0002> Tj 0 0 Td <0001> Tj EMC ET")));
  if (form) {
    const stream = raw(document, content);
    stream.dict.set(PDFName.of("Subtype"), PDFName.of("Form"));
    stream.dict.set(PDFName.of("BBox"), document.context.obj([0, 0, 100, 100]));
    stream.dict.set(PDFName.of("Resources"), document.context.obj({ Font: { F0: font } }));
    page.node.set(PDFName.of("Resources"), document.context.obj({ XObject: { X0: content }, Font: { F0: { Type: "Font", Subtype: "Type1" } } }));
    page.node.set(PDFName.of("Contents"), document.context.register(document.context.flateStream("/X0 Do")));
  } else page.node.set(PDFName.of("Contents"), content);
  expect(materializeClusters(document)).toBe(1);
  const repairedStream = raw(document, form ? content : page.node.get(PDFName.of("Contents")));
  const repaired = text(repairedStream);
  if (form) {
    expect(repairedStream.dict.get(PDFName.of("Subtype"))?.toString()).toBe("/Form");
    expect(repairedStream.dict.get(PDFName.of("BBox"))?.toString()).toBe("[ 0 0 100 100 ]");
    expect(repairedStream.dict.has(PDFName.of("Resources"))).toBe(true);
  }
  expect(repaired).toContain("<0003> Tj");
  expect(repaired).toContain("<0004> Tj");
  const mapping = text(raw(document, cmap));
  expect(mapping).toContain("<0003> <>"); // the zero-width dot carries no second letter
  expect(mapping).toContain("<0004> <0636>"); // the base's position carries ض, not ص
  const glyphMap = inflateSync(raw(document, descendant.get(PDFName.of("CIDToGIDMap"))).contents);
  expect(glyphMap.readUInt16BE(3 * 2)).toBe(2);
  expect(glyphMap.readUInt16BE(4 * 2)).toBe(1);
  const widths = descendant.lookup(PDFName.of("W"), PDFArray);
  expect(widths.lookup(3, PDFArray).lookup(0, PDFNumber).asNumber()).toBe(0);
  expect(widths.lookup(5, PDFArray).lookup(0, PDFNumber).asNumber()).toBe(600);
  // A second pass cannot rename an already remapped font.
  expect(materializeClusters(document)).toBe(0);
});

describe("unsupported PDF encodings", () => {
  it("keeps other fonts and content intact", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage();
    const font: PDFDict = document.context.obj({ Type: "Font", Subtype: "Type1", Encoding: "WinAnsiEncoding" });
    page.node.set(PDFName.of("Resources"), document.context.obj({ Font: { F0: font } }));
    const content = document.context.register(document.context.flateStream(Buffer.from("BT /F0 32 Tf /Span<</ActualText <FEFF0636>>> BDC <0001> Tj EMC ET")));
    page.node.set(PDFName.of("Contents"), content);
    const before = text(raw(document, content));
    expect(materializeClusters(document)).toBe(0);
    expect(text(raw(document, content))).toBe(before);
  });
});
