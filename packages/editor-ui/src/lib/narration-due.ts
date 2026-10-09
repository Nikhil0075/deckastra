import { localeTextHash, sayAsFingerprint, type NarrationCue, type Pronunciation } from "@deckastra/presentation-schema";

/**
 * Whether a line's recording in `locale` is due for voicing (plan 01 §3.8, §7).
 *
 * Due when there is none, when it says an older script, or — for a voiced take
 * only — when the names it says are now to be said differently, or the
 * speaking rate has changed. The service
 * decides the same way (`language_routes.synthesize_narration`), so the Voice
 * button's count is the number of lines the request will actually voice.
 * Recordings and uploaded files are never due for a pronunciation change:
 * nobody's list changes what a person said into a microphone.
 */
export function takeIsDue(
  cue: Pick<NarrationCue, "text" | "takes" | "voice">,
  locale: string,
  pronunciations: readonly Pronunciation[],
  rate = 1,
): boolean {
  if (!cue.text.trim()) return false;
  const take = cue.takes?.[locale];
  if (!take || take.textHash !== localeTextHash(cue.text)) return true;
  if (take.voice === "recorded" || take.voice === "file") return false;
  if (cue.voice && take.voice !== cue.voice && take.voice !== "stub") return true;
  return (take.sayAs ?? "") !== sayAsFingerprint(cue.text, pronunciations, rate);
}
