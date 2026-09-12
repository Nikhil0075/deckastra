import { describe, expect, it, vi } from "vitest";
import type { RenderBrowser as Browser, RenderPage as Page } from "../src/render-page";
import { RenderPool, RenderTimeoutError, type PoolEntry } from "../src/render";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeEntry(): { entry: PoolEntry; closePage: ReturnType<typeof vi.fn>; closeBrowser: ReturnType<typeof vi.fn> } {
  let closed = false;
  const closePage = vi.fn(async () => { closed = true; });
  const closeBrowser = vi.fn(async () => undefined);
  const page = { close: closePage, isClosed: () => closed } as unknown as Page;
  const browser = { close: closeBrowser } as unknown as Browser;
  return { entry: { page, browser, scale: 1 }, closePage, closeBrowser };
}

describe("RenderPool leases", () => {
  it("serializes overlapping callers and preserves FIFO order", async () => {
    const fake = fakeEntry();
    const pool = new RenderPool({ open: async () => fake.entry, timeoutMs: 1_000 });
    const firstDone = deferred<void>();
    const firstStarted = deferred<void>();
    const order: string[] = [];

    const first = pool.withPage(1, async () => {
      order.push("first:start");
      firstStarted.resolve();
      await firstDone.promise;
      order.push("first:end");
    });
    const second = pool.withPage(1, async () => { order.push("second"); });
    await firstStarted.promise;
    expect(order).toEqual(["first:start"]);
    firstDone.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    await pool.close();
  });

  it("includes queue wait in the deadline and removes a timed-out waiter", async () => {
    const fake = fakeEntry();
    const pool = new RenderPool({ open: async () => fake.entry, timeoutMs: 1_000 });
    const firstDone = deferred<void>();
    const first = pool.withPage(1, () => firstDone.promise);

    await expect(pool.withPage(1, async () => undefined, 10)).rejects.toBeInstanceOf(RenderTimeoutError);
    firstDone.resolve();
    await first;
    await expect(pool.withPage(1, async () => "next")).resolves.toBe("next");
    await pool.close();
  });

  it("destroys a page that exceeds the total deadline", async () => {
    const fake = fakeEntry();
    const never = new Promise<void>(() => undefined);
    const pool = new RenderPool({ open: async () => fake.entry, timeoutMs: 10 });
    await expect(pool.withPage(1, () => never)).rejects.toBeInstanceOf(RenderTimeoutError);
    expect(fake.closePage).toHaveBeenCalledTimes(1);
    expect(fake.closeBrowser).toHaveBeenCalledTimes(1);
    await pool.close();
  });
});
