import type { ChartElement, NumberFormat, Rect } from "@deckastra/presentation-schema";

import {
  legendItems,
  type ChartLegendItem,
  type ChartLine,
  type ChartPathMark,
  type ChartPayload,
  type ChartPointMark,
  type ChartTextMark,
} from "./charts";
import { formatNumber, toLabel, toNumber } from "./format";
import { estimateLabelWidth, linearScale, round } from "./scale";
import { resolveValue, type ResolvedTheme } from "./theme";
import { WORLD_LAND } from "./world-map";

/**
 * Charts whose points sit where their own numbers put them (image-led visual
 * systems, item 5, 2026-10-13): a scatter on two numeric axes, a bubble chart
 * whose areas carry a third value, and a bubble map on a world outline.
 *
 * Same contract as every other chart: concrete, rounded geometry in the
 * payload, so the canvas, the PDF and PowerPoint draw the same marks. The map
 * is projected and clipped to its frame here, so PowerPoint receives a land
 * shape that already fits rather than one it would draw past the chart.
 */

interface PointContext {
  width: number;
  height: number;
  palette: string[];
  fontSize: number;
  labelColor: string;
  theme: ResolvedTheme;
  pointSize: number;
  empty: ChartPayload;
  warnings: string[];
}

interface Datum {
  label: string;
  x: number;
  y: number;
  size?: number;
}

interface PointSeries {
  key: string;
  label: string;
  color: string;
  data: Datum[];
}

const AXIS_LABEL_GAP = 10;

/** Whether a scatter's horizontal values are numbers, so it can be drawn on a numeric axis. */
export function hasNumericX(element: ChartElement, rows: Record<string, unknown>[]): boolean {
  const field = element.encoding.x ?? element.encoding.category;
  return rows.length > 0 && rows.every((row) => toNumber(row[field]) !== undefined);
}

function firstValueField(element: ChartElement): string {
  return Array.isArray(element.encoding.value) ? element.encoding.value[0]! : element.encoding.value;
}

function groupSeries(element: ChartElement, palette: string[], data: { row: Record<string, unknown>; datum: Datum }[]): PointSeries[] {
  const order: string[] = [];
  const byKey = new Map<string, Datum[]>();
  for (const { row, datum } of data) {
    const key = element.encoding.series ? toLabel(row[element.encoding.series]) : firstValueField(element);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(datum);
  }
  return order.map((key, index) => ({ key, label: key, color: palette[index % palette.length]!, data: byKey.get(key)! }));
}

/** Radius for a size, so that area (not radius) is proportional to the value. */
function radiusFor(size: number, largest: number, maxRadius: number): number {
  return round(Math.max(3, maxRadius * Math.sqrt(size / largest)));
}

export function buildPointChart(element: ChartElement, rows: Record<string, unknown>[], ctx: PointContext): ChartPayload {
  return element.chartType === "bubbleMap" ? buildBubbleMap(element, rows, ctx) : buildScatter(element, rows, ctx);
}

// -------------------------------------------------------- scatter and bubble

