import { z } from "zod";
import { IdSchema } from "./ids.js";
import { FiniteNumber, InsetsSchema } from "./primitives.js";

/**
 * Layout constraints (doc 02 §20) and container layouts (§21).
 *
 * Precedence, normative here and restated in doc 04 §15.5:
 *
 *     container layout  >  constraints  >  absolute x/y
 *
 * A constraint on a container child may adjust cross-axis alignment only; it
 * cannot fight the container's main-axis placement.
 */

/**
 * Priority exists to break cycles. Doc 04 §16.1 resolves constraints with a
 * dependency-ordered evaluator that drops the lowest-priority constraint in any
 * cycle. Without priorities that choice is arbitrary; with them it is predictable
 * and explainable — "your equal-width rule was suspended because it conflicted
 * with the pin to the slide edge".
 *
 * Default is "strong". A "required" constraint is never dropped: two conflicting
 * required constraints are validation error E020, not a silent resolution.
 */
export const ConstraintPrioritySchema = z.enum(["required", "strong", "medium", "weak"]);
export type ConstraintPriority = z.infer<typeof ConstraintPrioritySchema>;

/** An element id, or one of the reserved container names. */
const ConstraintTargetSchema = z.union([IdSchema, z.enum(["slide", "safeArea", "parent"])]);

const EdgeSchema = z.enum(["left", "right", "top", "bottom"]);

export const AlignConstraintSchema = z.object({
  type: z.literal("align"),
  axis: z.enum(["left", "right", "top", "bottom", "centerX", "centerY"]),
  targetId: ConstraintTargetSchema,
  offset: FiniteNumber.optional(),
  priority: ConstraintPrioritySchema.optional(),
});

export const DistanceConstraintSchema = z.object({
  type: z.literal("distance"),
  edge: EdgeSchema,
  targetId: ConstraintTargetSchema,
  targetEdge: EdgeSchema.optional(),
  /** Logical px gap. */
  value: FiniteNumber,
  relation: z.enum(["equal", "min", "max"]).optional(),
  priority: ConstraintPrioritySchema.optional(),
});

export const AnchorConstraintSchema = z.object({
  type: z.literal("anchor"),
  anchor: z.enum(["parent", "slide"]),
  edges: z.array(EdgeSchema).min(1),
  insets: InsetsSchema,
  priority: ConstraintPrioritySchema.optional(),
});

export const EqualSizeConstraintSchema = z.object({
  type: z.literal("equalSize"),
  axis: z.enum(["width", "height", "both"]),
  targetId: IdSchema,
  priority: ConstraintPrioritySchema.optional(),
});

export const ContainmentConstraintSchema = z.object({
  type: z.literal("containment"),
  containerId: ConstraintTargetSchema,
  padding: InsetsSchema.optional(),
  priority: ConstraintPrioritySchema.optional(),
});

export const AspectRatioConstraintSchema = z.object({
  type: z.literal("aspectRatio"),
  /** width / height */
  ratio: FiniteNumber.positive(),
  priority: ConstraintPrioritySchema.optional(),
});

export const LayoutConstraintSchema = z.discriminatedUnion("type", [
  AlignConstraintSchema,
  DistanceConstraintSchema,
  AnchorConstraintSchema,
  EqualSizeConstraintSchema,
  ContainmentConstraintSchema,
  AspectRatioConstraintSchema,
]);
export type LayoutConstraint = z.infer<typeof LayoutConstraintSchema>;

/**
 * MVP solver scope (doc 02 §20.4): align, distance, anchor, containment.
 * equalSize and aspectRatio are schema-defined and can join the solver later
 * without a schema change.
 */
export const MVP_CONSTRAINT_TYPES = ["align", "distance", "anchor", "containment"] as const;

/**
 * Container layouts (doc 02 §21), attached to GroupElement.containerLayout.
 *
 * The single most common failure of generated slides is content that fits the
 * sample text and breaks on the real text. A container re-flows; absolute boxes
 * overlap. The Layout Agent should emit a container for anything repeated and
 * reserve "free" for genuinely bespoke compositions.
 *
 *   free        absolute children; the default and the escape hatch
 *   horizontal  KPI rows, logo strips, comparison columns
 *   vertical    bullet stacks, agenda lists, timeline steps
 *   grid        feature matrices, icon grids, photo walls
 *   stack       overlaid layers — a scrim over an image, a badge on a card
 */
export const ContainerLayoutSchema = z.looseObject({
  type: z.enum(["free", "horizontal", "vertical", "grid", "stack"]),
  /** Defaults to theme.spacing. */
  gap: FiniteNumber.min(0).optional(),
  rowGap: FiniteNumber.min(0).optional(),
  columnGap: FiniteNumber.min(0).optional(),
  padding: InsetsSchema.optional(),
  /** Cross axis. */
  align: z.enum(["start", "center", "end", "stretch", "baseline"]).optional(),
  justify: z
    .enum(["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly"])
    .optional(),
  columns: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  wrap: z.boolean().optional(),
  autoFlow: z.enum(["row", "column"]).optional(),
  /** "equal" gives every child the same main-axis size. */
  distribute: z.enum(["none", "equal"]).optional(),
});
export type ContainerLayout = z.infer<typeof ContainerLayoutSchema>;
