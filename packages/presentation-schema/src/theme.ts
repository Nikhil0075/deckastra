import { z } from "zod";
import { IdSchema, prefixedId } from "./ids";
import {
  ColorValueSchema,
  CommonStyleSchema,
  EasingSchema,
  FiniteNumber,
  InsetsSchema,
  MillisecondsSchema,
  PaintSchema,
  ShadowStyleSchema,
  StrokeStyleSchema,
} from "./primitives";
import { TypographyStyleSchema } from "./text";
import { SemanticRoleSchema } from "./semantic-roles";
import { PropertyTrackSchema } from "./animation";

/**
 * Theme (doc 02 §22).
 *
 * The theme is not cosmetic. Agents treat it as a design contract: the Creative
 * Director proposes tokens, the Layout Agent consumes them, the Critic checks
 * conformance against them. A three-color theme gives all three nothing to work
 * with, which is why the token set is this large.
 */

export const ColorTokensSchema = z.looseObject({
  // surfaces
  background: ColorValueSchema,
  surface: ColorValueSchema,
  surfaceAlt: ColorValueSchema,
  overlay: ColorValueSchema,

  // content
  foreground: ColorValueSchema,
  foregroundMuted: ColorValueSchema,
  foregroundSubtle: ColorValueSchema,

  // brand
  accent: ColorValueSchema,
  /**
   * Guaranteed readable ON accent. Exists so that "text on an accent fill" has a
   * defined answer instead of every layout guessing, and so contrast validation is
   * mechanical rather than heuristic.
   */
  accentForeground: ColorValueSchema,
  accentMuted: ColorValueSchema.optional(),
  secondary: ColorValueSchema.optional(),
  secondaryForeground: ColorValueSchema.optional(),

  // structure
  border: ColorValueSchema,
  borderStrong: ColorValueSchema.optional(),
  divider: ColorValueSchema.optional(),

  // status
  success: ColorValueSchema.optional(),
  warning: ColorValueSchema.optional(),
  danger: ColorValueSchema.optional(),
  info: ColorValueSchema.optional(),

  /**
   * Ordered, minimum 6. Series 0 always takes chartSeries[0], so chart color
   * assignment is deterministic and does not depend on data ordering — which a
   * palette keyed by name could not guarantee.
   */
  chartSeries: z.array(ColorValueSchema).min(6),
  chartPositive: ColorValueSchema.optional(),
  chartNegative: ColorValueSchema.optional(),
  chartNeutral: ColorValueSchema.optional(),

  custom: z.record(z.string(), ColorValueSchema).optional(),
});
export type ColorTokens = z.infer<typeof ColorTokensSchema>;

/**
 * Declared on the theme, checked by the validator (W210) and by the Critic. This
 * is how brand enforcement becomes testable rather than aspirational, and it is
 * the contrast requirement in doc 01 §9.5 expressed as a concrete rule.
 */
export const ContrastPairSchema = z.object({
  /** Token path, e.g. "colors.foreground". */
  foreground: z.string(),
  background: z.string(),
  /** 4.5 for body, 3.0 for large text and UI (WCAG 2.1 AA). */
  minimumRatio: FiniteNumber.positive(),
});
export type ContrastPair = z.infer<typeof ContrastPairSchema>;

/**
 * Typography tokens carry a complete TypographyStyle, so "token:typography.h1"
 * resolves to a whole style rather than a fragment and a token is directly
 * assignable to an element property.
 */
export const TypographyTokensSchema = z.looseObject({
  display: TypographyStyleSchema,
  h1: TypographyStyleSchema,
  h2: TypographyStyleSchema,
  h3: TypographyStyleSchema,
  body: TypographyStyleSchema,
  bodySmall: TypographyStyleSchema,
  caption: TypographyStyleSchema,
  quote: TypographyStyleSchema,
  code: TypographyStyleSchema,
  metric: TypographyStyleSchema,
  /** Documents the type scale, e.g. 1.25. */
  scaleRatio: FiniteNumber.positive().optional(),
  custom: z.record(z.string(), TypographyStyleSchema).optional(),
});
export type TypographyTokens = z.infer<typeof TypographyTokensSchema>;

export const SpacingTokensSchema = z.looseObject({
  base: FiniteNumber.positive(),
  xs: FiniteNumber,
  sm: FiniteNumber,
  md: FiniteNumber,
  lg: FiniteNumber,
  xl: FiniteNumber,
  xxl: FiniteNumber,
  slideMargin: InsetsSchema,
  custom: z.record(z.string(), FiniteNumber).optional(),
});
export type SpacingTokens = z.infer<typeof SpacingTokensSchema>;

