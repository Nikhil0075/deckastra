import { type Id } from "./ids";
import { type PatchOperation } from "./patch";
import { checkLimit, LIMITS } from "./limits";
import {
  CHART_KINDS,
  DIAGRAM_KINDS,
  ELEMENT_SCHEMA_BY_TYPE,
  SHAPE_KINDS,
  isKnownElementType,
  walkElements,
  type PresentationElement,
} from "./elements";
import { SEMANTIC_ROLES } from "./semantic-roles";
import { SLIDE_TRANSITION_TYPES } from "./animation";
import { isUnknownEnumValue } from "./primitives";
import { isTokenRef, resolveToken, tokenPath, type ThemeDefinition } from "./theme";
import { isAllowedBindingTarget } from "./data";
import {
  PresentationDocumentSchema,
  type PresentationDocument,
  type Slide,
} from "./document";
import { isReadableSchemaVersion, parseSemVer } from "./version";

/**
 * Validation (doc 02 §34, §42).
 *
 * Validation is a product surface, not a dev tool. This report is consumed by the
 * editor (inline badges), the Critic Agent (issue routing), the export adapters
 * (pre-flight) and later the MCP surface — so its shape is stable and documented.
 *
 * Levels:
 *   structural   parse/load, every patch      blocking
 *   referential  after structural             blocking for E codes
 *   semantic     on demand, after render      warnings
 *   brand        on demand                    Critic input
 *
 * A document that fails structural validation is never rendered (doc 04 §6.4).
 * Rendering a partially valid document produces bugs far harder to diagnose than
 * a clear failure.
 */

export type Severity = "error" | "warning" | "info";

export interface ValidationIssue {
  /** A stable code from the catalog below, e.g. "E001", "W203". */
  code: string;
  severity: Severity;
  /** Patch path to the offending node. */
  path: string;
  /** Actionable: says what to do, not just what is wrong. */
  message: string;
  targetIds?: Id[];
  /**
   * Present when the repair is mechanically derivable. This is what turns "this
   * text overflows" into a one-click fix, and what lets an agent correct itself
   * without another model round-trip.
   */
  suggestedFix?: PatchOperation[];
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  checkedAt: string;
}

/** The rule catalog (doc 02 §42). Stable codes so the editor, agents, exporters
 *  and the MCP surface all reference the same rule. */
