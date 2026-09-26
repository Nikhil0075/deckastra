import { z } from "zod";
import { IdSchema, prefixedId } from "./ids";
import {
  ColorValueSchema,
  CommonStyleSchema,
  FiniteNumber,
  HorizontalAlignSchema,
  ImageFitSchema,
  InsetsSchema,
  NormalizedSchema,
  openEnum,
  PointSchema,
  VerticalAlignSchema,
} from "./primitives";
import { SemanticRoleSchema } from "./semantic-roles";
import {
  ParagraphStyleSchema,
  RichTextDocumentSchema,
  TextFitSchema,
  TypographyStyleSchema,
} from "./text";
import { ContainerLayoutSchema, LayoutConstraintSchema } from "./layout";
import { DataBindingSchema, NumberFormatSchema } from "./data";

/**
 * Elements (doc 02 §8–§19, §40.4).
 *
 * Every element extends BaseElement and narrows `type` to a single literal. The
 * discriminant is `type`; `PresentationElement` at the bottom of this file is the
 * union that makes it discriminate.
 */

// ------------------------------------------------------------------ transform

/**
 * Transform (doc 02 §10).
 *
 * Origin (0,0) is the slide's top-left, x increases right and y increases
 * downward. `x, y` locate the element's *unrotated* top-left corner in its
 * parent's coordinate space; rotation and scale apply about (originX, originY)
 * expressed as a fraction of the element's own box.
 *
 * width/height and scaleX/scaleY are both present and mean different things:
 * a resize-handle drag changes width/height (layout), an animation changes scale
 * (visual only). Keeping them separate means an animation can never corrupt the
 * authored layout, and resetting scale to 1 always restores it. Flip is
 * scaleX: -1, not a separate property.
 */
export const TransformSchema = z.looseObject({
  x: FiniteNumber,
  y: FiniteNumber,
  /** >= 1: zero-size elements break hit testing and matrix inversion. */
  width: FiniteNumber.min(1),
  height: FiniteNumber.min(1),
  /** Degrees, clockwise positive, normalized to [0, 360) on commit. Default 0. */
  rotation: FiniteNumber.optional(),
  scaleX: FiniteNumber.optional(),
  scaleY: FiniteNumber.optional(),
  originX: NormalizedSchema.optional(),
  originY: NormalizedSchema.optional(),
});
export type Transform = z.infer<typeof TransformSchema>;

export const ElementMetadataSchema = z.looseObject({
  createdBy: z.enum(["user", "agent", "import", "template"]).optional(),
  agentId: z.string().optional(),
  /** Provenance records (doc 02 §30). */
  sourceIds: z.array(IdSchema).optional(),
  /**
   * Set when an agent substitutes an element. Matters more than it looks: it lets
   * the editor remap selection after an agent transaction, so a user who had an
   * element selected does not lose their selection when the AI swaps it.
   */
  replacesId: IdSchema.optional(),
  notes: z.string().optional(),
  /** Accessibility; also used for image, chart and diagram. */
  altText: z.string().optional(),
  /** Agents skip this element entirely. */
  doNotEdit: z.boolean().optional(),
});
export type ElementMetadata = z.infer<typeof ElementMetadataSchema>;

export const ElementTypeSchema = z.enum([
  "text",
  "shape",
  "line",
  "image",
  "icon",
  "group",
  "chart",
  "diagram",
  "table",
  "code",
  "video",
  "audio",
  "webEmbed",
  "componentInstance",
]);
export type ElementType = z.infer<typeof ElementTypeSchema>;

/**
 * Fields shared by every element (doc 02 §8).
 *
 * A minimal valid element is `id`, `type`, `transform`. Everything else earns its
 * place — semantic richness is optional by design so the model stays usable.
 */
