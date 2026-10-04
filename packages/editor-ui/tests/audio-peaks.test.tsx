import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

// jsdom has no audio decoder: stand in for one whose output is a known ramp.
vi.mock("../src/lib/audio-player", () => ({
  audioContext: () => ({
    decodeAudioData: async () => {
      const samples = new Float32Array(3200);
      for (let i = 0; i < samples.length; i += 1) samples[i] = (i / samples.length) * (i % 2 ? 1 : -1);
      return { length: samples.length, getChannelData: () => samples };
    },
  }),
}));

import { resetRecordedPeaks, useRecordedPeaks, LANE_PEAKS } from "../src/lib/audio-peaks";
import { AudioLanes } from "../src/components/AudioLanes";

const document = loadFixture("multilingual");
const takes = document.slides[1]!.narration!.cues.map((cue) => (cue.takes as Record<string, { assetId: string }>).en!.assetId);

beforeEach(() => resetRecordedPeaks());
afterEach(() => vi.restoreAllMocks());

describe("waveforms for recordings", () => {
  it("decodes each take once, scaled so the loudest bucket is full height", async () => {
    // jsdom's Blob has no arrayBuffer(); a browser's does.
    const load = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Blob);
    const { result, rerender } = renderHook(({ ids }) => useRecordedPeaks(document, ids, load), { initialProps: { ids: takes } });
    await waitFor(() => expect(result.current.size).toBe(new Set(takes).size));
    const peaks = result.current.get(takes[0]!)!;
    expect(peaks).toHaveLength(LANE_PEAKS);
    expect(Math.max(...peaks)).toBe(1);
    expect(peaks[0]!).toBeLessThan(peaks[LANE_PEAKS - 1]!); // the ramp rises
    // A re-render with fresh arrays asks for nothing again.
    const calls = load.mock.calls.length;
    rerender({ ids: [...takes] });
    expect(load.mock.calls.length).toBe(calls);
    expect(calls).toBe(new Set(takes).size);
  });

  it("remembers a file that could not be read, and asks for it once", async () => {
    const load = vi.fn(async () => {
      throw new Error("gone");
    });
    const { result, rerender } = renderHook(({ ids }) => useRecordedPeaks(document, ids, load), { initialProps: { ids: takes.slice(0, 1) } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    rerender({ ids: takes.slice(0, 1) });
    await act(async () => Promise.resolve());
    expect(result.current.size).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("draws a take's waveform behind its narration bar", () => {
    const peaks = new Map([[takes[0]!, Array.from({ length: LANE_PEAKS }, (_, i) => i / LANE_PEAKS)]]);
    const { getAllByTestId } = render(
      <AudioLanes
        durationMs={4000}
        narration={[{ cueId: "c1", step: 0, startMs: 0, durationMs: 1200, missing: false, orphaned: false }]}
        sounds={[]}
        scripts={{ c1: "Three steps make this work." }}
        takes={{ c1: takes[0]! }}
        recordedPeaks={peaks}
        onMoveSound={() => undefined}
      />,
    );
    expect(getAllByTestId("narration-wave")[0]!.children).toHaveLength(LANE_PEAKS);
  });
});
