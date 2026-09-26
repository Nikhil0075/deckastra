/**
 * PPTX export (doc 04 §33, doc 05 §16).
 *
 * The tests split three ways, and the middle one is the reason this file is long.
 *
 * **The package is well-formed.** A `.pptx` with a missing relationship does not
 * open partially — PowerPoint refuses the whole file — so the structural
 * assertions are not pedantry, they are the difference between an export and a
 * broken download.
 *
 * **Nothing degrades silently.** Every element this build cannot represent
 * natively has to appear in the report. That is the property doc 04 §32.2 asks
 * for, and it is the one that decays first, because the way to break it is to
 * add a feature and forget a ledger line.
 *
 * **The bytes are stable.** Doc 04 §32.3 wants the same version to export to the
 * same file, which makes the result cacheable and an export diffable.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateRawSync } from "node:zlib";

import type { PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { fontManifest, type ExportInput } from "@deckastra/export-core";
import { describe, expect, it } from "vitest";

import { buildPptx } from "../src/index";
import { hex, rotation, unitsFor, xml } from "../src/units";
import { createZip } from "../src/zip";

// ------------------------------------------------------------------ helpers

function fixture(name: string): PresentationDocument {
  const path = fileURLToPath(
    new URL(`../../presentation-schema/fixtures/${name}.mydeck.json`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as PresentationDocument;
}

function inputFor(document: PresentationDocument, options = {}): ExportInput {
  const scene = buildDocumentScene(document);
  const scenes = new Map(scene.slides.map((slide) => [slide.slideId, slide]));
  return {
    document,
    scenes,
    fontManifest: fontManifest(scenes.values()),
    options,
  };
}

/** Read a zip back without a dependency, so the test checks the writer too. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const decoder = new TextDecoder();
  const text = new Map<string, string>();
  for (const [path, data] of unzipRaw(bytes)) text.set(path, decoder.decode(data));
  return text;
}

/** The same walk, keeping the bytes — a media part is not text. */
function unzipRaw(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();

  // Walk the central directory rather than scanning for local headers: a local
  // header signature can occur inside compressed data, and scanning finds it.
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("no end-of-central-directory record");

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central header");

    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);

    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);

    files.set(name, method === 8 ? new Uint8Array(inflateRawSync(data)) : new Uint8Array(data));
    at += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

/**
 * The fixture's image asset, and a real PNG for it.
 *
 * `technical-deck` cites `fixtures/architecture-overview.png`, which is a storage
 * key rather than a file on disk — the manifest records what the deck refers to,
 * not bytes. So the test supplies its own: eight pixels of one colour, written by
 * hand, because a literal base64 blob would be a magic string nobody can check
 * and this one says exactly what it is.
 */