const baseElementShape = {
  id: prefixedId("el"),
  name: z.string().optional(),
  semanticRole: SemanticRoleSchema.optional(),
  transform: TransformSchema,
  style: CommonStyleSchema.optional(),
  /** Default 1. */
  opacity: NormalizedSchema.optional(),
  /**
   * Default true. Distinct from opacity: 0 and from locked (doc 02 §8.2) —
   * `visible: false` is excluded from layout and export, so an animation that
   * fades an element in must use opacity: 0 as its start state, never this.
   */
  visible: z.boolean().optional(),
  /** Default false. Still rendered and exported; only selectable via the layers panel. */
  locked: z.boolean().optional(),
  /**
   * An override, not the ordering authority (doc 02 §8.4). Array position in the
   * parent is the base z-order; this pins an element above or below its siblings
   * without reordering. "Bring to front" is an array move, not a zIndex increment.
   */
  zIndex: z.number().int().optional(),
  constraints: z.array(LayoutConstraintSchema).optional(),
  bindings: z.array(DataBindingSchema).optional(),
  metadata: ElementMetadataSchema.optional(),
  /**
   * The name of the theme object style this element follows
   * (`theme.objectStyles`). The style's values are copied onto the element when
   * applied, so this names a relationship rather than supplying values; a name
   * that is not in the theme is ignored.
   */
  styleRef: z.string().min(1).max(60).optional(),
  /** Preserved verbatim across round-trips (doc 02 §0.8). */
  extensions: z.record(z.string(), z.unknown()).optional(),
} as const;

// ----------------------------------------------------------------------- text

export const TextElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("text"),
  content: RichTextDocumentSchema,
  /** Element defaults; blocks and spans override. */
  typography: TypographyStyleSchema,
  paragraph: ParagraphStyleSchema.optional(),
  /** Default "fixed". */
  fit: TextFitSchema.optional(),
  /** shrinkToFit floor. Default max(12, fontSize * 0.5). */
  minFontSize: FiniteNumber.positive().optional(),
  maxFontSize: FiniteNumber.positive().optional(),
  /** Default "visible". */
  overflowBehavior: z.enum(["visible", "clip", "ellipsis"]).optional(),
  padding: InsetsSchema.optional(),
  verticalAlign: VerticalAlignSchema.optional(),
  /** Default "auto", derived from metadata.language. */
  direction: z.enum(["ltr", "rtl", "auto"]).optional(),
});

// ---------------------------------------------------------------------- shape

export const SHAPE_KINDS = [
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "pill",
  "star",
  "polygon",
  "arrow",
  "chevron",
  "parallelogram",
  "speechBubble",
  "customPath",
] as const;

/** Open: an unrecognized shape renders as a rectangle rather than failing the deck. */
export const ShapeKindSchema = openEnum(SHAPE_KINDS);
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export const MarkerKindSchema = z.enum([
  "none",
  "arrow",
  "openArrow",
  "dot",
  "square",
  "diamond",
]);
export type MarkerKind = z.infer<typeof MarkerKindSchema>;

/**
 * SVG path restricted to `M L H V C S Q T A Z` in a normalized 0..1 coordinate
 * space, scaled to the element's box at render time (doc 02 §13.2). Normalizing
 * means resizing a custom shape does not require rewriting the path, and the same
 * path survives a viewport change.
 *
 * Path strings are untrusted input when they arrive from import or an agent:
 * anything outside the grammar is rejected as E012.
 */
const PATH_DATA_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\-+\s]+$/;
export const PathDataSchema = z.string().regex(PATH_DATA_RE, {
  message: "pathData may contain only M L H V C S Q T A Z commands, numbers, and separators",
});

export const ShapeElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("shape"),
  shape: ShapeKindSchema,
  /** Required when shape === "customPath". */
  pathData: PathDataSchema.optional(),
  /** star / polygon point count. */
  points: z.number().int().min(3).optional(),
  innerRadius: NormalizedSchema.optional(),
  arrowhead: z
    .object({ start: MarkerKindSchema.optional(), end: MarkerKindSchema.optional() })
    .optional(),
  /**
   * A shape with a label is one element, not a shape plus an overlapping text box:
   * moving it is one operation, and a diagram node is exactly this.
   */
  text: RichTextDocumentSchema.optional(),
  textPadding: InsetsSchema.optional(),
  /**
   * How the label looks. Partial on purpose: a label names what it changes
   * (size, weight, colour) and takes the rest from the theme's body style. With
   * no colour the renderer picks whichever of the theme's foreground and
   * background reads against the shape's fill — a label with no colour of its
   * own used to inherit the page's and vanish on a dark card.
   */
  typography: TypographyStyleSchema.partial().optional(),
  /** Horizontal alignment of the label. Centred when absent, as a shape's label is everywhere else. */
  paragraph: ParagraphStyleSchema.optional(),
  /** Vertical alignment of the label. Middle when absent. */
  verticalAlign: VerticalAlignSchema.optional(),
});

