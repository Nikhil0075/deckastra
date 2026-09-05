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
  type: "index" | "hello" | "bye";
  index?: number;
}

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

    if (message.type === "hello") {
      this.channel?.postMessage({
        type: "index",
        index: this.handlers.currentIndex(),
      } satisfies SyncMessage);
    }
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
