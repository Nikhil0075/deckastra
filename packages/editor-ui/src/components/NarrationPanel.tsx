"use client";

import { serviceWords } from "../lib/assistant-words";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_NARRATION_GAP_MS,
  localeTextHash,
  sourceLocale,
  type AnimationTrack,
  type AnimationTrigger,
  type NarrationCue,
  type PresentationDocument,
  type SoundCue,
} from "@deckastra/presentation-schema";
import {
  addNarrationCuesOperations,
  addSoundCueOperations,
  cuesFromNotes,
  removeNarrationCueOperations,
  removeSoundCueOperations,
  setNarrationTakeOperations,
  setNarrationTextOperations,
  setNarrationStepOperations,
  setPlaybackOperations,
  updateSoundCueOperations,
} from "@deckastra/presentation-core";
import { compileNarratedPlayback, compileTimeline, type NarrationCueInput, type SoundCueInput } from "@deckastra/animation-engine";
import { SOUND_LIBRARY, librarySoundDurationMs, type DocumentScene } from "@deckastra/renderer";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { LanguagesStatus } from "@deckastra/workspace-contracts";

import { audioContext, gainToVolume, previewLibrarySound, stepPlan, StepPlayer } from "../lib/audio-player";
import { audioAssetReference, uploadAudio } from "../lib/insert-audio";
import { languageLabel } from "../lib/languages";
import { formatPronunciations, parsePronunciations, storedPronunciations } from "../lib/pronunciations";
import { takeIsDue } from "../lib/narration-due";
import { insertPause } from "../lib/pause-insert";
import { canRecord, measureAudio, startRecording, type Recording } from "../lib/recorder";
import type { EditorApi } from "../lib/useEditor";
import { Button, IconButton, Menu, NumberField, Section, Segmented, Select, StatusChip } from "../ui";

/**
 * Narration and sound for the slide on screen (integration plan 01 §3.3–§3.6).
 *
 * Organised by **click step**, because that is what narration belongs to: the
 * arrival, then each click's reveal. A slide with three reveals has four places
 * a line can go, and this panel shows exactly those four — derived from the
 * same compiled timeline present mode plays, so the panel and the room cannot
 * disagree about what "after click 2" means.
 *
 * Scripts are ordinary text. Shown in another language, they edit that
 * language's words through the editor's locale lens, and the recordings listed
 * are that language's takes. A take whose script changed since it was recorded
 * says so, rather than playing words that are no longer on the slide.
 */
