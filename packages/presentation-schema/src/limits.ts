/**
 * Size limits (doc 02 §0.9).
 *
 * Each limit is a warning at 80% and an error at 100%. They exist because every
 * one of them has a concrete failure mode behind it, not because round numbers
 * feel tidy.
 */
export const LIMITS = {
  /** Beyond this the slide strip and version diffs degrade. */
  slidesPerDocument: 300,
  /** Renderer budget (doc 04 §31.1). */
  elementsPerSlide: 800,
  /** Transform-math readability; deeper is almost always accidental. */
  groupNestingDepth: 8,
  /** Excludes assets, which are referenced and not embedded. */
  documentJsonBytes: 12 * 1024 * 1024,
  /** A slide is not a document. */
  textCharactersPerElement: 20_000,
  /** Timeline usability. */
  animationClipsPerSlide: 200,
  /** Each overlay roughly doubles the words in the file. */
  localesPerDocument: 40,
  /** A cue per click step; past this the slide is a lecture. */
  narrationCuesPerSlide: 60,
  soundCuesPerSlide: 60,
} as const;

export const WARN_AT = 0.8;

export type LimitName = keyof typeof LIMITS;

export interface LimitCheck {
  limit: LimitName;
  value: number;
  max: number;
  level: "ok" | "warn" | "error";
}

export function checkLimit(limit: LimitName, value: number): LimitCheck {
  const max = LIMITS[limit];
  const level = value >= max ? "error" : value >= max * WARN_AT ? "warn" : "ok";
  return { limit, value, max, level };
}
