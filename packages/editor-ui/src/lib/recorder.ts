"use client";

import { encodeWav, waveformPeaks } from "@deckastra/renderer";

import { audioContext } from "./audio-player";

/**
 * Recording narration in the app (integration plan 01 §3.5).
 *
 * The browser records in whatever its MediaRecorder makes — WebM/Opus in
 * Chromium — and a WebM from MediaRecorder usually has no duration in its
 * header at all, which is the one number a narrated deck advances on. So the
 * recording is decoded here and written as a 16-bit mono WAV at 24kHz: a
 * container the service reads its length from exactly, about 2.9MB a minute,
 * playable everywhere, and embeddable in PowerPoint as it is.
 *
 * On the desktop the main process grants the microphone to the editor
 * window's main frame only (`main/app.ts`); a render host, a presenter window
 * or an embedded frame is refused.
 */

export const RECORDING_SAMPLE_RATE = 24_000;

export interface MeasuredAudio {
  file: File;
  durationMs: number;
  peaks: number[];
}

export interface Recording {
  /** Stop and hand back the WAV, measured. */
  stop(): Promise<MeasuredAudio>;
  /** Stop and keep nothing. */
  cancel(): void;
  /** Peak level of the last 100ms, 0..1, for a live meter. */
  level(): number;
}

export function canRecord(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
}

export async function startRecording(): Promise<Recording> {
  if (!canRecord()) throw new Error("This browser cannot record audio.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });

  // A level meter, so a person can see the microphone is hearing them.
  const context = audioContext();
  const analyser = context?.createAnalyser();
  let source: MediaStreamAudioSourceNode | undefined;
  if (context && analyser) {
    analyser.fftSize = 2048;
    source = context.createMediaStreamSource(stream);
    source.connect(analyser);
  }
  const buffer = new Float32Array(2048);

  const release = () => {
    source?.disconnect();
    for (const track of stream.getTracks()) track.stop();
  };
  recorder.start(250);

  return {
    level() {
      if (!analyser) return 0;
      analyser.getFloatTimeDomainData(buffer);
      let peak = 0;
      for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
      return Math.min(1, peak);
    },
    cancel() {
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
    stop() {
      return new Promise<MeasuredAudio>((resolve, reject) => {
        recorder.addEventListener(
          "stop",
          () => {
            release();
            const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
            measureAudio(blob, "narration.wav").then(resolve, reject);
          },
          { once: true },
        );
        recorder.stop();
      });
    },
  };
}

/**
 * Decode any audio the browser can play, and re-encode it as the WAV the
 * service measures. Also how an uploaded sound gets its waveform.
 */
export async function measureAudio(blob: Blob, name: string): Promise<MeasuredAudio> {
  const context = audioContext();
  if (!context) throw new Error("This browser cannot decode audio.");
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const length = Math.max(1, Math.ceil(decoded.duration * RECORDING_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, length, RECORDING_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  const wav = encodeWav(samples, RECORDING_SAMPLE_RATE);
  return {
    file: new File([wav as Uint8Array<ArrayBuffer>], name.replace(/\.[^.]+$/, "") + ".wav", { type: "audio/wav" }),
    durationMs: Math.round((samples.length / RECORDING_SAMPLE_RATE) * 1000),
    peaks: waveformPeaks(samples),
  };
}