// ----------------------------------------------------------------------- line

export const AnchorPointSchema = z.enum([
  "top",
  "right",
  "bottom",
  "left",
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
  "center",
  /**
   * The default an agent should emit. It lets the connector re-choose its side
   * when either endpoint moves, which is what stops "add a node to the
   * architecture diagram" from producing a tangle.
   */
  "auto",
]);
export type AnchorPoint = z.infer<typeof AnchorPointSchema>;

export const AnchorReferenceSchema = z.object({
  elementId: IdSchema,
  anchor: AnchorPointSchema,
  offset: PointSchema.optional(),
});
export type AnchorReference = z.infer<typeof AnchorReferenceSchema>;

const EndpointSchema = z.union([PointSchema, AnchorReferenceSchema]);

export const LineElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("line"),
  from: EndpointSchema,
  to: EndpointSchema,
  /** Manual routing overrides. */
  waypoints: z.array(PointSchema).optional(),
  routing: z.enum(["straight", "orthogonal", "curved"]).optional(),
  startMarker: MarkerKindSchema.optional(),
  endMarker: MarkerKindSchema.optional(),
  label: RichTextDocumentSchema.optional(),
  /** 0..1 along the path, default 0.5. */
  labelPosition: NormalizedSchema.optional(),
});

// ---------------------------------------------------------------------- image

export const CropDefinitionSchema = z.object({
  /**
   * All four normalized to the SOURCE image, not to pixels, so replacing a 1200px
   * image with a 4000px version of the same picture keeps the crop valid.
   */
  x: NormalizedSchema,
  y: NormalizedSchema,
  width: NormalizedSchema,
  height: NormalizedSchema,
  rotation: FiniteNumber.optional(),
});
export type CropDefinition = z.infer<typeof CropDefinitionSchema>;

export const MaskDefinitionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rounded"),
    radius: z.union([FiniteNumber.min(0), z.record(z.string(), FiniteNumber)]),
  }),
  z.object({ type: z.literal("ellipse") }),
  z.object({ type: z.literal("path"), pathData: PathDataSchema }),
  z.object({ type: z.literal("shapeRef"), elementId: IdSchema }),
]);
export type MaskDefinition = z.infer<typeof MaskDefinitionSchema>;

export const ImageElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("image"),
  assetId: IdSchema,
  fit: ImageFitSchema.optional(),
  crop: CropDefinitionSchema.optional(),
  focalPoint: PointSchema.optional(),
  altText: z.string().optional(),
  mask: MaskDefinitionSchema.optional(),
  placeholder: z.enum(["blurhash", "color", "none"]).optional(),
});

// ----------------------------------------------------------------------- icon

/**
 * Icons are a separate type rather than images because they are theme-tinted,
 * resolution-independent, and searchable by name — which is what lets an agent
 * request "a database icon" without generating one.
 */
export const IconReferenceSchema = z.object({
  /** "lucide", "simple-icons", "custom" */
  set: z.string(),
  /** "database", "shield-check" */
  name: z.string(),
  /** Required when set === "custom". Custom SVGs are sanitized on ingestion. */
  assetId: IdSchema.optional(),
  variant: z.enum(["outline", "filled", "duotone"]).optional(),
});
export type IconReference = z.infer<typeof IconReferenceSchema>;

export const IconElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("icon"),
  icon: IconReferenceSchema,
  color: ColorValueSchema.optional(),
  strokeWidth: FiniteNumber.min(0).optional(),
});

// ---------------------------------------------------------------------- chart

export const CHART_KINDS = [
  "bar",
  "column",
  "line",
  "area",
  "pie",
  "donut",
  "scatter",
  "stackedBar",
  "stackedColumn",
  "combo",
] as const;

/** Open: an unrecognized chart type renders as a bar chart with a capability warning. */
export const ChartKindSchema = openEnum(CHART_KINDS);
export type ChartKind = (typeof CHART_KINDS)[number];