export const RULES: Record<string, { severity: Severity; summary: string }> = {
  // structural
  E001: { severity: "error", summary: "Duplicate id within the document" },
  E002: { severity: "error", summary: "Missing required property" },
  E003: { severity: "error", summary: "Property has the wrong type" },
  E004: { severity: "error", summary: "Unknown type for the declared schemaVersion major" },
  E005: { severity: "error", summary: "Element outside the PresentationElement union" },
  E006: { severity: "error", summary: "NaN or Infinity in a numeric field" },
  E007: { severity: "error", summary: "Negative or zero width/height" },
  E008: { severity: "error", summary: "Group nesting deeper than 8" },
  E009: { severity: "error", summary: "Document exceeds a size limit" },
  E010: { severity: "error", summary: "schemaVersion missing or unparseable" },
  E011: { severity: "error", summary: "updatedAt earlier than createdAt" },
  E012: { severity: "error", summary: "pathData outside the SVG path grammar" },

  // referential
  E101: { severity: "error", summary: "AnimationTrack.targetId does not resolve" },
  E102: { severity: "error", summary: "ImageElement.assetId does not resolve" },
  E103: { severity: "error", summary: "Constraint targetId does not resolve" },
  E104: { severity: "error", summary: "SharedElementMapping references a missing element" },
  E105: { severity: "error", summary: "Interaction.action.slideId does not resolve" },
  E106: { severity: "error", summary: "DiagramEdge from/to references a missing node" },
  E107: { severity: "error", summary: "ComponentInstanceElement.componentId does not resolve" },
  E108: { severity: "error", summary: "DataBinding.sourceId does not resolve" },
  E109: { severity: "error", summary: "AnchorReference.elementId does not resolve" },
  E110: { severity: "error", summary: "Chart table data reference points at a missing table" },

  // semantic
  E201: { severity: "error", summary: "Cycle among required constraints" },
  E202: { severity: "error", summary: "Theme token reference does not resolve" },
  E203: { severity: "error", summary: "Two required constraints conflict irreconcilably" },
  E204: { severity: "error", summary: "Keyframe offsets unsorted or outside 0..1" },
  E205: { severity: "error", summary: "AnimationClip.durationMs <= 0" },
  E206: { severity: "error", summary: "DataBinding.targetProperty outside the allowlist" },
  E207: { severity: "error", summary: "BindingTransform.fn not in the allowlist" },

  // patch
  E301: { severity: "error", summary: "Path does not resolve (id: segment not found)" },
  E302: { severity: "error", summary: "test operation failed" },
  E303: { severity: "error", summary: "Patch would produce an invalid document" },
  E304: { severity: "error", summary: "expectedVersionId does not match current head" },
  E305: { severity: "error", summary: "Patch targets a locked element or slide" },
  E306: { severity: "error", summary: "Patch targets an UnknownElement" },

  // warnings
  W101: { severity: "warning", summary: "More than one headline on a slide" },
  W102: { severity: "warning", summary: "keyMessage has no prominent element expressing it" },
  W103: { severity: "warning", summary: "Text overflows its box" },
  W104: { severity: "warning", summary: "Element outside the slide or safe area" },
  W105: { severity: "warning", summary: "Connector lost its anchor" },
  W110: { severity: "warning", summary: "Unintended overlap between non-decoration elements" },
  W111: { severity: "warning", summary: "More than three type sizes on one slide" },
  W130: { severity: "warning", summary: "subTarget does not resolve; clip skipped" },
  W131: { severity: "warning", summary: "Overlapping animation clips on the same property" },
  W132: { severity: "warning", summary: "Slide entrance exceeds motion.maxSlideDurationMs" },
  W133: { severity: "warning", summary: "Animation preset has no reduced-motion fallback" },
  W140: { severity: "warning", summary: "Binding transform received wrong-typed input" },
  W141: { severity: "warning", summary: "Binding is stale beyond its refresh policy" },
  W150: { severity: "warning", summary: "Component override dropped: target path is gone" },
  W203: { severity: "warning", summary: "Literal color used where a theme token exists" },
  W210: { severity: "warning", summary: "Contrast below the pair's minimumRatio" },
  W220: { severity: "warning", summary: "Asset missing altText" },
  W230: { severity: "warning", summary: "Document approaching a size limit" },

  // Extensions to the doc 02 §42 catalog. Both exist because §0.8 requires
  // unknown types and enum values to survive a round-trip, which means the
  // validator needs a way to say "preserved but not understood" without failing
  // the document. Fold these back into the spec at the next revision.
  W240: { severity: "warning", summary: "Unknown element type; preserved and rendered as a placeholder" },
  W241: { severity: "warning", summary: "Unknown enum value; preserved and degraded by the renderer" },

  // Brand rules that carry a `check` (doc 02 §22.7). Declared here rather than in
  // the renderer so that the editor, the Critic and an export report all name the
  // same rule; a check whose code lives with its implementation cannot be
  // referenced by anything else. Evaluated in the renderer's semantic pass,
  // because every one of them needs resolved geometry or resolved colour.
  W211: { severity: "warning", summary: "Slide uses more font sizes than the brand allows" },
  W212: { severity: "warning", summary: "Font family is not in the brand's allowed set" },
  W213: { severity: "warning", summary: "Slide exceeds the brand's text density limit" },
  W214: { severity: "warning", summary: "Slide is missing an element the brand requires" },
  W215: { severity: "warning", summary: "Logo is smaller than the brand's minimum" },
  W250: { severity: "warning", summary: "Font unavailable; rendered with a metric-matched substitute" },

  // The editor's Design Check (design review, 2026-09-27). Rendered geometry
  // again: the applied font size after fit, and where a diagram's boxes landed.
  W216: { severity: "warning", summary: "Text is smaller than the minimum readable size" },
  W217: { severity: "warning", summary: "Diagram uses little of its frame or shrinks its labels" },
  W218: { severity: "warning", summary: "Text over a picture; its contrast cannot be measured" },
};

