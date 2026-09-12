import { act, cleanup, renderHook } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene, createDomMeasurer, flattenScene } from "@deckastra/renderer";
import { browserMeasurer, useBrowserMeasurer } from "../src/lib/measurer";

const metrics = vi.hoisted(() => ({ lines: 1 }));
vi.mock("@deckastra/renderer", async importOriginal => ({
  ...await importOriginal<typeof import("@deckastra/renderer")>(),
  createDomMeasurer: vi.fn(() => ({ measure: (request: { maxWidth: number; maxHeight: number; typography: { fontSize: number } }) => ({
    width: request.maxWidth, height: request.maxHeight, lineCount: metrics.lines,
    appliedFontSize: request.typography.fontSize, overflow: false, estimated: false,
  }) })),
}));

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
afterEach(() => {
  cleanup();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

it("rebuilds cached scenes on font readiness, load and failure, sharing one underlying measurer", async () => {
  let ready!: () => void;
  const fonts = Object.assign(new EventTarget(), { ready: new Promise<void>(resolve => { ready = resolve; }) });
  const add = vi.spyOn(fonts, "addEventListener");
  const remove = vi.spyOn(fonts, "removeEventListener");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  vi.mocked(createDomMeasurer).mockReturnValueOnce(undefined);
  expect(browserMeasurer()).toBeUndefined(); // no-body/SSR attempt can be retried
  const deck = loadFixture("technical");
  const useScene = () => {
    const measurer = useBrowserMeasurer();
    return useMemo(() => buildDocumentScene(deck, { measurer }), [measurer]);
  };
  const first = renderHook(useScene);
  const second = renderHook(useScene);
  const lineCount = () => {
    const text = flattenScene(first.result.current.slides[0]!).find(node => node.renderPayload.kind === "text")!;
    return text.renderPayload.kind === "text" ? text.renderPayload.metrics.lineCount : 0;
  };
  expect(lineCount()).toBe(1);
  const initial = first.result.current;
  first.rerender();
  expect(first.result.current).toBe(initial);
  metrics.lines = 2;
  await act(async () => ready());
  expect(lineCount()).toBe(2);
  const otherInitial = second.result.current;
  metrics.lines = 3;
  act(() => fonts.dispatchEvent(new Event("loadingdone")));
  expect(lineCount()).toBe(3);
  expect(second.result.current).not.toBe(otherInitial);
  metrics.lines = 4;
  act(() => fonts.dispatchEvent(new Event("loadingerror")));
  expect(lineCount()).toBe(4);
  expect(createDomMeasurer).toHaveBeenCalledTimes(2); // failed lookup + one shared instance
  expect(add).toHaveBeenCalledTimes(2); // one pair, not a pair per component
  first.unmount();
  expect(remove).not.toHaveBeenCalled();
  second.unmount();
  expect(remove).toHaveBeenCalledTimes(2);
});
