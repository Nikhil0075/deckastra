/**
 * The names of the built-in sound library (integration plan 01 §3.5).
 *
 * Only the names live here, so the validator can tell a library sound it knows
 * from one a newer build added (W324) without this package depending on audio
 * code. The sounds themselves are `@deckastra/renderer`'s `sound-library.ts`:
 * each is a short deterministic synthesis recipe rather than a vendored file,
 * which keeps the installer small and the licence question empty — nobody else
 * wrote them. A test holds the two lists to one answer.
 */
export const SOUND_LIBRARY_NAMES = [
  "whoosh-soft",
  "whoosh-fast",
  "swoosh-up",
  "swoosh-down",
  "transition-sweep",
  "pop",
  "pop-soft",
  "bloop",
  "click",
  "click-soft",
  "tick",
  "keystroke",
  "typing",
  "chime",
  "chime-high",
  "ding",
  "bell",
  "sparkle",
  "notify",
  "success",
  "level-up",
  "coin",
  "error-buzz",
  "rise",
  "fall",
  "thud",
  "knock",
  "heartbeat",
  "drum-roll",
  "applause",
  "camera-shutter",
] as const;

export type SoundLibraryName = (typeof SOUND_LIBRARY_NAMES)[number];