export const RadiusTokensSchema = z.looseObject({
  none: FiniteNumber.min(0),
  sm: FiniteNumber.min(0),
  md: FiniteNumber.min(0),
  lg: FiniteNumber.min(0),
  full: FiniteNumber.min(0),
  custom: z.record(z.string(), FiniteNumber).optional(),
});
export type RadiusTokens = z.infer<typeof RadiusTokensSchema>;

export const ShadowTokensSchema = z.looseObject({
  none: z.array(ShadowStyleSchema),
  sm: z.array(ShadowStyleSchema),
  md: z.array(ShadowStyleSchema),
  lg: z.array(ShadowStyleSchema),
  custom: z.record(z.string(), z.array(ShadowStyleSchema)).optional(),
});
export type ShadowTokens = z.infer<typeof ShadowTokensSchema>;

export const GridTokensSchema = z.looseObject({
  columns: z.number().int().positive(),
  gutter: FiniteNumber.min(0),
  margin: FiniteNumber.min(0),
  /**
   * Snapping increment. Doc 04 §14.5 uses it for Shift+arrow nudges and grid
   * snapping, so a dense technical deck and an airy pitch deck can carry different
   * rhythms without either one hardcoding a number.
   */
  baseUnit: FiniteNumber.positive(),
  baselineGrid: FiniteNumber.positive().optional(),
});
export type GridTokens = z.infer<typeof GridTokensSchema>;

export const ChartThemeSchema = z.looseObject({
  series: z.array(ColorValueSchema),
  gridlineColor: ColorValueSchema.optional(),
  axisColor: ColorValueSchema.optional(),
  labelTypography: TypographyStyleSchema.optional(),
  showGridlines: z.boolean().optional(),
  barCornerRadius: FiniteNumber.min(0).optional(),
  lineWidth: FiniteNumber.min(0).optional(),
  pointSize: FiniteNumber.min(0).optional(),
});
export type ChartTheme = z.infer<typeof ChartThemeSchema>;

export const DiagramThemeSchema = z.looseObject({
  nodeFill: PaintSchema.optional(),
  nodeStroke: StrokeStyleSchema.optional(),
  nodeRadius: FiniteNumber.min(0).optional(),
  nodePadding: InsetsSchema.optional(),
  nodeTypography: TypographyStyleSchema.optional(),
  edgeStroke: StrokeStyleSchema.optional(),
  edgeLabelTypography: TypographyStyleSchema.optional(),
  /**
   * Keyed by DiagramNode.role. This is what makes an architecture diagram legible:
   * datastores look different from services and externals from internals, and the
   * difference comes from the theme rather than from per-node styling that an
   * agent has to remember to apply consistently.
   */
  roleStyles: z.record(z.string(), CommonStyleSchema).optional(),
  boundaryStyle: CommonStyleSchema.optional(),
});
export type DiagramTheme = z.infer<typeof DiagramThemeSchema>;

/**
 * How tables look across the deck (design review, 2026-09-27). An element's own
 * `tableStyle` still wins; this is what a table with none draws, so a deck's
 * tables can be restyled in one place instead of table by table.
 */
export const TableThemeSchema = z.looseObject({
  headerFill: PaintSchema.optional(),
  headerColor: ColorValueSchema.optional(),
  borderColor: ColorValueSchema.optional(),
  borders: z.enum(["all", "horizontal", "outer", "none"]).optional(),
  banding: z.enum(["none", "rows", "columns"]).optional(),
  bandColor: ColorValueSchema.optional(),
  cellPadding: InsetsSchema.optional(),
  fontSize: FiniteNumber.positive().optional(),
});
export type TableTheme = z.infer<typeof TableThemeSchema>;

export const ImageryThemeSchema = z.looseObject({
  treatment: z.enum(["none", "duotone", "grayscale", "tinted"]).optional(),
  duotoneColors: z.tuple([ColorValueSchema, ColorValueSchema]).optional(),
  defaultCornerRadius: FiniteNumber.min(0).optional(),
  defaultOverlay: PaintSchema.optional(),
  /** e.g. ["16:9", "4:3"] */
  aspectPreference: z.array(z.string()).optional(),
});
export type ImageryTheme = z.infer<typeof ImageryThemeSchema>;

