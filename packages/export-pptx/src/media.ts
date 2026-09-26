/**
 * Pictures inside the package (doc 04 §33).
 *
 * A `.pptx` is a zip, so an image in one is a **part** — bytes under
 * `ppt/media/`, a content type for its extension, and a relationship from the
 * slide that draws it. Three things that have to agree, which is why they are
 * allocated in one place rather than by whoever happens to emit the shape.
 *
 * Until this existed the adapter routed every image to `unsupported()`: a dashed
 * box with the element's name in it, and a line in the report saying so. That was
 * honest and it was not a deck. A client opening "my slides" and finding a grey
 * rectangle where the product photograph was is the failure doc 04 §33.4 is about.
 *
 * **Deduplicated by asset id**, because a logo on twelve slides is one file in
 * the package and twelve relationships to it. Deduplicating by *bytes* would be
 * more thorough and is not worth hashing megabytes for: two assets with identical
 * content are two uploads, and the document already treats them as two things.
 */

import type { ExportImage } from "@deckastra/export-core";

/** What PowerPoint will actually draw. Anything else is reported, not embedded. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
};

export interface MediaPart {
  /** `ppt/media/image3.png` — the path inside the package. */
  path: string;
  bytes: Uint8Array;
  extension: string;
}

export interface Placed {
  /** The `r:embed` a `<a:blip>` names. */
  relationshipId: string;
}

/**
 * The media parts of one package, and the per-slide relationships into them.
 *
 * A slide's relationship ids have to be unique *within that slide's* `.rels`
 * part and mean nothing across slides, so the counter restarts per slide while
 * the media parts themselves are shared.
 */
export class MediaRegistry {
  private readonly parts = new Map<string, MediaPart>();
  /** Per slide: asset id → relationship id, and the ordered rels to write. */
  private slideRelationships: Array<{ id: string; target: string }> = [];
  private byAssetThisSlide = new Map<string, string>();
  private nextRelationship = 0;

  constructor(
    private readonly images: ReadonlyMap<string, ExportImage> | undefined,
      /**
     * rIds 1 and 2 are the layout and the notes slide, so pictures start at 3.
     *
     * Constant whether or not the slide has notes: a relationship id is an
     * opaque name, not an index, and leaving rId2 unused is legal and stops the
     * numbering from depending on something unrelated to pictures.
     */
    private readonly firstRelationship: number,
  ) {}

  /** Begin a slide. Relationship numbering is per part, so it restarts here. */
  startSlide(): void {
    this.slideRelationships = [];
    this.byAssetThisSlide = new Map();
    this.nextRelationship = this.firstRelationship;
  }

  /**
   * Claim a picture for the slide being built.
   *
   * `undefined` means it cannot be embedded, and the caller must say why rather
   * than drawing nothing: either no bytes were supplied for it, or they are in a
   * format PowerPoint will not open. The two are different messages, so the
   * reason comes back with the answer.
   */
  place(assetId: string): { placed: Placed } | { refused: string } {
    const existing = this.byAssetThisSlide.get(assetId);
    if (existing) return { placed: { relationshipId: existing } };

    const image = this.images?.get(assetId);
    if (!image) {
      return { refused: "its bytes were not available to the exporter" };
    }

    const type = image.contentType.split(";", 1)[0]!.trim().toLowerCase();
    const extension = EXTENSIONS[type];
    if (!extension) {
      return {
        refused: `PowerPoint does not open ${type || "that image format"}`,
      };
    }

    let part = this.parts.get(assetId);
    if (!part) {
      // Numbered by insertion order over the whole package, so two exports of an
      // unchanged deck name the same bytes the same thing — doc 04 §32.3's
      // byte-stability rule reaches the media parts too.
      part = {
        path: `ppt/media/image${this.parts.size + 1}.${extension}`,
        bytes: image.bytes,
        extension,
      };
      this.parts.set(assetId, part);
    }

    const relationshipId = `rId${this.nextRelationship++}`;
    this.byAssetThisSlide.set(assetId, relationshipId);
    this.slideRelationships.push({
      id: relationshipId,
      // Relative to `ppt/slides/_rels/`, which is where the part is read from.
      target: `../media/${part.path.slice("ppt/media/".length)}`,
    });
    return { placed: { relationshipId } };
  }