function pngBytes(): Uint8Array {
  const raw = Buffer.alloc(8 * (1 + 8 * 3));
  for (let y = 0; y < 8; y += 1) {
    const row = y * (1 + 8 * 3);
    for (let x = 0; x < 8; x += 1) raw[row + 1 + x * 3] = 255;
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** The asset the technical fixture's image element points at. */
function imageAssetId(document: PresentationDocument): string {
  for (const slide of document.slides) {
    for (const element of slide.elements as { type: string; assetId?: string }[]) {
      if (element.type === "image" && element.assetId) return element.assetId;
    }
  }
  throw new Error("The technical fixture no longer carries an image element.");
}

const TECHNICAL = fixture("technical-deck");
const ANIMATION = fixture("animation-test");

// ------------------------------------------------------------- the package

describe("the package PowerPoint has to open", () => {
  const { bytes } = buildPptx(inputFor(TECHNICAL));
  const files = unzip(bytes);

  it("starts with the content-type map", () => {
    // The OPC specification requires it to be the first part, and readers that
    // stream the zip rely on it being there before anything it describes.
    expect([...files.keys()][0]).toBe("[Content_Types].xml");
  });

  it("declares every part it contains", () => {
    const types = files.get("[Content_Types].xml")!;
    const slideParts = [...files.keys()].filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path));

    expect(slideParts.length).toBe(TECHNICAL.slides.length);
    for (const path of slideParts) {
      expect(types).toContain(`PartName="/${path}"`);
    }
  });

  it("has a complete relationship graph", () => {
    // A dangling relationship is the difference between a file that opens and
    // one PowerPoint refuses outright.
    const referenced = new Set<string>();

    for (const [path, content] of files) {
      if (!path.endsWith(".rels")) continue;

      const base = path.replace(/_rels\/[^/]+$/, "");
      for (const match of content.matchAll(/Target="([^"]+)"/g)) {
        const target = match[1]!;
        if (target.startsWith("http")) continue;
        referenced.add(new URL(target, `file:///${base}`).pathname.replace(/^\//, ""));
      }
    }

    for (const target of referenced) {
      expect(files.has(target), `${target} is referenced but missing`).toBe(true);
    }
  });

  it("numbers slide ids from 256, where PowerPoint expects them", () => {
    const presentation = files.get("ppt/presentation.xml")!;
    expect(presentation).toContain('<p:sldId id="256"');
    // Below 256 the package opens but cannot be edited reliably.
    expect(presentation).not.toMatch(/<p:sldId id="(\d{1,2})"/);
  });

  it("sizes the slide from the document's viewport, not a constant", () => {
    // Doc 04 §33.1 says the factor is derived. A hardcoded 6350 silently
    // stretches any deck not authored at 1920 wide, by exactly enough to look
    // deliberate.
    expect(files.get("ppt/presentation.xml")).toContain('cx="12192000" cy="6858000"');
    expect(unitsFor(1920).emuPerPx).toBe(6350);
    expect(unitsFor(1280).emuPerPx).toBe(9525);
  });

  it("carries the deck's palette into the theme", () => {
    // Every element already has an explicit colour, so this changes nothing
    // about rendering — it changes what the recipient sees in the colour picker.
    const theme = files.get("ppt/theme/theme1.xml")!;
    expect(theme).toContain("<a:clrScheme");
    expect(theme).toMatch(/<a:accent1><a:srgbClr val="[0-9A-F]{6}"\/><\/a:accent1>/);
  });

  it("uses a blank master with no placeholders", () => {
    // Deckastra positions everything absolutely. A master carrying title and
    // body placeholders gives every exported slide two empty boxes the
    // recipient has to delete.
    const master = files.get("ppt/slideMasters/slideMaster1.xml")!;
    expect(master).not.toContain("<p:ph ");
  });
});

// -------------------------------------------------------------- the content

describe("what lands on a slide", () => {
  const { bytes } = buildPptx(inputFor(TECHNICAL));
  const files = unzip(bytes);
  const first = files.get("ppt/slides/slide1.xml")!;

  it("writes text as editable runs, not a picture", () => {
    // The whole reason PPTX is worth having (doc 04 §33.4).
    expect(first).toContain("<a:t>");
    expect(first).toContain("<p:txBody>");
  });

  it("names shapes from element ids so Morph can pair them", () => {
    // Doc 04 §33.3: Morph matches by name. A counter re-numbers whenever a slide
    // gains an element, and every morph silently stops pairing.
    const names = [...first.matchAll(/name="deckastra-(el_[0-9A-Z]+)"/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every shape a unique non-zero id, with 1 reserved for the tree", () => {
    const ids = [...first.matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => Number(match[1]));
    expect(ids[0]).toBe(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 0)).toHaveLength(0);
  });

  it("turns off autofit so PowerPoint does not re-break the lines", () => {
    // The scene already decided where the lines break; re-fitting would move
    // text the author positioned deliberately.
    expect(first).toContain("<a:noAutofit/>");
  });

  it("suppresses bullets on paragraphs that are not lists", () => {
    // PowerPoint's default placeholder style adds one, and a paragraph that
    // grows a bullet in the client's copy is the classic export complaint.
    expect(first).toContain("<a:buNone/>");
  });

  it("paints the slide background rather than inheriting the master's", () => {
    // Inheriting gives a dark deck a white page in the recipient's copy.
    expect(first).toContain("<p:bg>");
  });

  it("carries alt text so a screen reader in PowerPoint has something", () => {
    expect(first).toMatch(/descr="[^"]+"/);
  });
});

// ------------------------------------------------------------- degradation

describe("degradation is reported, never silent", () => {
  const { result } = buildPptx(inputFor(TECHNICAL));

  it("names every feature it could not represent natively", () => {
    // The technical fixture contains charts, diagrams, tables and icons, none of
    // which this build writes natively.
    expect(result.report.unsupportedFeatures.length).toBeGreaterThan(0);
    expect(result.report.warnings.length).toBeGreaterThan(0);
  });

  it("reports the image it was given no bytes for", () => {
    // This `result` is built with no `images` map, which is the honest state for
    // a caller that has not supplied any: the picture becomes a labelled box and
    // the report says which one and why. The embedded case is its own block
    // below — both matter, because "the export succeeded" is true of each and
    // only one of them is a deck.
    const listed = JSON.stringify(result.report.unsupportedFeatures).toLowerCase();
    expect(listed).toContain("image");

    const warning = result.report.warnings.find((one) => one.feature === "image")!;
    expect(warning.action).toBe("dropped");
    expect(warning.message).toMatch(/bytes were not available/);
  });

  it("says what happened, not just that something did", () => {
    // "Unsupported" tells a reader nothing. "Rasterized" tells them the text is
    // no longer selectable; "dropped" tells them to look for what is missing.
    for (const warning of result.report.warnings) {
      expect(["flattened", "rasterized", "dropped", "approximated"]).toContain(warning.action);
      expect(warning.message.length).toBeGreaterThan(20);
    }
  });

  it("never claims a raster it did not write", () => {
    // The placeholder path reported `rasterized`, which tells a reader the
    // appearance survived as an image and only the selectable text was lost.
    // This build embeds no image for those elements — it draws a dashed box —
    // so the honest action is `dropped`. A report that flatters the file is
    // worse than no report: it is believed.
    const rasterized = result.report.warnings.filter(
      (warning) => warning.action === "rasterized",
    );
    expect(rasterized).toEqual([]);

    const dropped = result.report.warnings.filter((warning) => warning.action === "dropped");
    expect(dropped.length).toBeGreaterThan(0);
    for (const warning of dropped) expect(warning.message).toMatch(/not in the file/);
  });

  it("lists the elements that were flattened", () => {
    expect(result.report.flattenedElements.length).toBeGreaterThan(0);
    for (const id of result.report.flattenedElements) expect(id).toMatch(/^el_/);
  });

  it("deduplicates so one feature is one line, not forty", () => {
    const keys = result.report.warnings.map(
      (warning) => `${warning.slideId}|${warning.feature}|${warning.action}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reports the slide count it actually wrote", () => {
    expect(result.report.slideCount).toBe(TECHNICAL.slides.length);
  });

  it("nothing vanishes: every visible element is a shape or a reported placeholder", () => {
    // The failure a compatibility export cannot have — the user hands the file
    // to a client and finds the gap from them.
    const files = unzip(buildPptx(inputFor(TECHNICAL)).bytes);
    const slideXml = files.get("ppt/slides/slide1.xml")!;
    const scene = buildDocumentScene(TECHNICAL).slides[0]!;

    const visible = scene.paintOrder.filter((id) => {
      const node = [...flattenNodes(scene.nodes)].find((one) => one.id === id);
      return node && !node.flags.hidden;
    });

    for (const id of visible) {
      expect(slideXml, `${id} is missing from the exported slide`).toContain(`deckastra-${id}`);
    }
  });
});

function* flattenNodes(nodes: ReturnType<typeof buildDocumentScene>["slides"][number]["nodes"]): Generator<(typeof nodes)[number]> {
  for (const node of nodes) {
    yield node;
    if (node.children) yield* flattenNodes(node.children);
  }
}

// ---------------------------------------------------------------- animation

describe("animation mapping", () => {
  const { bytes, result } = buildPptx(inputFor(ANIMATION));
  const files = unzip(bytes);

  it("writes timing nodes for a slide that animates", () => {
    // Slide 1's clips name `fadeUp`, which PowerPoint has no effect for. It
    // still animates: the browser degrades an unknown preset to a fade, so an
    // export that dropped it would disagree with what the author saw.
    expect(files.get("ppt/slides/slide1.xml")).toContain("<p:timing>");
    expect(
      result.report.warnings.some((warning) => warning.feature === "animation:fadeUp"),
    ).toBe(true);
  });

  it("writes none for a slide that does not", () => {
    // An empty `<p:timing/>` reads as "animation deliberately cleared" and
    // suppresses the master's behaviour, which is not what an unanimated slide
    // means.
    const last = files.get(`ppt/slides/slide${ANIMATION.slides.length}.xml`)!;
    expect(last).not.toContain("<p:timing>");
  });

  it("makes a click-triggered reveal wait for the presenter", () => {
    // `delay="indefinite"` is what makes PowerPoint stop, which is the whole of
    // click-to-reveal (doc 04 §33.3).
    const clickSlide = files.get("ppt/slides/slide2.xml")!;
    expect(clickSlide).toContain('<p:cond delay="indefinite"/>');
  });

  it("gives a morph's paired objects one name across both slides", () => {
    // Morph pairs by name (doc 04 §33.3). Names derive from element ids, which
    // is stable across edits and — on its own — useless here: two paired
    // elements are two different elements, so their names differ and PowerPoint
    // pairs nothing. The destination borrows the source's name.
    const morphIndex = ANIMATION.slides.findIndex(
      (slide) => slide.transition?.type === "morph",
    );
    expect(morphIndex).toBeGreaterThan(0);

    const mappings = ANIMATION.slides[morphIndex]!.transition!.sharedElements!;
    expect(mappings.length).toBeGreaterThan(0);

    const from = files.get(`ppt/slides/slide${morphIndex}.xml`)!;
    const to = files.get(`ppt/slides/slide${morphIndex + 1}.xml`)!;

    for (const mapping of mappings) {
      const shared = `name="deckastra-${mapping.sourceElementId}"`;
      expect(from).toContain(shared);
      // The same name on the next slide, even though the element there has a
      // different id. That is the whole mechanism.
      expect(to).toContain(shared);
      expect(to).not.toContain(`name="deckastra-${mapping.destinationElementId}"`);
    }
  });

  it("says a morph exports as a fade rather than implying it will morph", () => {
    // The previous message said the names let PowerPoint "pair objects", which
    // reads as though the transition morphs. It does not: the file carries a
    // fade, and a report that implies otherwise is the kind of claim this
    // ledger exists to prevent.
    const morph = result.report.warnings.find(
      (warning) => warning.feature === "transition:morph",
    );

    expect(morph).toBeDefined();
    expect(morph!.message).toContain("fade");
    expect(morph!.action).toBe("approximated");
  });

  it("reports the presets it could only approximate", () => {
    const approximated = result.report.warnings.filter(
      (warning) => warning.feature.startsWith("animation:") || warning.feature.startsWith("transition:"),
    );
    expect(approximated.length).toBeGreaterThan(0);
  });

  it("never animates a shape id that is not in the tree", () => {
    // A timing node pointing at a missing shape makes PowerPoint discard every
    // animation on the slide, not just that one.
    for (const [path, content] of files) {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(path)) continue;

      const shapeIds = new Set(
        [...content.matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => match[1]),
      );
      for (const match of content.matchAll(/spid="(\d+)"/g)) {
        expect(shapeIds.has(match[1]!), `${path} animates missing shape ${match[1]}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------- stability

describe("determinism", () => {
  it("exports the same deck to the same bytes", () => {
    // Doc 04 §32.3. Every general-purpose zip library writes the current time
    // into each entry, which is why this package has its own writer.
    const first = buildPptx(inputFor(TECHNICAL)).bytes;
    const second = buildPptx(inputFor(TECHNICAL)).bytes;
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it("takes its timestamps from the document, not the clock", () => {
    const files = unzip(buildPptx(inputFor(TECHNICAL)).bytes);
    expect(files.get("docProps/core.xml")).toContain(TECHNICAL.createdAt);
  });

  it("orders the report so two identical exports read identically", () => {
    const first = buildPptx(inputFor(TECHNICAL)).result.report;
    const second = buildPptx(inputFor(TECHNICAL)).result.report;
    expect(second.warnings).toEqual(first.warnings);
    expect(second.unsupportedFeatures).toEqual(first.unsupportedFeatures);
  });
});

// -------------------------------------------------------------- selection

describe("which slides get exported", () => {
  it("excludes hidden slides by default", () => {
    const hidden: PresentationDocument = {
      ...TECHNICAL,
      slides: TECHNICAL.slides.map((slide, index) =>
        index === 1 ? { ...slide, hidden: true } : slide,
      ),
    };
    expect(buildPptx(inputFor(hidden)).result.report.slideCount).toBe(TECHNICAL.slides.length - 1);
  });

  it("includes a hidden slide that was named explicitly", () => {
    // Naming a slide is an instruction. Dropping it silently would be the export
    // refusing one.
    const hidden: PresentationDocument = {
      ...TECHNICAL,
      slides: TECHNICAL.slides.map((slide, index) =>
        index === 1 ? { ...slide, hidden: true } : slide,
      ),
    };
    const options = { slideIds: [TECHNICAL.slides[1]!.id] };
    expect(buildPptx(inputFor(hidden, options)).result.report.slideCount).toBe(1);
  });

  it("writes speaker notes only when asked", () => {
    // None of the fixtures carry notes, so this builds a deck that does.
    const noted: PresentationDocument = {
      ...TECHNICAL,
      slides: TECHNICAL.slides.map((slide, index) =>
        index === 0 ? { ...slide, speakerNotes: "Open on the problem, not the product." } : slide,
      ),
    };

    const without = unzip(buildPptx(inputFor(noted)).bytes);
    expect([...without.keys()].some((path) => path.includes("notesSlide"))).toBe(false);

    const withNotes = unzip(buildPptx(inputFor(noted, { includeNotes: true })).bytes);
    expect(withNotes.get("ppt/notesSlides/notesSlide1.xml")).toContain("Open on the problem");
    // The notes master is required by the relationship graph; without it the
    // package has a dangling reference and PowerPoint refuses the file.
    expect(withNotes.has("ppt/notesMasters/notesMaster1.xml")).toBe(true);
  });
});

// ------------------------------------------------------------------ units

describe("units and escaping", () => {
  it("converts logical pixels to EMU exactly at the default viewport", () => {
    // Doc 04 §33.1: 12192000 / 1920 = 6350, and it has to be exact or a
    // full-bleed element misses the slide edge by a visible sliver.
    const units = unitsFor(1920);
    expect(units.px(1920)).toBe(12_192_000);
    expect(units.px(1080)).toBe(6_858_000);
  });

  it("converts font size to hundredths of a point", () => {
    // 96dpi px → pt is ×0.75.
    expect(unitsFor(1920).fontSize(88)).toBe(6600);
  });

  it("normalises colours a client might have authored several ways", () => {
    expect(hex("#4CC2FF")).toBe("4CC2FF");
    expect(hex("#abc")).toBe("AABBCC");
    expect(hex("rgb(76, 194, 255)")).toBe("4CC2FF");
    // Unparseable becomes black rather than absent: a missing fill in PowerPoint
    // means "inherit from the theme", and inheriting a colour the deck never
    // chose is worse than a wrong one.
    expect(hex("chartreuse")).toBe("000000");
  });

  it("expresses rotation in sixtieths of a degree, normalised", () => {
    expect(rotation(90)).toBe(5_400_000);
    expect(rotation(-90)).toBe(rotation(270));
  });

  it("escapes what would otherwise make PowerPoint refuse the file", () => {
    expect(xml('a & b < c > d "e" \'f\'')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
    // XML 1.0 forbids most control characters outright, and one stray byte makes
    // PowerPoint reject the whole package rather than skip the run.
    expect(xml("cleantext")).toBe("cleantext");
  });
});

describe("the zip writer", () => {
  it("round-trips what it wrote", () => {
    const bytes = createZip([
      { path: "a.txt", data: "hello" },
      { path: "nested/b.xml", data: "<x>".repeat(400) },
    ]);
    const files = unzip(bytes);
    expect(files.get("a.txt")).toBe("hello");
    expect(files.get("nested/b.xml")).toBe("<x>".repeat(400));
  });

  it("writes the same bytes for the same input", () => {
    const once = createZip([{ path: "a.txt", data: "hello" }]);
    const twice = createZip([{ path: "a.txt", data: "hello" }]);
    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
  });

  it("stores rather than deflates when deflating would grow the entry", () => {
    // A "compressed" entry larger than its input is the kind of thing that makes
    // a reader suspect the file.
    const bytes = createZip([{ path: "t", data: "x" }]);
    expect(unzip(bytes).get("t")).toBe("x");
  });
});

// ---------------------------------------------------------------- pictures

/**
 * A picture in the file (2026-09-17).
 *
 * The adapter routed every image to `unsupported()` from the day it was written:
 * a dashed box with the element's name in it, and a line in the report saying
 * so. Truthful, and not a deck — a client opening "my slides" to find a grey
 * rectangle where the product photograph was is precisely the outcome doc 04
 * §33.4 is about.
 *
 * A picture in a `.pptx` is three things that have to agree: **bytes** under
 * `ppt/media/`, a **content type** for the extension, and a **relationship** from
 * the slide whose `r:embed` names it. Any one missing and PowerPoint refuses the
 * whole file rather than the picture, which is why they are asserted together.
 */
describe("a picture the exporter was given", () => {
  const assetId = imageAssetId(TECHNICAL);
  const png = pngBytes();
  const { bytes, result } = buildPptx({
    ...inputFor(TECHNICAL),
    images: new Map([[assetId, { bytes: png, contentType: "image/png" }]]),
  });
  const files = unzipRaw(bytes);
  const text = unzip(bytes);

  it("puts the bytes in the package, unchanged", () => {
    const media = [...files.keys()].filter((path) => path.startsWith("ppt/media/"));
    expect(media).toEqual(["ppt/media/image1.png"]);
    // Byte for byte: an exporter that re-encoded a photograph would be making a
    // quality decision nobody asked it to make.
    expect([...files.get("ppt/media/image1.png")!]).toEqual([...png]);
  });

  it("names the relationship the slide actually embeds", () => {
    // The `Id` in the rels part and the `r:embed` in the slide are the same
    // string, and two places counting is one place getting it wrong.
    const slide = [...text.entries()].find(
      ([path, body]) => /^ppt\/slides\/slide\d+\.xml$/.test(path) && body.includes("<p:pic>"),
    )!;
    const index = slide[0].match(/slide(\d+)\.xml$/)![1];
    const embed = slide[1].match(/r:embed="(rId\d+)"/)![1];

    const rels = text.get(`ppt/slides/_rels/slide${index}.xml.rels`)!;
    expect(rels).toContain(`Id="${embed}"`);
    expect(rels).toContain('Target="../media/image1.png"');
    expect(rels).toContain("/relationships/image");
  });

  it("declares the extension, or the file will not open", () => {
    expect(text.get("[Content_Types].xml")!).toContain(
      '<Default Extension="png" ContentType="image/png"/>',
    );
  });

  it("stops reporting it as dropped", () => {
    // The point of the change. A report still saying "dropped" about a picture
    // that is in the file would be the ledger lying in the other direction, and
    // someone would go looking for a gap that is not there.
    const aboutImages = result.report.warnings.filter((one) => one.feature === "image");
    expect(aboutImages.filter((one) => one.action === "dropped")).toEqual([]);
    expect(result.report.unsupportedFeatures).not.toContain("image");
  });

  it("letterboxes a contained picture instead of stretching it", () => {
    // DrawingML has no `object-fit`. `contain` is geometry: the shape shrinks to
    // the picture's aspect ratio and centres inside the author's box.
    //
    // Measured against a **square** box, deliberately. The fixture's own image
    // box is already 16:9, so a picture of a 16:9 asset fills it exactly whether
    // the adapter fitted it or simply stretched it — an assertion there passes
    // against code that does nothing, which is how a fit gets quietly lost.
    const square = structuredClone(TECHNICAL);
    const element = square.slides
      .flatMap((slide) => slide.elements as { type: string; transform: Record<string, number> }[])
      .find((one) => one.type === "image")!;
    element.transform = { ...element.transform, width: 400, height: 400 };

    const { bytes: fitted } = buildPptx({
      ...inputFor(square),
      images: new Map([[assetId, { bytes: png, contentType: "image/png" }]]),
    });
    const drawn = [...unzip(fitted).values()].find((body) => body.includes("<p:pic>"))!;
    const ext = drawn.match(/<p:pic>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/)!;
    const ratio = Number(ext[1]) / Number(ext[2]);

    // The asset's 16:9, not the box's 1:1.
    expect(Math.abs(ratio - 1600 / 900)).toBeLessThan(0.02);
    expect(Math.abs(ratio - 1)).toBeGreaterThan(0.5);
  });

  it("crops a covered picture rather than letterboxing it", () => {
    // `cover` keeps the author's box and crops the source, which DrawingML
    // expresses as `srcRect` insets in thousandths of a percent. The two fits
    // produce visibly different slides and only one of them is what was asked
    // for, so the adapter has to distinguish them.
    const covered = structuredClone(TECHNICAL);
    const element = covered.slides
      .flatMap((slide) => slide.elements as { type: string; fit?: string; transform: Record<string, number> }[])
      .find((one) => one.type === "image")!;
    element.fit = "cover";
    element.transform = { ...element.transform, width: 400, height: 400 };

    const { bytes: cropped } = buildPptx({
      ...inputFor(covered),
      images: new Map([[assetId, { bytes: png, contentType: "image/png" }]]),
    });
    const drawn = [...unzip(cropped).values()].find((body) => body.includes("<p:pic>"))!;

    // A 16:9 source in a square box loses the sides, half from each.
    const crop = drawn.match(/<a:srcRect l="(\d+)" t="(\d+)" r="(\d+)" b="(\d+)"\/>/)!;
    expect(Number(crop[1])).toBeGreaterThan(0);
    expect(Number(crop[2])).toBe(0);
    expect(crop[1]).toBe(crop[3]);

    // And the shape still fills the box the author drew.
    const ext = drawn.match(/<p:pic>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/)!;
    expect(ext[1]).toBe(ext[2]);
  });

  it("crops a repositioned picture where the editor shows it, not centred again (MA-22)", () => {
    // The renderer draws `focalPoint` as CSS object-position; the window starts
    // that fraction of the way along the overflow. A picture pushed to its left
    // edge in the editor must lose only its right side in PowerPoint.
    const covered = structuredClone(TECHNICAL);
    const element = covered.slides
      .flatMap((slide) => slide.elements as { type: string; fit?: string; focalPoint?: unknown; transform: Record<string, number> }[])
      .find((one) => one.type === "image")!;
    element.fit = "cover";
    element.focalPoint = { x: 0, y: 0.5 };
    element.transform = { ...element.transform, width: 400, height: 400 };

    const { bytes } = buildPptx({
      ...inputFor(covered),
      images: new Map([[assetId, { bytes: png, contentType: "image/png" }]]),
    });
    const drawn = [...unzip(bytes).values()].find((body) => body.includes("<p:pic>"))!;
    const crop = drawn.match(/<a:srcRect l="(\d+)" t="(\d+)" r="(\d+)" b="(\d+)"\/>/)!;
    expect(Number(crop[1])).toBe(0);
    expect(Number(crop[3])).toBeGreaterThan(0);
  });

  it("refuses a format PowerPoint will not open, and says which", () => {
    // Embedding a webp because it is "an image" produces a file that opens with
    // a broken picture in it, which is worse than a labelled box: the recipient
    // cannot tell whether it is their machine.
    const refused = buildPptx({
      ...inputFor(TECHNICAL),
      images: new Map([[assetId, { bytes: png, contentType: "image/webp" }]]),
    });
    expect(
      [...unzipRaw(refused.bytes).keys()].filter((path) => path.startsWith("ppt/media/")),
    ).toEqual([]);

    const warning = refused.result.report.warnings.find((one) => one.feature === "image")!;
    expect(warning.action).toBe("dropped");
    expect(warning.message).toMatch(/does not open image\/webp/);
  });

  it("writes the same bytes twice", () => {
    // Doc 04 §32.3 reaches the media parts too: numbering them by insertion order
    // rather than by anything a run can vary is what keeps that true.
    const again = buildPptx({
      ...inputFor(TECHNICAL),
      images: new Map([[assetId, { bytes: png, contentType: "image/png" }]]),
    });
    expect([...again.bytes]).toEqual([...bytes]);
  });
});

/**
 * A slide background that is a photograph.
 *
 * `scene.background.assetId` was read by nothing in this adapter, so a full-bleed
 * image became the theme's flat colour with **no line in the report** — the exact
 * silent degradation the ledger exists to prevent, and one nobody would find by
 * reading the file, because a flat background looks deliberate.
 */
describe("a slide background picture", () => {
  const assetId = imageAssetId(TECHNICAL);
  const png = pngBytes();

  function withBackground(): PresentationDocument {
    const document = structuredClone(TECHNICAL);
    document.slides[0]!.background = { assetId } as never;
    return document;
  }

  it("becomes a blipFill rather than the theme colour", () => {
    const { bytes } = buildPptx({
      ...inputFor(withBackground()),
      images: new Map([[assetId, { bytes: png, contentType: "image/png" }]]),
    });
    const files = unzip(bytes);
    const first = files.get("ppt/slides/slide1.xml")!;

    expect(first).toContain("<p:bg><p:bgPr><a:blipFill");
    expect(first).not.toContain("<p:bg><p:bgPr><a:solidFill");

    const embed = first.match(/<p:bg>[\s\S]*?r:embed="(rId\d+)"/)![1];
    expect(files.get("ppt/slides/_rels/slide1.xml.rels")!).toContain(`Id="${embed}"`);
  });

  it("falls back to the colour and says so when it has no bytes", () => {
    // Without this the picture vanished and the report was silent, which reads as
    // a deck that was always this colour.
    const { bytes, result } = buildPptx(inputFor(withBackground()));

    expect(unzip(bytes).get("ppt/slides/slide1.xml")!).toContain("<a:solidFill>");
    const warning = result.report.warnings.find((one) => one.feature === "background image")!;
    expect(warning.action).toBe("dropped");
    expect(warning.message).toMatch(/bytes were not available/);
  });
});

describe("charts, tables and diagrams are in the file (manual-authoring MA-17 to MA-19)", () => {
  function withChart(chartType: string) {
    const document = structuredClone(TECHNICAL);
    const slide = document.slides[0]!;
    (slide.elements as unknown[]).push({
      id: "el_01JCHARTCHARTCHARTCHARTCHA",
      type: "chart",
      chartType,
      transform: { x: 100, y: 100, width: 800, height: 500 },
      data: { type: "inline", rows: [{ q: "Q1", v: 10 }, { q: "Q2", v: 25 }, { q: "Q3", v: 15 }] },
      encoding: { category: "q", value: "v" },
      chartStyle: { showDataLabels: true },
      altText: "Quarterly values",
    });
    return document;
  }

  it.each(["column", "line", "pie", "donut"])("draws a %s chart as shapes with its labels as text, and says it approximated", (kind) => {
    const { bytes, result } = buildPptx(inputFor(withChart(kind)));
    const report = result.report;
    const slide = [...unzip(bytes).entries()].find(([path]) => path === "ppt/slides/slide1.xml")![1];
    expect(slide).toContain('name="deckastra-el_01JCHARTCHARTCHARTCHARTCHA"');
    expect(slide).toMatch(/<p:grpSp>/);
    // Every label the slide shows is text in the file: tick labels, data
    // labels, the legend — whatever this kind of chart draws.
    const node = [...buildDocumentScene(withChart(kind)).slides[0]!.nodes].find((candidate) => candidate.id === "el_01JCHARTCHARTCHARTCHARTCHA")!;
    const payload = node.renderPayload as { texts: { text: string }[]; legend: { label: string }[] };
    const shown = [...payload.texts.map((text) => text.text), ...payload.legend.map((item) => item.label)];
    expect(shown.length).toBeGreaterThan(0);
    for (const label of shown) expect(slide).toContain(`<a:t>${label.replace(/&/g, "&amp;")}</a:t>`);
    const chart = report.warnings.filter((warning) => warning.feature === "chart");
    expect(chart.map((warning) => warning.action)).toEqual(["approximated"]);
  });
});

describe("SVG paths as DrawingML", () => {
  it("flattens an arc to its end point and keeps curves as curves", async () => {
    const { parsePath } = await import("../src/drawn");
    const arc = parsePath("M 100 50 A 50 50 0 0 1 50 100 L 50 50 Z");
    const lines = arc.filter((segment) => segment.op === "L");
    const last = lines.at(-2) as { to: { x: number; y: number } };
    expect(last.to.x).toBeCloseTo(50, 5);
    expect(last.to.y).toBeCloseTo(100, 5);
    // A quarter circle of radius 50 about (50, 50): every point on it is 50 away.
    for (const segment of lines.slice(0, -1)) {
      const { x, y } = (segment as { to: { x: number; y: number } }).to;
      expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(50, 3);
    }
    expect(parsePath("M0 0 C 1 1 2 2 3 3 s 4 4 5 5").map((segment) => segment.op)).toEqual(["M", "C", "C"]);
    expect(parsePath("m 10 10 h 5 v 5 z").map((segment) => segment.op)).toEqual(["M", "L", "L", "Z"]);
  });
});