export const ChartDataReferenceSchema = z.discriminatedUnion("type", [
  /** Keeps a deck self-contained and portable — the default for AI-generated charts. */
  z.object({ type: z.literal("inline"), rows: z.array(z.record(z.string(), z.unknown())) }),
  z.object({ type: z.literal("dataSource"), sourceId: IdSchema, path: z.string().optional() }),
  /** Driven by a TableElement on the same slide, so table and chart stay in sync. */
  z.object({ type: z.literal("table"), elementId: IdSchema }),
]);
export type ChartDataReference = z.infer<typeof ChartDataReferenceSchema>;

export const ChartEncodingSchema = z.looseObject({
  category: z.string(),
  value: z.union([z.string(), z.array(z.string())]),
  series: z.string().optional(),
  color: z.string().optional(),
  size: z.string().optional(),
  sort: z
    .object({ by: z.enum(["category", "value"]), direction: z.enum(["asc", "desc"]) })
    .optional(),
  aggregate: z.enum(["sum", "avg", "min", "max", "count"]).optional(),
  /** Top-N; the remainder is grouped as "Other". */
  limit: z.number().int().positive().optional(),
});
export type ChartEncoding = z.infer<typeof ChartEncodingSchema>;

export const AxisStyleSchema = z.looseObject({
  title: z.string().optional(),
  min: FiniteNumber.optional(),
  max: FiniteNumber.optional(),
  /** Default true for bar and column. */
  includeZero: z.boolean().optional(),
  /** A target, not an exact count; the renderer picks "nice" values. */
  tickCount: z.number().int().positive().optional(),
  format: NumberFormatSchema.optional(),
  hidden: z.boolean().optional(),
});
export type AxisStyle = z.infer<typeof AxisStyleSchema>;

export const ChartStyleSchema = z.looseObject({
  palette: z.array(ColorValueSchema).optional(),
  showLegend: z.boolean().optional(),
  legendPosition: z.enum(["top", "right", "bottom", "left"]).optional(),
  showGridlines: z.boolean().optional(),
  showDataLabels: z.boolean().optional(),
  numberFormat: NumberFormatSchema.optional(),
  axisX: AxisStyleSchema.optional(),
  axisY: AxisStyleSchema.optional(),
  stacking: z.enum(["none", "normal", "percent"]).optional(),
  smoothing: NormalizedSchema.optional(),
});
export type ChartStyle = z.infer<typeof ChartStyleSchema>;

/**
 * The document holds data and intent only. Everything geometric — plot area, tick
 * placement, label collision avoidance, legend layout — is the renderer's, which
 * is what makes the same chart render identically in the editor, a PNG and a PDF.
 */
export const ChartElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("chart"),
  chartType: ChartKindSchema,
  data: ChartDataReferenceSchema,
  encoding: ChartEncodingSchema,
  chartStyle: ChartStyleSchema.optional(),
  altText: z.string().optional(),
});

// -------------------------------------------------------------------- diagram

export const DIAGRAM_KINDS = [
  "flow",
  "architecture",
  "sequence",
  "network",
  "mindmap",
  "timeline",
] as const;

/** Open: an unrecognized diagram type falls back to layered layout. */
export const DiagramKindSchema = openEnum(DIAGRAM_KINDS);
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

export const DiagramNodeSchema = z.looseObject({
  id: IdSchema,
  label: z.string(),
  sublabel: z.string().optional(),
  /** "service", "datastore", "external", "actor" — styled via theme.diagram.roleStyles. */
  role: z.string().optional(),
  icon: IconReferenceSchema.optional(),
  shape: ShapeKindSchema.optional(),
  /** Layout hint: pin to a layer. */
  rank: z.number().int().optional(),
  /** Manual override; honoured according to layoutHint.mode (doc 02 §18.5). */
  position: PointSchema.optional(),
  style: CommonStyleSchema.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  groupId: IdSchema.optional(),
});
export type DiagramNode = z.infer<typeof DiagramNodeSchema>;

export const DiagramEdgeSchema = z.looseObject({
  id: IdSchema,
  from: IdSchema,
  to: IdSchema,
  label: z.string().optional(),
  direction: z.enum(["forward", "reverse", "both", "none"]).optional(),
  kind: z.enum(["solid", "dashed", "dotted"]).optional(),
  weight: FiniteNumber.optional(),
  style: CommonStyleSchema.optional(),
});
export type DiagramEdge = z.infer<typeof DiagramEdgeSchema>;

/**
 * Trust boundaries and swimlanes are what make an architecture diagram say
 * something. Without them every system diagram is an undifferentiated
 * box-and-arrow field.
 */