/**
 * Rules whose repair is mechanically derivable (doc 02 §42.6). Every one of these
 * must eventually emit a `suggestedFix`; the set is declared here so a test can
 * assert none of them silently stops doing so.
 */
export const MECHANICALLY_FIXABLE = ["W103", "W104", "W203", "W220", "E204", "W131"] as const;

/**
 * Rules that need rendered geometry or text measurement and therefore run in the
 * semantic pass, not here. Declared so the catalog stays honest about what a
 * document-only validator can and cannot see.
 */
export const REQUIRES_RENDER_CONTEXT = [
  "W102",
  "W103",
  "W104",
  "W110",
  "W111",
  "W210",
  "W211",
  "W212",
  "W213",
  "W214",
  "W215",
  "W216",
  "W217",
  "W218",
  "W250",
] as const;

class IssueCollector {
  readonly errors: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];

  add(
    code: string,
    path: string,
    message: string,
    extra?: { targetIds?: Id[]; suggestedFix?: PatchOperation[] },
  ): void {
    const rule = RULES[code];
    const severity = rule?.severity ?? "error";
    const issue: ValidationIssue = { code, severity, path, message, ...extra };
    if (severity === "error") this.errors.push(issue);
    else this.warnings.push(issue);
  }
}

function slidePath(slideId: string): string {
  return `/slides/id:${slideId}`;
}

function elementPath(slideId: string, elementId: string): string {
  return `${slidePath(slideId)}/elements/id:${elementId}`;
}

/**
 * Structural + referential + the semantic rules that need no render context.
 *
 * Everything in REQUIRES_RENDER_CONTEXT is left to the semantic pass, which runs
 * after a render and has text metrics and resolved geometry to work with.
 */
export function validateDocument(input: unknown): ValidationReport {
  const c = new IssueCollector();
  const checkedAt = new Date().toISOString();

  // ---- structural: does it parse at all?
  const parsed = PresentationDocumentSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of expandUnionIssues(input, parsed.error.issues)) {
      const path = "/" + issue.path.join("/");
      const code = structuralCode(input, issue.path);
      const message = code === "E002"
        ? `Missing required field "${String(issue.path.at(-1))}": ${issue.message}`
        : issue.message;
      c.add(code, path, message);
    }
    return { valid: false, errors: c.errors, warnings: c.warnings, checkedAt };
  }

  const doc = parsed.data;

  validateVersionAndTimestamps(doc, c);
  const { ids, elementsById, slidesById } = collectIds(doc, c);
  validateElements(doc, c, ids);
  validateReferences(doc, c, { ids, elementsById, slidesById });
  validateAnimations(doc, c, elementsById);
  validateThemeTokens(doc, c);
  validateLimits(doc, c);

  return {
    valid: c.errors.length === 0,
    errors: c.errors,
    warnings: c.warnings,
    checkedAt,
  };
}

interface FlatIssue {
  path: PropertyKey[];
  message: string;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let cursor: unknown = input;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[key];
  }
  return cursor;
}

/**
 * Replace "invalid_union" issues with the real reason underneath them.
 *
 * PresentationElement is a union, so any element-level failure surfaces as
 * `invalid_union` at the element with the message "Invalid input" — which tells a
 * user nothing and gives an agent nothing to correct. Re-parsing the value against
 * the one member its `type` field selects recovers the actual path and message
 * ("transform.x is NaN"), and the recovered paths are then absolute again.
 *
 * Unknown types retain the original issue (they can still have invalid base
 * fields). Nested groups/slots recurse so the actual child field is reported.
 */
