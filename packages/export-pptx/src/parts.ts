/**
 * The XML parts a `.pptx` is made of.
 *
 * A PPTX is an Open Packaging Convention zip: a content-type map, a relationship
 * graph, and one XML part per slide plus the masters they inherit from. None of
 * it is optional — PowerPoint refuses a package with a missing relationship
 * rather than opening it partially — so the shapes here are the minimum that a
 * real PowerPoint will open, not a subset that happens to work in a viewer.
 *
 * Everything is written as strings rather than through a DOM. The parts are
 * small, fixed and mostly constant, and a builder API would add indirection
 * between this file and the specification it is transcribing.
 */

import { SLIDE_HEIGHT_EMU, SLIDE_WIDTH_EMU, xml } from "./units";

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const NS_PRESENTATION =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

export function contentTypes(
  slideCount: number,
  hasNotes: boolean,
  imageExtensions: readonly string[] = [],
): string {
  const slides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ` +
      `ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");

  const notes = hasNotes
    ? Array.from(
        { length: slideCount },
        (_, index) =>
          `<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ` +
          `ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
      ).join("") +
      `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ` +
      `ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>`
    : "";

  return (
    XML_DECLARATION +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    // Anything beyond the two always-declared defaults. A media part whose
    // extension has no content type is a package a reader refuses to open, so
    // this is not decoration: it is the third of the three things that have to
    // agree about a picture (bytes, content type, relationship).
    imageExtensions
      .filter((extension) => extension !== "png" && extension !== "jpeg")
      .map(
        (extension) =>
          `<Default Extension="${extension}" ContentType="image/${extension}"/>`,
      )
      .join("") +
    '<Override PartName="/ppt/presentation.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '<Override PartName="/docProps/core.xml" ' +
    'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    slides +
    notes +
    "</Types>"
  );
}

export function rootRelationships(): string {
  return (
    XML_DECLARATION +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    "</Relationships>"
  );
}

export function presentation(slideCount: number): string {
  // Slide ids start at 256: PowerPoint reserves everything below it, and a
  // package using low ids opens but cannot be edited reliably.
  const ids = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
  ).join("");

  return (
    XML_DECLARATION +
    `<p:presentation ${NS_PRESENTATION} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${ids}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}"/>` +
    // Notes pages are portrait even when the slide is landscape; this is the
    // conventional A4-ish size PowerPoint itself writes.
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    "</p:presentation>"
  );
}

export function presentationRelationships(slideCount: number, hasNotes: boolean): string {
  const slides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Relationship Id="rId${index + 2}" ` +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ' +
      `Target="slides/slide${index + 1}.xml"/>`,
  ).join("");

  const themeId = slideCount + 2;
  const notesMaster = hasNotes
    ? `<Relationship Id="rId${themeId + 1}" ` +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" ' +
      'Target="notesMasters/notesMaster1.xml"/>'
    : "";

  return (
    XML_DECLARATION +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    slides +
    `<Relationship Id="rId${themeId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
    notesMaster +
    "</Relationships>"
  );
}

/**
 * One slide.
 *
 * `<p:bg>` carries the slide background because a Deckastra slide always has
 * one, and inheriting the master's would give the client's copy a white page
 * behind a dark deck.
 */
export function slide(shapes: string, background: string, timing: string): string {
  return (
    XML_DECLARATION +
    `<p:sld ${NS_PRESENTATION}><p:cSld>${background}` +
    "<p:spTree>" +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes +
    "</p:spTree></p:cSld>" +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    timing +
    "</p:sld>"
  );
}

export function solidBackground(colour: string): string {
  return `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
}

export function slideRelationships(
  hasNotes: boolean,
  notesIndex: number,
  images: readonly { id: string; target: string }[] = [],
): string {
  const notes = hasNotes
    ? '<Relationship Id="rId2" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" ' +
      `Target="../notesSlides/notesSlide${notesIndex}.xml"/>`
    : "";

  // One per picture this slide draws. The ids come from the media registry
  // rather than being counted here, because the `r:embed` inside the shape and
  // the `Id` here are the same string and two places counting is one place
  // getting it wrong.
  const media = images
    .map(
      (image) =>
        `<Relationship Id="${image.id}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
        `Target="${image.target}"/>`,
    )
    .join("");

  return (
    XML_DECLARATION +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    notes +
    media +
    "</Relationships>"
  );
}

/**
 * A slide whose background is a picture.
 *
 * The scene carries `background.assetId` and this adapter ignored it entirely —
 * a full-bleed photograph simply became the theme's flat colour, with nothing in
 * the report saying so. `<a:blipFill>` with `stretch` is the background case:
 * the box is the slide, so there is no fit to honour.
 */
export function imageBackground(relationshipId: string): string {
  return (
    "<p:bg><p:bgPr>" +
    `<a:blipFill rotWithShape="1"><a:blip r:embed="${relationshipId}"/>` +
    "<a:stretch><a:fillRect/></a:stretch></a:blipFill>" +
    "<a:effectLst/></p:bgPr></p:bg>"
  );
}

