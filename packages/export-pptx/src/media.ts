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

/** What an audio object on a slide names: its file twice (two relationship types) and its icon. */
export interface PlacedAudio {
  /** `r:link` of `<a:audioFile>`: the classic audio relationship. */
  audioRelationshipId: string;
  /** `r:embed` of `<p14:media>`: the 2010 media relationship PowerPoint plays from. */
  mediaRelationshipId: string;
  /** The poster picture every `<p:pic>` must have. */
  iconRelationshipId: string;
}

export interface PlacedVideo {
  videoRelationshipId: string;
  mediaRelationshipId: string;
  posterRelationshipId: string;
}

/** Audio PowerPoint plays everywhere it runs. Anything else is reported, not embedded. */
const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
};

/** Content types for the media extensions a package can hold. */
export const MEDIA_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
};

/**
 * The audio object's poster: a 1×1 transparent PNG. A `<p:pic>` must have a
 * picture, and the object sits off the slide, so nothing is ever drawn of it.
 */
const ICON_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

const RELATIONSHIP = {
  image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
  audio: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio",
  video: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video",
  media: "http://schemas.microsoft.com/office/2007/relationships/media",
} as const;

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
  private slideRelationships: Array<{ id: string; target: string; type?: string }> = [];
  private audioThisSlide = new Map<string, PlacedAudio>();
  private videoThisSlide = new Map<string, PlacedVideo>();
  private byAssetThisSlide = new Map<string, string>();
  private nextRelationship = 0;

  constructor(
    private readonly images: ReadonlyMap<string, ExportImage> | undefined,
    private readonly videos: ReadonlyMap<string, ExportImage> | undefined,
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
    this.audioThisSlide = new Map();
    this.videoThisSlide = new Map();
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

  /**
   * Claim a sound for the slide being built (integration plan 01 §3.10): its
   * file as a media part, two relationships to it — PowerPoint reads the 2010
   * media one and older readers the audio one — and the poster picture.
   *
   * `key` names the sound across the package (an asset id, or `library:pop`),
   * so a pop on twelve slides is one file.
   */
  placeAudio(key: string, media: { bytes: Uint8Array; contentType: string } | undefined): { placed: PlacedAudio } | { refused: string } {
    const existing = this.audioThisSlide.get(key);
    if (existing) return { placed: existing };
    if (!media) return { refused: "its bytes were not available to the exporter" };
    const type = media.contentType.split(";", 1)[0]!.trim().toLowerCase();
    const extension = AUDIO_EXTENSIONS[type];
    if (!extension) return { refused: `PowerPoint does not reliably play ${type || "that audio format"}` };

    let part = this.parts.get(`audio:${key}`);
    if (!part) {
      const count = [...this.parts.keys()].filter((name) => name.startsWith("audio:")).length;
      part = { path: `ppt/media/media${count + 1}.${extension}`, bytes: media.bytes, extension };
      this.parts.set(`audio:${key}`, part);
    }
    let icon = this.parts.get("audio-icon");
    if (!icon) {
      icon = { path: "ppt/media/audioIcon.png", bytes: ICON_PNG, extension: "png" };
      this.parts.set("audio-icon", icon);
    }
    const target = `../media/${part.path.slice("ppt/media/".length)}`;
    const placed: PlacedAudio = {
      audioRelationshipId: this.relate(target, RELATIONSHIP.audio),
      mediaRelationshipId: this.relate(target, RELATIONSHIP.media),
      iconRelationshipId: this.relate(`../media/${icon.path.slice("ppt/media/".length)}`, RELATIONSHIP.image),
    };
    this.audioThisSlide.set(key, placed);
    return { placed };
  }

  placeVideo(assetId: string, posterAssetId?: string): { placed: PlacedVideo } | { refused: string } {
    const existing = this.videoThisSlide.get(assetId);
    if (existing) return { placed: existing };
    const video = this.videos?.get(assetId);
    if (!video) return { refused: "its MP4 bytes were not available to the exporter" };
    if (video.contentType.split(";", 1)[0]!.trim().toLowerCase() !== "video/mp4") {
      return { refused: `PowerPoint does not reliably play ${video.contentType || "that video format"}` };
    }
    if (!posterAssetId) return { refused: "it has no poster frame" };
    const poster = this.place(posterAssetId);
    if ("refused" in poster) return { refused: `its poster frame is unavailable because ${poster.refused}` };
    let part = this.parts.get(`video:${assetId}`);
    if (!part) {
      const count = [...this.parts.keys()].filter((name) => name.startsWith("video:")).length;
      part = { path: `ppt/media/video${count + 1}.mp4`, bytes: video.bytes, extension: "mp4" };
      this.parts.set(`video:${assetId}`, part);
    }
    const target = `../media/${part.path.slice("ppt/media/".length)}`;
    const placed: PlacedVideo = {
      videoRelationshipId: this.relate(target, RELATIONSHIP.video),
      mediaRelationshipId: this.relate(target, RELATIONSHIP.media),
      posterRelationshipId: poster.placed.relationshipId,
    };
    this.videoThisSlide.set(assetId, placed);
    return { placed };
  }

  private relate(target: string, type: string): string {
    const id = `rId${this.nextRelationship++}`;
    this.slideRelationships.push({ id, target, type });
    return id;
  }

  /** The `<Relationship>` entries this slide needs, in allocation order. */
  relationshipsForSlide(): Array<{ id: string; target: string; type?: string }> {
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