function expandUnionIssues(
  input: unknown,
  issues: readonly { path: PropertyKey[]; message: string; code: string }[],
): FlatIssue[] {
  const out: FlatIssue[] = [];

  for (const issue of issues) {
    if (issue.code !== "invalid_union") {
      out.push({ path: issue.path, message: issue.message });
      continue;
    }

    const value = valueAt(input, issue.path);
    const type =
      value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
    const member = typeof type === "string" && Object.hasOwn(ELEMENT_SCHEMA_BY_TYPE, type)
      ? ELEMENT_SCHEMA_BY_TYPE[type]
      : undefined;

    if (!member) {
      out.push({ path: issue.path, message: issue.message });
      continue;
    }

    const inner = member.safeParse(value);
    if (inner.success) {
      out.push({ path: issue.path, message: issue.message });
      continue;
    }

    for (const innerIssue of expandUnionIssues(value, inner.error.issues)) {
      out.push({
        path: [...issue.path, ...innerIssue.path],
        message: innerIssue.message,
      });
    }
  }

  return out;
}

/**
 * Map a schema parse failure onto the catalog.
 *
 * Zod reports a NaN or an Infinity as a generic type failure, but the catalog
 * distinguishes them (E006) from an ordinary wrong type (E003) and from a missing
 * property (E002). The distinction is not cosmetic: a client routing on the code
 * shows "this number came out of a bad calculation" rather than "wrong type", and
 * non-finite geometry has a specific cause worth naming.
 *
 * The value at the failing path is inspected directly rather than pattern-matching
 * on Zod's message text, which is not a stable contract.
 */
function structuralCode(input: unknown, path: readonly PropertyKey[]): string {
  const cursor = valueAt(input, path);

  if (cursor === undefined) return "E002";
  if (typeof cursor === "number" && !Number.isFinite(cursor)) return "E006";
  return "E003";
}

function validateVersionAndTimestamps(doc: PresentationDocument, c: IssueCollector): void {
  try {
    parseSemVer(doc.schemaVersion);
  } catch {
    c.add("E010", "/schemaVersion", `schemaVersion ${doc.schemaVersion} is not parseable`);
    return;
  }

  if (!isReadableSchemaVersion(doc.schemaVersion)) {
    c.add(
      "E004",
      "/schemaVersion",
      `Document major version ${parseSemVer(doc.schemaVersion).major} is newer than this reader supports. ` +
        `Forward-compatible reading is not forward-compatible editing; refusing rather than partially understanding it.`,
    );
  }

  // ISO 8601 UTC strings compare correctly lexicographically.
  if (doc.updatedAt < doc.createdAt) {
    c.add(
      "E011",
      "/updatedAt",
      `updatedAt (${doc.updatedAt}) is earlier than createdAt (${doc.createdAt})`,
    );
  }
}

interface IdIndex {
  ids: Set<string>;
  elementsById: Map<string, { element: PresentationElement; slideId: string }>;
  slidesById: Map<string, Slide>;
}

function collectIds(doc: PresentationDocument, c: IssueCollector): IdIndex {
  const ids = new Set<string>();
  const elementsById = new Map<string, { element: PresentationElement; slideId: string }>();
  const slidesById = new Map<string, Slide>();

  const claim = (id: string, path: string): void => {
    if (ids.has(id)) {
      c.add("E001", path, `Duplicate id "${id}". Ids are unique within a document and never reused.`, {
        targetIds: [id],
      });
    }
    ids.add(id);
  };

  claim(doc.id, "/id");
  claim(doc.theme.id, "/theme/id");
  for (const asset of doc.assets) claim(asset.id, `/assets/id:${asset.id}`);
  for (const component of doc.components) claim(component.id, `/components/id:${component.id}`);
  for (const source of doc.dataSources) claim(source.id, `/dataSources/id:${source.id}`);

  for (const slide of doc.slides) {
    claim(slide.id, slidePath(slide.id));
    slidesById.set(slide.id, slide);

    for (const { element } of walkElements(slide.elements)) {
      claim(element.id, elementPath(slide.id, element.id));
      elementsById.set(element.id, { element, slideId: slide.id });
    }

    for (const track of slide.animations ?? []) {
      claim(track.id, `${slidePath(slide.id)}/animations/id:${track.id}`);
      for (const clip of track.clips) {
        claim(clip.id, `${slidePath(slide.id)}/animations/id:${track.id}/clips/id:${clip.id}`);
      }
    }
  }

  return { ids, elementsById, slidesById };
}

