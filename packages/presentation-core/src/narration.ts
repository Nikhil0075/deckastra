import {
  localeTextHash,
  narrationScriptIn,
  newId,
  sourceLocale,
  textContent,
  type AssetReference,
  type NarrationCue,
  type NarrationTake,
  type PatchOperation,
  type PlaybackSettings,
  type PresentationDocument,
  type SoundCue,
  type SoundSource,
  type Soundtrack,
  type AnimationTrigger,
} from "@deckastra/presentation-schema";

import { OperationError } from "./operations";

/**
 * Operations over narration cues, sound cues and playback (plan 01 §3.3–§3.5).
 * Patches only, like the rest of this package.
 */

function requireSlide(document: PresentationDocument, slideId: string) {
  const slide = document.slides.find((candidate) => candidate.id === slideId);
  if (!slide) throw new OperationError(`No slide with id "${slideId}".`);
  return slide;
}

function requireCue(document: PresentationDocument, slideId: string, cueId: string): NarrationCue {
  const cue = requireSlide(document, slideId).narration?.cues.find((candidate) => candidate.id === cueId);
  if (!cue) throw new OperationError(`No narration cue "${cueId}" on this slide.`);
  return cue;
}

const slidePath = (slideId: string) => `/slides/id:${slideId}`;
const cuePath = (slideId: string, cueId: string) => `${slidePath(slideId)}/narration/cues/id:${cueId}`;

export interface NewNarrationCue {
  step: number;
  text: string;
  voice?: string;
  advanceOnWord?: number;
}

/**
 * Add cues to a slide. Kept sorted by step, so the narration panel and the
 * timeline lane list them in the order they are heard; a new cue for a step
 * that already has one goes after it, which is how a step gets a second line.
 */
export function addNarrationCuesOperations(
  document: PresentationDocument,
  slideId: string,
  cues: readonly NewNarrationCue[],
): { operations: PatchOperation[]; ids: string[] } {
  const slide = requireSlide(document, slideId);
  const made: NarrationCue[] = cues.map((cue) => ({
    id: newId("nar"), step: Math.max(0, Math.trunc(cue.step)), text: cue.text,
    ...(cue.voice ? { voice: cue.voice } : {}),
    ...(cue.advanceOnWord !== undefined ? { advanceOnWord: Math.max(0, Math.trunc(cue.advanceOnWord)) } : {}),
  }));
  const ids = made.map((cue) => cue.id);
  if (!slide.narration) {
    const sorted = [...made].sort((a, b) => a.step - b.step);
    return { operations: [{ op: "add", path: `${slidePath(slideId)}/narration`, value: { cues: sorted } }], ids };
  }
  const operations: PatchOperation[] = [];
  const existing = [...slide.narration.cues];
  for (const cue of made) {
    // Insert after the last cue at or before this step.
    let at = existing.length;
    for (let i = 0; i < existing.length; i += 1) {
      if (existing[i]!.step > cue.step) {
        at = i;
        break;
      }
    }
    existing.splice(at, 0, cue);
    operations.push({ op: "add", path: `${slidePath(slideId)}/narration/cues/${at === existing.length - 1 ? "-" : at}`, value: cue });
  }
  return { operations, ids };
}

/** Change a cue's script. Its takes become stale by hash, not by deletion (W322). */
export function setNarrationTextOperations(
  document: PresentationDocument,
  slideId: string,
  cueId: string,
  text: string,
): PatchOperation[] {
  const cue = requireCue(document, slideId, cueId);
  if (cue.text === text) return [];
  return [{ op: "replace", path: `${cuePath(slideId, cueId)}/text`, value: text }];
}

export function setNarrationStepOperations(
  document: PresentationDocument,
  slideId: string,
  cueId: string,
  step: number,
): PatchOperation[] {
  const cue = requireCue(document, slideId, cueId);
  const next = Math.max(0, Math.trunc(step));
  if (cue.step === next) return [];
  return [{ op: "replace", path: `${cuePath(slideId, cueId)}/step`, value: next }];
}

