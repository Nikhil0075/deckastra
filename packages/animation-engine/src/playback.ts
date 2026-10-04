/**
 * The playback engine (doc 04 §26).
 *
 * One engine, three surfaces. Doc 04 §26.1 says the editor preview, present mode
 * and the video export drive the same `CompiledTimeline` and differ *only* in the
 * clock — so the clock is an injected dependency and there is no second engine to
 * diverge. When the exported video does not match what the author previewed, it
 * is because those two things were built twice; here there is nothing to build
 * twice.
 *
 * Segments are the other half. A click-triggered track starts a new segment; the
 * engine runs to the boundary and *stops there*, waiting. `next()` advances to
 * the next segment, or reports that there is none so the caller can advance the
 * slide. That single rule is what makes "reveal the next bullet" and "next slide"
 * the same key.
 */

import type { CompiledTimeline } from "./compile";
import { finalSample, sampleAt, type Sample } from "./sample";

export type PlaybackStatus = "playing" | "paused" | "stopped";

export interface PlaybackState {
  slideId: string;
  timeMs: number;
  ambientTimeMs: number;
  ambientPaused: boolean;
  status: PlaybackStatus;
  segmentIndex: number;
  totalDurationMs: number;
  rate: number;
  /** True when the current segment has finished and is waiting for a click. */
  awaitingAdvance: boolean;
}

/**
 * Where time comes from.
 *
 * `now()` is a monotonic millisecond reading; `schedule` asks for a callback on
 * the next frame and returns a way to cancel it. A fixed-step export supplies a
 * clock it controls entirely (doc 04 §35), which is what makes a rendered video
 * frame-exact rather than dependent on how fast the exporting machine ran.
 */
export interface Clock {
  now(): number;
  schedule(callback: () => void): () => void;
}

export function browserClock(): Clock {
  return {
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    schedule: (callback) => {
      const handle = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(handle);
    },
  };
}

/**
 * A clock the caller steps by hand.
 *
 * Not a test double — it is the export clock from doc 04 §26.1, and using the
 * same one in tests is what keeps the tested path and the exported path the same
 * path.
 */
export function steppedClock(stepMs = 1000 / 60): Clock & { step(times?: number): void } {
  let time = 0;
  let pending: (() => void) | undefined;

  return {
    now: () => time,
    schedule: (callback) => {
      pending = callback;
      return () => {
        if (pending === callback) pending = undefined;
      };
    },
    step(times = 1) {
      for (let index = 0; index < times; index += 1) {
        time += stepMs;
        const callback = pending;
        pending = undefined;
        callback?.();
      }
    },
  };
}

export interface PlaybackListener {
  onSample?(sample: Sample, state: PlaybackState): void;
  onSegmentEnd?(state: PlaybackState): void;
  onComplete?(state: PlaybackState): void;
}

export class PlaybackEngine {
  private timeMs = 0;
  private ambientTimeMs = 0;
  private ambientPaused = false;
  private status: PlaybackStatus = "stopped";
  private rate = 1;
  private segmentIndex = 0;
  private cancel: (() => void) | undefined;
  private lastTick = 0;
  private readonly listeners = new Set<PlaybackListener>();
  private readonly segmentStartedAt = new Map<number, number>([[0, 0]]);
  private readonly emittedBoundaries = new Set<number>();
  private completed = false;

  constructor(
    private timeline: CompiledTimeline,
    private readonly clock: Clock = browserClock(),
  ) {}