function validateElements(doc: PresentationDocument, c: IssueCollector, ids: Set<string>): void {
  for (const slide of doc.slides) {
    let headlines = 0;

    for (const { element, depth } of walkElements(slide.elements)) {
      const path = elementPath(slide.id, element.id);

      if (depth >= LIMITS.groupNestingDepth) {
        c.add(
          "E008",
          path,
          `Group nesting is ${depth + 1} deep; the limit is ${LIMITS.groupNestingDepth}. Nesting this deep is almost always accidental.`,
          { targetIds: [element.id] },
        );
      }

      if (!isKnownElementType(element.type)) {
        // Not an error: §0.8 requires unknown types to survive round-trip. The
        // renderer draws a labelled placeholder and agents refuse to edit it.
        c.add(
          "W240",
          path,
          `Element type "${element.type}" is not known to this reader. It will be preserved on save and rendered as a placeholder.`,
          { targetIds: [element.id] },
        );
      }

      // Open enums (doc 02 §0.8): an unrecognized value is preserved and degraded
      // by the renderer, never rejected. Warn so the author knows it will not draw
      // as authored in this client.
      const openEnumChecks: [readonly string[], unknown, string][] = [
        [SEMANTIC_ROLES, element.semanticRole, "semanticRole"],
        [SHAPE_KINDS, (element as { shape?: unknown }).shape, "shape"],
        [CHART_KINDS, (element as { chartType?: unknown }).chartType, "chartType"],
        [DIAGRAM_KINDS, (element as { diagramType?: unknown }).diagramType, "diagramType"],
      ];
      for (const [known, value, property] of openEnumChecks) {
        if (value !== undefined && isUnknownEnumValue(known, value)) {
          c.add(
            "W241",
            `${path}/${property}`,
            `${property} "${String(value)}" is not known to this reader. It is preserved on save; the renderer will fall back to a default.`,
            { targetIds: [element.id] },
          );
        }
      }

      const t = element.transform;
      for (const [key, value] of Object.entries(t)) {
        if (typeof value === "number" && !Number.isFinite(value)) {
          c.add("E006", `${path}/transform/${key}`, `transform.${key} is ${value}`, {
            targetIds: [element.id],
          });
        }
      }
      if (t.width <= 0 || t.height <= 0) {
        c.add(
          "E007",
          `${path}/transform`,
          `width and height must be >= 1; zero-size elements break hit testing and matrix inversion.`,
          { targetIds: [element.id] },
        );
      }

      if (element.semanticRole === "headline") headlines += 1;

      for (const binding of element.bindings ?? []) {
        if (!isAllowedBindingTarget(binding.targetProperty)) {
          c.add(
            "E206",
            `${path}/bindings`,
            `targetProperty "${binding.targetProperty}" is outside the allowlist. Unrestricted paths would let a binding rewrite id, type or children.`,
            { targetIds: [element.id] },
          );
        }
        if (!ids.has(binding.sourceId)) {
          c.add("E108", `${path}/bindings`, `DataBinding.sourceId "${binding.sourceId}" does not resolve.`, {
            targetIds: [element.id],
          });
        }
      }
    }

    if (headlines > 1) {
      c.add(
        "W101",
        slidePath(slide.id),
        `${headlines} elements carry semanticRole "headline". At most one per slide, or hierarchy stops meaning anything.`,
      );
    }
  }
}