export const DiagramGroupSchema = z.looseObject({
  id: IdSchema,
  label: z.string().optional(),
  nodeIds: z.array(IdSchema),
  style: CommonStyleSchema.optional(),
  kind: z.enum(["boundary", "swimlane", "cluster"]).optional(),
});
export type DiagramGroup = z.infer<typeof DiagramGroupSchema>;

export const DiagramLayoutHintSchema = z.looseObject({
  algorithm: z.enum(["layered", "radial", "grid", "force", "manual"]).optional(),
  /** Default "LR" for architecture. */
  direction: z.enum(["TB", "BT", "LR", "RL"]).optional(),
  nodeSpacing: FiniteNumber.min(0).optional(),
  rankSpacing: FiniteNumber.min(0).optional(),
  alignRanks: z.boolean().optional(),
  /**
   * Default "hybrid". Silently discarding a user's drag on the next relayout is
   * the worst of the three outcomes and must not be a reachable state.
   */
  mode: z.enum(["managed", "hybrid", "manual"]).optional(),
  /** Required when algorithm === "force": layout must be deterministic. */
  seed: z.number().int().optional(),
});
export type DiagramLayoutHint = z.infer<typeof DiagramLayoutHintSchema>;

/**
 * A diagram is structure, not SVG. That buys four things: layout recomputes when
 * a node is added; motion can be semantic ("draw the edges out of the
 * orchestrator" resolves to edge ids); agents edit meaning rather than
 * repositioning nine shapes; and PPTX export gets real shapes and connectors
 * instead of a flat image.
 */
export const DiagramElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("diagram"),
  diagramType: DiagramKindSchema,
  nodes: z.array(DiagramNodeSchema),
  edges: z.array(DiagramEdgeSchema),
  layoutHint: DiagramLayoutHintSchema.optional(),
  groups: z.array(DiagramGroupSchema).optional(),
});

// ---------------------------------------------------------------------- table

export const TableColumnSchema = z.looseObject({
  id: IdSchema,
  label: z.string().optional(),
  align: HorizontalAlignSchema.optional(),
  format: NumberFormatSchema.optional(),
  width: FiniteNumber.positive().optional(),
});
export type TableColumn = z.infer<typeof TableColumnSchema>;

export const TableCellSchema = z.looseObject({
  content: z.union([RichTextDocumentSchema, z.string()]),
  colSpan: z.number().int().positive().optional(),
  rowSpan: z.number().int().positive().optional(),
  style: CommonStyleSchema.optional(),
  align: HorizontalAlignSchema.optional(),
});
export type TableCell = z.infer<typeof TableCellSchema>;

export const TableRowSchema = z.looseObject({
  id: IdSchema,
  cells: z.array(TableCellSchema),
  emphasis: z.enum(["none", "subtotal", "total", "highlight"]).optional(),
});
export type TableRow = z.infer<typeof TableRowSchema>;

export const TableStyleSchema = z.looseObject({
  banding: z.enum(["none", "rows", "columns"]).optional(),
  borders: z.enum(["all", "horizontal", "outer", "none"]).optional(),
  headerFill: CommonStyleSchema.shape.fill.optional(),
  /** The heading row's text colour; with a header fill, so the two can be chosen together. */
  headerColor: ColorValueSchema.optional(),
  cellPadding: InsetsSchema.optional(),
  compact: z.boolean().optional(),
});
export type TableStyle = z.infer<typeof TableStyleSchema>;

/**
 * Tables were absent from doc 01 §8.3 entirely. They belong in MVP: business
 * review and technical decks both need them, PPTX maps them natively, and a table
 * is the only sensible representation for comparison data a chart would obscure.
 */
export const TableElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("table"),
  columns: z.array(TableColumnSchema),
  rows: z.array(TableRowSchema),
  headerRow: z.boolean().optional(),
  headerColumn: z.boolean().optional(),
  /** Logical px; omitted means auto. */
  columnWidths: z.array(FiniteNumber.positive()).optional(),
  rowHeights: z.array(FiniteNumber.positive()).optional(),
  tableStyle: TableStyleSchema.optional(),
  data: ChartDataReferenceSchema.optional(),
});

// ----------------------------------------------------------------------- code