  /**
   * Swap in a recompiled timeline without losing the playhead.
   *
   * The timeline is recompiled on every document change — a timeline edit is a
   * patch (doc 04 §25.2) — and an author dragging a clip watches the playhead
   * jump back to zero if this resets. Clamped, because the edit may have made the
   * slide shorter than where they were.
   */
  replace(timeline: CompiledTimeline): void {
    this.timeline = timeline;
    this.timeMs = Math.min(this.timeMs, timeline.durationMs);
    this.segmentIndex = Math.min(this.segmentIndex, Math.max(0, timeline.segments.length - 1));
    this.emit();
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state(): PlaybackState {
    const segment = this.timeline.segments[this.segmentIndex];
    return {
      slideId: this.timeline.slideId,
      timeMs: this.timeMs,
      ambientTimeMs: this.ambientTimeMs,
      ambientPaused: this.ambientPaused,
      status: this.status,
      segmentIndex: this.segmentIndex,
      totalDurationMs: this.timeline.durationMs,
      rate: this.rate,
      awaitingAdvance:
        segment !== undefined &&
        this.timeMs >= segment.endMs &&
        this.segmentIndex < this.timeline.segments.length - 1,
    };
  }

  play(): void {
    if (this.status === "playing") return;
    this.status = "playing";
    this.lastTick = this.clock.now();
    this.tick();
  }

  pause(): void {
    if (this.status !== "playing") return;
    this.status = "paused";
    this.cancel?.();
    this.cancel = undefined;
    this.emit();
  }

  /** Freeze only ambient loops; finite entrances and reveals keep playing. */
  pauseAmbient(): void {
    if (this.ambientPaused) return;
    this.ambientPaused = true;
    this.emit();
  }

  resumeAmbient(): void {
    if (!this.ambientPaused) return;
    this.ambientPaused = false;
    this.emit();
  }

  /**
   * Jump to `timeMs`.
   *
   * Stateless with respect to playback history (doc 04 §26.2): the sample at `t`
   * is computed from the keyframes, never by advancing from wherever the playhead
   * happened to be. That is what makes scrubbing backwards give the same picture
   * as scrubbing forwards.
   */
  seek(timeMs: number): void {
    this.timeMs = clamp(timeMs, 0, this.timeline.durationMs);
    this.ambientTimeMs = this.timeMs;
    this.segmentIndex = this.segmentContaining(this.timeMs);
    this.emit();
  }

  /**
   * Seek without letting the time decide which segment we are in.
   *
   * A boundary instant belongs to two segments — the end of one and the start of
   * the next — and `segmentContaining` has to pick, so it picks the later. That
   * is right for a scrub and wrong for stepping backwards: `previous()` would set
   * segment 1, seek to its end, and be put straight back into segment 2, so the
   * second press of `←` went nowhere.
   */
  private seekWithin(timeMs: number, segmentIndex: number): void {
    this.timeMs = clamp(timeMs, 0, this.timeline.durationMs);
    this.segmentIndex = segmentIndex;
    this.emit();
  }

  restart(): void {
    this.ambientTimeMs = 0;
    this.ambientPaused = false;
    this.segmentStartedAt.clear();
    this.segmentStartedAt.set(0, 0);
    this.emittedBoundaries.clear();
    this.completed = false;
    this.segmentIndex = 0;
    this.seek(0);
    this.play();
  }

  stop(): void {
    this.status = "stopped";
    this.cancel?.();
    this.cancel = undefined;
    this.timeMs = 0;
    this.ambientTimeMs = 0;
    this.ambientPaused = false;
    this.segmentIndex = 0;
    this.emit();
  }

  setPlaybackRate(rate: number): void {
    // A zero or negative rate is a pause or a reversal, both of which have their
    // own controls. Silently accepting one here produces a timeline that never
    // advances and no error to explain why.
    if (rate > 0) this.rate = rate;
  }

  /**
   * Advance to the next segment.
   *
   * Returns false when there is none — the caller's cue to advance the slide.
   * Present mode's `→` is exactly this call plus that fallback.
   */
  next(): boolean {
    if (this.segmentIndex >= this.timeline.segments.length - 1) {
      // Already in the last segment: finish it rather than doing nothing. A
      // presenter pressing → mid-entrance wants the entrance over with.
      if (this.timeMs < this.timeline.durationMs) {
        this.seek(this.timeline.durationMs);
      }
      return false;
    }

    this.segmentIndex += 1;
    const segment = this.timeline.segments[this.segmentIndex]!;
    this.timeMs = segment.startMs;
    this.segmentStartedAt.set(this.segmentIndex, this.ambientTimeMs);
    this.play();
    return true;
  }

  /**
   * Go back one segment, landing on its end state.
   *
   * Not on its start: doc 04 §26.3 says backward navigation lands on final
   * animation state, because replaying an entrance in reverse is disorienting and
   * an entrance replayed forwards is a slide that appears to be loading again.
   */
  previous(): boolean {
    if (this.segmentIndex <= 0) return false;

    this.pause();
    const target = this.segmentIndex - 1;
    const segment = this.timeline.segments[target]!;
    this.seekWithin(segment.endMs, target);
    return true;
  }

  /** Every animated target at its resting state. Used entering a slide backwards. */
  enterAtEnd(): void {
    this.status = "paused";
    this.cancel?.();
    this.cancel = undefined;
    this.segmentIndex = Math.max(0, this.timeline.segments.length - 1);
    this.timeMs = this.timeline.durationMs;
    this.ambientTimeMs = this.timeline.durationMs;
    this.broadcast(finalSample(this.timeline));
  }

  dispose(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.listeners.clear();
  }

  // ----------------------------------------------------------------- private

  private tick(): void {
    this.cancel = this.clock.schedule(() => {
      if (this.status !== "playing") return;

      const now = this.clock.now();
      const elapsed = (now - this.lastTick) * this.rate;
      this.lastTick = now;
      if (!this.ambientPaused) this.ambientTimeMs += elapsed;

      const segment = this.timeline.segments[this.segmentIndex];
      // The segment boundary is a hard stop, not a suggestion. Overshooting it by
      // part of a frame and then correcting shows a flash of the next segment's
      // first frame before it is meant to be seen.
      const limit = segment ? segment.endMs : this.timeline.durationMs;
      const next = Math.min(this.timeMs + elapsed, limit);

      this.timeMs = next;
      this.emit();

      if (next >= limit) {
        const state = this.state;
        if (!this.emittedBoundaries.has(this.segmentIndex)) {
          this.emittedBoundaries.add(this.segmentIndex);
          for (const listener of this.listeners) listener.onSegmentEnd?.(state);
        }
        if (this.segmentIndex >= this.timeline.segments.length - 1 && !this.completed) {
          this.completed = true;
          for (const listener of this.listeners) listener.onComplete?.(state);
        }
        if (!this.timeline.hasInfiniteMotion) {
          this.status = "paused";
          return;
        }
      }

      this.tick();
    });
  }

  private emit(): void {
    this.broadcast(sampleAt(this.timeline, this.timeMs, {
      ambientTimeMs: this.ambientTimeMs,
      activeSegment: this.segmentIndex,
      segmentStartedAt: this.segmentStartedAt,
    }));
  }

  private broadcast(sample: Sample): void {
    const state = this.state;
    for (const listener of this.listeners) listener.onSample?.(sample, state);
  }

  private segmentContaining(timeMs: number): number {
    let index = 0;
    for (const segment of this.timeline.segments) {
      if (timeMs >= segment.startMs) index = segment.index;
    }
    return index;
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