export function NarrationPanel({
  editor,
  presentationId,
  scene,
  resolveAssetUrl,
}: {
  editor: EditorApi;
  presentationId: string;
  scene: DocumentScene;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}) {
  const client = useWorkspaceClient();
  const document = editor.document;
  const slide = document.slides[editor.slideIndex];
  const slideScene = scene.slides[editor.slideIndex];
  // The language on screen is the language the takes are for.
  const locale = sourceLocale(document);
  const playback = editor.sourceDocument.playback;
  const [status, setStatus] = useState<LanguagesStatus | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [recording, setRecording] = useState<{ cueId: string; session: Recording } | null>(null);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const player = useRef<StepPlayer | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.languages?.status().then((answer) => !cancelled && setStatus(validStatus(answer))).catch(() => {});
    return () => {
      cancelled = true;
      player.current?.stop();
    };
  }, [client]);

  // A live meter while recording, so the person sees the microphone hears them.
  useEffect(() => {
    if (!recording) return;
    let frame = 0;
    const tick = () => {
      setLevel(recording.session.level());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [recording]);

  const timeline = useMemo(
    () => (slideScene ? compileTimeline(slideScene, (slideScene.animations ?? []) as AnimationTrack[]) : null),
    [slideScene],
  );
  const cues: NarrationCue[] = slide?.narration?.cues ?? [];
  const sounds: SoundCue[] = slide?.soundCues ?? [];
  const steps = Math.max(1, timeline?.segments.length ?? 1);
  const schedule = useMemo(
    () =>
      timeline
        ? compileNarratedPlayback(timeline, cues as NarrationCueInput[], sounds as SoundCueInput[], {
            locale,
            gapMs: playback?.gapMs ?? DEFAULT_NARRATION_GAP_MS,
            soundDurationMs: (source) => ("library" in source ? librarySoundDurationMs(source.library) : (document.assets.find((asset) => asset.id === source.assetId)?.durationMs ?? 0)),
          })
        : null,
    [timeline, cues, sounds, locale, playback?.gapMs, document.assets],
  );

  const flash = useCallback((tone: "ok" | "error", text: string) => setMessage({ tone, text }), []);

  if (!slide || !timeline) return null;

  const stepTitle = (step: number): string => {
    if (step === 0) return "On arrival";
    const segment = timeline.segments[step];
    return `After click ${step}${segment?.label ? ` · ${segment.label}` : ""}`;
  };
  const orphaned = cues.filter((cue) => cue.step >= steps);

  const commitText = (cue: NarrationCue, text: string) => {
    if (text === cue.text) return;
    editor.apply(setNarrationTextOperations(document, slide.id, cue.id, text), { label: "Edit narration", coalesceKey: `narration:${cue.id}` });
  };

  // Every audio file in the deck, offered as a take for any line.
  const choices = takeChoices(document, locale);

  const uploadTake = async (cue: NarrationCue, file: File) => {
    setBusy(cue.id);
    try {
      // Re-encoded to WAV like a recording, so its length is read and PowerPoint can carry it.
      const measured = await measureAudio(file, file.name);
      const uploaded = await uploadAudio(client, measured);
      const asset = audioAssetReference(uploaded, measured);
      editor.apply(
        setNarrationTakeOperations(document, slide.id, cue.id, locale, { assetId: asset.id, durationMs: asset.durationMs ?? measured.durationMs, voice: "file" }, asset),
        { label: "Use a recording file" },
      );
      flash("ok", `Using ${file.name} for ${stepTitle(cue.step).toLowerCase()}.`);
    } catch (error) {
      flash("error", error instanceof Error ? error.message : "That file could not be used.");
    } finally {
      setBusy(null);
    }
  };

  const record = async (cue: NarrationCue) => {
    if (recording) {
      const current = recording;
      setRecording(null);
      setBusy(current.cueId);
      try {
        const measured = await current.session.stop();
        const uploaded = await uploadAudio(client, measured);
        const asset = audioAssetReference(uploaded, measured);
        const target = cues.find((candidate) => candidate.id === current.cueId) ?? cue;
        editor.apply(
          setNarrationTakeOperations(document, slide.id, target.id, locale, { assetId: asset.id, durationMs: asset.durationMs ?? measured.durationMs, voice: "recorded" }, asset),
          { label: "Record narration" },
        );
        flash("ok", `Recorded ${(measured.durationMs / 1000).toFixed(1)}s for ${stepTitle(target.step).toLowerCase()}.`);
      } catch (error) {
        flash("error", error instanceof Error ? error.message : "The recording could not be saved.");
      } finally {
        setBusy(null);
      }
      return;
    }
    try {
      const session = await startRecording();
      setRecording({ cueId: cue.id, session });
      setMessage(null);
    } catch (error) {
      flash("error", error instanceof Error && error.name === "NotAllowedError" ? "The microphone is not allowed for this window." : error instanceof Error ? error.message : "Recording could not start.");
    }
  };

  const playStep = (step: number) => {
    player.current?.stop();
    if (!schedule) return;
    const plan = stepPlan(schedule, step, 0);
    if (!plan) return;
    player.current = new StepPlayer(resolveAssetUrl ?? (() => undefined), scene.audio, audioContext, false);
    player.current.start(plan);
  };

  const playTake = (cue: NarrationCue) => {
    const take = cue.takes?.[locale];
    if (!take) return;
    player.current?.stop();
    player.current = new StepPlayer(resolveAssetUrl ?? (() => undefined), scene.audio, audioContext, false);
    player.current.start({
      audio: [{ kind: "narration", cueId: cue.id, source: { assetId: take.assetId }, delayMs: 0, offsetMs: 0, volume: gainToVolume(take.gainDb), endsInMs: take.durationMs }],
      advanceInMs: 0,
      stepMs: take.durationMs,
    });
  };

  // How to say names the voice gets wrong; follows the person, like the glossary.
  const [sayAs, setSayAs] = useState("");
  useEffect(() => {
    let cancelled = false;
    client.session
      .readPreference?.("pronunciations")
      .then((value) => {
        if (!cancelled) setSayAs(formatPronunciations(storedPronunciations(value)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);
  const saveSayAs = () => {
    void client.session.writePreference?.("pronunciations", { list: parsePronunciations(sayAs) }).catch(() => {});
  };

  // How fast voiced lines are said: the person's, like their pronunciations,
  // and part of how a take was delivered, so changing it makes voiced lines due.
  const [rate, setRate] = useState(1);
  useEffect(() => {
    let cancelled = false;
    client.session
      .readPreference?.("speech")
      .then((value) => {
        const stored = Number((value as { rate?: unknown } | undefined)?.rate);
        if (!cancelled && Number.isFinite(stored) && stored >= 0.5 && stored <= 2) setRate(stored);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);
  const commitRate = (next: number) => {
    const value = Math.round(next * 20) / 20;
    setRate(value);
    void client.session.writePreference?.("speech", { rate: value }).catch(() => {});
  };

  const voiceMissing = async () => {
    if (!client.languages) return;
    setBusy("voice");
    setMessage(null);
    try {
      if (!(await editor.saveNow())) {
        flash("error", "Your latest edits are not saved yet, so nothing was voiced.");
        return;
      }
      const pronunciations = parsePronunciations(sayAs);
      const result = await client.languages.synthesize(presentationId, {
        locale,
        expected_version_id: editor.currentVersionId(),
        rate,
        ...(pronunciations.length ? { pronunciations } : {}),
      });
      if (result.outcome === "applied" && result.document && result.version_id) {
        editor.adoptDocument(result.document, result.version_id);
        flash("ok", `Voiced ${result.voiced?.length ?? 0} line(s).`);
      } else if (result.outcome === "pending") {
        flash("ok", `${result.voiced?.length ?? 0} recording(s) are waiting for you in AI › Pending changes.`);
      } else {
        flash("ok", result.message ?? "Every line already has a current recording.");
      }
    } catch (error) {
      flash("error", error instanceof Error ? error.message : "The narration could not be voiced.");
    } finally {
      setBusy(null);
    }
  };

  const pronunciationList = parsePronunciations(sayAs);
  const missingTakes = cues.filter((cue) => cue.step < steps && takeIsDue(cue, locale, pronunciationList, rate)).length;

  return (
    <>
      <Section title="Narration" defaultOpen meta={`${cues.length} line${cues.length === 1 ? "" : "s"}`} data-testid="narration-panel">
        <div className="dk-narration">
          <Segmented
            label="How the deck plays"
            size="sm"
            value={playback?.mode ?? "manual"}
            items={[
              { value: "manual", label: "By click" },
              { value: "narrated", label: "Plays itself" },
            ]}
            onChange={(mode) =>
              editor.apply(setPlaybackOperations(editor.sourceDocument, { mode, ...(playback?.gapMs !== undefined ? { gapMs: playback.gapMs } : {}) }), {
                label: mode === "narrated" ? "Play narrated" : "Play by clicks",
              })
            }
          />
          {playback?.mode === "narrated" ? (
            <NumberField
              label="Pause after each step"
              value={playback.gapMs ?? DEFAULT_NARRATION_GAP_MS}
              min={0}
              max={10000}
              step={100}
              integer
              unit="ms"
              onCommit={(gapMs) => editor.apply(setPlaybackOperations(editor.sourceDocument, { mode: "narrated", gapMs }), { label: "Narration pause" })}
            />
          ) : null}
          <p className="dk-field__hint">
            Recordings for <strong dir="auto">{languageLabel(locale)}</strong>. Each line plays when its step is reached
            {playback?.mode === "narrated" ? "; the deck moves on when the motion and the voice have both finished." : "."}
          </p>

          {Array.from({ length: steps }, (_, step) => (
            <div key={step} className="dk-narration__step" data-testid="narration-step" data-step={step}>
              <div className="dk-narration__step-head">
                <span className="dk-narration__step-title">{stepTitle(step)}</span>
                <IconButton icon="play" label={`Play ${stepTitle(step).toLowerCase()}`} size="sm" onClick={() => playStep(step)} />
              </div>
              {cues
                .filter((cue) => cue.step === step)
                .map((cue) => (
                  <CueRow
                    key={cue.id}
                    cue={cue}
                    locale={locale}
                    recording={recording?.cueId === cue.id}
                    level={recording?.cueId === cue.id ? level : 0}
                    busy={busy === cue.id}
                    canRecord={canRecord() && (!recording || recording.cueId === cue.id)}
                    onText={(text) => commitText(cue, text)}
                    onRecord={() => void record(cue)}
                    onPlay={() => playTake(cue)}
                    onRemove={() => editor.apply(removeNarrationCueOperations(document, slide.id, cue.id), { label: "Remove narration line" })}
                    alternatives={choices}
                    deliveryChanged={
                      Boolean(cue.takes?.[locale]) &&
                      cue.takes?.[locale]?.textHash === localeTextHash(cue.text) &&
                      takeIsDue(cue, locale, pronunciationList, rate)
                    }
                    onGain={(gainDb) => {
                      const take = cue.takes?.[locale];
                      if (!take) return;
                      const { gainDb: _previous, ...rest } = take;
                      editor.apply(
                        setNarrationTakeOperations(document, slide.id, cue.id, locale, gainDb ? { ...rest, gainDb } : rest),
                        { label: "Narration volume", coalesceKey: `narration-gain:${cue.id}` },
                      );
                    }}
                    onUseTake={(choice) =>
                      editor.apply(
                        setNarrationTakeOperations(document, slide.id, cue.id, locale, {
                          assetId: choice.assetId,
                          durationMs: choice.durationMs,
                          voice: choice.voice,
                        }),
                        { label: "Use another recording" },
                      )
                    }
                    onUploadTake={(file) => void uploadTake(cue, file)}
                  />
                ))}
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                onClick={() => editor.apply(addNarrationCuesOperations(document, slide.id, [{ step, text: "" }]).operations, { label: "Add narration line" })}
                data-testid={`add-narration-${step}`}
              >
                Add a line
              </Button>
            </div>
          ))}

          {orphaned.length ? (
            <div className="dk-narration__orphans" role="status" data-testid="narration-orphans">
              <p className="dk-languages__error">
                {orphaned.length} line(s) belong to a click this slide no longer has. They are kept, and play nowhere.
              </p>
              {orphaned.map((cue) => (
                <div key={cue.id} className="dk-narration__orphan">
                  <span dir="auto">“{cue.text || "(empty)"}”</span>
                  <Button size="sm" variant="ghost" onClick={() => editor.apply(setNarrationStepOperations(document, slide.id, cue.id, steps - 1), { label: "Move narration" })}>
                    Move to the last step
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="dk-narration__actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={!slide.speakerNotes}
              onClick={() => {
                const made = cuesFromNotes(slide.speakerNotes, steps - 1);
                if (!made.length) return;
                editor.apply(addNarrationCuesOperations(document, slide.id, made).operations, { label: "Split notes into narration" });
              }}
              data-testid="narration-from-notes"
            >
              Split notes into narration
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="narration"
              disabled={!missingTakes || busy !== null || status?.speech.available === false}
              onClick={() => void voiceMissing()}
              title={status ? serviceWords(status.speech.reason, "Voices are not set up on this computer yet.") : undefined}
              data-testid="narration-voice"
            >
              {busy === "voice" ? "Voicing…" : `Voice ${missingTakes} line${missingTakes === 1 ? "" : "s"}`}
            </Button>
          </div>
          {status ? (
            <p className="dk-field__hint">
              {status.speech.available
                ? serviceWords(status.speech.reason, "The script is sent online to be voiced when you press Voice.")
                : serviceWords(
                    status.speech.reason && `Voices are not available: ${status.speech.reason}`,
                    "Voices are not set up on this computer yet. You can still record narration.",
                  )}
            </p>
          ) : null}
          <NumberField
            label="Speaking rate"
            value={rate}
            min={0.5}
            max={2}
            step={0.05}
            unit="×"
            onCommit={commitRate}
            data-testid="narration-rate"
          />
          <label className="dk-field">
            <span className="dk-label">Say names as</span>
            <textarea
              className="dk-input dk-narration__script"
              rows={2}
              dir="auto"
              value={sayAs}
              placeholder={"Deckastra = Deck astra\nGCP = G C P\nNguyễn = /ŋwiən/"}
              onChange={(event) => setSayAs(event.target.value)}
              onBlur={saveSayAs}
              data-testid="narration-say-as"
            />
            <span className="dk-field__hint">
              One per line: how to spell it out, or its sounds in IPA between slashes. Used when lines are voiced, not when you
              record them yourself. Add a pause to a line with its Pause button.
            </span>
          </label>
        </div>
      </Section>

      <Section title="Sounds" defaultOpen={sounds.length > 0} meta={sounds.length ? `${sounds.length}` : undefined} data-testid="sounds-panel">
        <SoundsEditor
          editor={editor}
          slideId={slide.id}
          sounds={sounds}
          timeline={timeline}
          onMessage={flash}
        />
      </Section>

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "dk-languages__error" : "dk-muted"} data-testid="narration-message">
          {message.text}
        </p>
      ) : null}
    </>
  );
}

function CueRow({
  cue,
  locale,
  recording,
  level,
  busy,
  canRecord: recordable,
  onText,
  onRecord,
  onPlay,
  onRemove,
  alternatives = [],
  onGain,
  onUseTake,
  onUploadTake,
  deliveryChanged = false,
}: {
  cue: NarrationCue;
  locale: string;
  recording: boolean;
  level: number;
  busy: boolean;
  canRecord: boolean;
  onText: (text: string) => void;
  onRecord: () => void;
  onPlay: () => void;
  onRemove: () => void;
  /** The deck's other audio files this line could play instead. */
  alternatives?: TakeChoice[];
  onGain?: (gainDb: number) => void;
  onUseTake?: (choice: TakeChoice) => void;
  onUploadTake?: (file: File) => void;
  /** The words match, and the names or the rate it was voiced with have changed. */
  deliveryChanged?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const script = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState(cue.text);
  useEffect(() => setDraft(cue.text), [cue.text]);
  const take = cue.takes?.[locale];
  const current = take && take.textHash === localeTextHash(cue.text);
  return (
    <div className="dk-narration__cue" data-testid="narration-cue" data-cue-id={cue.id}>
      <textarea
        ref={script}
        className="dk-input dk-narration__script"
        aria-label="Narration script"
        dir="auto"
        rows={2}
        value={draft}
        placeholder="What the narrator says here"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onText(draft)}
      />
      <div className="dk-narration__cue-foot">
        {take ? (
          current && deliveryChanged ? (
            <StatusChip tone="waiting">Names or rate changed</StatusChip>
          ) : current ? (
            <StatusChip tone="action">{(take.durationMs / 1000).toFixed(1)}s {take.voice === "recorded" ? "recorded" : take.voice === "file" ? "from a file" : "voiced"}</StatusChip>
          ) : (
            <StatusChip tone="waiting">Says older words</StatusChip>
          )
        ) : (
          <StatusChip tone="neutral">No recording</StatusChip>
        )}
        {recording ? (
          <span className="dk-narration__meter" aria-hidden="true">
            <span style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
        ) : null}
        <span className="dk-narration__cue-actions">
          {/* A pause where the caret is: `[pause]` in the script, a <break> to the
              voice. Pressed with the mouse, the field keeps its focus and caret. */}
          <IconButton
            icon="pause"
            label="Add a pause where the cursor is"
            size="sm"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const field = script.current;
              const placed = insertPause(draft, field?.selectionStart ?? draft.length, field?.selectionEnd ?? undefined);
              setDraft(placed.text);
              onText(placed.text);
              requestAnimationFrame(() => field?.setSelectionRange(placed.caret, placed.caret));
            }}
            data-testid="narration-pause"
          />
          {take ? <IconButton icon="play" label="Play the recording" size="sm" onClick={onPlay} /> : null}
          <IconButton
            icon={recording ? "stop" : "mic"}
            label={recording ? "Stop and keep the recording" : "Record this line"}
            size="sm"
            disabled={busy || !recordable}
            onClick={onRecord}
            data-testid="narration-record"
          />
          <IconButton icon="trash" label="Remove this line" size="sm" onClick={onRemove} />
        </span>
      </div>
      {onUseTake || (take && onGain) ? (
        <div className="dk-narration__take">
          {take && onGain ? (
            <NumberField
              label="Volume"
              value={take.gainDb ?? 0}
              min={-30}
              max={0}
              step={1}
              integer
              unit="dB"
              onCommit={onGain}
            />
          ) : null}
          {onUseTake ? (
            <Menu
              label="Use another recording"
              align="end"
              items={[
                ...alternatives.map((choice) => ({
                  id: `take-${choice.assetId}`,
                  label: `${choice.label} · ${(choice.durationMs / 1000).toFixed(1)}s`,
                  checked: choice.assetId === take?.assetId,
                  onSelect: () => onUseTake(choice),
                })),
                { id: "take-upload", label: "Upload a file…", icon: "upload" as const, onSelect: () => fileInput.current?.click() },
              ]}
              trigger={(props) => (
                <Button size="sm" variant="ghost" disabled={busy} data-testid="narration-swap" {...props}>
                  {take ? "Other recording" : "Use a recording"}
                </Button>
              )}
            />
          ) : null}
          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            hidden
            aria-label="Recording file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file && onUploadTake) onUploadTake(file);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** An audio file in the deck a narration line could play. */
export interface TakeChoice {
  assetId: string;
  label: string;
  durationMs: number;
  voice: string;
}

/**
 * The deck's audio files, named so a person can tell them apart: the words a
 * file already voices, or its file name. A take recorded for one line is often
 * the right one for another after a script is re-split, and swapping one in is
 * cheaper than recording again (plan 01 §3.6).
 */
export function takeChoices(document: PresentationDocument, locale: string): TakeChoice[] {
  const voicing = new Map<string, { voice: string; text: string }>();
  for (const slide of document.slides) {
    for (const cue of slide.narration?.cues ?? []) {
      for (const [language, take] of Object.entries(cue.takes ?? {})) {
        if (!voicing.has(take.assetId) || language === locale) voicing.set(take.assetId, { voice: take.voice ?? "recorded", text: cue.text });
      }
    }
  }
  return document.assets
    .filter((asset) => asset.type === "audio")
    .map((asset) => {
      const use = voicing.get(asset.id);
      const words = use?.text.trim();
      return {
        assetId: asset.id,
        label: words ? `“${words.length > 32 ? `${words.slice(0, 31)}…` : words}”` : (asset.fileName ?? "Audio file"),
        durationMs: asset.durationMs ?? 0,
        voice: use?.voice ?? "file",
      };
    });
}

type TriggerChoice = string;

/** The trigger choices a sound offers, in words: arrival, every click, one click by what it reveals. */
function triggerChoices(timeline: ReturnType<typeof compileTimeline>): { value: TriggerChoice; label: string; trigger: AnimationTrigger }[] {
  const choices: { value: TriggerChoice; label: string; trigger: AnimationTrigger }[] = [
    { value: "enter", label: "On arrival", trigger: { type: "slideEnter" } },
    { value: "after", label: "After the arrival's motion", trigger: { type: "afterPrevious" } },
  ];
  if (timeline.segments.length > 1) choices.push({ value: "click", label: "With every click", trigger: { type: "click" } });
  for (const segment of timeline.segments.slice(1)) {
    const clip = timeline.clips.find((candidate) => candidate.segment === segment.index);
    if (!clip) continue;
    choices.push({
      value: `click:${clip.targetId}`,
      label: `With click ${segment.index}${segment.label ? ` · ${segment.label}` : ""}`,
      trigger: { type: "click", targetId: clip.targetId },
    });
  }
  return choices;
}

function choiceOf(trigger: AnimationTrigger): TriggerChoice {
  if (trigger.type === "slideEnter" || trigger.type === "withPrevious") return "enter";
  if (trigger.type === "afterPrevious") return "after";
  if (trigger.type === "click") return trigger.targetId ? `click:${trigger.targetId}` : "click";
  return trigger.type;
}

function SoundsEditor({
  editor,
  slideId,
  sounds,
  timeline,
  onMessage,
}: {
  editor: EditorApi;
  slideId: string;
  sounds: SoundCue[];
  timeline: ReturnType<typeof compileTimeline>;
  onMessage: (tone: "ok" | "error", text: string) => void;
}) {
  const client = useWorkspaceClient();
  const [library, setLibrary] = useState<string>(SOUND_LIBRARY[0]!.name);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const choices = triggerChoices(timeline);
  const document = editor.document;

  const add = (source: SoundCue["source"], label: string, asset?: Parameters<typeof addSoundCueOperations>[3]) => {
    const trigger: AnimationTrigger = timeline.segments.length > 1 ? { type: "click" } : { type: "slideEnter" };
    editor.apply(addSoundCueOperations(document, slideId, { source, trigger, label, volume: 0.8 }, asset).operations, { label: `Add sound: ${label}` });
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const measured = await measureAudio(file, file.name);
      const uploaded = await uploadAudio(client, measured);
      const asset = audioAssetReference(uploaded, measured);
      add({ assetId: asset.id }, file.name.replace(/\.[^.]+$/, ""), asset);
    } catch (error) {
      onMessage("error", error instanceof Error ? error.message : "That sound could not be added.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="dk-narration" data-testid="sounds-editor">
      {sounds.length === 0 ? <p className="dk-muted">No sounds on this slide. A sound can fire on arrival or with a click.</p> : null}
      {sounds.map((sound) => {
        const name = "library" in sound.source ? (SOUND_LIBRARY.find((entry) => entry.name === (sound.source as { library: string }).library)?.label ?? (sound.source as { library: string }).library) : (sound.label ?? "Your sound");
        return (
          <div key={sound.id} className="dk-narration__cue" data-testid="sound-cue">
            <div className="dk-narration__step-head">
              <span className="dk-narration__step-title">{sound.label ?? name}</span>
              <span className="dk-narration__cue-actions">
                {"library" in sound.source ? (
                  <IconButton icon="play" label={`Play ${name}`} size="sm" onClick={() => previewLibrarySound((sound.source as { library: string }).library, sound.volume ?? 1)} />
                ) : null}
                <IconButton icon="trash" label="Remove this sound" size="sm" onClick={() => editor.apply(removeSoundCueOperations(document, slideId, sound.id), { label: "Remove sound" })} />
              </span>
            </div>
            <Select
              label="Plays"
              value={choiceOf(sound.trigger)}
              options={choices.map((choice) => ({ value: choice.value, label: choice.label }))}
              onChange={(value) => {
                const choice = choices.find((candidate) => candidate.value === value);
                if (choice) editor.apply(updateSoundCueOperations(document, slideId, sound.id, { trigger: choice.trigger }), { label: "Sound timing" });
              }}
            />
            <div className="dk-narration__row">
              <NumberField
                label="Delay"
                value={sound.startMs}
                min={0}
                max={60000}
                step={50}
                integer
                unit="ms"
                onCommit={(startMs) => editor.apply(updateSoundCueOperations(document, slideId, sound.id, { startMs }), { label: "Sound delay" })}
              />
              <NumberField
                label="Volume"
                value={Math.round((sound.volume ?? 1) * 100)}
                min={0}
                max={100}
                step={5}
                integer
                unit="%"
                onCommit={(percent) => editor.apply(updateSoundCueOperations(document, slideId, sound.id, { volume: percent / 100 }), { label: "Sound volume" })}
              />
            </div>
          </div>
        );
      })}
      <div className="dk-narration__row">
        <Select
          label="Library sound"
          value={library}
          options={SOUND_LIBRARY.map((sound) => ({ value: sound.name, label: `${sound.label} · ${sound.category}` }))}
          onChange={setLibrary}
          data-testid="sound-library-select"
        />
        <IconButton icon="play" label="Hear it" size="sm" onClick={() => previewLibrarySound(library)} />
      </div>
      <div className="dk-narration__actions">
        <Button
          size="sm"
          variant="secondary"
          icon="sound"
          onClick={() => add({ library }, SOUND_LIBRARY.find((sound) => sound.name === library)?.label ?? library)}
          data-testid="add-library-sound"
        >
          Add sound
        </Button>
        <Button size="sm" variant="ghost" icon="upload" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? "Adding…" : "Your own sound…"}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
    </div>
  );
}

/** A status answer with both halves, or nothing: an older service answers something else. */
function validStatus(answer: unknown): LanguagesStatus | null {
  const value = answer as Partial<LanguagesStatus> | null | undefined;
  return value?.translation && value.speech ? (value as LanguagesStatus) : null;
}
