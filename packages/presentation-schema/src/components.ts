import { z } from "zod";
import { IdSchema, prefixedId } from "./ids";
import { SizeSchema } from "./primitives";
import { ContainerLayoutSchema } from "./layout";
import {
  ElementTypeSchema,
  PresentationElementSchema,
  type GroupResizeMode,
  type PresentationElement,
} from "./elements";

/**
 * Components and variables (doc 02 §40).
 *
 * The point of components is the last row of the spec's table: a 40-slide deck
 * with 30 hand-built cards cannot be restyled; the same deck with 30 instances
 * can. They are also the Layout Agent's safest building block — instantiate a
 * known-good component rather than compose five elements and hope.
 *
 * Schema-defined in v1; renderer and editor support land in Phase 2, so decks
 * authored now stay forward-compatible without a migration.
 */

export const ParameterTargetSchema = z.object({
  /** Path within the template, e.g. "children/0". */
  elementPath: z.string(),
  /** Allowlisted, exactly as binding targets are (doc 02 §29.4). */
  property: z.string(),
});
export type ParameterTarget = z.infer<typeof ParameterTargetSchema>;

/**
 * A parameter is wired to concrete places in the template rather than substituted
 * into a template string. Same reasoning as binding transforms: no expression
 * language anywhere in a document that is meant to be shareable.
 */
export const ComponentParameterSchema = z.looseObject({
  name: z.string().min(1),
  label: z.string().optional(),
  type: z.enum(["text", "richText", "number", "boolean", "color", "image", "icon", "enum"]),
  default: z.unknown().optional(),
  options: z.array(z.object({ value: z.unknown(), label: z.string() })).optional(),
  required: z.boolean().optional(),
  targets: z.array(ParameterTargetSchema),
});
export type ComponentParameter = z.infer<typeof ComponentParameterSchema>;

/**
 * Slots hold arbitrary child elements. A card component with a `body` slot lets
 * one instance contain a chart and another contain text, without two definitions.
 */
export const ComponentSlotSchema = z.looseObject({
  name: z.string().min(1),
  label: z.string().optional(),
  /** Default: any element type. */
  accepts: z.array(ElementTypeSchema).optional(),
  maxItems: z.number().int().positive().optional(),
  containerLayout: ContainerLayoutSchema.optional(),
});
export type ComponentSlot = z.infer<typeof ComponentSlotSchema>;

export interface ComponentDefinition {
  id: string;
  name: string;
  description?: string;
  /** Semver. Instances pin to it; updating a definition never silently
   *  propagates across 40 slides — that is exactly the unreviewable edit doc 01
   *  §4.2 exists to prevent. The editor offers an explicit, previewable,
   *  revertible "update instances to v2" transaction instead. */
  version: string;
  category?: string;
  parameters: ComponentParameter[];
  slots?: ComponentSlot[];
  /** Usually a GroupElement. */
  template: PresentationElement;
  defaultSize?: z.infer<typeof SizeSchema>;
  resizeBehavior?: GroupResizeMode;
  previewAssetId?: string;
  /** Workspace components are shared across a workspace's decks. */
  scope?: "document" | "workspace";
  [key: string]: unknown;
}

export const ComponentDefinitionSchema: z.ZodType<ComponentDefinition> = z.looseObject({
  id: prefixedId("cmp"),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, { message: "Expected a semver string" }),
  category: z.string().optional(),
  parameters: z.array(ComponentParameterSchema),
  slots: z.array(ComponentSlotSchema).optional(),
  get template() {
    return PresentationElementSchema;
  },
  defaultSize: SizeSchema.optional(),
  resizeBehavior: z.enum(["scaleChildren", "resizeContainer"]).optional(),
  previewAssetId: IdSchema.optional(),
  scope: z.enum(["document", "workspace"]).optional(),
}) as unknown as z.ZodType<ComponentDefinition>;

/**
 * Document-scoped named values, referenced from TextSpan.variableRef and from
 * component parameters. Typical: client name, quarter, presenter, product
 * version, date.
 *
 * Slide-scoped variables are deliberately excluded from v1 — they invite the
 * shadowing bugs that make templating systems hard to reason about.
 */
export const VariableDefinitionSchema = z.looseObject({
  type: z.enum(["string", "number", "boolean", "date", "color"]),
  value: z.unknown(),
  label: z.string().optional(),
  description: z.string().optional(),
  /** Optionally driven by a data source. */
  bindingSourceId: IdSchema.optional(),
});
export type VariableDefinition = z.infer<typeof VariableDefinitionSchema>;

/**
 * Value resolution (doc 02 §40.6):
 *
 *   explicit element value
 *     > component override
 *     > component parameter value
 *     > variable value
 *     > component parameter default
 *     > empty (render the variable name in a placeholder style)
 *
 * And within a single instance (§40.7):
 *
 *   template default  <  parameter value  <  explicit override
 *
 * Overrides are per-property and survive component updates as long as the
 * targeted path still exists. When it does not, the override is dropped with
 * warning W150 naming the instance and the lost property — visible, not silent.
 */
export const VALUE_RESOLUTION_ORDER = [
  "elementLiteral",
  "componentOverride",
  "componentParameterValue",
  "variableValue",
  "componentParameterDefault",
  "empty",
] as const;
