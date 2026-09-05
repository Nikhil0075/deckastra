import { z } from "zod";
import { IdSchema, prefixedId } from "./ids.js";
import {
  FiniteNumber,
  ImageFitSchema,
  InsetsSchema,
  IsoDateTimeSchema,
  PaintSchema,
  PointSchema,
  RectSchema,
} from "./primitives.js";
import { RichTextDocumentSchema } from "./text.js";
import { PresentationElementSchema, type PresentationElement } from "./elements.js";
import {
  AnimationTrackSchema,
  InteractionSchema,
  SlideTransitionSchema,
  TimelineMarkerSchema,
} from "./animation.js";
import { ThemeDefinitionSchema } from "./theme.js";
import { AssetReferenceSchema } from "./assets.js";
import { DataSourceDefinitionSchema, ProvenanceRecordSchema } from "./data.js";
import { ComponentDefinitionSchema, VariableDefinitionSchema } from "./components.js";

/** Slide and document (doc 02 §4–§7). */

// -------------------------------------------------------------------- viewport

export const PresentationViewportSchema = z.looseObject({
  width: FiniteNumber.positive(),
  height: FiniteNumber.positive(),
  unit: z.literal("px"),
  /** Derived; stored for readability. */
  aspectRatio: z.string().optional(),
  /**
   * Advisory geometry, not a clip region — nothing is cut off by it. It exists so
   * snapping has margin targets, the Layout Agent has a content region rather than
   * the full bleed, the Critic can flag text too close to the edge, and hero
   * imagery can intentionally break out of it.
   */
  safeArea: InsetsSchema.optional(),
});
export type PresentationViewport = z.infer<typeof PresentationViewportSchema>;

export const DEFAULT_VIEWPORT: PresentationViewport = {
  width: 1920,
  height: 1080,
  unit: "px",
  aspectRatio: "16:9",
  safeArea: { top: 80, right: 120, bottom: 80, left: 120 },
};

export const VIEWPORT_PRESETS = {
  "16:9": { width: 1920, height: 1080, unit: "px", aspectRatio: "16:9" },
  "16:10": { width: 1920, height: 1200, unit: "px", aspectRatio: "16:10" },
  "4:3": { width: 1440, height: 1080, unit: "px", aspectRatio: "4:3" },
  a4Landscape: { width: 1123, height: 794, unit: "px", aspectRatio: "1.41:1" },
  "1:1": { width: 1080, height: 1080, unit: "px", aspectRatio: "1:1" },
} as const;

// -------------------------------------------------------------------- metadata

/**
 * `audience` and `objective` are not decoration — every agent reads them. An
 * untitled deck with no audience and no objective forces every agent to guess,
 * and guessing is what produces generic output.
 */
export const PresentationMetadataSchema = z.looseObject({
  title: z.string(),
  description: z.string().optional(),
  authorIds: z.array(z.string()).optional(),
  /** BCP-47, e.g. "en-IN". Default "en". Also the text-measurement cache key. */
  language: z.string().optional(),
  tags: z.array(z.string()).optional(),
  presentationType: z
    .enum([
      "technical",
      "pitch",
      "business-review",
      "training",
      "conference",
      "education",
      "marketing",
      "custom",
    ])
    .optional(),
  /** Story Agent vocabulary and assumed expertise; Critic density judgement. */
  audience: z.string().optional(),
  /** Story Agent narrative arc; Critic narrative-clarity score. */
  objective: z.string().optional(),
  /** Story Agent slide count; Motion Agent timing budget. */
  estimatedDurationSeconds: FiniteNumber.positive().optional(),
  sourceProjectId: z.string().optional(),
});
export type PresentationMetadata = z.infer<typeof PresentationMetadataSchema>;

// ----------------------------------------------------------------------- slide

/**
 * The overlay exists because full-bleed photography under text almost always
 * needs a scrim, and encoding that as a separate rectangle element makes it a
 * selectable object the user deletes by accident.
 */
export const BackgroundDefinitionSchema = z.looseObject({
  paint: PaintSchema.optional(),
  /** Convenience for a full-bleed image. */
  assetId: IdSchema.optional(),
  fit: ImageFitSchema.optional(),
  focalPoint: PointSchema.optional(),
  /** Scrim above the image, below content. */
  overlay: PaintSchema.optional(),
  blur: FiniteNumber.min(0).optional(),
});
export type BackgroundDefinition = z.infer<typeof BackgroundDefinitionSchema>;

export const SlideLayoutMetadataSchema = z.looseObject({
  /** Which layout pattern produced this slide. */
  templateId: z.string().optional(),
  /** "asymmetric editorial", "centered hero". */
  styleLabel: z.string().optional(),
  /** Authored content area; defaults to the viewport safeArea. */
  contentRegion: RectSchema.optional(),
  gridColumns: z.number().int().positive().optional(),
  /**
   * The user's way of saying "I arranged this by hand, leave it alone." Agents
   * must honour it: a locked slide can have its content edited but not its
   * composition, and a broad restyle skips it.
   */
  locked: z.boolean().optional(),
});
export type SlideLayoutMetadata = z.infer<typeof SlideLayoutMetadataSchema>;

