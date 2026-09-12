import { createDomMeasurer, detectFontAvailability, type MeasureRequest } from "@deckastra/renderer";

/** Runs inside the render page, using the editor's measurement implementation. */
export async function measureBatch(requests: MeasureRequest[]) {
  await document.fonts.ready;
  const measurer = createDomMeasurer();
  if (!measurer) throw new Error("The render page has no DOM text measurer");
  const metrics = requests.map((request) => measurer.measure(request));
  const fonts = detectFontAvailability();
  return { metrics, fonts: { available: [...fonts.available], unknown: fonts.unknown } };
}