/**
 * Brand rules (doc 02 §22.7).
 *
 * Rules carrying a `check` are enforced by the validator. Rules without one are
 * prompt context for the Creative Director and the Critic. Both forms are useful;
 * only the first is reliable.
 */
export const BrandCheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("maxFontSizesPerSlide"), value: z.number().int().positive() }),
  z.object({ type: z.literal("allowedFontFamilies"), value: z.array(z.string()) }),
  z.object({ type: z.literal("minContrastRatio"), value: FiniteNumber.positive() }),
  z.object({ type: z.literal("forbiddenColorLiterals"), value: z.boolean() }),
  /** Characters per slide. */
  z.object({ type: z.literal("maxTextDensity"), value: z.number().int().positive() }),
  z.object({ type: z.literal("requiredElements"), value: z.array(SemanticRoleSchema) }),
  z.object({
    type: z.literal("logoPlacement"),
    value: z.object({ corner: z.string(), minSize: FiniteNumber.positive() }),
  }),
]);
export type BrandCheck = z.infer<typeof BrandCheckSchema>;

export const BrandRuleSchema = z.object({
  id: z.string(),
  kind: z.enum(["must", "should", "must-not"]),
  scope: z.enum(["typography", "color", "imagery", "layout", "motion", "content"]),
  /** Human-readable; handed to agents verbatim. */
  statement: z.string(),
  check: BrandCheckSchema.optional(),
});
export type BrandRule = z.infer<typeof BrandRuleSchema>;

/**
 * A portable, data-only motion preset.
 *
 * There is deliberately no expression or callback field. A `.mydeck` file may
 * be opened from an email attachment, so a theme can carry keyframes but never
 * executable code. `reducedMotion` remains optional at the structural layer so
 * older readers can preserve an incomplete preset; validation rejects it with
 * E208 before the document can be presented or exported.
 */
export const CustomMotionPresetSchema = z.looseObject({
  category: z.enum(["entrance", "emphasis", "loop", "exit", "path"]).optional(),
  description: z.string().max(280).optional(),
  propertyTracks: z.array(PropertyTrackSchema).min(1),
  reducedMotion: z.string().min(1).optional(),
});
export type CustomMotionPreset = z.infer<typeof CustomMotionPresetSchema>;

/** Motion theme (doc 02 §23). Preset defaults live here so no agent hardcodes them. */
export const MotionThemeSchema = z.looseObject({
  personality: z.enum(["subtle", "cinematic", "playful", "technical", "custom"]).optional(),
  defaultEntrance: z.string().optional(),
  defaultExit: z.string().optional(),
  defaultEmphasis: z.string().optional(),
  defaultDurationMs: MillisecondsSchema.optional(),
  defaultEasing: EasingSchema.optional(),
  staggerMs: MillisecondsSchema.optional(),
  reducedMotionFallback: z.enum(["fade", "none"]).optional(),
  /** Theme-local presets travel with templates and imported `.mydeck` files. */
  motionPresets: z.record(
    z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    CustomMotionPresetSchema,
  ).optional(),
  /**
   * The entrance budget, default 2500. Past roughly 2.5s the presenter is talking
   * over an animation that is still running. The Critic flags slides that exceed
   * it; the Motion Agent treats it as a hard constraint when sequencing.
   */
  maxSlideDurationMs: MillisecondsSchema.optional(),
});
export type MotionTheme = z.infer<typeof MotionThemeSchema>;

/**
 * Personality defaults (doc 02 §23.1). A preset invoked with no parameters must
 * look right for the deck's personality; this table is how that happens.
 */
export const MOTION_PERSONALITY_DEFAULTS = {
  subtle: { defaultDurationMs: 300, defaultEasing: "easeOut", staggerMs: 50 },
  technical: { defaultDurationMs: 400, defaultEasing: "emphasized", staggerMs: 70 },
  cinematic: { defaultDurationMs: 700, defaultEasing: "emphasized", staggerMs: 120 },
  playful: { defaultDurationMs: 500, defaultEasing: "spring(180,12,1)", staggerMs: 90 },
} as const;

/**
 * A named, reusable look for an object: "Metric card", "Callout", "Caption"
 * (design review, 2026-09-27). The name is the key in `theme.objectStyles`,
 * and an element that uses one says so with `styleRef`.
 *
 * A style is applied by **copying** its values onto the element, not by
 * reference at render time. The element keeps its own `style`, `typography`
 * and `opacity`, so a deck is still complete without the definition, every
 * renderer and exporter reads what it already reads, and the inspector shows
 * real values. `styleRef` is what lets the editor update every user of a style
 * at once, and say which objects have drifted from it.
 */
