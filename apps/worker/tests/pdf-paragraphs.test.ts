import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { PDFDocument, PDFHexString, PDFName, PDFRawStream } from "pdf-lib";
import { paragraphText } from "../src/pdf-paragraphs";

async function taggedParagraph() {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const content = document.context.register(document.context.flateStream(Buffer.from(
    "/NonStruct <</MCID 0>> BDC BT /ReversedChars BMC /Span<</ActualText <FEFF0636>>> BDC <0001> Tj EMC EMC ET EMC",
  )));
  page.node.set(PDFName.of("Contents"), content);
  const paragraph = document.context.obj({ Type: "StructElem", S: "P", Pg: page.ref, K: 0 });
  document.catalog.set(PDFName.of("StructTreeRoot"), document.context.obj({ Type: "StructTreeRoot", K: [paragraph] }));
  const text = () => {
    const stream = document.context.lookup(page.node.get(PDFName.of("Contents")));
    if (!(stream instanceof PDFRawStream)) throw new Error("Expected a raw PDF stream");
    return inflateSync(stream.contents).toString("latin1");
  };
  return { document, text };
}

it("carries logical RTL paragraph text over its nested glyph paint fragments", async () => {
  const { document, text } = await taggedParagraph();
  expect(paragraphText(document, [[{ kind: "P", text: "عرض واحد بأربع لغات" }]])).toBe(1);
  expect(text()).toContain(`/ActualText ${PDFHexString.fromText("عرض واحد بأربع لغات")}`);
  expect(text()).toContain("/Span <</MCID 0 /ActualText");
  expect(text().match(/\/ActualText/g)).toHaveLength(1);
  expect(text()).not.toContain("ReversedChars");
  expect(text()).toContain("<0001> Tj"); // painting remains untouched
});

it("does not guess when the DOM and PDF paragraph structures disagree", async () => {
  const { document, text } = await taggedParagraph();
  const before = text();
  expect(paragraphText(document, [[{ kind: "LI", text: "other content" }]])).toBe(0);
  expect(text()).toBe(before);
});