function validateReferences(
  doc: PresentationDocument,
  c: IssueCollector,
  index: IdIndex,
): void {
  const assetIds = new Set(doc.assets.map((a) => a.id));
  const componentIds = new Set(doc.components.map((cd) => cd.id));

  for (const slide of doc.slides) {
    for (const { element } of walkElements(slide.elements)) {
      const path = elementPath(slide.id, element.id);

      if (element.type === "image") {
        const assetId = (element as { assetId?: string }).assetId;
        if (assetId && !assetIds.has(assetId)) {
          c.add("E102", `${path}/assetId`, `assetId "${assetId}" is not in the asset manifest.`, {
            targetIds: [element.id],
          });
        }
      }

      if (element.type === "componentInstance") {
        const componentId = (element as { componentId?: string }).componentId;
        if (componentId && !componentIds.has(componentId)) {
          c.add("E107", `${path}/componentId`, `componentId "${componentId}" does not resolve.`, {
            targetIds: [element.id],
          });
        }
      }

      if (element.type === "line") {
        for (const end of ["from", "to"] as const) {
          const endpoint = (element as Record<string, unknown>)[end];
          if (endpoint && typeof endpoint === "object" && "elementId" in endpoint) {
            const targetId = (endpoint as { elementId: string }).elementId;
            if (!index.elementsById.has(targetId)) {
              c.add(
                "W105",
                `${path}/${end}`,
                `Connector endpoint anchored to "${targetId}", which no longer exists. Convert the endpoint to a fixed point rather than deleting the connector.`,
                { targetIds: [element.id] },
              );
            }
          }
        }
      }

      if (element.type === "diagram") {
        const nodes = (element as { nodes?: { id: string }[] }).nodes ?? [];
        const edges = (element as { edges?: { id: string; from: string; to: string }[] }).edges ?? [];
        const nodeIds = new Set(nodes.map((n) => n.id));
        for (const edge of edges) {
          for (const end of ["from", "to"] as const) {
            if (!nodeIds.has(edge[end])) {
              c.add(
                "E106",
                `${path}/edges/id:${edge.id}/${end}`,
                `Edge ${end} "${edge[end]}" is not a node in this diagram.`,
                { targetIds: [element.id] },
              );
            }
          }
        }
      }

      if (element.type === "chart") {
        const data = (element as { data?: { type: string; elementId?: string } }).data;
        if (data?.type === "table" && data.elementId && !index.elementsById.has(data.elementId)) {
          c.add("E110", `${path}/data/elementId`, `Chart is driven by table "${data.elementId}", which does not exist.`, {
            targetIds: [element.id],
          });
        }
      }

      for (const constraint of element.constraints ?? []) {
        const targetId =
          "targetId" in constraint
            ? constraint.targetId
            : "containerId" in constraint
              ? constraint.containerId
              : undefined;
        const RESERVED = ["slide", "safeArea", "parent"];
        if (targetId && !RESERVED.includes(targetId) && !index.elementsById.has(targetId)) {
          c.add("E103", `${path}/constraints`, `Constraint target "${targetId}" does not resolve.`, {
            targetIds: [element.id],
          });
        }
      }
    }

    for (const interaction of slide.interactions ?? []) {
      if (interaction.action.type === "goToSlide" && !index.slidesById.has(interaction.action.slideId)) {
        c.add(
          "E105",
          `${slidePath(slide.id)}/interactions/id:${interaction.id}`,
          `goToSlide targets "${interaction.action.slideId}", which does not exist.`,
        );
      }
    }

    if (
      slide.transition &&
      isUnknownEnumValue(SLIDE_TRANSITION_TYPES.known, slide.transition.type)
    ) {
      c.add(
        "W241",
        `${slidePath(slide.id)}/transition/type`,
        `Transition type "${slide.transition.type}" is not known to this reader; it will play as a cut and be preserved on save.`,
      );
    }

    for (const mapping of slide.transition?.sharedElements ?? []) {
      for (const key of ["sourceElementId", "destinationElementId"] as const) {
        if (!index.elementsById.has(mapping[key])) {
          c.add(
            "E104",
            `${slidePath(slide.id)}/transition/sharedElements`,
            `Morph mapping ${key} "${mapping[key]}" does not resolve.`,
          );
        }
      }
    }
  }

  for (const asset of doc.assets) {
    if (asset.type === "image" && !asset.altText) {
      c.add("W220", `/assets/id:${asset.id}`, `Image asset "${asset.fileName ?? asset.id}" has no altText.`, {
        targetIds: [asset.id],
      });
    }
  }
}