export interface Slide {
  id: string;
  name?: string;
  /** Why the slide exists. Drives Story, Layout, Motion and Critic. */
  semanticIntent?: string;
  /** The one thing the audience should retain. A slide with a keyMessage and no
   *  matching prominent element is a hierarchy failure the Critic detects
   *  mechanically. */
  keyMessage?: string;
  background?: BackgroundDefinition;
  layout?: SlideLayoutMetadata;
  /** Array order is the z-order base (doc 02 §8.4). */
  elements: PresentationElement[];
  /** Track order here is the animation sequencing authority (doc 02 §24.4). */
  animations?: z.infer<typeof AnimationTrackSchema>[];
  /** How the deck moves INTO this slide, so reordering carries it along. */
  transition?: z.infer<typeof SlideTransitionSchema>;
  interactions?: z.infer<typeof InteractionSchema>[];
  timelineMarkers?: z.infer<typeof TimelineMarkerSchema>[];
  speakerNotes?: z.infer<typeof RichTextDocumentSchema> | string;
  hidden?: boolean;
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export const SlideSchema: z.ZodType<Slide> = z.looseObject({
  id: prefixedId("sld"),
  name: z.string().optional(),
  semanticIntent: z.string().optional(),
  keyMessage: z.string().optional(),
  background: BackgroundDefinitionSchema.optional(),
  layout: SlideLayoutMetadataSchema.optional(),
  get elements() {
    return z.array(PresentationElementSchema);
  },
  animations: z.array(AnimationTrackSchema).optional(),
  transition: SlideTransitionSchema.optional(),
  interactions: z.array(InteractionSchema).optional(),
  /** Named moments that speaker notes and interactions reference without
   *  hardcoding milliseconds; also stable anchors the Motion Agent can describe
   *  intent against. */
  timelineMarkers: z.array(TimelineMarkerSchema).optional(),
  speakerNotes: z.union([RichTextDocumentSchema, z.string()]).optional(),
  hidden: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
}) as unknown as z.ZodType<Slide>;

/**
 * Ordering (doc 02 §7.2).
 *
 * v1.0 had `Slide.order: number` alongside slides living in an array — two sources
 * of truth, so a reorder had to update N fields and any disagreement was undefined
 * behaviour. v1.1 removes it.
 *
 * Array position in `slides[]` is the sole authority. Reordering is a `move` patch
 * operation, not N replaces. Slide numbering shown to the user is derived
 * (index + 1), skipping hidden slides in present mode but not in the editor.
 */
export const SLIDE_ORDER_AUTHORITY = "arrayPosition" as const;

// -------------------------------------------------------------------- document

export interface PresentationDocument {
  /** Semver, e.g. "1.1.0". Present and parseable, always. */
  schemaVersion: string;
  id: string;
  metadata: PresentationMetadata;
  viewport: PresentationViewport;
  theme: z.infer<typeof ThemeDefinitionSchema>;
  /** May be empty — a zero-slide deck is valid (a new project). */
  slides: Slide[];
  assets: z.infer<typeof AssetReferenceSchema>[];
  components: z.infer<typeof ComponentDefinitionSchema>[];
  dataSources: z.infer<typeof DataSourceDefinitionSchema>[];
  variables: Record<string, z.infer<typeof VariableDefinitionSchema>>;
  provenance?: z.infer<typeof ProvenanceRecordSchema>[];
  createdAt: string;
  /** Always >= createdAt. */
  updatedAt: string;
  /** Preserved verbatim across round-trips (doc 02 §0.8). */
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export const PresentationDocumentSchema: z.ZodType<PresentationDocument> = z.looseObject({
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  id: prefixedId("doc"),
  metadata: PresentationMetadataSchema,
  viewport: PresentationViewportSchema,
  theme: ThemeDefinitionSchema,
  get slides() {
    return z.array(SlideSchema);
  },
  assets: z.array(AssetReferenceSchema),
  components: z.array(ComponentDefinitionSchema),
  dataSources: z.array(DataSourceDefinitionSchema),
  variables: z.record(z.string(), VariableDefinitionSchema),
  provenance: z.array(ProvenanceRecordSchema).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  extensions: z.record(z.string(), z.unknown()).optional(),
}) as unknown as z.ZodType<PresentationDocument>;

/**
 * What is deliberately absent from the document (doc 02 §4.1). A field belongs
 * here if and only if two users opening the same deck must agree on it.
 *
 *   editor camera, zoom, pan          editor state
 *   selection, hover, isolation       editor state
 *   resolved geometry and matrices    IntermediateScene (doc 04 §7)
 *   signed asset URLs                 minted at render time from storageKey
 *   undo stack                        session memory + transactions table
 *   comments                          separate collaboration store (V2)
 */
export const EXCLUDED_FROM_DOCUMENT = [
  "camera",
  "zoom",
  "pan",
  "selection",
  "hover",
  "isolation",
  "signedUrl",
  "undoStack",
] as const;
