import { z } from "zod";
import { IdSchema, prefixedId } from "./ids";
import { FiniteNumber, MillisecondsSchema, NormalizedSchema } from "./primitives";
import { AnimationTriggerSchema } from "./animation";

/**
 * Narration, sound and how a deck plays itself (integration plan 01 §3.3–§3.5).
 *
 * Narration belongs to a **click step**, not to a time. A slide whose timeline
 * has click reveals A, B and C has four segments — arrival, A, B, C — and a cue
 * names the segment it speaks over. That is what keeps the voice and the
 * reveals together when someone retimes an animation: a cue written as "at
 * 2400ms" would talk over the wrong bullet the moment a clip got longer.
 *
 * The audio itself is a take per language. The script is ordinary text, so it
 * is translated by the same locale overlay every other word on the slide is
 * (`locales.ts`), and a take records the hash of the script it says: change the
 * words and the recording is stale, not silently wrong.
 */

/** One recording of one cue in one language. */
export const NarrationTakeSchema = z.looseObject({
  /** An `audio` entry in the asset manifest. */
  assetId: IdSchema,
  /** Read from the encoded file, never from what a speech request asked for. */
  durationMs: MillisecondsSchema,
  /** The voice that said it ("hi-IN-Chirp3-HD-…"), or "recorded". */
  voice: z.string().max(120).optional(),
  /** `localeTextHash` of the script this audio says. A mismatch is a stale take (W322). */
  textHash: z.string().min(1).max(64),
  /** Gain applied when it plays, in decibels. Bounded: this is a trim, not a mixer. */
  gainDb: FiniteNumber.min(-30).max(12).optional(),
  /**
   * For a voiced take, which pronunciations it used (`sayAsFingerprint`).
   * Absent when it used none. A different fingerprint for the line now is a
   * take due for voicing again, the way a different `textHash` is.
   */
  sayAs: z.string().max(64).optional(),
});
export type NarrationTake = z.infer<typeof NarrationTakeSchema>;

export const NarrationCueSchema = z.looseObject({
  id: prefixedId("nar"),
  /**
   * The segment this cue speaks over: 0 is the slide's arrival, 1 the segment
   * after the first click, and so on. A step the timeline no longer has is an
   * orphaned cue (W323) — reported and kept, never deleted, because the author
   * may be about to put the click back.
   */
  step: z.number().int().min(0).max(200),
  /** The script, in the deck's source language. Overlays translate it. */
  text: z.string().max(5000),
  /** Keyed by BCP-47 locale. The source language's take sits under its own tag. */
  takes: z.record(z.string(), NarrationTakeSchema).optional(),
});
export type NarrationCue = z.infer<typeof NarrationCueSchema>;

export const SlideNarrationSchema = z.looseObject({
  cues: z.array(NarrationCueSchema),
});
export type SlideNarration = z.infer<typeof SlideNarrationSchema>;

/**
 * A sound that fires with the timeline (plan 01 §3.5).
 *
 * Not an animation track: a sound has no target element, and forcing one into
 * `animations` would make every overlap rule (W131/W136) reason about a "target"
 * that does not exist. It does reuse the trigger vocabulary, so a sound can fire
 * "with the click that reveals B" without a second way of saying when.
 */
export const SoundSourceSchema = z.union([
  z.object({ assetId: IdSchema }),
  /** A sound from the built-in library, by name; resolved when it plays. */
  z.object({ library: z.string().min(1).max(60) }),
]);
export type SoundSource = z.infer<typeof SoundSourceSchema>;

export const SoundCueSchema = z.looseObject({
  id: prefixedId("snd"),
  label: z.string().max(120).optional(),
  source: SoundSourceSchema,
  trigger: AnimationTriggerSchema,
  /** An offset from the trigger's resolved time, the same rule a clip follows. */
  startMs: MillisecondsSchema,
  volume: NormalizedSchema.optional(),
});
export type SoundCue = z.infer<typeof SoundCueSchema>;

/**
 * How present mode moves through the deck.
 *
 * `manual` waits for the presenter, as every deck always has; a step's
 * narration still plays when the step is reached. `narrated` advances on its
 * own once a step's motion *and* its narration have both finished, plus a gap.
 */
export const PlaybackSettingsSchema = z.looseObject({
  mode: z.enum(["manual", "narrated"]),
  /** Pause after a step finishes before the next begins, default 600ms. */
  gapMs: MillisecondsSchema.max(10_000).optional(),
});
export type PlaybackSettings = z.infer<typeof PlaybackSettingsSchema>;

export const DEFAULT_NARRATION_GAP_MS = 600;