function validateAnimations(
  doc: PresentationDocument,
  c: IssueCollector,
  elementsById: IdIndex["elementsById"],
): void {
  for (const slide of doc.slides) {
    const clipCount = (slide.animations ?? []).reduce((n, t) => n + t.clips.length, 0);
    const limit = checkLimit("animationClipsPerSlide", clipCount);
    if (limit.level !== "ok") {
      c.add(
        limit.level === "error" ? "E009" : "W230",
        `${slidePath(slide.id)}/animations`,
        `${clipCount} animation clips on this slide; the limit is ${limit.max}.`,
      );
    }

    for (const track of slide.animations ?? []) {
      const trackPath = `${slidePath(slide.id)}/animations/id:${track.id}`;

      if (!elementsById.has(track.targetId)) {
        c.add("E101", `${trackPath}/targetId`, `Animation targets "${track.targetId}", which does not exist.`, {
          targetIds: [track.id],
        });
      }

      for (const clip of track.clips) {
        const clipPath = `${trackPath}/clips/id:${clip.id}`;

        if (clip.durationMs <= 0) {
          c.add("E205", `${clipPath}/durationMs`, `durationMs must be > 0.`, { targetIds: [clip.id] });
        }

        for (const propertyTrack of clip.propertyTracks ?? []) {
          const offsets = propertyTrack.keyframes.map((k) => k.offset);
          const sorted = [...offsets].sort((a, b) => a - b);
          const isSorted = offsets.every((v, i) => v === sorted[i]);
          const inRange = offsets.every((v) => v >= 0 && v <= 1);

          if (!isSorted || !inRange) {
            c.add(
              "E204",
              `${clipPath}/propertyTracks`,
              `Keyframe offsets for "${propertyTrack.property}" must be sorted ascending within 0..1. Offsets are normalized to the clip duration, not milliseconds.`,
              {
                targetIds: [clip.id],
                suggestedFix: isSorted
                  ? undefined
                  : [
                      {
                        op: "replace",
                        path: `${clipPath}/propertyTracks`,
                        value: (clip.propertyTracks ?? []).map((pt) => ({
                          ...pt,
                          keyframes: [...pt.keyframes].sort((a, b) => a.offset - b.offset),
                        })),
                      },
                    ],
              },
            );
          }
        }
      }
    }

    // W131: two clips animating the same property of the same target over
    // overlapping intervals. Last-defined wins; values are never blended.
    const spans = new Map<string, { start: number; end: number; clipId: string }[]>();
    for (const track of slide.animations ?? []) {
      for (const clip of track.clips) {
        const start = clip.startMs + (clip.delayMs ?? 0);
        const end = start + clip.durationMs;
        const properties = clip.propertyTracks?.map((pt) => pt.property) ?? [clip.preset ?? "preset"];
        for (const property of properties) {
          const key = `${track.targetId}::${property}`;
          const existing = spans.get(key) ?? [];
          for (const prior of existing) {
            if (start < prior.end && prior.start < end) {
              c.add(
                "W131",
                `${slidePath(slide.id)}/animations`,
                `Clips ${prior.clipId} and ${clip.id} both animate "${property}" of ${track.targetId} over overlapping intervals. The later clip wins; values are never blended.`,
                { targetIds: [prior.clipId, clip.id] },
              );
            }
          }
          existing.push({ start, end, clipId: clip.id });
          spans.set(key, existing);
        }
      }
    }

    const budget = doc.theme.motion?.maxSlideDurationMs ?? 2500;
    let entranceEnd = 0;
    for (const track of slide.animations ?? []) {
      if (track.trigger.type !== "slideEnter" && track.trigger.type !== "afterPrevious") continue;
      for (const clip of track.clips) {
        entranceEnd = Math.max(entranceEnd, clip.startMs + (clip.delayMs ?? 0) + clip.durationMs);
      }
    }
    if (entranceEnd > budget) {
      c.add(
        "W132",
        `${slidePath(slide.id)}/animations`,
        `Slide entrance runs ${entranceEnd}ms against a budget of ${budget}ms. Past that the presenter is talking over an animation that is still running.`,
      );
    }
  }
}