export const CodeElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("code"),
  language: z.string(),
  code: z.string(),
  showLineNumbers: z.boolean().optional(),
  startLineNumber: z.number().int().optional(),
  highlightedLines: z.array(z.number().int()).optional(),
  /** Render +/- lines. */
  diffMode: z.boolean().optional(),
  wrap: z.boolean().optional(),
  /** Syntax theme id. */
  themeToken: z.string().optional(),
  /** Rendered as a caption or tab. */
  fileName: z.string().optional(),
});

// ------------------------------------------------------------------- equation

/**
 * A mathematical expression, written in LaTeX (Design tab review, 2026-09-26).
 *
 * The source is the document's fact; the typeset form is derived by the renderer
 * every time, the same way a chart's bars are. Storing rendered markup would be
 * a second description of the maths that could disagree with the first, and
 * would make an emailed deck carry HTML someone else wrote into every reader.
 *
 * Bounded, because LaTeX macros expand: a short source can ask the typesetter
 * for a great deal of work, and the renderer runs it on every open.
 */
export const EQUATION_MAX_LENGTH = 4000;

export const EquationElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("equation"),
  latex: z.string().max(EQUATION_MAX_LENGTH),
  /** Display style (larger operators, limits above and below) rather than inline. */
  display: z.boolean().optional(),
  /** Logical px. Omitted means the theme's body size. */
  fontSize: FiniteNumber.positive().optional(),
  color: ColorValueSchema.optional(),
  align: z.enum(["left", "center", "right"]).optional(),
});

// ----------------------------------------------------------- video / audio / embed

export const VideoElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("video"),
  assetId: IdSchema,
  posterAssetId: IdSchema.optional(),
  autoplay: z.boolean().optional(),
  loop: z.boolean().optional(),
  /** Default true; browsers require it for autoplay. */
  muted: z.boolean().optional(),
  controls: z.boolean().optional(),
  startTimeMs: FiniteNumber.min(0).optional(),
  endTimeMs: FiniteNumber.min(0).optional(),
  fit: ImageFitSchema.optional(),
  /** WebVTT */
  captionsAssetId: IdSchema.optional(),
});

export const AudioElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("audio"),
  assetId: IdSchema,
  autoplay: z.boolean().optional(),
  loop: z.boolean().optional(),
  /**
   * "presentation" is how a background track survives slide changes, and it is the
   * hook video export needs for narration mixing (doc 04 §35.2).
   */
  scope: z.enum(["slide", "presentation"]).optional(),
  volume: NormalizedSchema.optional(),
  transcript: z.string().optional(),
});

/**
 * Security (doc 02 §19.6): embed URLs are checked against a workspace allowlist at
 * render time, rendered in a sandboxed iframe with no same-origin access, and
 * never granted clipboard, camera, microphone or storage permissions. Creating one
 * via an agent patch requires an elevated scope. Exports always use
 * fallbackAssetId — a PDF cannot contain a live page.
 */
export const WebEmbedElementSchema = z.looseObject({
  ...baseElementShape,
  type: z.literal("webEmbed"),
  url: z.string(),
  allowInteraction: z.boolean().optional(),
  fallbackAssetId: IdSchema.optional(),
  aspectRatio: z.string().optional(),
});

// ------------------------------------------------------ component instance

export const ComponentOverrideSchema = z.object({
  /** Path within the resolved instance. */
  elementPath: z.string(),
  property: z.string(),
  value: z.unknown(),
});
export type ComponentOverride = z.infer<typeof ComponentOverrideSchema>;

// --------------------------------------------------------------- recursion

/**
 * Group and the element union are mutually recursive, so their TypeScript shapes
 * are written out and the schemas annotated against them. Everything else in this
 * file is inferred.
 */

export type BaseElement = {
  id: string;
  type: ElementType | string;
  name?: string;
  semanticRole?: z.infer<typeof SemanticRoleSchema>;
  transform: Transform;
  style?: z.infer<typeof CommonStyleSchema>;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  zIndex?: number;
  constraints?: z.infer<typeof LayoutConstraintSchema>[];
  bindings?: z.infer<typeof DataBindingSchema>[];
  metadata?: ElementMetadata;
  styleRef?: string;
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
};