function buildScatter(element: ChartElement, rows: Record<string, unknown>[], ctx: PointContext): ChartPayload {
  const { width, height, fontSize, labelColor, theme, warnings } = ctx;
  const style = element.chartStyle ?? {};
  const encoding = element.encoding;
  const bubble = element.chartType === "bubble";
  const xField = encoding.x ?? encoding.category;
  const yField = firstValueField(element);
  const numericX = hasNumericX(element, rows);
  if (!numericX) warnings.push("The horizontal values are not numbers, so the points are spaced evenly in row order.");
  if (bubble && !encoding.size) warnings.push("A bubble chart needs a size field; every bubble is drawn the same size.");

  let skipped = 0;
  let unsized = 0;
  const data: { row: Record<string, unknown>; datum: Datum }[] = [];
  rows.forEach((row, index) => {
    const x = numericX ? toNumber(row[xField]) : index;
    const y = toNumber(row[yField]);
    if (x === undefined || y === undefined) {
      skipped += 1;
      return;
    }
    let size: number | undefined;
    if (bubble && encoding.size) {
      size = toNumber(row[encoding.size]);
      if (size === undefined || size <= 0) {
        unsized += 1;
        return;
      }
    }
    data.push({ row, datum: { label: toLabel(row[encoding.category]), x, y, size } });
  });
  if (skipped) warnings.push(`${skipped} ${skipped === 1 ? "row has" : "rows have"} no number to plot and ${skipped === 1 ? "was" : "were"} left out.`);
  if (unsized) warnings.push(`${unsized} ${unsized === 1 ? "bubble has" : "bubbles have"} no positive size and ${unsized === 1 ? "was" : "were"} left out.`);
  if (data.length === 0) return { ...ctx.empty, notice: warnings[0] ?? "This chart has no data to show." };

  const series = groupSeries(element, ctx.palette, data);
  const showLegend = style.showLegend ?? series.length > 1;
  const legend = showLegend
    ? legendItems(series.map((s) => ({ key: s.key, label: s.label, color: s.color, points: [] })), style.legendPosition ?? "bottom", { width, height }, fontSize)
    : { items: [] as ChartLegendItem[], inset: { top: 0, right: 0, bottom: 0, left: 0 } };

  const numberFormat: NumberFormat | undefined = style.numberFormat;
  const xs = data.map(({ datum }) => datum.x);
  const ys = data.map(({ datum }) => datum.y);
  const draftY = linearScale(ys, { rangeStart: 0, rangeEnd: 1, min: style.axisY?.min, max: style.axisY?.max, includeZero: style.axisY?.includeZero ?? false, tickCount: style.axisY?.tickCount });
  const yFormat = style.axisY?.format ?? numberFormat;
  const xFormat = style.axisX?.format ?? numberFormat;
  const hideY = style.axisY?.hidden === true;
  const hideX = style.axisX?.hidden === true;
  const gutterLeft = hideY ? 0 : Math.max(0, ...draftY.ticks.map((tick) => estimateLabelWidth(formatNumber(tick, yFormat), fontSize))) + AXIS_LABEL_GAP;
  const gutterBottom = hideX ? 0 : fontSize * 1.6;
  const titleLeft = style.axisY?.title ? fontSize * 1.6 : 0;
  const titleBottom = style.axisX?.title ? fontSize * 1.6 : 0;

  const plot: Rect = {
    x: round(legend.inset.left + gutterLeft + titleLeft),
    y: round(legend.inset.top + fontSize * 0.6),
    width: round(width - legend.inset.left - legend.inset.right - gutterLeft - titleLeft - fontSize * 0.6),
    height: round(height - legend.inset.top - legend.inset.bottom - gutterBottom - titleBottom - fontSize * 0.6),
  };
  if (plot.width <= 0 || plot.height <= 0) return { ...ctx.empty, notice: "This chart is too small to draw." };

  const largest = Math.max(1e-9, ...data.map(({ datum }) => datum.size ?? 0));
  const maxRadius = bubble ? Math.max(6, Math.min(80, Math.min(plot.width, plot.height) * 0.09)) : ctx.pointSize * 1.4;
  // Inset the ranges by the largest mark, so nothing is drawn across an axis.
  const pad = round(maxRadius);
  const xScale = linearScale(xs, { rangeStart: plot.x + pad, rangeEnd: plot.x + plot.width - pad, min: style.axisX?.min, max: style.axisX?.max, includeZero: style.axisX?.includeZero ?? false, tickCount: style.axisX?.tickCount });
  const yScale = linearScale(ys, { rangeStart: plot.y + plot.height - pad, rangeEnd: plot.y + pad, min: style.axisY?.min, max: style.axisY?.max, includeZero: style.axisY?.includeZero ?? false, tickCount: style.axisY?.tickCount });

  const gridlines: ChartLine[] = [];
  const axisLines: ChartLine[] = [];
  const texts: ChartTextMark[] = [];
  const showGridlines = style.showGridlines ?? (theme.source.chart?.showGridlines ?? true);
  const right = round(plot.x + plot.width);
  const bottom = round(plot.y + plot.height);

  if (!hideY) {
    yScale.ticks.forEach((tick, index) => {
      const y = yScale.project(tick);
      if (showGridlines) gridlines.push({ x1: plot.x, y1: y, x2: right, y2: y });
      texts.push({ id: `${element.id}:ytick:${index}`, text: formatNumber(tick, yFormat), x: round(plot.x - AXIS_LABEL_GAP), y: round(y + fontSize * 0.35), anchor: "end", fontSize, fill: labelColor });
    });
  }
  if (!hideX && numericX) {
    xScale.ticks.forEach((tick, index) => {
      const x = xScale.project(tick);
      if (showGridlines) gridlines.push({ x1: x, y1: plot.y, x2: x, y2: bottom });
      texts.push({ id: `${element.id}:xtick:${index}`, text: formatNumber(tick, xFormat), x, y: round(bottom + AXIS_LABEL_GAP + fontSize * 0.8), anchor: "middle", fontSize, fill: labelColor });
    });
  }
  axisLines.push({ x1: plot.x, y1: bottom, x2: right, y2: bottom }, { x1: plot.x, y1: plot.y, x2: plot.x, y2: bottom });
  if (style.axisY?.title) {
    texts.push({ id: `${element.id}:ytitle`, text: style.axisY.title, x: round(legend.inset.left + fontSize), y: round(plot.y + plot.height / 2), anchor: "middle", rotate: -90, fontSize, fill: labelColor });
  }
  if (style.axisX?.title) {
    texts.push({ id: `${element.id}:xtitle`, text: style.axisX.title, x: round(plot.x + plot.width / 2), y: round(height - legend.inset.bottom), anchor: "middle", fontSize, fill: labelColor });
  }

  const points = placePoints(element, series, ctx, (datum) => ({
    cx: xScale.project(datum.x),
    cy: yScale.project(datum.y),
    r: bubble && datum.size !== undefined ? radiusFor(datum.size, largest, maxRadius) : round(maxRadius),
  }), bubble);
  if (style.showDataLabels) texts.push(...pointLabels(element, points, ctx, numberFormat, bubble));

  return { ...ctx.empty, plot, gridlines, axisLines, points: points.map((one) => one.mark), texts, legend: legend.items, warnings };
}

