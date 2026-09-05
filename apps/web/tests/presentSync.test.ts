import { describe, expect, it, vi } from "vitest";

import { PresentChannel, clampIndex, type SyncMessage } from "../lib/presentSync";

/**
 * A fake BroadcastChannel that records what was posted and lets a test deliver
 * a message. The real one does not deliver to the window that posted, which is
 * exactly the behaviour under test, so a fake is clearer than two jsdom windows.
 */
class FakeChannel {
  readonly posted: SyncMessage[] = [];
  onmessage: ((event: MessageEvent<SyncMessage>) => void) | null = null;
  closed = false;

  postMessage(message: SyncMessage): void {
    this.posted.push(message);
  }

  close(): void {
    this.closed = true;
  }

  deliver(message: SyncMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<SyncMessage>);
  }
}

function channelWith(slideCount: number, currentIndex = 0) {
  const fake = new FakeChannel();
  const onIndex = vi.fn();

  const channel = new PresentChannel(
    "test",
    { onIndex, currentIndex: () => currentIndex, slideCount: () => slideCount },
    () => fake as unknown as BroadcastChannel,
  );

  channel.open();
  return { channel, fake, onIndex };
}

describe("clampIndex", () => {
  it("keeps an in-range index", () => {
    expect(clampIndex(3, 6)).toBe(3);
  });

  it("clamps an index from a window holding more slides", () => {
    // The two windows load the deck independently, so the audience window can
    // carry unsaved edits the presenter window has never seen. An unclamped
    // index lands past the end and blanks the projector mid-talk.
    expect(clampIndex(5, 5)).toBe(4);
    expect(clampIndex(99, 5)).toBe(4);
  });

  it("clamps below zero", () => {
    expect(clampIndex(-3, 5)).toBe(0);
  });

  it("survives an empty deck and a nonsense index", () => {
    expect(clampIndex(2, 0)).toBe(0);
    expect(clampIndex(Number.NaN, 5)).toBe(0);
    // Non-finite is not "very far along", it is no information at all.
    expect(clampIndex(Number.POSITIVE_INFINITY, 5)).toBe(0);
    expect(clampIndex(2.7, 5)).toBe(2);
  });
});

describe("PresentChannel", () => {
  it("announces itself on open so a late joiner lands on the right slide", () => {
    const { fake } = channelWith(5);
    expect(fake.posted).toEqual([{ type: "hello" }]);
  });

  it("answers a hello with where it is", () => {
    const { fake } = channelWith(5, 3);
    fake.posted.length = 0;

    fake.deliver({ type: "hello" });
    expect(fake.posted).toEqual([{ type: "index", index: 3 }]);
  });

  it("applies a received index but never echoes it", () => {
    // Two windows echoing each other never settle.
    const { fake, onIndex } = channelWith(6);
    fake.posted.length = 0;

    fake.deliver({ type: "index", index: 2 });

    expect(onIndex).toHaveBeenCalledWith(2);
    expect(fake.posted).toEqual([]);
  });

  it("clamps a received index to this window's deck", () => {
    const { fake, onIndex } = channelWith(5);
    fake.deliver({ type: "index", index: 99 });
    expect(onIndex).toHaveBeenCalledWith(4);
  });

  it("ignores a bye and a malformed message rather than throwing mid-talk", () => {
    const { fake, onIndex } = channelWith(5);

    expect(() => fake.deliver({ type: "bye" })).not.toThrow();
    expect(() => fake.deliver({ type: "index" })).not.toThrow();
    expect(() => (fake.onmessage?.({ data: undefined } as never), undefined)).not.toThrow();
    expect(onIndex).not.toHaveBeenCalled();
  });

  it("posts this window's own moves", () => {
    const { channel, fake } = channelWith(5);
    fake.posted.length = 0;

    channel.post(4);
    expect(fake.posted).toEqual([{ type: "index", index: 4 }]);
  });

  it("says goodbye and closes exactly once", () => {
    const { channel, fake } = channelWith(5);
    fake.posted.length = 0;

    channel.close();
    channel.close();

    expect(fake.posted).toEqual([{ type: "bye" }]);
    expect(fake.closed).toBe(true);
  });
});