export type TextElement = z.infer<typeof TextElementSchema>;
export type ShapeElement = z.infer<typeof ShapeElementSchema>;
export type LineElement = z.infer<typeof LineElementSchema>;
export type ImageElement = z.infer<typeof ImageElementSchema>;
export type IconElement = z.infer<typeof IconElementSchema>;
export type ChartElement = z.infer<typeof ChartElementSchema>;
export type DiagramElement = z.infer<typeof DiagramElementSchema>;
export type TableElement = z.infer<typeof TableElementSchema>;
export type CodeElement = z.infer<typeof CodeElementSchema>;
export type EquationElement = z.infer<typeof EquationElementSchema>;
export type VideoElement = z.infer<typeof VideoElementSchema>;
export type AudioElement = z.infer<typeof AudioElementSchema>;
export type WebEmbedElement = z.infer<typeof WebEmbedElementSchema>;

export type GroupResizeMode = "scaleChildren" | "resizeContainer";

export interface GroupElement extends BaseElement {
  type: "group";
  /** Array order is the z-order base within the group. */
  children: PresentationElement[];
  /** "titleBlock", "kpiRow", "architectureCluster" — an AI instruction targets one id. */
  groupRole?: string;
  containerLayout?: z.infer<typeof ContainerLayoutSchema>;
  resizeMode?: GroupResizeMode;
  clipContent?: boolean;
  padding?: z.infer<typeof InsetsSchema>;
}

export interface ComponentInstanceElement extends BaseElement {
  type: "componentInstance";
  componentId: string;
  /** Pinned. Updating a definition does not retroactively change instances. */
  componentVersion: string;
  parameters: Record<string, unknown>;
  slotContent?: Record<string, PresentationElement[]>;
  overrides?: ComponentOverride[];
  detachedFrom?: string;
}

/**
 * An element type this reader does not know (doc 02 §8.7).
 *
 * Required by the forward-compatibility rule: a reader meeting an element from a
 * newer schema keeps it intact, renders a labelled placeholder at its transform,
 * and refuses to let agents modify it. Without this, opening a deck in an older
 * client silently deletes content.
 */
export interface UnknownElement extends BaseElement {
  type: string;
}

export type PresentationElement =
  | TextElement
  | ShapeElement
  | LineElement
  | ImageElement
  | IconElement
  | GroupElement
  | ChartElement
  | DiagramElement
  | TableElement
  | CodeElement
  | EquationElement
  | VideoElement
  | AudioElement
  | WebEmbedElement
  | ComponentInstanceElement
  | UnknownElement;

export const GroupElementSchema: z.ZodType<GroupElement> = z.looseObject({
  ...baseElementShape,
  type: z.literal("group"),
  get children() {
    return z.array(PresentationElementSchema);
  },
  groupRole: z.string().optional(),
  /**
   * The v1.0 gap: ContainerLayout existed and was attached to nothing, so
   * container layouts were unreachable from a valid document.
   *
   * When present, children's transform.x/y become advisory — retained so pulling a
   * child out of the container restores a sensible position, but ignored while the
   * container lays out. This is the mechanism that keeps AI-generated content
   * robust: four KPI cards emitted as a horizontal container survive a longer
   * label; the same four emitted as absolute boxes overlap.
   */
  containerLayout: ContainerLayoutSchema.optional(),
  /** Defaults to "resizeContainer" when containerLayout is set, else "scaleChildren". */
  resizeMode: z.enum(["scaleChildren", "resizeContainer"]).optional(),
  clipContent: z.boolean().optional(),
  padding: InsetsSchema.optional(),
}) as unknown as z.ZodType<GroupElement>;

export const ComponentInstanceElementSchema: z.ZodType<ComponentInstanceElement> = z.looseObject({
  ...baseElementShape,
  type: z.literal("componentInstance"),
  componentId: prefixedId("cmp"),
  componentVersion: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  /** Resolved children are never persisted back into the instance (doc 02 §40.4). */
  get slotContent() {
    return z.record(z.string(), z.array(PresentationElementSchema)).optional();
  },
  overrides: z.array(ComponentOverrideSchema).optional(),
  detachedFrom: IdSchema.optional(),
}) as unknown as z.ZodType<ComponentInstanceElement>;