/** Choose a speaker and, optionally, the spoken word that advances the step. */
export function setNarrationDeliveryOperations(
  document: PresentationDocument,
  slideId: string,
  cueId: string,
  delivery: { voice?: string | null; advanceOnWord?: number | null },
): PatchOperation[] {
  const cue = requireCue(document, slideId, cueId);
  const operations: PatchOperation[] = [];
  for (const [key, raw] of Object.entries(delivery) as ["voice" | "advanceOnWord", string | number | null | undefined][]) {
    if (raw === undefined) continue;
    const current = cue[key];
    if (raw === null || raw === "") {
      if (current !== undefined) operations.push({ op: "remove", path: `${cuePath(slideId, cueId)}/${key}` });
      continue;
    }
    const value = key === "advanceOnWord" ? Math.max(0, Math.trunc(raw as number)) : raw;
    if (current === value) continue;
    operations.push({ op: current === undefined ? "add" : "replace", path: `${cuePath(slideId, cueId)}/${key}`, value });
  }
  return operations;
}

export function removeNarrationCueOperations(
  document: PresentationDocument,
  slideId: string,
  cueId: string,
): PatchOperation[] {
  const slide = requireSlide(document, slideId);
  requireCue(document, slideId, cueId);
  if (slide.narration!.cues.length === 1) return [{ op: "remove", path: `${slidePath(slideId)}/narration` }];
  return [{ op: "remove", path: cuePath(slideId, cueId) }];
}

/**
 * Attach a recording to a cue in one language, and declare its audio file in
 * the asset manifest **in the same patch** — the reason `insertImageOperations`
 * is one patch too: a take citing an asset the manifest does not have cannot
 * play, and a manifest entry nothing cites is an asset the reference counter
 * sweeps. One patch means they arrive together and undo together.
 *
 * The take's `textHash` is computed here from the script the cue has in that
 * language now, so a caller cannot attach audio and claim it says something
 * it does not.
 */
