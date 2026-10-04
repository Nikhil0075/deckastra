import { z } from "zod";
import { IdSchema, prefixedId } from "./ids";
import { IsoDateTimeSchema, NormalizedSchema } from "./primitives";

/**
 * Patch and transaction model (doc 02 §31).
 *
 * THIS IS THE CANONICAL DEFINITION OF THE CHANGE LINEAGE. Doc 03 §16's
 * AgentTransaction, doc 05 §11's Transaction and doc 04 §29's EditCommand were
 * four names for one concept; they reference these types rather than redefining
 * them.
 *
 *     PatchOperation   atomic change to one path
 *           |
 *         Patch        an ordered set of operations + intent
 *           |
 *      Transaction     an applied patch + inverse + source + status
 */

/**
 * Path grammar — id-addressed (doc 02 §31.3).
 *
 *     PatchPath := "/" Segment ( "/" Segment )*
 *     Segment   := Key | Index | IdRef | "-"
 *     IdRef     := "id:" Id
 *
 *     /slides/id:sld_01JB8Z.../elements/id:el_07/transform/x
 *     /slides/id:sld_01JB8Z.../elements/-                     (append)
 *     /theme/colors/accent
 *
 * v1.0 used plain JSON Pointer. Index-addressed paths break whenever an earlier
 * sibling is inserted or removed — which is exactly what agents do, and exactly
 * what happens between an agent's read and its write.
 *
 * Rules:
 *   1. Anything carrying an Id is addressed by "id:" — slides, elements, tracks,
 *      clips, assets, components, data sources.
 *   2. Numeric indices stay valid for arrays whose members have no id: keyframes,
 *      spans, blocks, gradient stops, chart rows.
 *   3. Ids resolve to indices at apply time, atomically with the rest of the patch.
 *   4. An unresolvable id fails the whole patch with E030 and a message naming the
 *      nearest match.
 *   5. "-" appends, as in RFC 6902. "~0" and "~1" escape "~" and "/".
 *
 * Agents must emit id-addressed paths. The editor may emit index paths for local
 * operations where it holds the document, but anything crossing a process
 * boundary uses ids.
 */
export const PatchPathSchema = z.string().startsWith("/");
export type PatchPath = string;

export const ID_SEGMENT_PREFIX = "id:";

export function isIdSegment(segment: string): boolean {
  return segment.startsWith(ID_SEGMENT_PREFIX);
}

export function segmentId(segment: string): string {
  return segment.slice(ID_SEGMENT_PREFIX.length);
}

/** Split a patch path into segments, unescaping ~1 -> "/" and ~0 -> "~". */
export function splitPath(path: PatchPath): string[] {
  if (path === "/") return [];
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function joinPath(segments: readonly string[]): PatchPath {
  return "/" + segments.map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

/**
 * `copy` and `test` are new in v1.1. `test` is the mechanism for optimistic
 * concurrency: an agent that read a value can assert it is unchanged before
 * writing, and the whole patch fails atomically if it is not.
 */
export const PatchOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: PatchPathSchema, value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: PatchPathSchema }),
  z.object({ op: z.literal("replace"), path: PatchPathSchema, value: z.unknown() }),
  z.object({ op: z.literal("move"), from: PatchPathSchema, path: PatchPathSchema }),
  z.object({ op: z.literal("copy"), from: PatchPathSchema, path: PatchPathSchema }),
  z.object({ op: z.literal("test"), path: PatchPathSchema, value: z.unknown() }),
]);
export type PatchOperation = z.infer<typeof PatchOperationSchema>;

/**
 * What powers AI-specific undo, the agent inspector, audit logs and change
 * explanation (doc 01 §11.3).
 *
 * `reason` is user-facing and should be a sentence, not a label. "Shortened the
 * headline so it fits at the theme's display size without shrinking" tells the
 * user something; "Optimized text" does not.
 */
export const AgentChangeMetadataSchema = z.looseObject({
  agentId: z.string(),
  intent: z.string(),
  reason: z.string().optional(),
  confidence: NormalizedSchema.optional(),
  sourceIds: z.array(IdSchema).optional(),
  alternativesConsidered: z.array(z.string()).optional(),
  criticScoreBefore: z.number().optional(),
  criticScoreAfter: z.number().optional(),
  createdAt: IsoDateTimeSchema,
});
export type AgentChangeMetadata = z.infer<typeof AgentChangeMetadataSchema>;

/** Patches are atomic: all operations apply or none do. A partially applied patch
 *  is never a valid state. */
export const PatchSchema = z.looseObject({
  id: IdSchema,
  targetPresentationId: prefixedId("doc"),
  /** Optimistic concurrency at patch level. */
  expectedVersionId: z.string().optional(),
  operations: z.array(PatchOperationSchema),
  /** Human-readable summary. */
  intent: z.string(),
  agentMetadata: AgentChangeMetadataSchema.optional(),
});
export type Patch = z.infer<typeof PatchSchema>;

/**
 * Lifecycle (doc 02 §31.6):
 *
 *     pending ──approve──> applied ──undo──> reverted
 *        |
 *        ├──reject──> rejected
 *        └──24h────> expired
 *
 * v1.0 had no representation for a proposed-but-unapplied change, so "preview this
 * AI edit" had nowhere to live. A pending transaction is validated on creation and
 * re-validated on approval, because the document may have moved underneath it; if
 * re-validation fails it moves to `expired` with a diff explaining what changed.
 */
