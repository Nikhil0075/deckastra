/**
 * The PPTX export adapter (doc 04 §33, doc 05 §16).
 *
 * Assembles the package: one slide part per exported slide, the master and
 * layout they inherit from, a theme carrying the deck's palette, and the
 * relationship graph that ties them together.
 *
 * Two properties worth stating because they are easy to lose later.
 *
 * **Byte-stable for a given version** (doc 04 §32.3). Every timestamp comes from
 * the document rather than the clock, the zip writer fixes its own dates, and
 * shape names derive from element ids rather than counters. Two exports of an
 * unchanged deck are the same file, which is what makes the result cacheable and
 * an export diffable.
 *
 * **Nothing disappears silently.** An element this build cannot represent
 * natively becomes a labelled dashed box and a line in the report. The user
 * story is "my client needs a .pptx" (§33.4), and the worst outcome is the
 * client finding the gap first.
 */

import type { PresentationDocument } from "@deckastra/presentation-schema";
import type { SlideScene } from "@deckastra/renderer";
import { compileTimeline } from "@deckastra/animation-engine";
import type { AnimationTrack } from "@deckastra/presentation-schema";
import {
  DegradationLedger,
  slidesToExport,
  type ExportAdapter,
  type ExportCapability,
  type ExportInput,
  type ExportResult,
} from "@deckastra/export-core";

import {
  appProperties,
  contentTypes,
  coreProperties,
  notesMaster,
  notesMasterRelationships,
  notesSlide,
  notesSlideRelationships,
  presentation,
  presentationRelationships,
  rootRelationships,
  slide as slidePart,
  slideLayout,
  slideLayoutRelationships,
  slideMaster,
  slideMasterRelationships,
  slideRelationships,
  solidBackground,
  theme,
} from "./parts";
import { shapeFor, type ShapeContext } from "./shapes";
import { timingFor, transitionFor } from "./timing";
import { hex, unitsFor } from "./units";
import { createZip, type ZipEntry } from "./zip";

/**
 * Doc 04 §32.2.
 *
 * `supportsVectorText: true` is the important one and it is why PPTX is worth
 * having at all: the text arrives editable. `supportsAnimation` is true with a
 * narrow meaning — entrance effects and click boundaries survive; everything
 * else is reported.
 */
export const PPTX_CAPABILITIES: ExportCapability = {
  supportsBlur: false,
  supportsMorph: true,
  supportsVideo: false,
  supportsAnimation: true,
  supportsVectorText: true,
  supportsInteractivity: false,
  maxImageDpi: 300,
};

export interface PptxArtifact {
  bytes: Uint8Array;
  result: ExportResult;
}

/**
 * Build the package in memory.
 *
 * Separate from the adapter's `export` so a caller that wants the bytes — a
 * test, an in-process API, the worker — does not have to go through a file.
 */
