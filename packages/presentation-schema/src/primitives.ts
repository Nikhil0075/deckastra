import { z } from "zod";
import { IdSchema } from "./ids.js";

/**
 * Conventions and primitives (doc 02 §0).
 *
 * Every length, size and coordinate is a logical presentation pixel expressed as a
 * bare number — never a "12px" string. Durations are integer milliseconds. Angles
 * are degrees, clockwise positive. Timestamps are ISO 8601 UTC.
 */

/** A finite number. NaN and Infinity are validation error E006. */
export const FiniteNumber = z.number().finite();

/** 0..1, clamped by the validator (doc 02 §0.3). */
export const NormalizedSchema = z.number().min(0).max(1);
export type Normalized = number;

export const MillisecondsSchema = z.number().int().min(0);
export type Milliseconds = number;

export const IsoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, {
    message: "Expected an ISO 8601 timestamp, e.g. 2026-09-05T00:00:00Z",
  });

/**
 * An enum that accepts values it does not know (doc 02 §0.8).
 *
 * The forward-compatibility rule requires unknown enum values to survive a
 * round-trip: a v1 reader opening a v2 deck must not delete a transition type it
 * has never heard of. A closed `z.enum` would reject the whole document.
 *
 * Use this for *descriptive* enums — ones where a renderer can degrade sensibly
 * (a transition it cannot draw becomes a cut; a semantic role it does not know is
 * treated as "custom"). Keep `z.enum` for *structural* ones, where an unknown
 * value cannot be interpreted at all and silently accepting it would push the
 * failure somewhere far less diagnosable: patch op codes, paint variants,
 * constraint kinds.
 *
 * The known values stay attached as `.known` so the validator can warn (W241) and
 * editor UI can still offer a fixed list.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T) {
  const schema = z.string() as z.ZodString & { known: T };
  schema.known = values;
  return schema;
}

/** True when `value` is outside an open enum's known set. */
export function isUnknownEnumValue(known: readonly string[], value: unknown): boolean {
  return typeof value === "string" && !known.includes(value);
}

// ---------------------------------------------------------------- geometry

export const PointSchema = z.object({ x: FiniteNumber, y: FiniteNumber });
export const SizeSchema = z.object({ width: FiniteNumber, height: FiniteNumber });
export const RectSchema = z.object({
  x: FiniteNumber,
  y: FiniteNumber,
  width: FiniteNumber,
  height: FiniteNumber,
});
export const InsetsSchema = z.object({
  top: FiniteNumber,
  right: FiniteNumber,
  bottom: FiniteNumber,
  left: FiniteNumber,
});

export type Point = z.infer<typeof PointSchema>;
export type Size = z.infer<typeof SizeSchema>;
export type Rect = z.infer<typeof RectSchema>;
export type Insets = z.infer<typeof InsetsSchema>;

// ------------------------------------------------------------ color & paint

/**
 * Either a theme token reference or a literal color (doc 02 §0.4).
 *   token:    "token:colors.accent" — resolved against ThemeDefinition (§22)
 *   literal:  "#RRGGBB", "#RRGGBBAA", or a CSS rgb()/hsl() string
 *
 * Prefer tokens. A deck built from token references re-themes cleanly; one built
 * from hex values does not. Literal colors with a near-equivalent token are
 * flagged by rule W203, not rejected.
 */
export const ColorValueSchema = z.string().min(1);
export type ColorValue = string;

export const ImageFitSchema = z.enum(["cover", "contain", "fill", "none"]);
export const HorizontalAlignSchema = z.enum(["left", "center", "right", "justify"]);
export const VerticalAlignSchema = z.enum(["top", "middle", "bottom"]);

export type ImageFit = z.infer<typeof ImageFitSchema>;
export type HorizontalAlign = z.infer<typeof HorizontalAlignSchema>;
export type VerticalAlign = z.infer<typeof VerticalAlignSchema>;

export const GradientStopSchema = z.object({
  offset: NormalizedSchema,
  color: ColorValueSchema,
});
export type GradientStop = z.infer<typeof GradientStopSchema>;

export const PaintSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("solid"), color: ColorValueSchema }),
  z.object({
    type: z.literal("linearGradient"),
    stops: z.array(GradientStopSchema).min(2),
    angle: FiniteNumber,
  }),
  z.object({
    type: z.literal("radialGradient"),
    stops: z.array(GradientStopSchema).min(2),
    center: PointSchema.optional(),
    radius: FiniteNumber.optional(),
  }),
  z.object({
    type: z.literal("image"),
    assetId: IdSchema,
    fit: ImageFitSchema.optional(),
    opacity: NormalizedSchema.optional(),
  }),
]);
export type Paint = z.infer<typeof PaintSchema>;