// ---------------------------------------------------------------- bubble map

/**
 * Equal Earth (Šavrič, Patterson and Jenny, 2018): an equal-area projection,
 * so a bubble's size is not exaggerated by how far from the equator it sits,
 * and one that reads as the familiar world shape. Returns unit coordinates with
 * y pointing up.
 */
function equalEarth(lonDeg: number, latDeg: number): [number, number] {
  const A1 = 1.340264;
  const A2 = -0.081106;
  const A3 = 0.000893;
  const A4 = 0.003796;
  const M = Math.sqrt(3) / 2;
  const lambda = (lonDeg * Math.PI) / 180;
  const phi = (latDeg * Math.PI) / 180;
  const theta = Math.asin(M * Math.sin(phi));
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  const x = (lambda * Math.cos(theta)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
  const y = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  return [x, y];
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The world frame: the whole width, from the far north to the Southern Ocean.
 * Antarctica is left below the frame, as world maps on slides usually leave it:
 * drawn in full it takes a fifth of the height for no bubble.
 */
const WORLD: Box = (() => {
  const [right] = equalEarth(180, 0);
  const [, top] = equalEarth(0, 84);
  const [, bottom] = equalEarth(0, -58);
  return { left: -right, right, top, bottom };
})();

/** The narrowest frame a data view zooms to: about a continent's width. */
const MIN_SPAN = equalEarth(45, 0)[0] - equalEarth(0, 0)[0];

/** Clip a closed polygon to a rectangle (Sutherland and Hodgman). */
function clipPolygon(points: [number, number][], rect: Rect): [number, number][] {
  const edges: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= rect.x, (a, b) => at(a, b, (rect.x - a[0]) / (b[0] - a[0]))],
    [(p) => p[0] <= rect.x + rect.width, (a, b) => at(a, b, (rect.x + rect.width - a[0]) / (b[0] - a[0]))],
    [(p) => p[1] >= rect.y, (a, b) => at(a, b, (rect.y - a[1]) / (b[1] - a[1]))],
    [(p) => p[1] <= rect.y + rect.height, (a, b) => at(a, b, (rect.y + rect.height - a[1]) / (b[1] - a[1]))],
  ];
  let output = points;
  for (const [inside, cross] of edges) {
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i += 1) {
      const current = input[i]!;
      const previous = input[(i + input.length - 1) % input.length]!;
      if (inside(current)) {
        if (!inside(previous)) output.push(cross(previous, current));
        output.push(current);
      } else if (inside(previous)) {
        output.push(cross(previous, current));
      }
    }
    if (output.length === 0) break;
  }
  return output;
}

/** Longitudes either side of the map, for clipping a ring in degrees. */
const MAP_DEGREES: Rect = { x: -180, y: -90, width: 360, height: 180 };

/**
 * A ring as degree pairs, once for an ordinary ring. A ring stored running past
 * ±180 (it crosses the 180° meridian) is drawn twice, once as stored and once
 * shifted by 360°, each clipped to ±180, so both halves land on their own side
 * of the map instead of a line across it.
 */