export function buildPptx(input: ExportInput): PptxArtifact {
  const startedAt = Date.now();
  const ledger = new DegradationLedger();
  const { document, scenes, options } = input;

  const ids = slidesToExport(document, options);
  const elementsById = indexElements(document);
  const units = unitsFor(document.viewport.width);
  const palette = paletteOf(document);

  const includeNotes = options.includeNotes === true;
  const entries: ZipEntry[] = [];
  const notesPerSlide: (string | undefined)[] = [];

  ids.forEach((slideId, index) => {
    input.signal?.throwIfAborted();

    const scene = scenes.get(slideId);
    if (!scene) {
      // A scene the caller did not build. Reported rather than skipped quietly,
      // because the slide count in the report would otherwise disagree with the
      // deck and nobody would know which slide is missing.
      ledger.record({
        severity: "warning",
        slideId,
        feature: "slide",
        action: "dropped",
        message: "This slide had no resolved scene and could not be exported.",
      });
      notesPerSlide.push(undefined);
      entries.push({
        path: `ppt/slides/slide${index + 1}.xml`,
        data: slidePart("", solidBackground("FFFFFF"), ""),
      });
      entries.push({
        path: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        data: slideRelationships(false, index + 1),
      });
      return;
    }

    if (sceneUsedEstimatedMetrics(scene)) ledger.noteEstimatedMetrics();

    const { xmlBody, shapeIds } = shapesFor(scene, units, ledger, elementsById);

    const timeline = compileTimeline(scene, (scene.animations ?? []) as AnimationTrack[], {
      // Full motion: PowerPoint has its own reduced-motion handling, and
      // resolving to the exporting machine's preference would bake one viewer's
      // setting into a file everyone else opens.
      userMotionPreference: "full",
    });

    const timing = timingFor({ timeline, slideId, ledger, shapeIds });
    const transition = transitionFor(
      scene.transition?.type,
      scene.transition?.durationMs,
      slideId,
      ledger,
    );

    const background = solidBackground(hex(scene.background?.color ?? palette.background));
    const notes = includeNotes ? scene.speakerNotes : undefined;
    notesPerSlide.push(notes);

    entries.push({
      path: `ppt/slides/slide${index + 1}.xml`,
      data: slidePart(xmlBody, background, transition + timing),
    });
    entries.push({
      path: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      data: slideRelationships(Boolean(notes), index + 1),
    });
  });

  const hasNotes = notesPerSlide.some(Boolean);

  notesPerSlide.forEach((notes, index) => {
    if (!notes) return;
    entries.push({ path: `ppt/notesSlides/notesSlide${index + 1}.xml`, data: notesSlide(notes) });
    entries.push({
      path: `ppt/notesSlides/_rels/notesSlide${index + 1}.xml.rels`,
      data: notesSlideRelationships(index + 1),
    });
  });

  if (hasNotes) {
    entries.push({ path: "ppt/notesMasters/notesMaster1.xml", data: notesMaster() });
    entries.push({
      path: "ppt/notesMasters/_rels/notesMaster1.xml.rels",
      data: notesMasterRelationships(),
    });
  }

  // `[Content_Types].xml` first: the OPC specification requires it to be the
  // first part in the package, and readers that stream the zip rely on it.
  const packaged: ZipEntry[] = [
    { path: "[Content_Types].xml", data: contentTypes(ids.length, hasNotes) },
    { path: "_rels/.rels", data: rootRelationships() },
    { path: "docProps/core.xml", data: coreProperties(metadataOf(document)) },
    { path: "docProps/app.xml", data: appProperties(ids.length, document.metadata.title) },
    { path: "ppt/presentation.xml", data: presentation(ids.length) },
    { path: "ppt/_rels/presentation.xml.rels", data: presentationRelationships(ids.length, hasNotes) },
    { path: "ppt/slideMasters/slideMaster1.xml", data: slideMaster() },
    { path: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: slideMasterRelationships() },
    { path: "ppt/slideLayouts/slideLayout1.xml", data: slideLayout() },
    { path: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: slideLayoutRelationships() },
    { path: "ppt/theme/theme1.xml", data: theme(palette) },
    ...entries,
  ];

  for (const font of input.fontManifest) {
    if (font.available) continue;
    ledger.record({
      severity: "warning",
      slideId: "",
      feature: `font:${font.family}`,
      action: "approximated",
      message:
        `"${font.family}" was not available when this deck was measured, so a ` +
        "substitute was used. PowerPoint will substitute again on a machine that " +
        "does not have it.",
    });
  }

  const bytes = createZip(packaged);

  return {
    bytes,
    result: {
      artifactUri: "",
      bytes: bytes.length,
      report: ledger.report(ids.length, Date.now() - startedAt),
    },
  };
}

// ------------------------------------------------------------------ adapter