const KNOWN_ELEMENT_SCHEMAS = [
  TextElementSchema,
  ShapeElementSchema,
  LineElementSchema,
  ImageElementSchema,
  IconElementSchema,
  GroupElementSchema,
  ChartElementSchema,
  DiagramElementSchema,
  TableElementSchema,
  CodeElementSchema,
  EquationElementSchema,
  VideoElementSchema,
  AudioElementSchema,
  WebEmbedElementSchema,
  ComponentInstanceElementSchema,
] as const;

/**
 * Element schemas keyed by their `type` discriminant.
 *
 * A `z.union` reports a failure as "invalid_union" at the union's own path, which
 * loses the inner reason entirely — the validator would report "Invalid input" on
 * the element instead of "transform.x is NaN". Re-parsing the offending value
 * against the single member its `type` selects recovers the real issue, which is
 * what inline editor badges and agent self-correction both need.
 */
export const ELEMENT_SCHEMA_BY_TYPE: Record<string, z.ZodType<unknown>> = {
  text: TextElementSchema as unknown as z.ZodType<unknown>,
  shape: ShapeElementSchema as unknown as z.ZodType<unknown>,
  line: LineElementSchema as unknown as z.ZodType<unknown>,
  image: ImageElementSchema as unknown as z.ZodType<unknown>,
  icon: IconElementSchema as unknown as z.ZodType<unknown>,
  group: GroupElementSchema as unknown as z.ZodType<unknown>,
  chart: ChartElementSchema as unknown as z.ZodType<unknown>,
  diagram: DiagramElementSchema as unknown as z.ZodType<unknown>,
  table: TableElementSchema as unknown as z.ZodType<unknown>,
  code: CodeElementSchema as unknown as z.ZodType<unknown>,
  equation: EquationElementSchema as unknown as z.ZodType<unknown>,
  video: VideoElementSchema as unknown as z.ZodType<unknown>,
  audio: AudioElementSchema as unknown as z.ZodType<unknown>,
  webEmbed: WebEmbedElementSchema as unknown as z.ZodType<unknown>,
  componentInstance: ComponentInstanceElementSchema as unknown as z.ZodType<unknown>,
};

// Define the registry before the fallback. Recursive children/slots use getters,
// so they do not evaluate PresentationElementSchema during this initialization.
const knownElementTypes = Object.keys(ELEMENT_SCHEMA_BY_TYPE);
const knownElementTypeSet = new Set(knownElementTypes);

const UnknownElementSchema = z.looseObject({
  ...baseElementShape,
  // Doc 02 §0.8 preserves future types, not malformed instances of known types.
  // Refinements alone disappear in JSON Schema. Emit the equivalent exclusion
  // from the same registry so Python enforces exactly the same type boundary.
  type: z.string()
    .refine((type) => !knownElementTypeSet.has(type), {
      message: "Known element types must satisfy their specific element schema",
      // Abort this branch so Zod reports the union failure for member expansion,
      // rather than selecting this fallback's continuable refinement issue.
      abort: true,
    })
    .meta({ not: { enum: knownElementTypes } }),
}) as unknown as z.ZodType<UnknownElement>;

/** Known types validate strictly; only future types use the §0.8 fallback. */
export const PresentationElementSchema: z.ZodType<PresentationElement> = z.union([
  ...KNOWN_ELEMENT_SCHEMAS,
  UnknownElementSchema,
]) as unknown as z.ZodType<PresentationElement>;

export { UnknownElementSchema };

/** MVP element subset (doc 02 §37.1) — the single canonical list. */
export const MVP_ELEMENT_TYPES = [
  "text",
  "shape",
  "line",
  "image",
  "icon",
  "group",
  "chart",
  "diagram",
  "table",
  "code",
] as const;

/** Schema-defined now so decks stay forward-compatible; renderer lands in Phase 2+. */
export const DEFERRED_ELEMENT_TYPES = [
  "componentInstance",
  "video",
  "audio",
  "webEmbed",
] as const;

export function isKnownElementType(type: string): type is ElementType {
  return (ElementTypeSchema.options as readonly string[]).includes(type);
}

export function isGroup(el: PresentationElement): el is GroupElement {
  return el.type === "group";
}

/** Depth-first walk in document order, groups before their children. */
export function* walkElements(
  elements: readonly PresentationElement[],
  depth = 0,
): Generator<{ element: PresentationElement; depth: number }> {
  for (const element of elements) {
    yield { element, depth };
    if (isGroup(element)) yield* walkElements(element.children, depth + 1);
  }
}