export const TransactionStatusSchema = z.enum([
  "pending",
  "applied",
  "rejected",
  "expired",
  "reverted",
]);
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

export const TransactionSchema = z.looseObject({
  id: prefixedId("txn"),
  presentationId: prefixedId("doc"),
  parentVersionId: z.string(),
  /** Set on apply. */
  resultVersionId: z.string().optional(),
  source: z.enum(["user", "agent", "system", "import"]),
  agentId: z.string().optional(),
  /** MCP client or app surface. */
  clientId: z.string().optional(),
  userInstruction: z.string().optional(),
  intent: z.string(),
  operations: z.array(PatchOperationSchema),
  /** Computed at apply time against the pre-state — the only moment the old value
   *  is known (doc 02 §31.4). */
  inverseOperations: z.array(PatchOperationSchema),
  status: TransactionStatusSchema,
  reason: z.string().optional(),
  confidence: NormalizedSchema.optional(),
  sourceIds: z.array(IdSchema).optional(),
  createdAt: IsoDateTimeSchema,
  appliedAt: IsoDateTimeSchema.optional(),
  createdBy: z.string(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

/**
 * Risk tier (doc 02 §31.7).
 *
 * Computed SERVER-SIDE from the operations, never declared by the caller. A
 * caller-declared tier is a caller-controlled security boundary, which is no
 * boundary at all.
 */
export type RiskTier = "low" | "medium" | "high";

export interface RiskTierResult {
  tier: RiskTier;
  /** Why this tier — surfaced to the user in the approval prompt. */
  reasons: string[];
  defaultBehavior: "autoApply" | "pendingPreview" | "explicitApproval";
}

/**
 * low     <= 3 ops on one slide, no deletions, no theme/viewport change  -> auto-apply
 * medium  one slide restructured, image replaced, slide added            -> pending + preview
 * high    > 3 slides touched, any slide deleted, theme or viewport change -> explicit approval
 */
/** The slot paths an operation under `/locales` writes: one in its path, or every entry in an added overlay. */
function localeSlotPathsIn(segments: readonly string[], value: unknown): string[] {
  if (segments.length >= 4 && segments[2] === "entries") return [segments[3]!];
  const entriesOf = (overlay: unknown): string[] =>
    overlay && typeof overlay === "object" && (overlay as { entries?: unknown }).entries && typeof (overlay as { entries?: unknown }).entries === "object"
      ? Object.keys((overlay as { entries: Record<string, unknown> }).entries)
      : [];
  if (segments.length === 2) return entriesOf(value);
  if (segments.length === 1 && value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(entriesOf);
  }
  if (segments.length === 3 && segments[2] === "entries" && value && typeof value === "object") return Object.keys(value);
  return [];
}

export function computeRiskTier(operations: readonly PatchOperation[]): RiskTierResult {
  const reasons: string[] = [];
  const touchedSlides = new Set<string>();
  let removesSlide = false;
  let touchesThemeOrViewport = false;
  let hasDeletion = false;

  for (const op of operations) {
    const segments = splitPath(op.path);
    const root = segments[0];

    if (root === "theme" || root === "viewport") {
      touchesThemeOrViewport = true;
      reasons.push(`Changes ${root}`);
    }

    if (root === "slides" && segments.length >= 2) {
      touchedSlides.add(segments[1]!);
      if (op.op === "remove" && segments.length === 2) {
        removesSlide = true;
        reasons.push("Deletes a slide");
      }
    }

    // A translation touches the slides whose words it replaces (integration plan
    // 01 §3.1). Overlay entries live under `/locales`, outside `/slides`, and a
    // forty-slide translation counted as touching no slide would auto-apply as a
    // "small" change. Entries are found in the path or inside an added overlay.
    if (root === "locales") {
      for (const slot of localeSlotPathsIn(segments, "value" in op ? op.value : undefined)) {
        const slotSegments = splitPath(slot);
        if (slotSegments[0] === "slides" && slotSegments.length >= 2) touchedSlides.add(slotSegments[1]!);
      }
    }

    if (op.op === "remove") hasDeletion = true;

    if (op.op === "move" || op.op === "copy") {
      const fromSegments = splitPath(op.from);
      if (fromSegments[0] === "slides" && fromSegments.length >= 2) {
        touchedSlides.add(fromSegments[1]!);
      }
    }
  }

  if (touchedSlides.size > 3) reasons.push(`Touches ${touchedSlides.size} slides`);

  if (removesSlide || touchesThemeOrViewport || touchedSlides.size > 3) {
    return { tier: "high", reasons, defaultBehavior: "explicitApproval" };
  }

  if (operations.length <= 3 && touchedSlides.size <= 1 && !hasDeletion) {
    return { tier: "low", reasons, defaultBehavior: "autoApply" };
  }

  if (hasDeletion) reasons.push("Removes content");
  return { tier: "medium", reasons, defaultBehavior: "pendingPreview" };
}

/**
 * Granularity guidance for agents (doc 02 §31.8).
 *
 * Agents return patches, not documents. A patch that replaces a whole slide
 * destroys ids, breaks animations that referenced them, and makes the change
 * unreviewable. Target the narrowest path that expresses the intent.
 */
export const MAX_RECOMMENDED_OPS_PER_PATCH = 40;