function validateThemeTokens(doc: PresentationDocument, c: IssueCollector): void {
  const theme: ThemeDefinition = doc.theme;

  const check = (value: unknown, path: string): void => {
    if (!isTokenRef(value)) return;
    if (resolveToken(theme, tokenPath(value)) === undefined) {
      c.add("E202", path, `Theme token "${value}" does not resolve against theme "${theme.name}".`);
    }
  };

  const walkValue = (value: unknown, path: string, depth = 0): void => {
    if (depth > 12) return;
    if (typeof value === "string") {
      check(value, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walkValue(v, `${path}/${i}`, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walkValue(v, `${path}/${k}`, depth + 1);
    }
  };

  for (const slide of doc.slides) {
    walkValue(slide.background, `${slidePath(slide.id)}/background`);
    for (const { element } of walkElements(slide.elements)) {
      walkValue(element.style, `${elementPath(slide.id, element.id)}/style`);
      if (element.type === "text") {
        walkValue(
          (element as { typography?: unknown }).typography,
          `${elementPath(slide.id, element.id)}/typography`,
        );
      }
    }
  }
}

function validateLimits(doc: PresentationDocument, c: IssueCollector): void {
  const slideLimit = checkLimit("slidesPerDocument", doc.slides.length);
  if (slideLimit.level !== "ok") {
    c.add(
      slideLimit.level === "error" ? "E009" : "W230",
      "/slides",
      `${doc.slides.length} slides against a limit of ${slideLimit.max}.`,
    );
  }

  for (const slide of doc.slides) {
    let count = 0;
    for (const _ of walkElements(slide.elements)) count += 1;
    const elementLimit = checkLimit("elementsPerSlide", count);
    if (elementLimit.level !== "ok") {
      c.add(
        elementLimit.level === "error" ? "E009" : "W230",
        `${slidePath(slide.id)}/elements`,
        `${count} elements on this slide against a limit of ${elementLimit.max}.`,
      );
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(doc), "utf8");
  const sizeLimit = checkLimit("documentJsonBytes", bytes);
  if (sizeLimit.level !== "ok") {
    c.add(
      sizeLimit.level === "error" ? "E009" : "W230",
      "/",
      `Document JSON is ${(bytes / 1_048_576).toFixed(1)}MB against a limit of ${(sizeLimit.max / 1_048_576).toFixed(0)}MB. Assets are referenced, not embedded — check for inline data.`,
    );
  }
}

/** Convenience: parse and throw on the first error. Prefer validateDocument in
 *  product code, which reports everything at once. */
export function parseDocument(input: unknown): PresentationDocument {
  const report = validateDocument(input);
  if (!report.valid) {
    const first = report.errors[0]!;
    throw new Error(
      `Invalid .mydeck document: ${first.code} at ${first.path} — ${first.message}` +
        (report.errors.length > 1 ? ` (+${report.errors.length - 1} more)` : ""),
    );
  }
  return PresentationDocumentSchema.parse(input);
}