function acrossTheMeridian(ring: readonly number[]): [number, number][][] {
  const points: [number, number][] = [];
  let outside = false;
  for (let i = 0; i < ring.length; i += 2) {
    const lon = ring[i]! / 10;
    if (lon < -180 || lon > 180) outside = true;
    points.push([lon, ring[i + 1]! / 10]);
  }
  if (!outside) return [points];
  const shift = points.some(([lon]) => lon > 180) ? -360 : 360;
  return [points, points.map(([lon, lat]) => [lon + shift, lat] as [number, number])]
    .map((copy) => clipPolygon(copy, MAP_DEGREES))
    .filter((copy) => copy.length >= 3);
}

function at(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function buildBubbleMap(element: ChartElement, rows: Record<string, unknown>[], ctx: PointContext): ChartPayload {
  const { width, height, fontSize, theme, warnings } = ctx;
  const style = element.chartStyle ?? {};
  const encoding = element.encoding;
  if (!encoding.latitude || !encoding.longitude) {
    return { ...ctx.empty, notice: "A bubble map needs latitude and longitude fields." };
  }
  const sizeField = encoding.size ?? firstValueField(element);

  let unplaced = 0;
  let unsized = 0;
  const data: { row: Record<string, unknown>; datum: Datum }[] = [];
  for (const row of rows) {
    const lat = toNumber(row[encoding.latitude]);
    const lon = toNumber(row[encoding.longitude]);
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      unplaced += 1;
      continue;
    }
    const size = toNumber(row[sizeField]);
    if (size === undefined || size <= 0) {
      unsized += 1;
      continue;
    }
    const [x, y] = equalEarth(lon, lat);
    data.push({ row, datum: { label: toLabel(row[encoding.category]), x, y, size } });
  }
  if (unplaced) warnings.push(`${unplaced} ${unplaced === 1 ? "row has" : "rows have"} no usable latitude and longitude and ${unplaced === 1 ? "was" : "were"} left out.`);
  if (unsized) warnings.push(`${unsized} ${unsized === 1 ? "row has" : "rows have"} no positive value to size a bubble and ${unsized === 1 ? "was" : "were"} left out.`);
  if (data.length === 0) return { ...ctx.empty, notice: warnings[0] ?? "This map has no places to show." };

  const series = groupSeries(element, ctx.palette, data);
  const showLegend = style.showLegend ?? series.length > 1;
  const legend = showLegend
    ? legendItems(series.map((s) => ({ key: s.key, label: s.label, color: s.color, points: [] })), style.legendPosition ?? "bottom", { width, height }, fontSize)
    : { items: [] as ChartLegendItem[], inset: { top: 0, right: 0, bottom: 0, left: 0 } };

  const plot: Rect = {
    x: round(legend.inset.left),
    y: round(legend.inset.top),
    width: round(width - legend.inset.left - legend.inset.right),
    height: round(height - legend.inset.top - legend.inset.bottom),
  };
  if (plot.width <= 0 || plot.height <= 0) return { ...ctx.empty, notice: "This map is too small to draw." };

  const maxRadius = Math.max(6, Math.min(70, Math.min(plot.width, plot.height) * 0.08));

  // The frame in projected units: the data's own extent, grown to a minimum
  // width and to the plot's shape, or the whole world.
  let frame: Box = WORLD;
  if ((style.mapExtent ?? "data") === "data") {
    const xs = data.map(({ datum }) => datum.x);
    const ys = data.map(({ datum }) => datum.y);
    let box: Box = { left: Math.min(...xs), right: Math.max(...xs), top: Math.max(...ys), bottom: Math.min(...ys) };
    const spanX = Math.max(MIN_SPAN, (box.right - box.left) * 1.3);
    const spanY = Math.max(MIN_SPAN * (plot.height / plot.width), (box.top - box.bottom) * 1.3);
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    box = { left: cx - spanX / 2, right: cx + spanX / 2, top: cy + spanY / 2, bottom: cy - spanY / 2 };
    frame = box;
  }
  // Fit the frame inside the plot without distorting it: one scale, centred.
  const frameWidth = frame.right - frame.left;
  const frameHeight = frame.top - frame.bottom;
  // Leave room for the largest bubble inside the frame.
  const inner = { width: plot.width - maxRadius * 2, height: plot.height - maxRadius * 2 };
  const scale = Math.min(inner.width / frameWidth, inner.height / frameHeight);
  const originX = plot.x + plot.width / 2 - ((frame.left + frame.right) / 2) * scale;
  const originY = plot.y + plot.height / 2 + ((frame.top + frame.bottom) / 2) * scale;
  const project = (x: number, y: number): [number, number] => [originX + x * scale, originY - y * scale];

  // The land, in one path, clipped to the plot. Each ring is projected, then
  // clipped; a ring entirely outside the frame draws nothing.
  // The land is a surface, not a line: the theme's alternate surface colour.
  const land = String(resolveValue(theme, "token:colors.surfaceAlt", "#8888882e"));
  const parts: string[] = [];
  for (const ring of WORLD_LAND) {
    for (const degrees of acrossTheMeridian(ring)) {
      const projected = degrees.map(([lon, lat]) => project(...equalEarth(lon, lat)));
      const clipped = clipPolygon(projected, plot);
      if (clipped.length < 3) continue;
      parts.push(`M ${clipped.map(([x, y]) => `${round(x)} ${round(y)}`).join(" L ")} Z`);
    }
  }
  const paths: ChartPathMark[] = parts.length ? [{ id: `${element.id}:land`, d: parts.join(" "), fill: land }] : [];

  const largest = Math.max(...data.map(({ datum }) => datum.size ?? 0));
  const numberFormat: NumberFormat | undefined = style.numberFormat;
  const points = placePoints(element, series, ctx, (datum) => {
    const [cx, cy] = project(datum.x, datum.y);
    return { cx: round(cx), cy: round(cy), r: radiusFor(datum.size ?? largest, largest, maxRadius) };
  }, true);
  const texts = style.showDataLabels ? pointLabels(element, points, ctx, numberFormat, true) : [];

  return { ...ctx.empty, plot, paths, points: points.map((one) => one.mark), texts, legend: legend.items, warnings };
}