  /** The `<Relationship>` entries this slide needs, in allocation order. */
  relationshipsForSlide(): Array<{ id: string; target: string }> {
    return [...this.slideRelationships];
  }

  /** Every media part in the package, in allocation order. */
  allParts(): MediaPart[] {
    return [...this.parts.values()];
  }

  /** The distinct extensions used, so `[Content_Types].xml` can declare them. */
  extensions(): string[] {
    return [...new Set(this.allParts().map((part) => part.extension))].sort();
  }
}

/**
 * Where a picture actually lands inside its box, given how it is fitted.
 *
 * DrawingML has no `object-fit`. `<a:stretch>` fills the box exactly, which is
 * CSS `fill`; the other three have to be expressed as geometry:
 *
 * - **contain** shrinks the *shape* to the picture's aspect ratio and centres it,
 *   which is what letterboxing is.
 * - **cover** keeps the shape and crops the *source* with `<a:srcRect>`, whose
 *   insets are thousandths of a percent of the source.
 * - **none** draws the picture at its own pixel size, centred, clipped by the box
 *   — expressed the same way as the other two depending on which way it overflows.
 *
 * All of it needs the intrinsic size, which the document's asset manifest carries.
 * Without it there is no honest answer but `fill`, and the caller says so.
 */
export function fitPicture(
  box: { x: number; y: number; width: number; height: number },
  fit: string,
  intrinsic: { width: number; height: number } | undefined,
  /**
   * Where the visible window sits in an overflowing picture, 0..1 per axis —
   * the element's `focalPoint`, which the renderer applies as CSS
   * `object-position`. Centred when absent. A picture the author repositioned
   * in its box used to export centred again, showing a different part of the
   * photograph than the editor did (MA-22).
   */
  focal: { x: number; y: number } = { x: 0.5, y: 0.5 },
): { box: { x: number; y: number; width: number; height: number }; srcRect?: string } {
  if (!intrinsic || intrinsic.width <= 0 || intrinsic.height <= 0 || fit === "fill") {
    return { box };
  }

  const boxRatio = box.width / box.height;
  const imageRatio = intrinsic.width / intrinsic.height;

  if (fit === "cover") {
    // Crop the overflowing axis, split by the focal point exactly as CSS
    // `object-position: p%` splits it: the window starts `p` of the way along
    // the overflow. Centred (p = 0.5) is half from each side.
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    const overflowX = imageRatio > boxRatio ? 1 - boxRatio / imageRatio : 0;
    const overflowY = imageRatio > boxRatio ? 0 : 1 - imageRatio / boxRatio;
    const l = Math.round(overflowX * clamp(focal.x) * 100_000);
    const r = Math.round(overflowX * (1 - clamp(focal.x)) * 100_000);
    const t = Math.round(overflowY * clamp(focal.y) * 100_000);
    const b = Math.round(overflowY * (1 - clamp(focal.y)) * 100_000);
    if (l === 0 && t === 0 && r === 0 && b === 0) return { box };
    return {
      box,
      srcRect: `<a:srcRect l="${l}" t="${t}" r="${r}" b="${b}"/>`,
    };
  }

  // `contain`, and `none` when the picture is larger than its box — both letterbox.
  const scale =
    fit === "none"
      ? Math.min(1, box.width / intrinsic.width, box.height / intrinsic.height)
      : Math.min(box.width / intrinsic.width, box.height / intrinsic.height);
  const width = Math.round(intrinsic.width * scale);
  const height = Math.round(intrinsic.height * scale);

  return {
    box: {
      x: Math.round(box.x + (box.width - width) / 2),
      y: Math.round(box.y + (box.height - height) / 2),
      width: Math.max(1, width),
      height: Math.max(1, height),
    },
  };
}
