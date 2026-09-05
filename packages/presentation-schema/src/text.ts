import { z } from "zod";
import { IdSchema } from "./ids";
import {
  ColorValueSchema,
  FiniteNumber,
  HorizontalAlignSchema,
  openEnum,
  VerticalAlignSchema,
} from "./primitives";

/**
 * Rich text (doc 02 §12.1).
 *
 * The blocks-and-spans shape ships now even though MVP may only ever populate one
 * span per block. Shipping plain strings and adding inline styling later would
 * force a migration onto every stored deck; this costs nothing today.
 */

export const TextSpanSchema = z.looseObject({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  code: z.boolean().optional(),
  superscript: z.boolean().optional(),
  subscript: z.boolean().optional(),
  color: ColorValueSchema.optional(),
  highlight: ColorValueSchema.optional(),
  link: z.string().optional(),
  /** Rare; prefer inheriting from the element. */
  fontFamily: z.string().optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  /**
   * Relative to the element's fontSize, default 1.
   *
   * Deliberately not an absolute size: shrink-to-fit (doc 04 §17.3) multiplies one
   * number and every span keeps its relative emphasis. With absolute span sizes,
   * resizing the box destroys the typographic hierarchy inside it — and so does a
   * theme type-scale change.
   */
  fontSizeScale: FiniteNumber.positive().optional(),
  /**
   * Renders a variable's value (§40.6). "Prepared for {{client}}" must survive
   * re-theming, translation and shrink-to-fit as one text run, not three elements.
   */
  variableRef: z.string().optional(),
});
export type TextSpan = z.infer<typeof TextSpanSchema>;

export const ParagraphStyleSchema = z.looseObject({
  align: HorizontalAlignSchema.optional(),
  verticalAlign: VerticalAlignSchema.optional(),
  listStyle: z.enum(["none", "bullet", "numbered"]).optional(),
  /** Px after each block, default 0. */
  paragraphSpacing: FiniteNumber.optional(),
  paragraphSpacingBefore: FiniteNumber.optional(),
  indent: FiniteNumber.optional(),
  hangingIndent: FiniteNumber.optional(),
  /**
   * "balanced" maps to CSS `text-wrap: balance` and is the right default for
   * headlines — it prevents the single-orphan-word last line that makes generated
   * titles look unconsidered.
   */
  lineBreakStrategy: z.enum(["auto", "balanced", "strict"]).optional(),
});
export type ParagraphStyle = z.infer<typeof ParagraphStyleSchema>;

/** Open: an unknown block kind renders as a paragraph rather than vanishing. */
export const TEXT_BLOCK_TYPES = openEnum([
  "paragraph",
  "bullet",
  "numbered",
  "quote",
  "heading",
]);

export const TextBlockSchema = z.looseObject({
  id: IdSchema,
  type: TEXT_BLOCK_TYPES,
  /** 0..4, default 0. */
  indentLevel: z.number().int().min(0).max(4).optional(),
  spans: z.array(TextSpanSchema),
  /** Overrides the element's paragraph style. */
  style: ParagraphStyleSchema.optional(),
  /** Custom bullet glyph. */
  listMarker: z.string().optional(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

export const RichTextDocumentSchema = z.looseObject({
  version: z.literal(1),
  blocks: z.array(TextBlockSchema),
});
export type RichTextDocument = z.infer<typeof RichTextDocumentSchema>;

export const TypographyStyleSchema = z.looseObject({
  /** Family name, or "token:typography.heading.fontFamily". */
  fontFamily: z.string().min(1),
  /** Logical px. */
  fontSize: FiniteNumber.positive(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  fontStyle: z.enum(["normal", "italic"]).optional(),
  /** Multiplier, default 1.3. */
  lineHeight: FiniteNumber.positive().optional(),
  /** Logical px, default 0. */
  letterSpacing: FiniteNumber.optional(),
  color: ColorValueSchema.optional(),
  textTransform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(),
  textDecoration: z.enum(["none", "underline", "lineThrough"]).optional(),
  /**
   * Not a nicety: tabular numerals (tnum) are what stop a numberCount animation
   * from making a whole slide jitter as digit widths change.
   */
  fontFeatures: z.array(z.string()).optional(),
  fontVariationSettings: z.record(z.string(), z.number()).optional(),
});
export type TypographyStyle = z.infer<typeof TypographyStyleSchema>;

/**
 * Fit modes (doc 02 §12.4). The algorithm — including the 0.25px quantization that
 * keeps results stable across runs — is doc 04 §17.3.
 *
 * Layout Agent guidance: autoHeight for body text (length varies), shrinkToFit for
 * headlines in fixed hero regions, fixed only when overflow is genuinely fine.
 */
export const TextFitSchema = z.enum(["fixed", "autoHeight", "shrinkToFit", "growBox"]);
export type TextFit = z.infer<typeof TextFitSchema>;

/** Convenience for the common single-run case. Not a schema type. */
export function plainText(text: string, blockId: string): RichTextDocument {
  return { version: 1, blocks: [{ id: blockId, type: "paragraph", spans: [{ text }] }] };
}

/** Flatten to a plain string, for measurement keys, search and export fallbacks. */
export function textContent(doc: RichTextDocument | string): string {
  if (typeof doc === "string") return doc;
  return doc.blocks.map((b) => b.spans.map((s) => s.text).join("")).join("\n");
}