// -------------------------------------------------------------------- shared

interface Placed {
  mark: ChartPointMark;
  datum: Datum;
}

/**
 * Every point as a mark. Bubbles are drawn largest first, so a small bubble
 * over a large one stays visible; ties keep row order, so the result does not
 * depend on how a sort breaks them.
 */
function placePoints(
  element: ChartElement,
  series: PointSeries[],
  ctx: PointContext,
  place: (datum: Datum) => { cx: number; cy: number; r: number },
  bubbles: boolean,
): Placed[] {
  const background = String(resolveValue(ctx.theme, "token:colors.background", "#ffffff"));
  const placed: (Placed & { order: number })[] = [];
  let order = 0;
  for (const s of series) {
    s.data.forEach((datum, index) => {
      const at = place(datum);
      placed.push({
        order: order++,
        datum,
        mark: {
          id: `${element.id}:pt:${s.key}:${index}`,
          cx: round(at.cx),
          cy: round(at.cy),
          r: at.r,
          fill: s.color,
          ...(bubbles ? { fillOpacity: 0.72, stroke: background, strokeWidth: 1.5 } : {}),
        },
      });
    });
  }
  if (bubbles) placed.sort((a, b) => b.mark.r - a.mark.r || a.order - b.order);
  return placed;
}

/**
 * A label for each point: its name, and for a bubble its value. Above the
 * point, or inside a bubble large enough to hold it.
 */
function pointLabels(
  element: ChartElement,
  placed: Placed[],
  ctx: PointContext,
  numberFormat: NumberFormat | undefined,
  bubbles: boolean,
): ChartTextMark[] {
  const size = Math.max(10, ctx.fontSize * 0.8);
  // Largest first, so where two labels would collide the bigger bubble keeps
  // its own; a label that would overlap one already placed is left off, and
  // the count is said, rather than drawing two names over each other.
  const order = [...placed].sort((a, b) => b.mark.r - a.mark.r);
  const taken: Rect[] = [];
  const out: ChartTextMark[] = [];
  let hidden = 0;
  for (const { mark, datum } of order) {
    if (datum.label.length === 0) continue;
    const text = bubbles && datum.size !== undefined ? `${datum.label} ${formatNumber(datum.size, numberFormat)}` : datum.label;
    const width = estimateLabelWidth(text, size);
    const fits = width < mark.r * 1.8;
    const y = round(fits ? mark.cy + size * 0.35 : mark.cy - mark.r - 4);
    const box: Rect = { x: mark.cx - width / 2, y: y - size, width, height: size * 1.2 };
    if (taken.some((other) => box.x < other.x + other.width && other.x < box.x + box.width && box.y < other.y + other.height && other.y < box.y + box.height)) {
      hidden += 1;
      continue;
    }
    taken.push(box);
    out.push({ id: `${element.id}:plabel:${out.length}`, text, x: mark.cx, y, anchor: "middle", fontSize: size, fill: ctx.labelColor, weight: 600 });
  }
  if (hidden) ctx.warnings.push(`${hidden} ${hidden === 1 ? "label was" : "labels were"} left off where ${hidden === 1 ? "it" : "they"} would overlap another.`);
  return out;
}