export const ObjectStyleSchema = z.looseObject({
  /** What kind of object the style was made from, so it is offered where it fits. */
  appliesTo: z.enum(["shape", "text", "icon", "group", "any"]).optional(),
  style: CommonStyleSchema.partial().optional(),
  typography: TypographyStyleSchema.partial().optional(),
  opacity: z.number().min(0).max(1).optional(),
  description: z.string().max(280).optional(),
});
export type ObjectStyle = z.infer<typeof ObjectStyleSchema>;

/**
 * A colour mode (design review, 2026-09-27): a dark version of a light deck, a
 * section in the brand's second palette. It overrides some colour tokens and
 * nothing else, so everything that refers to a token follows it and a slide
 * picks one with `colorMode`.
 */
export const ColorModeSchema = z.looseObject({
  appearance: z.enum(["light", "dark"]).optional(),
  colors: ColorTokensSchema.partial(),
});
export type ColorMode = z.infer<typeof ColorModeSchema>;

/**
 * An icon someone brought (design review, 2026-09-27): an uploaded SVG reduced
 * to path data and circles on a square grid, kept with the theme so a brand's
 * icons travel with its colours and faces — into every deck that uses the
 * theme, and into a saved workspace theme. Only geometry survives the import:
 * no markup, no styles, no links, so a deck that carries one is still safe to
 * email. The same path grammar a custom shape is held to.
 */
export const BrandIconSchema = z.looseObject({
  viewBox: FiniteNumber.positive(),
  paths: z.array(z.string().max(20_000).regex(/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\-+\s]+$/)).max(200),
  circles: z.array(z.tuple([FiniteNumber, FiniteNumber, FiniteNumber.min(0)])).max(200).optional(),
  /** Filled shapes (a logo mark) rather than outlines (a line icon). */
  fill: z.boolean().optional(),
  keywords: z.array(z.string().max(40)).max(20).optional(),
});
export type BrandIcon = z.infer<typeof BrandIconSchema>;

export const ThemeDefinitionSchema = z.looseObject({
  id: prefixedId("thm"),
  name: z.string().min(1),
  description: z.string().optional(),
  mode: z.enum(["light", "dark"]).optional(),
  colors: ColorTokensSchema,
  typography: TypographyTokensSchema,
  spacing: SpacingTokensSchema,
  radii: RadiusTokensSchema,
  shadows: ShadowTokensSchema,
  grid: GridTokensSchema,
  chart: ChartThemeSchema.optional(),
  diagram: DiagramThemeSchema.optional(),
  table: TableThemeSchema.optional(),
  imagery: ImageryThemeSchema.optional(),
  motion: MotionThemeSchema.optional(),
  contrastPairs: z.array(ContrastPairSchema).optional(),
  brandRules: z.array(BrandRuleSchema).optional(),
  logoAssetIds: z.array(IdSchema).optional(),
  /** Named object styles, keyed by name (no dots). See `ObjectStyleSchema`. */
  objectStyles: z.record(z.string().min(1).max(60).regex(/^[^.]+$/), ObjectStyleSchema).optional(),
  /** The brand's own icons by name, drawn with `icon.set: "brand"`. See `BrandIconSchema`. */
  icons: z.record(z.string().min(1).max(60).regex(/^[^./~]+$/), BrandIconSchema).optional(),
  /** Colour modes by name. See `ColorModeSchema`. */
  modes: z.record(z.string().min(1).max(40), ColorModeSchema).optional(),
  /** Inherit from a workspace theme. */
  extends: IdSchema.optional(),
});
export type ThemeDefinition = z.infer<typeof ThemeDefinitionSchema>;

/**
 * Theme resolution order (doc 02 §22.8):
 *
 *   element literal value
 *     > element token reference
 *     > component parameter default
 *     > theme token
 *     > theme.extends parent token
 *     > built-in default
 *
 * A missing token resolves up the chain rather than failing. A token reference
 * that resolves nowhere is error E015.
 */
export const TOKEN_PREFIX = "token:";

export function isTokenRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(TOKEN_PREFIX);
}

/** "token:colors.accent" -> "colors.accent" */
export function tokenPath(value: string): string {
  return value.slice(TOKEN_PREFIX.length);
}

/** Resolve a dotted token path against a theme. Returns undefined if unresolvable. */
export function resolveToken(theme: ThemeDefinition, path: string): unknown {
  let cursor: unknown = theme;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