export function setNarrationTakeOperations(
  document: PresentationDocument,
  slideId: string,
  cueId: string,
  locale: string,
  take: { assetId: string; durationMs: number; voice?: string; gainDb?: number; textHash?: string; wordTimings?: { word: string; startMs: number; endMs: number }[] },
  asset?: AssetReference,
): PatchOperation[] {
  const cue = requireCue(document, slideId, cueId);
  const operations: PatchOperation[] = [];
  if (asset) {
    if (asset.type !== "audio") throw new OperationError("A narration take must be an audio file.");
    if (asset.id !== take.assetId) throw new OperationError("The take and its asset name different files.");
    if (!document.assets.some((existing) => existing.id === asset.id)) {
      operations.push({ op: "add", path: "/assets/-", value: asset });
    }
  } else if (!document.assets.some((existing) => existing.id === take.assetId && existing.type === "audio")) {
    throw new OperationError(`"${take.assetId}" is not an audio file in this deck.`);
  }
  const script = narrationScriptIn(document, slideId, cue, locale);
  const value: NarrationTake = { ...take, textHash: take.textHash ?? localeTextHash(script) };
  const escaped = locale.replace(/~/g, "~0").replace(/\//g, "~1");
  if (!cue.takes) {
    operations.push({ op: "add", path: `${cuePath(slideId, cueId)}/takes`, value: { [locale]: value } });
  } else {
    operations.push({ op: cue.takes[locale] ? "replace" : "add", path: `${cuePath(slideId, cueId)}/takes/${escaped}`, value });
  }
  return operations;
}

export function removeNarrationTakeOperations(
  document: PresentationDocument,
  slideId: string,
  cueId: string,
  locale: string,
): PatchOperation[] {
  const cue = requireCue(document, slideId, cueId);
  if (!cue.takes?.[locale]) return [];
  if (Object.keys(cue.takes).length === 1) return [{ op: "remove", path: `${cuePath(slideId, cueId)}/takes` }];
  return [{ op: "remove", path: `${cuePath(slideId, cueId)}/takes/${locale.replace(/~/g, "~0").replace(/\//g, "~1")}` }];
}

/**
 * A starting point for a slide's narration: its speaker notes, one paragraph
 * per step. Paragraphs beyond the last step all go to the last step, joined, so
 * nothing the presenter wrote is dropped; fewer paragraphs than steps leaves the
 * later steps silent rather than inventing words.
 */
export function cuesFromNotes(
  notes: PresentationDocument["slides"][number]["speakerNotes"],
  steps: number,
): NewNarrationCue[] {
  if (notes === undefined) return [];
  const text = typeof notes === "string" ? notes : textContent(notes);
  const paragraphs = text
    .split(/\n\s*\n|\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) return [];
  const last = Math.max(0, steps);
  const cues: NewNarrationCue[] = [];
  paragraphs.forEach((paragraph, index) => {
    const step = Math.min(index, last);
    const previous = cues[cues.length - 1];
    if (previous && previous.step === step) previous.text = `${previous.text} ${paragraph}`;
    else cues.push({ step, text: paragraph });
  });
  return cues;
}

// --------------------------------------------------------------------- sound

export interface NewSoundCue {
  source: SoundSource;
  trigger: AnimationTrigger;
  startMs?: number;
  volume?: number;
  label?: string;
}

export function addSoundCueOperations(
  document: PresentationDocument,
  slideId: string,
  input: NewSoundCue,
  asset?: AssetReference,
): { operations: PatchOperation[]; id: string } {
  const slide = requireSlide(document, slideId);
  const cue: SoundCue = {
    id: newId("snd"),
    source: input.source,
    trigger: input.trigger,
    startMs: Math.max(0, Math.round(input.startMs ?? 0)),
    ...(input.volume !== undefined ? { volume: Math.max(0, Math.min(1, input.volume)) } : {}),
    ...(input.label ? { label: input.label } : {}),
  };
  const operations: PatchOperation[] = [];
  if (asset) {
    if (asset.type !== "audio") throw new OperationError("A sound must be an audio file.");
    if (!document.assets.some((existing) => existing.id === asset.id)) operations.push({ op: "add", path: "/assets/-", value: asset });
  }
  operations.push(
    slide.soundCues
      ? { op: "add", path: `${slidePath(slideId)}/soundCues/-`, value: cue }
      : { op: "add", path: `${slidePath(slideId)}/soundCues`, value: [cue] },
  );
  return { operations, id: cue.id };
}

export function updateSoundCueOperations(
  document: PresentationDocument,
  slideId: string,
  cueId: string,
  changes: Partial<Pick<SoundCue, "startMs" | "volume" | "label" | "trigger" | "source">>,
): PatchOperation[] {
  const cue = requireSlide(document, slideId).soundCues?.find((candidate) => candidate.id === cueId);
  if (!cue) throw new OperationError(`No sound "${cueId}" on this slide.`);
  const operations: PatchOperation[] = [];
  for (const [key, value] of Object.entries(changes) as [keyof SoundCue, unknown][]) {
    if (value === undefined) continue;
    const next = key === "startMs" ? Math.max(0, Math.round(value as number)) : value;
    if (JSON.stringify(cue[key]) === JSON.stringify(next)) continue;
    operations.push({ op: cue[key] === undefined ? "add" : "replace", path: `${slidePath(slideId)}/soundCues/id:${cueId}/${key}`, value: next });
  }
  return operations;
}

export function removeSoundCueOperations(
  document: PresentationDocument,
  slideId: string,
  cueId: string,
): PatchOperation[] {
  const slide = requireSlide(document, slideId);
  if (!slide.soundCues?.some((cue) => cue.id === cueId)) return [];
  if (slide.soundCues.length === 1) return [{ op: "remove", path: `${slidePath(slideId)}/soundCues` }];
  return [{ op: "remove", path: `${slidePath(slideId)}/soundCues/id:${cueId}` }];
}

// ------------------------------------------------------------------ playback

export function setPlaybackOperations(
  document: PresentationDocument,
  playback: PlaybackSettings | undefined,
): PatchOperation[] {
  if (playback === undefined) return document.playback ? [{ op: "remove", path: "/playback" }] : [];
  if (JSON.stringify(document.playback) === JSON.stringify(playback)) return [];
  return [{ op: document.playback ? "replace" : "add", path: "/playback", value: playback }];
}

/** Set or remove the deck/section music bed as one undoable value. */
export function setSoundtrackOperations(
  document: PresentationDocument,
  soundtrack: Soundtrack | undefined,
): PatchOperation[] {
  if (soundtrack === undefined) return document.soundtrack ? [{ op: "remove", path: "/soundtrack" }] : [];
  if (JSON.stringify(document.soundtrack) === JSON.stringify(soundtrack)) return [];
  return [{ op: document.soundtrack ? "replace" : "add", path: "/soundtrack", value: soundtrack }];
}

/** The language a take for "the deck as written" is filed under. */
export function sourceTakeLocale(document: PresentationDocument): string {
  return sourceLocale(document);
}