export function pptxAdapter(write: (bytes: Uint8Array) => Promise<string>): ExportAdapter {
  return {
    id: "pptx",
    capabilities: PPTX_CAPABILITIES,
    async export(input: ExportInput): Promise<ExportResult> {
      const artifact = buildPptx(input);
      const artifactUri = await write(artifact.bytes);
      return { ...artifact.result, artifactUri };
    },
  };
}

// ------------------------------------------------------------------ pieces

function shapesFor(
  scene: SlideScene,
  units: ReturnType<typeof unitsFor>,
  ledger: DegradationLedger,
  elementsById: Map<string, { type: string; shape?: string }>,
): { xmlBody: string; shapeIds: Map<string, number> } {
  const shapeIds = new Map<string, number>();
  // PowerPoint reserves id 1 for the slide's own group; shapes start at 2.
  let counter = 2;

  const context: ShapeContext = {
    scene,
    units,
    ledger,
    elementsById,
    nextId: () => counter++,
  };

  const byId = new Map(flatten(scene.nodes).map((node) => [node.id, node]));

  const parts: string[] = [];
  for (const nodeId of scene.paintOrder) {
    const node = byId.get(nodeId);
    if (!node) continue;

    const before = counter;
    const xmlBody = shapeFor(node, context);
    if (!xmlBody) continue;

    shapeIds.set(node.id, before);
    parts.push(xmlBody);
  }

  return { xmlBody: parts.join(""), shapeIds };
}

function flatten(nodes: SlideScene["nodes"]): SlideScene["nodes"] {
  const out: SlideScene["nodes"] = [];
  const walk = (list: SlideScene["nodes"]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function indexElements(
  document: PresentationDocument,
): Map<string, { type: string; shape?: string }> {
  const byId = new Map<string, { type: string; shape?: string }>();

  const walk = (elements: readonly unknown[]): void => {
    for (const element of elements as { id: string; type: string; shape?: string; children?: unknown[] }[]) {
      byId.set(element.id, { type: element.type, shape: element.shape });
      if (element.children) walk(element.children);
    }
  };

  for (const slide of document.slides) walk(slide.elements);
  return byId;
}

function paletteOf(document: PresentationDocument): {
  background: string;
  foreground: string;
  accent: string;
  fontHeading: string;
  fontBody: string;
} {
  const colors = document.theme.colors as Record<string, unknown>;
  const typography = document.theme.typography as Record<string, { fontFamily?: string }>;

  return {
    background: hex(String(colors.background ?? "#FFFFFF")),
    foreground: hex(String(colors.foreground ?? "#000000")),
    accent: hex(String(colors.accent ?? "#4472C4")),
    fontHeading: (typography.display?.fontFamily ?? typography.heading?.fontFamily ?? "Inter")
      .split(",")[0]!
      .trim()
      .replace(/["']/g, ""),
    fontBody: (typography.body?.fontFamily ?? "Inter").split(",")[0]!.trim().replace(/["']/g, ""),
  };
}

function metadataOf(document: PresentationDocument): {
  title: string;
  author: string;
  subject: string;
  created: string;
  modified: string;
} {
  return {
    title: document.metadata.title,
    // The schema stores `authorIds`, not names — resolving one to a person is a
    // database lookup this package has no business doing, and putting an opaque
    // id in a client-facing document property would be worse than the tool name.
    author: "Deckastra",
    subject: document.metadata.objective ?? document.metadata.description ?? "",
    // The document's timestamps, not the clock's. An export that stamps
    // "now" is a different file every time it runs, which defeats caching and
    // makes two exports of an unchanged deck impossible to compare.
    created: document.createdAt,
    modified: document.updatedAt,
  };
}

/** True when any text on the slide was measured by estimate rather than a browser. */
function sceneUsedEstimatedMetrics(scene: SlideScene): boolean {
  return flatten(scene.nodes).some(
    (node) => node.renderPayload.kind === "text" && node.renderPayload.metrics.estimated,
  );
}

export { createZip } from "./zip";
export * from "./units";
