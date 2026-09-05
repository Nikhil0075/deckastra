/**
 * Scales and tick selection (doc 04 §21.4).
 *
 * Every number a chart draws comes from here, and all of it is pure arithmetic
 * with a fixed iteration count. That is the whole requirement: the same data must
 * produce the same pixels in the editor, in a PNG and in a PDF, so nothing in
 * this file may consult a locale, a font, a clock or a random source.
 */

/** Geometry is rounded to 3 decimals before it reaches the payload.
 *
 *  Float noise in the fourth decimal is invisible on screen and fatal to a
 *  byte-identical render test — two runs that differ only by `1e-15` produce
 *  different markup. Rounding once, here, is cheaper than normalising every
 *  comparison downstream. */
export function round(value: number): number {
  const scaled = Math.round(value * 1000) / 1000;
  // `-0` serialises as "-0" and compares unequal in snapshots.
  return scaled === 0 ? 0 : scaled;
}

export interface LinearScale {
  min: number;
  max: number;
  step: number;
  ticks: number[];
  /** Maps a data value to a position in [rangeStart, rangeEnd]. */
  project: (value: number) => number;
}

/** The 1-2-2.5-5-10 progression. Anything else produces ticks a reader has to decode. */
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/**
 * Round a raw step up to the next "nice" value.
 *
 * Ticks at 3.7 are technically correct and useless; a reader parses 2, 5 and 10
 * without thinking, which is the entire point of an axis.
 */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const chosen = NICE_STEPS.find((step) => normalised <= step + 1e-9) ?? 10;
  return chosen * magnitude;
}

/** Snap a value onto the step grid, killing the float residue that `k * step` leaves. */
function onStep(value: number, step: number): number {
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step)) + 2));
  return Number(value.toFixed(decimals));
}

export interface LinearScaleOptions {
  rangeStart: number;
  rangeEnd: number;
  min?: number;
  max?: number;
  includeZero?: boolean;
  tickCount?: number;
}

/**
 * A linear scale with nice bounds and ticks.
 *
 * `includeZero` is not cosmetic: a bar chart whose axis starts at 18,000
 * exaggerates every difference between its bars, which is why doc 02 defaults it
 * true for bar and column. The caller decides; this honours it.
 */
export function linearScale(
  values: readonly number[],
  options: LinearScaleOptions,
): LinearScale {
  const { rangeStart, rangeEnd } = options;
  const target = Math.max(2, Math.min(12, options.tickCount ?? 5));

  const finite = values.filter((value) => Number.isFinite(value));
  let low = options.min ?? (finite.length ? Math.min(...finite) : 0);
  let high = options.max ?? (finite.length ? Math.max(...finite) : 1);

  if (options.includeZero) {
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  }

  if (low === high) {
    // A flat series still needs an axis with extent, or every mark lands on one
    // line and the chart says nothing.
    const pad = Math.abs(low) > 0 ? Math.abs(low) * 0.5 : 1;
    low -= pad;
    high += pad;
  }

  const step = niceStep((high - low) / target);
  const niceMin = options.min ?? onStep(Math.floor(low / step) * step, step);
  const niceMax = options.max ?? onStep(Math.ceil(high / step) * step, step);

  const ticks: number[] = [];
  // Bounded: a pathological step would otherwise spin here forever.
  const limit = Math.ceil((niceMax - niceMin) / step) + 1;
  for (let i = 0; i <= limit && i <= 200; i += 1) {
    const value = onStep(niceMin + i * step, step);
    if (value > niceMax + step * 1e-6) break;
    ticks.push(value);
  }

  const span = niceMax - niceMin || 1;
  const project = (value: number): number =>
    round(rangeStart + ((value - niceMin) / span) * (rangeEnd - rangeStart));

  return { min: niceMin, max: niceMax, step, ticks, project };
}

export interface BandScale {
  /** Start of band i. */
  start: (index: number) => number;
  /** Centre of band i. */
  centre: (index: number) => number;
  /** Drawn width of a band after padding. */
  bandWidth: number;
  /** Full step between band starts. */
  stepWidth: number;
  count: number;
}

/**
 * Categorical positions.
 *
 * `padding` is the fraction of each step left as gap. 0.2 is the conventional
 * default; a chart with no gap reads as a single block.
 */
export function bandScale(
  count: number,
  rangeStart: number,
  rangeEnd: number,
  padding = 0.2,
): BandScale {
  const safeCount = Math.max(1, count);
  const stepWidth = (rangeEnd - rangeStart) / safeCount;
  const bandWidth = Math.max(1, stepWidth * (1 - padding));
  const inset = (stepWidth - bandWidth) / 2;

  return {
    count: safeCount,
    stepWidth: round(stepWidth),
    bandWidth: round(bandWidth),
    start: (index: number) => round(rangeStart + index * stepWidth + inset),
    centre: (index: number) => round(rangeStart + index * stepWidth + stepWidth / 2),
  };
}

/**
 * Estimated advance width of a label, in the same terms the text estimator uses.
 *
 * Axis gutters have to be sized before anything is drawn, and the scene builder
 * has no DOM. Being systematically slightly wide is the safe direction: a gutter
 * that is too generous wastes a few pixels, one that is too tight clips the
 * numbers a chart exists to communicate.
 */
export function estimateLabelWidth(text: string, fontSize: number): number {
  return round(text.length * fontSize * 0.55);
}
