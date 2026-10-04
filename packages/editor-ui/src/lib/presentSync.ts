"use client";

/**
 * Presenter-window sync.
 *
 * Two windows show the same talk: one on the projector, one on the laptop. They
 * load the deck independently — the presenter window reads the saved deck from
 * the API rather than being handed one, so it survives a reload and does not
 * depend on the audience window staying open — and they agree on exactly one
 * thing, which slide is showing.
 *
 * Extracted from the component because the interesting parts are rules, not
 * rendering: clamping an index that arrives from a window holding a different
 * number of slides, replying to a late joiner, and not echoing a received index
 * back into an infinite ping-pong. All three are testable here and none of them
 * are testable inside a `useEffect`.
 */

export interface SyncMessage {
  type: "index" | "hello" | "bye" | "state" | "command";
  index?: number;
  /**
   * `state` (audience → presenter): where the talk is *within* the slide, and
   * whether the projector is blacked out. Only the audience window plays the
   * slide's motion, so only it knows which reveal is showing.
   */
  step?: number;
  blacked?: boolean;
  motionPaused?: boolean;
  /** Narration muted on the projector (integration plan 01 §3.4). */
  muted?: boolean;
  /** The line being narrated, for the presenter's script view. */
  speaking?: { text: string; remainingMs: number } | null;
  /**
   * `command` (presenter → audience): an intent the audience window carries
   * out, because it owns the motion. "Next" from the laptop has to reveal the
   * next bullet on the projector, not jump the slide past it.
   */
  action?: "advance" | "black" | "motion" | "mute";
  delta?: 1 | -1;
}

/** What the audience window reports after every change. */
export interface PresentState {
  index: number;
  step: number;
  blacked: boolean;
  motionPaused?: boolean;
  muted?: boolean;
  speaking?: { text: string; remainingMs: number } | null;
}

export type PresentCommand = { action: "advance"; delta: 1 | -1 } | { action: "black" } | { action: "motion" } | { action: "mute" };

/**
 * Clamp an index from the other window.
 *
 * The two windows can legitimately hold different lengths: the audience window
 * may carry unsaved edits the presenter window has never seen. An unclamped
 * index lands past the end and blanks the projector mid-talk, which is the worst
 * moment for it to happen.
 */
export function clampIndex(index: number, slideCount: number): number {
  if (!Number.isFinite(index) || slideCount <= 0) return 0;
  return Math.max(0, Math.min(slideCount - 1, Math.trunc(index)));
}

export interface PresentChannelHandlers {
  /** A slide index arrived from the other window, already clamped. */
  onIndex: (index: number) => void;
  /** Where this window currently is, for answering a late joiner. */
  currentIndex: () => number;
  /** How many slides this window has, for clamping. */
  slideCount: () => number;
  /**
   * The audience window's full state arrived (presenter side). The index is
   * already clamped; the step is passed through as sent.
   */
  onState?: (state: PresentState) => void;
  /** A command arrived from a presenter window (audience side). */
  onCommand?: (command: PresentCommand) => void;
  /** This window's full state, for answering a late joiner (audience side). */
  currentState?: () => PresentState;
}

/**
 * A thin wrapper over BroadcastChannel with the protocol rules baked in.
 *
 * `post` is how this window announces a move; `onIndex` is how it learns of
 * one. The asymmetry is deliberate: a received index is applied but never
 * re-broadcast, because two windows echoing each other never settle.
 */
export class PresentChannel {
  private channel?: BroadcastChannel;

  constructor(
    private readonly name: string,
    private readonly handlers: PresentChannelHandlers,
    /** Injected in tests; defaults to the platform's. */
    private readonly factory: (name: string) => BroadcastChannel = (n) => new BroadcastChannel(n),
  ) {}

  open(): void {
    if (this.channel || typeof BroadcastChannel === "undefined") return;

    this.channel = this.factory(this.name);
    this.channel.onmessage = (event: MessageEvent<SyncMessage>) => this.receive(event.data);

    // Ask whoever is already presenting where they are, so a window that opens
    // late lands on the right slide instead of slide 1.
    this.channel.postMessage({ type: "hello" } satisfies SyncMessage);
  }

  /** Exposed for tests; the platform calls it through `onmessage`. */
  receive(message: SyncMessage | undefined): void {
    if (!message) return;

    if (message.type === "index" && typeof message.index === "number") {
      this.handlers.onIndex(clampIndex(message.index, this.handlers.slideCount()));
      return;
    }

    if (message.type === "state" && typeof message.index === "number") {
      this.handlers.onState?.({
        index: clampIndex(message.index, this.handlers.slideCount()),
        step: typeof message.step === "number" && message.step >= 0 ? Math.trunc(message.step) : 0,
        blacked: message.blacked === true,
        // Older audience windows do not send this field. Keep it absent so the
        // protocol remains structurally backwards-compatible as well as safe.
        ...(typeof message.motionPaused === "boolean" ? { motionPaused: message.motionPaused } : {}),
        ...(typeof message.muted === "boolean" ? { muted: message.muted } : {}),
        ...(message.speaking && typeof message.speaking.text === "string" && typeof message.speaking.remainingMs === "number"
          ? { speaking: { text: message.speaking.text.slice(0, 2000), remainingMs: Math.max(0, message.speaking.remainingMs) } }
          : message.speaking === null
            ? { speaking: null }
            : {}),
      });
      return;
    }

    if (message.type === "command") {
      // Only the two commands there are; anything else is ignored rather than
      // guessed at, since a guess here moves a projector in front of a room.
      if (message.action === "advance" && (message.delta === 1 || message.delta === -1)) {
        this.handlers.onCommand?.({ action: "advance", delta: message.delta });
      } else if (message.action === "black") {
        this.handlers.onCommand?.({ action: "black" });
      } else if (message.action === "motion") {
        this.handlers.onCommand?.({ action: "motion" });
      } else if (message.action === "mute") {
        this.handlers.onCommand?.({ action: "mute" });
      }
      return;
    }

    if (message.type === "hello") {
      this.channel?.postMessage({
        type: "index",
        index: this.handlers.currentIndex(),
      } satisfies SyncMessage);
      const state = this.handlers.currentState?.();
      if (state) this.postState(state);
    }
  }

  /** Announce this window's full state (audience side). */
  postState(state: PresentState): void {
    this.channel?.postMessage({ type: "state", ...state } satisfies SyncMessage);
  }

  /** Ask the audience window to do something (presenter side). */
  command(command: PresentCommand): void {
    this.channel?.postMessage({ type: "command", ...command } satisfies SyncMessage);
  }

  /** Announce this window's position. */
  post(index: number): void {
    this.channel?.postMessage({ type: "index", index } satisfies SyncMessage);
  }

  close(): void {
    if (!this.channel) return;
    this.channel.postMessage({ type: "bye" } satisfies SyncMessage);
    this.channel.close();
    this.channel = undefined;
  }
}