// ------------------------------------------- stroke, shadow, corners, filters

export const StrokeStyleSchema = z.object({
  paint: PaintSchema,
  /** Logical px. Default 1. */
  width: FiniteNumber.min(0).default(1),
  align: z.enum(["inside", "center", "outside"]).optional(),
  /** e.g. [6, 4]. Omit for a solid stroke. */
  dash: z.array(FiniteNumber.min(0)).optional(),
  dashOffset: FiniteNumber.optional(),
  cap: z.enum(["butt", "round", "square"]).optional(),
  join: z.enum(["miter", "round", "bevel"]).optional(),
});
export type StrokeStyle = z.infer<typeof StrokeStyleSchema>;

export const ShadowStyleSchema = z.object({
  type: z.enum(["drop", "inner"]),
  offsetX: FiniteNumber,
  offsetY: FiniteNumber,
  blur: FiniteNumber.min(0),
  spread: FiniteNumber.optional(),
  color: ColorValueSchema,
});
export type ShadowStyle = z.infer<typeof ShadowStyleSchema>;

export const CornerRadiusSchema = z.union([
  FiniteNumber.min(0),
  z.object({
    topLeft: FiniteNumber.min(0),
    topRight: FiniteNumber.min(0),
    bottomRight: FiniteNumber.min(0),
    bottomLeft: FiniteNumber.min(0),
  }),
]);
export type CornerRadius = z.infer<typeof CornerRadiusSchema>;

/**
 * Filters are schema-legal but export-constrained: PPTX cannot represent most of
 * them and rasterizes (doc 04 §33.2). The model does not shrink to the weakest
 * export target; adapters degrade and report.
 */
export const VisualFilterSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("blur"), radius: FiniteNumber.min(0) }),
  z.object({ type: z.literal("brightness"), amount: FiniteNumber }),
  z.object({ type: z.literal("contrast"), amount: FiniteNumber }),
  z.object({ type: z.literal("saturate"), amount: FiniteNumber }),
  z.object({ type: z.literal("grayscale"), amount: NormalizedSchema }),
  z.object({ type: z.literal("sepia"), amount: NormalizedSchema }),
]);
export type VisualFilter = z.infer<typeof VisualFilterSchema>;

export const BlendModeSchema = z.enum([
  "normal", "multiply", "screen", "overlay",
  "darken", "lighten", "colorDodge", "colorBurn",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
]);
export type BlendMode = z.infer<typeof BlendModeSchema>;

/** Common style shared by every element (doc 02 §11). */
export const CommonStyleSchema = z.object({
  fill: PaintSchema.optional(),
  stroke: StrokeStyleSchema.optional(),
  /** Applied in array order. */
  shadow: z.array(ShadowStyleSchema).optional(),
  cornerRadius: CornerRadiusSchema.optional(),
  blendMode: BlendModeSchema.optional(),
  filters: z.array(VisualFilterSchema).optional(),
  /** Applied to what is behind the element. */
  backdropFilters: z.array(VisualFilterSchema).optional(),
});
export type CommonStyle = z.infer<typeof CommonStyleSchema>;

// --------------------------------------------------------------- time/easing

const NAMED_EASINGS = ["linear", "easeIn", "easeOut", "easeInOut", "emphasized"] as const;
const CUBIC_BEZIER_RE = /^cubic-bezier\(\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*\)$/;
const SPRING_RE = /^spring\(\s*\d*\.?\d+\s*,\s*\d*\.?\d+\s*,\s*\d*\.?\d+\s*\)$/;

/**
 * Named easings resolve through one canonical table shared by the animation
 * runtime and every export adapter (doc 04 §22.3), so a curve authored in the
 * editor is the same curve in a PDF or a PPTX.
 *
 * Spring form is sampled to keyframes at build time — it never reaches a runtime
 * that would have to simulate it.
 */
export const EasingSchema = z.string().refine(
  (v) =>
    (NAMED_EASINGS as readonly string[]).includes(v) ||
    CUBIC_BEZIER_RE.test(v) ||
    SPRING_RE.test(v),
  {
    message:
      'Expected a named easing (linear, easeIn, easeOut, easeInOut, emphasized), "cubic-bezier(a,b,c,d)", or "spring(stiffness,damping,mass)"',
  },
);
export type Easing = string;

export const NAMED_EASING_VALUES = NAMED_EASINGS;
