import { createDomMeasurer, detectFontAvailability, type MeasureRequest } from "@deckastra/renderer";

/** Runs inside the render page, using the editor's measurement implementation. */
export async function measureBatch(requests: MeasureRequest[]) {
  // A declared face loads only once something uses it, and `fonts.ready` is
  // already resolved before the first layout; measuring then would measure the
  // fallback. So every face the page declares is loaded first.
  await Promise.all([...document.fonts].map((face) => face.load().catch(() => undefined)));
  await document.fonts.ready;
  const measurer = createDomMeasurer();
  if (!measurer) throw new Error("The render page has no DOM text measurer");
  const metrics = requests.map((request) => measurer.measure(request));
  const fonts = detectFontAvailability();
  return { metrics, fonts: { available: [...fonts.available], unknown: fonts.unknown } };
}