/**
 * A blank master and layout.
 *
 * Deliberately empty of placeholders. Deckastra positions every element
 * absolutely, so a master with title and body placeholders would give every
 * exported slide two empty boxes that the recipient has to delete.
 */
export function slideMaster(): string {
  return (
    XML_DECLARATION +
    `<p:sldMaster ${NS_PRESENTATION}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    "</p:spTree></p:cSld>" +
    "<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" " +
    "accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>" +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    "</p:sldMaster>"
  );
}

export function slideMasterRelationships(): string {
  return (
    XML_DECLARATION +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    "</Relationships>"
  );
}

export function slideLayout(): string {
  return (
    XML_DECLARATION +
    `<p:sldLayout ${NS_PRESENTATION} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    "</p:spTree></p:cSld>" +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    "</p:sldLayout>"
  );
}

export function slideLayoutRelationships(): string {
  return (
    XML_DECLARATION +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
    "</Relationships>"
  );
}

/**
 * The theme.
 *
 * Populated from the deck's own palette so that a recipient using PowerPoint's
 * colour picker sees the deck's colours rather than Office's defaults. Every
 * element already carries an explicit `srgbClr`, so this changes nothing about
 * how the file renders — it changes what happens when someone edits it.
 */
export function theme(palette: {
  background: string;
  foreground: string;
  accent: string;
  fontHeading: string;
  fontBody: string;
}): string {
  const accents = [palette.accent, "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5"];

  return (
    XML_DECLARATION +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Deckastra">' +
    "<a:themeElements><a:clrScheme name=\"Deckastra\">" +
    `<a:dk1><a:srgbClr val="${palette.foreground}"/></a:dk1>` +
    `<a:lt1><a:srgbClr val="${palette.background}"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="${palette.foreground}"/></a:dk2>` +
    `<a:lt2><a:srgbClr val="${palette.background}"/></a:lt2>` +
    accents
      .map((colour, index) => `<a:accent${index + 1}><a:srgbClr val="${colour}"/></a:accent${index + 1}>`)
      .join("") +
    `<a:hlink><a:srgbClr val="${palette.accent}"/></a:hlink>` +
    `<a:folHlink><a:srgbClr val="${palette.accent}"/></a:folHlink>` +
    "</a:clrScheme>" +
    `<a:fontScheme name="Deckastra">` +
    `<a:majorFont><a:latin typeface="${xml(palette.fontHeading)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="${xml(palette.fontBody)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    "</a:fontScheme>" +
    "<a:fmtScheme name=\"Deckastra\">" +
    "<a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>" +
    "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>" +
    "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst>" +
    "<a:lnStyleLst>" +
    '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    "</a:lnStyleLst>" +
    "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>" +
    "<a:effectStyle><a:effectLst/></a:effectStyle>" +
    "<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
    "<a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>" +
    "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>" +
    "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst>" +
    "</a:fmtScheme></a:themeElements></a:theme>"
  );
}

// ------------------------------------------------------------------- notes

export function notesMaster(): string {
  return (
    XML_DECLARATION +
    `<p:notesMaster ${NS_PRESENTATION}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    "</p:spTree></p:cSld>" +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    "</p:notesMaster>"
  );
}

export function notesMasterRelationships(): string {
  return (
    XML_DECLARATION +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    "</Relationships>"
  );
}

export function notesSlide(notes: string): string {
  const paragraphs = notes
    .split(/\r?\n/)
    .map((line) => `<a:p><a:r><a:rPr lang="en-US" sz="1200"/><a:t>${xml(line)}</a:t></a:r></a:p>`)
    .join("");

  return (
    XML_DECLARATION +
    `<p:notesSlide ${NS_PRESENTATION}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/>' +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs || "<a:p/>"}</p:txBody></p:sp>` +
    "</p:spTree></p:cSld></p:notesSlide>"
  );
}

export function notesSlideRelationships(slideIndex: number): string {
  return (
    XML_DECLARATION +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>' +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slideIndex}.xml"/>` +
    "</Relationships>"
  );
}

// -------------------------------------------------------------- properties

/**
 * Document properties.
 *
 * `created` is the document's own timestamp, not the export's. Doc 04 §32.3 asks
 * for a byte-stable artifact for a given version, and `new Date()` here would
 * make every export of an unchanged deck a different file.
 */
export function coreProperties(meta: {
  title: string;
  author: string;
  subject: string;
  created: string;
  modified: string;
}): string {
  return (
    XML_DECLARATION +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xml(meta.title)}</dc:title>` +
    `<dc:creator>${xml(meta.author)}</dc:creator>` +
    `<dc:subject>${xml(meta.subject)}</dc:subject>` +
    `<cp:lastModifiedBy>${xml(meta.author)}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${xml(meta.created)}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${xml(meta.modified)}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

export function appProperties(slideCount: number, title: string): string {
  return (
    XML_DECLARATION +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<Application>Deckastra</Application>" +
    `<Slides>${slideCount}</Slides>` +
    `<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${xml(title)}</vt:lpstr></vt:vector></TitlesOfParts>` +
    "</Properties>"
  );
}
