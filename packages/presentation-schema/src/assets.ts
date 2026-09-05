import { z } from "zod";
import { prefixedId } from "./ids.js";
import { ColorValueSchema, FiniteNumber, IsoDateTimeSchema, PointSchema } from "./primitives.js";

/** Assets (doc 02 §28). */

export const AssetVariantSchema = z.object({
  storageKey: z.string().min(1),
  width: FiniteNumber.positive(),
  height: FiniteNumber.positive(),
  format: z.enum(["webp", "avif", "jpeg", "png"]),
  purpose: z.enum(["thumbnail", "display", "print"]).optional(),
});
export type AssetVariant = z.infer<typeof AssetVariantSchema>;

export const AssetLicenseSchema = z.object({
  kind: z.enum(["owned", "stock", "cc", "generated", "unknown"]),
  attribution: z.string().optional(),
  sourceUrl: z.string().optional(),
  /**
   * Load-bearing for font export (doc 04 §18.5): the PDF adapter subsets and
   * embeds when true, and outlines glyphs with a warning when false.
   */
  embedAllowed: z.boolean().optional(),
  expiresAt: IsoDateTimeSchema.optional(),
});
export type AssetLicense = z.infer<typeof AssetLicenseSchema>;

export const AssetReferenceSchema = z.looseObject({
  id: prefixedId("ast"),
  type: z.enum(["image", "video", "audio", "font", "file"]),
  /**
   * An opaque, permanent storage identifier — e.g.
   * "workspaces/ws_.../assets/ast_....png".
   *
   * v1.0 called this `uri`, which invited storing a signed URL and directly
   * contradicted doc 05 §24. Signed URLs are minted at render time and never
   * persisted: a .mydeck document must stay valid after every URL it was created
   * with has expired.
   */
  storageKey: z.string().min(1),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  byteSize: FiniteNumber.min(0).optional(),
  width: FiniteNumber.positive().optional(),
  height: FiniteNumber.positive().optional(),
  durationMs: FiniteNumber.min(0).optional(),
  /** sha256 */
  checksum: z.string().optional(),
  altText: z.string().optional(),
  dominantColor: ColorValueSchema.optional(),
  blurHash: z.string().optional(),
  /** Detected; used as the default for ImageElement.focalPoint. */
  focalPoint: PointSchema.optional(),
  /** Derivatives at 480/960/1920/3840 px feed srcset in the editor and
   *  full-resolution originals in export (doc 04 §19.3). */
  variants: z.array(AssetVariantSchema).optional(),
  license: AssetLicenseSchema.optional(),
  createdBy: z.enum(["upload", "generated", "import", "integration"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AssetReference = z.infer<typeof AssetReferenceSchema>;

/**
 * Referencing rule (doc 02 §28.4): elements reference assets by id, never by path
 * or URL. That is what lets an asset be re-uploaded, re-encoded, or migrated
 * between buckets without touching a single slide.
 */
