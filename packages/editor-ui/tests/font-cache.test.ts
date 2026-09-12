import { expect, it, vi } from "vitest";
import { DomMeasurer } from "@deckastra/layout-engine";

it("invalidates cached fallback measurements on load/failure and removes listeners on disposal", () => {
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  const fonts = new EventTarget();
  const remove = vi.spyOn(fonts, "removeEventListener");
  let width = 20;
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [{ width, bottom: 20 }] });
  const measurer = new DomMeasurer(document);
  const request = { text: "Sample", typography: { fontFamily: "Test", fontSize: 20 }, maxWidth: 200 };
  try {
    expect(measurer.measure(request).width).toBe(20);
    width = 40;
    expect(measurer.measure(request).width).toBe(20); // cached until a font change
    fonts.dispatchEvent(new Event("loadingdone"));
    expect(measurer.measure(request).width).toBe(40);
    width = 60;
    fonts.dispatchEvent(new Event("loadingerror"));
    expect(measurer.measure(request).width).toBe(60);
    expect(document.querySelectorAll("[data-deckastra-measure]")).toHaveLength(1);
    const revision = measurer.fontRevision;
    measurer.dispose();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll("[data-deckastra-measure]")).toHaveLength(0);
    fonts.dispatchEvent(new Event("loadingdone"));
    expect(measurer.fontRevision).toBe(revision);
  } finally {
    measurer.dispose();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
    if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
  }
});
