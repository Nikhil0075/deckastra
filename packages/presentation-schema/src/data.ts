import { z } from "zod";
import { IdSchema, prefixedId } from "./ids.js";
import { FiniteNumber, IsoDateTimeSchema, NormalizedSchema } from "./primitives.js";

/** Data sources, bindings and provenance (doc 02 §29–§30). */

export const NumberFormatSchema = z.object({
  style: z.enum(["decimal", "percent", "currency", "compact"]).optional(),
  /** ISO 4217 */
  currency: z.string().length(3).optional(),
  decimals: z.number().int().min(0).max(20).optional(),
  locale: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});
export type NumberFormat = z.infer<typeof NumberFormatSchema>;

/**
 * Binding transforms (doc 02 §29.5).
 *
 * v1.0 had `transform?: string` — an unspecified expression language. Evaluated
 * client-side that makes a shared deck a code-execution vector, and doc 05 §34
 * forbids arbitrary code execution in MVP. This is the replacement: a fixed,
 * chainable allowlist.
 *
 * Every function is pure, total, and has a defined result for wrong-typed input
 * (pass through unchanged, emit warning W140). A binding must never throw during
 * render. `string.template` substitutes only the incoming value into {value}; it
 * is not a template language and cannot reference other data.
 */
export const BindingTransformSchema = z.discriminatedUnion("fn", [
  z.object({ fn: z.literal("number.format"), options: NumberFormatSchema }),
  z.object({ fn: z.literal("number.round"), options: z.object({ decimals: z.number().int() }) }),
  z.object({ fn: z.literal("number.scale"), options: z.object({ factor: FiniteNumber }) }),
  z.object({ fn: z.literal("number.percentChange"), options: z.object({ from: z.string() }) }),
  z.object({
    fn: z.literal("date.format"),
    options: z.object({ pattern: z.string(), timeZone: z.string().optional() }),
  }),
  z.object({ fn: z.literal("date.relative") }),
  z.object({ fn: z.literal("string.upper") }),
  z.object({ fn: z.literal("string.lower") }),
  z.object({ fn: z.literal("string.title") }),
  z.object({
    fn: z.literal("string.truncate"),
    options: z.object({ length: z.number().int().positive(), ellipsis: z.boolean().optional() }),
  }),
  z.object({ fn: z.literal("string.template"), options: z.object({ pattern: z.string() }) }),
  z.object({ fn: z.literal("array.join"), options: z.object({ separator: z.string() }) }),
  z.object({
    fn: z.literal("array.take"),
    options: z.object({
      count: z.number().int().positive(),
      from: z.enum(["start", "end"]).optional(),
    }),
  }),
  z.object({
    fn: z.literal("array.sort"),
    options: z.object({
      by: z.string().optional(),
      direction: z.enum(["asc", "desc"]).optional(),
    }),
  }),
  z.object({ fn: z.literal("math.sum") }),
  z.object({ fn: z.literal("math.avg") }),
  z.object({ fn: z.literal("math.min") }),
  z.object({ fn: z.literal("math.max") }),
  z.object({ fn: z.literal("math.count") }),
]);
export type BindingTransform = z.infer<typeof BindingTransformSchema>;

/**
 * targetProperty allowlist (doc 02 §29.4).
 *
 * Unrestricted property paths would let a binding rewrite `id`, `type` or
 * `children`, which is a structural-integrity hazard. Anything outside this list
 * is error E017.
 */
export const BINDING_TARGET_ALLOWLIST: readonly RegExp[] = [
  /^content\.blocks\.\d+\.spans\.\d+\.text$/, // TextElement
  /^data\.rows$/, // ChartElement, TableElement
  /^assetId$/, // ImageElement
  /^label$/, // DiagramNode, via subpath
  /^style\.fill\.color$/, // any element
];

export function isAllowedBindingTarget(targetProperty: string): boolean {
  return BINDING_TARGET_ALLOWLIST.some((re) => re.test(targetProperty));
}

export const DataBindingSchema = z.looseObject({
  sourceId: IdSchema,
  /** JSONPath into the resolved data. */
  path: z.string(),
  targetProperty: z.string(),
  /** Applied in array order. */
  transforms: z.array(BindingTransformSchema).optional(),
  /** Used when resolution fails. */
  fallback: z.unknown().optional(),
  /**
   * Why a deck still presents correctly when the network is down or a source has
   * been disconnected: the last good value renders with a staleness badge in the
   * editor and no badge in present mode.
   */
  cachedValue: z.unknown().optional(),
  cachedAt: IsoDateTimeSchema.optional(),
});
export type DataBinding = z.infer<typeof DataBindingSchema>;

export const RefreshPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("manual") }),
  z.object({ mode: z.literal("onOpen") }),
  z.object({ mode: z.literal("interval"), ms: z.number().int().positive() }),
]);
export type RefreshPolicy = z.infer<typeof RefreshPolicySchema>;

export const DataSourceDefinitionSchema = z.looseObject({
  id: prefixedId("src"),
  name: z.string().optional(),
  type: z.enum(["inline", "csv", "json", "api", "github", "database", "mcp"]),
  /**
   * Holds a *reference* to a workspace-level connection — never a URL with a
   * token, never an API key, never a connection string. Resolution happens
   * server-side under the requesting user's permissions.
   *
   * A .mydeck file must be safe to email.
   */
  configuration: z.record(z.string(), z.unknown()),
  refreshPolicy: RefreshPolicySchema.optional(),
  lastRefreshedAt: IsoDateTimeSchema.optional(),
  schema: z.record(z.string(), z.enum(["string", "number", "boolean", "date"])).optional(),
});
export type DataSourceDefinition = z.infer<typeof DataSourceDefinitionSchema>;

/** MVP data source types (doc 02 §37.2). The rest are schema-defined, deferred. */
export const MVP_DATA_SOURCE_TYPES = ["inline", "csv", "json"] as const;

/**
 * Provenance (doc 02 §30).
 *
 * It lives in the document rather than a side table for three reasons: the user
 * can click a claim and see which file produced it, and that must survive export
 * and duplication; a technical audience will ask "where did that number come
 * from" in the room; and when a repository changes the system can identify which
 * slides depended on the changed files.
 *
 * `excerpt` may contain private repository content, so it inherits the document's
 * access controls. Exports strip provenance by default.
 */
export const ProvenanceRecordSchema = z.looseObject({
  id: prefixedId("prv"),
  /** Element or slide. */
  targetId: IdSchema,
  sourceType: z.enum(["github", "web", "file", "user", "model", "mcp"]),
  /** repo#path:lines, a URL, an assetId, or a tool name. */
  sourceReference: z.string(),
  excerpt: z.string().optional(),
  excerptHash: z.string().optional(),
  confidence: NormalizedSchema.optional(),
  agentId: z.string().optional(),
  createdAt: IsoDateTimeSchema,
});
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;
