import { openEnum } from "./primitives";

/**
 * Semantic roles (doc 02 §9).
 *
 * Roles are what let an instruction be expressed against meaning rather than
 * geometry. Without them, "increase headline dominance" requires an LLM to infer
 * which element is the title from font size and position — the exact failure mode
 * doc 01 §3.6 identifies.
 *
 * Roles are advisory for rendering and authoritative for agent targeting.
 * Changing a role never changes appearance.
 */
export const SEMANTIC_ROLES = [
  "headline",
  "subtitle",
  "body",
  "caption",
  "quote",
  "metric",
  "eyebrow",
  "footer",
  "pageNumber",
  "heroVisual",
  "supportingVisual",
  "primaryChart",
  "secondaryChart",
  "mainDiagram",
  "supportingDiagram",
  "callout",
  "evidence",
  "logo",
  "navigation",
  "decoration",
  "custom",
] as const;

/** Open: an unknown role is treated as "custom" by the renderer and preserved. */
export const SemanticRoleSchema = openEnum(SEMANTIC_ROLES);
export type SemanticRole = (typeof SEMANTIC_ROLES)[number];

/** Roles whose content is text and therefore subject to contrast checking. */
export const TEXT_ROLES: readonly SemanticRole[] = [
  "headline",
  "subtitle",
  "body",
  "caption",
  "quote",
  "metric",
  "eyebrow",
  "footer",
  "pageNumber",
  "callout",
];

/**
 * Decoration is excluded from overlap checks, tab order and screen-reader output
 * (doc 02 §9.2). A background flourish overlapping a headline is intentional; the
 * validator flagging it every time is noise that trains users to ignore warnings.
 */
export const EXCLUDED_FROM_OVERLAP: readonly SemanticRole[] = ["decoration"];
