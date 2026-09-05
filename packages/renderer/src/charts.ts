import type {
  ChartElement,
  NumberFormat,
  Rect,
  TypographyStyle,
} from "@deckastra/presentation-schema";

import { formatNumber, toLabel, toNumber } from "./format";
import { bandScale, estimateLabelWidth, linearScale, round } from "./scale";
import { resolveTypography, resolveValue, type ResolvedTheme } from "./theme";

/**
 * Chart layout (doc 04 §21).
 *
 * The document carries data and intent; every geometric decision — plot area,
 * tick placement, bar width, arc angles, legend position — is made here, once,
 * and lands in the payload as concrete numbers. The React layer draws them and
 * computes nothing.
 *
 * That is not tidiness. It is what lets the PDF and PPTX adapters consume the
 * same structure in Phase 8 rather than each re-deriving a chart and drifting
 * from what the user approved on screen.
 */

export type ChartMarkFill = string;

export interface ChartRectMark {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: ChartMarkFill;
  radius: number;
}

export interface ChartPathMark {
  id: string;
  d: string;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  fillOpacity?: number;
  dash?: string;
}

export interface ChartPointMark {
  id: string;
  cx: number;
  cy: number;
  r: number;
  fill: string;
}

export interface ChartTextMark {
  id: string;
  text: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  /** Degrees, about (x, y). Only the y-axis title uses it. */
  rotate?: number;
  fontSize: number;
  fill: string;
  weight?: number;
}

export interface ChartLegendItem {
  label: string;
  color: string;
  swatch: Rect;
  textX: number;
  textY: number;
}

export interface ChartLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ChartPayload {
  kind: "chart";
  /** The kind actually drawn. An unknown `chartType` degrades to "column". */
  chartType: string;
  requestedType: string;
  plot: Rect;
  gridlines: ChartLine[];
  axisLines: ChartLine[];
  rects: ChartRectMark[];
  paths: ChartPathMark[];
  points: ChartPointMark[];
  texts: ChartTextMark[];
  legend: ChartLegendItem[];
  labelTypography: TypographyStyle;
  altText?: string;
  /** Shown in place of the chart when there is nothing to draw. */
  notice?: string;
  /** Degradations the user should know about. Surfaced, never silent (doc 04 §33). */
  warnings: string[];
}

const KNOWN_KINDS = new Set([
  "bar",
  "column",
  "line",
  "area",
  "pie",
  "donut",
  "scatter",
  "stackedBar",
  "stackedColumn",
  "combo",
]);

interface SeriesPoint {
  category: string;
  value: number;
}

interface Series {
  key: string;
  label: string;
  color: string;
  points: SeriesPoint[];
}

interface ChartContext {
  theme: ResolvedTheme;
  /** Rows from a TableElement on the same slide, when `data.type === "table"`. */
  tableRows?: Record<string, unknown>[];
}

// --------------------------------------------------------------------- data

/**
 * Rows for the chart.
 *
 * `dataSource` resolves server-side under the requesting user's permissions
 * (doc 02 §29.2), so the renderer cannot fetch it and must say so rather than
 * drawing an empty chart that looks like a data problem.
 */
function extractRows(
  element: ChartElement,
  ctx: ChartContext,
  warnings: string[],
): Record<string, unknown>[] {
  const data = element.data;

  if (data.type === "inline") return data.rows as Record<string, unknown>[];

  if (data.type === "table") {
    if (ctx.tableRows) return ctx.tableRows;
    warnings.push("The table this chart reads from is not on this slide.");
    return [];
  }

  warnings.push("Data source values are resolved server-side and are not available here.");
  return [];
}

function aggregate(values: number[], how: string | undefined): number {
  if (values.length === 0) return 0;
  switch (how) {
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "count":
      return values.length;
    default:
      return values.reduce((a, b) => a + b, 0);
  }
}

/**
 * Rows -> series, applying the encoding.
 *
 * Category order is first-appearance order unless `sort` says otherwise. That
 * matters: a stable order means adding a row does not reshuffle a chart the user
 * has already read.
 */
function buildSeries(
  element: ChartElement,
  rows: Record<string, unknown>[],
  palette: string[],
  warnings: string[],
): { series: Series[]; categories: string[] } {
  const encoding = element.encoding;
  const valueFields = Array.isArray(encoding.value) ? encoding.value : [encoding.value];

  const categories: string[] = [];
  const seen = new Set<string>();
  // key -> category -> raw values awaiting aggregation
  const buckets = new Map<string, Map<string, number[]>>();
  const seriesOrder: string[] = [];

  for (const row of rows) {
    const category = toLabel(row[encoding.category]);
    if (!seen.has(category)) {
      seen.add(category);
      categories.push(category);
    }

    for (const field of valueFields) {
      const value = toNumber(row[field]);
      if (value === undefined) continue;

      const key = encoding.series
        ? `${toLabel(row[encoding.series])}${valueFields.length > 1 ? ` · ${field}` : ""}`
        : field;

      if (!buckets.has(key)) {
        buckets.set(key, new Map());
        seriesOrder.push(key);
      }
      const byCategory = buckets.get(key)!;
      const list = byCategory.get(category) ?? [];
      list.push(value);
      byCategory.set(category, list);
    }
  }

  let orderedCategories = categories;

  if (encoding.sort) {
    const totals = new Map<string, number>();
    for (const category of categories) {
      let sum = 0;
      for (const byCategory of buckets.values()) {
        sum += aggregate(byCategory.get(category) ?? [], encoding.aggregate);
      }
      totals.set(category, sum);
    }

    orderedCategories = [...categories].sort((a, b) => {
      const comparison =
        encoding.sort!.by === "value"
          ? (totals.get(a) ?? 0) - (totals.get(b) ?? 0)
          : a.localeCompare(b);
      return encoding.sort!.direction === "desc" ? -comparison : comparison;
    });
  }

  if (encoding.limit && orderedCategories.length > encoding.limit) {
    // Top-N with the tail folded into "Other" rather than dropped: a chart that
    // silently discards categories misrepresents its own totals.
    const kept = orderedCategories.slice(0, encoding.limit);
    const dropped = orderedCategories.slice(encoding.limit);

    for (const byCategory of buckets.values()) {
      const tail: number[] = [];
      for (const category of dropped) {
        tail.push(...(byCategory.get(category) ?? []));
        byCategory.delete(category);
      }
      if (tail.length > 0) byCategory.set("Other", [aggregate(tail, encoding.aggregate)]);
    }

    orderedCategories = [...kept, "Other"];
    warnings.push(`${dropped.length} smaller categories were grouped as "Other".`);
  }

  const series: Series[] = seriesOrder.map((key, index) => {
    const byCategory = buckets.get(key)!;
    return {
      key,
      label: key,
      color: palette[index % palette.length]!,
      points: orderedCategories.map((category) => ({
        category,
        value: aggregate(byCategory.get(category) ?? [], encoding.aggregate),
      })),
    };
  });

  return { series, categories: orderedCategories };
}

// ------------------------------------------------------------------- layout

const LEGEND_SWATCH = 14;
const LEGEND_GAP = 8;
const LEGEND_ITEM_GAP = 24;
const AXIS_LABEL_GAP = 10;

function legendItems(
  series: Series[],
  position: string,
  box: { width: number; height: number },
  fontSize: number,
): { items: ChartLegendItem[]; inset: { top: number; right: number; bottom: number; left: number } } {
  if (series.length <= 1) {
    return { items: [], inset: { top: 0, right: 0, bottom: 0, left: 0 } };
  }

  const rowHeight = Math.max(LEGEND_SWATCH, fontSize * 1.4);

  if (position === "right" || position === "left") {
    const width =
      LEGEND_SWATCH +
      LEGEND_GAP +
      Math.max(...series.map((s) => estimateLabelWidth(s.label, fontSize))) +
      LEGEND_ITEM_GAP;

    const startY = round((box.height - series.length * rowHeight) / 2);
    const x = position === "right" ? round(box.width - width + LEGEND_ITEM_GAP / 2) : 0;

    return {
      items: series.map((s, i) => ({
        label: s.label,
        color: s.color,
        swatch: {
          x,
          y: round(startY + i * rowHeight + (rowHeight - LEGEND_SWATCH) / 2),
          width: LEGEND_SWATCH,
          height: LEGEND_SWATCH,
        },
        textX: round(x + LEGEND_SWATCH + LEGEND_GAP),
        textY: round(startY + i * rowHeight + rowHeight / 2),
      })),
      inset:
        position === "right"
          ? { top: 0, right: round(width), bottom: 0, left: 0 }
          : { top: 0, right: 0, bottom: 0, left: round(width) },
    };
  }

  // Horizontal: one row, centred. Items that would overflow are still emitted —
  // clipping the legend is better than dropping the key to the data.
  const widths = series.map(
    (s) => LEGEND_SWATCH + LEGEND_GAP + estimateLabelWidth(s.label, fontSize) + LEGEND_ITEM_GAP,
  );
  const total = widths.reduce((a, b) => a + b, 0) - LEGEND_ITEM_GAP;
  const y = position === "top" ? 0 : round(box.height - rowHeight);

  let cursor = round(Math.max(0, (box.width - total) / 2));
  const items: ChartLegendItem[] = series.map((s, i) => {
    const item: ChartLegendItem = {
      label: s.label,
      color: s.color,
      swatch: {
        x: cursor,
        y: round(y + (rowHeight - LEGEND_SWATCH) / 2),
        width: LEGEND_SWATCH,
        height: LEGEND_SWATCH,
      },
      textX: round(cursor + LEGEND_SWATCH + LEGEND_GAP),
      textY: round(y + rowHeight / 2),
    };
    cursor = round(cursor + widths[i]!);
    return item;
  });

  return {
    items,
    inset:
      position === "top"
        ? { top: round(rowHeight + AXIS_LABEL_GAP), right: 0, bottom: 0, left: 0 }
        : { top: 0, right: 0, bottom: round(rowHeight + AXIS_LABEL_GAP), left: 0 },
  };
}

function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  startAngle: number,
  endAngle: number,
): string {
  // A full circle cannot be drawn as a single arc — start and end coincide and
  // the path collapses. Two half arcs are the standard workaround.
  const sweep = endAngle - startAngle;
  if (sweep >= Math.PI * 2 - 1e-9) {
    const half = startAngle + Math.PI;
    return [
      arcPath(cx, cy, outer, inner, startAngle, half),
      arcPath(cx, cy, outer, inner, half, startAngle + Math.PI * 2 - 1e-9),
    ].join(" ");
  }

  const point = (radius: number, angle: number): [number, number] => [
    round(cx + radius * Math.cos(angle)),
    round(cy + radius * Math.sin(angle)),
  ];

  const large = sweep > Math.PI ? 1 : 0;
  const [x0, y0] = point(outer, startAngle);
  const [x1, y1] = point(outer, endAngle);

  if (inner <= 0) {
    return `M ${cx} ${cy} L ${x0} ${y0} A ${outer} ${outer} 0 ${large} 1 ${x1} ${y1} Z`;
  }

  const [x2, y2] = point(inner, endAngle);
  const [x3, y3] = point(inner, startAngle);
  return (
    `M ${x0} ${y0} A ${outer} ${outer} 0 ${large} 1 ${x1} ${y1} ` +
    `L ${x2} ${y2} A ${inner} ${inner} 0 ${large} 0 ${x3} ${y3} Z`
  );
}

/** Catmull-Rom to cubic Bézier. Smoothing 0 gives straight segments. */
function linePath(points: [number, number][], smoothing: number): string {
  if (points.length === 0) return "";
  if (points.length === 1 || smoothing <= 0) {
    return points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
  }

  const tension = Math.min(1, smoothing) / 6;
  let d = `M ${points[0]![0]} ${points[0]![1]}`;

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;

    const c1x = round(p1[0] + (p2[0] - p0[0]) * tension);
    const c1y = round(p1[1] + (p2[1] - p0[1]) * tension);
    const c2x = round(p2[0] - (p3[0] - p1[0]) * tension);
    const c2y = round(p2[1] - (p3[1] - p1[1]) * tension);

    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`;
  }

  return d;
}

// --------------------------------------------------------------------- build

export function buildChartPayload(
  element: ChartElement,
  width: number,
  height: number,
  ctx: ChartContext,
): ChartPayload {
  const warnings: string[] = [];
  const theme = ctx.theme;
  const style = element.chartStyle ?? {};

  const requestedType = element.chartType;
  let chartType = requestedType;
  if (!KNOWN_KINDS.has(chartType)) {
    warnings.push(`Chart type "${requestedType}" is not known here; drawn as a column chart.`);
    chartType = "column";
  }

  const chartTheme = theme.source.chart;
  const palette = (
    style.palette ??
    chartTheme?.series ??
    theme.source.colors.chartSeries
  ).map((color) => String(resolveValue(theme, color, "#888888")));

  const labelTypography = resolveTypography(
    theme,
    chartTheme?.labelTypography ?? {
      fontFamily: "token:typography.caption.fontFamily",
      fontSize: 20,
      color: "token:colors.foregroundMuted",
    },
  );
  const fontSize = labelTypography.fontSize;
  const labelColor = String(labelTypography.color ?? "#888888");

  const axisColor = String(
    resolveValue(theme, chartTheme?.axisColor ?? "token:colors.border", "#8884"),
  );
  const gridColor = String(
    resolveValue(theme, chartTheme?.gridlineColor ?? "token:colors.border", "#8882"),
  );
  const barRadius = chartTheme?.barCornerRadius ?? 4;
  const lineWidth = chartTheme?.lineWidth ?? 3;
  const pointSize = chartTheme?.pointSize ?? 5;

  const empty: ChartPayload = {
    kind: "chart",
    chartType,
    requestedType,
    plot: { x: 0, y: 0, width, height },
    gridlines: [],
    axisLines: [],
    rects: [],
    paths: [],
    points: [],
    texts: [],
    legend: [],
    labelTypography,
    altText: element.altText,
    warnings,
  };

  const rows = extractRows(element, ctx, warnings);
  const { series, categories } = buildSeries(element, rows, palette, warnings);

  if (series.length === 0 || categories.length === 0) {
    return { ...empty, notice: warnings[0] ?? "This chart has no data to show." };
  }

  const showLegend = style.showLegend ?? series.length > 1;
  const legendPosition =
    style.legendPosition ?? (chartType === "pie" || chartType === "donut" ? "right" : "bottom");

  const legend = showLegend
    ? legendItems(series, legendPosition, { width, height }, fontSize)
    : { items: [] as ChartLegendItem[], inset: { top: 0, right: 0, bottom: 0, left: 0 } };

  const texts: ChartTextMark[] = [];
  const rects: ChartRectMark[] = [];
  const paths: ChartPathMark[] = [];
  const points: ChartPointMark[] = [];
  const gridlines: ChartLine[] = [];
  const axisLines: ChartLine[] = [];

  const numberFormat: NumberFormat | undefined = style.numberFormat;

  // ------------------------------------------------------------ pie / donut

  if (chartType === "pie" || chartType === "donut") {
    const box = {
      x: legend.inset.left,
      y: legend.inset.top,
      width: width - legend.inset.left - legend.inset.right,
      height: height - legend.inset.top - legend.inset.bottom,
    };

    // Only the first series is drawn: a pie with two series is two claims in one
    // circle, and there is no honest way to show it.
    const first = series[0]!;
    if (series.length > 1) {
      warnings.push("A pie chart shows one series; the others were not drawn.");
    }

    const slices = first.points.filter((point) => point.value > 0);
    const total = slices.reduce((sum, point) => sum + point.value, 0);

    if (total <= 0) {
      return { ...empty, notice: "Every value in this chart is zero." };
    }

    const cx = round(box.x + box.width / 2);
    const cy = round(box.y + box.height / 2);
    const outer = round(Math.min(box.width, box.height) / 2 - 8);
    const inner = chartType === "donut" ? round(outer * 0.58) : 0;

    // Start at 12 o'clock and go clockwise, which is how a reader expects to
    // enter a pie.
    let angle = -Math.PI / 2;

    slices.forEach((point, index) => {
      const sweep = (point.value / total) * Math.PI * 2;
      paths.push({
        id: `${element.id}:slice:${index}`,
        d: arcPath(cx, cy, outer, inner, angle, angle + sweep),
        fill: palette[index % palette.length]!,
      });

      if (style.showDataLabels) {
        const mid = angle + sweep / 2;
        const radius = inner > 0 ? (outer + inner) / 2 : outer * 0.65;
        texts.push({
          id: `${element.id}:label:${index}`,
          text: formatNumber(point.value / total, { style: "percent", decimals: 0 }),
          x: round(cx + radius * Math.cos(mid)),
          y: round(cy + radius * Math.sin(mid) + fontSize * 0.35),
          anchor: "middle",
          fontSize,
          fill: labelColor,
          weight: 600,
        });
      }

      angle += sweep;
    });

    // The legend keys categories, not series, for a pie.
    const categoryLegend: ChartLegendItem[] = showLegend
      ? legendItems(
          slices.map((point, index) => ({
            key: point.category,
            label: point.category,
            color: palette[index % palette.length]!,
            points: [],
          })),
          legendPosition,
          { width, height },
          fontSize,
        ).items
      : [];

    return {
      ...empty,
      plot: { x: box.x, y: box.y, width: round(box.width), height: round(box.height) },
      paths,
      texts,
      legend: categoryLegend,
      warnings,
    };
  }

  // ----------------------------------------------------- cartesian charts

  const horizontal = chartType === "bar" || chartType === "stackedBar";
  const stacked =
    chartType === "stackedBar" ||
    chartType === "stackedColumn" ||
    (style.stacking && style.stacking !== "none");

  const valuesForScale: number[] = [];
  if (stacked) {
    for (const category of categories) {
      let positive = 0;
      let negative = 0;
      for (const s of series) {
        const value = s.points.find((p) => p.category === category)?.value ?? 0;
        if (value >= 0) positive += value;
        else negative += value;
      }
      valuesForScale.push(positive, negative);
    }
  } else {
    for (const s of series) for (const point of s.points) valuesForScale.push(point.value);
  }

  const valueAxis = horizontal ? style.axisX : style.axisY;
  const categoryAxis = horizontal ? style.axisY : style.axisX;

  // Zero-based by default for anything drawn as a bar: a truncated bar axis
  // exaggerates every difference between the bars (doc 02 §17.4).
  const includeZero =
    valueAxis?.includeZero ??
    (chartType === "bar" ||
      chartType === "column" ||
      chartType === "stackedBar" ||
      chartType === "stackedColumn" ||
      chartType === "area" ||
      chartType === "combo");

  // Two passes: size the gutters from the formatted labels, then lay out. The
  // first pass needs a scale, so it runs against the full box and is thrown away.
  const draft = linearScale(valuesForScale, {
    rangeStart: 0,
    rangeEnd: 1,
    min: valueAxis?.min,
    max: valueAxis?.max,
    includeZero,
    tickCount: valueAxis?.tickCount,
  });
  const valueLabels = draft.ticks.map((tick) => formatNumber(tick, valueAxis?.format ?? numberFormat));
  const widestValueLabel = Math.max(
    0,
    ...valueLabels.map((label) => estimateLabelWidth(label, fontSize)),
  );
  const widestCategoryLabel = Math.max(
    0,
    ...categories.map((label) => estimateLabelWidth(label, fontSize)),
  );

  const hideValueAxis = valueAxis?.hidden === true;
  const hideCategoryAxis = categoryAxis?.hidden === true;

  const gutterLeft = horizontal
    ? hideCategoryAxis
      ? 0
      : widestCategoryLabel + AXIS_LABEL_GAP
    : hideValueAxis
      ? 0
      : widestValueLabel + AXIS_LABEL_GAP;
  const gutterBottom = horizontal
    ? hideValueAxis
      ? 0
      : fontSize * 1.6
    : hideCategoryAxis
      ? 0
      : fontSize * 1.6;

  const titleSpace = {
    left: (horizontal ? categoryAxis?.title : valueAxis?.title) ? fontSize * 1.6 : 0,
    bottom: (horizontal ? valueAxis?.title : categoryAxis?.title) ? fontSize * 1.6 : 0,
  };

  const plot: Rect = {
    x: round(legend.inset.left + gutterLeft + titleSpace.left),
    y: round(legend.inset.top + fontSize * 0.6),
    width: round(
      width - legend.inset.left - legend.inset.right - gutterLeft - titleSpace.left - fontSize * 0.6,
    ),
    height: round(
      height -
        legend.inset.top -
        legend.inset.bottom -
        gutterBottom -
        titleSpace.bottom -
        fontSize * 0.6,
    ),
  };

  if (plot.width <= 0 || plot.height <= 0) {
    return { ...empty, notice: "This chart is too small to draw." };
  }

  const scale = linearScale(valuesForScale, {
    rangeStart: horizontal ? plot.x : plot.y + plot.height,
    rangeEnd: horizontal ? plot.x + plot.width : plot.y,
    min: valueAxis?.min,
    max: valueAxis?.max,
    includeZero,
    tickCount: valueAxis?.tickCount,
  });

  const bands = bandScale(
    categories.length,
    horizontal ? plot.y : plot.x,
    horizontal ? plot.y + plot.height : plot.x + plot.width,
    categories.length > 12 ? 0.1 : 0.25,
  );

  const showGridlines = style.showGridlines ?? chartTheme?.showGridlines ?? true;

  if (showGridlines && !hideValueAxis) {
    for (const tick of scale.ticks) {
      const position = scale.project(tick);
      gridlines.push(
        horizontal
          ? { x1: position, y1: plot.y, x2: position, y2: round(plot.y + plot.height) }
          : { x1: plot.x, y1: position, x2: round(plot.x + plot.width), y2: position },
      );
    }
  }

  // The zero line is drawn as an axis, not a gridline: it is the reference every
  // bar is measured from and must not be mistaken for a tick.
  const zeroPosition = scale.min <= 0 && scale.max >= 0 ? scale.project(0) : undefined;
  if (zeroPosition !== undefined) {
    axisLines.push(
      horizontal
        ? { x1: zeroPosition, y1: plot.y, x2: zeroPosition, y2: round(plot.y + plot.height) }
        : { x1: plot.x, y1: zeroPosition, x2: round(plot.x + plot.width), y2: zeroPosition },
    );
  }

  if (!hideValueAxis) {
    scale.ticks.forEach((tick, index) => {
      const position = scale.project(tick);
      texts.push({
        id: `${element.id}:vtick:${index}`,
        text: valueLabels[index] ?? formatNumber(tick, valueAxis?.format ?? numberFormat),
        x: horizontal ? position : round(plot.x - AXIS_LABEL_GAP),
        y: horizontal
          ? round(plot.y + plot.height + AXIS_LABEL_GAP + fontSize * 0.8)
          : round(position + fontSize * 0.35),
        anchor: horizontal ? "middle" : "end",
        fontSize,
        fill: labelColor,
      });
    });
  }

  if (!hideCategoryAxis) {
    categories.forEach((category, index) => {
      texts.push({
        id: `${element.id}:ctick:${index}`,
        text: category,
        x: horizontal ? round(plot.x - AXIS_LABEL_GAP) : bands.centre(index),
        y: horizontal
          ? round(bands.centre(index) + fontSize * 0.35)
          : round(plot.y + plot.height + AXIS_LABEL_GAP + fontSize * 0.8),
        anchor: horizontal ? "end" : "middle",
        fontSize,
        fill: labelColor,
      });
    });
  }

  const valueTitle = valueAxis?.title;
  const categoryTitle = categoryAxis?.title;

  if (valueTitle) {
    texts.push(
      horizontal
        ? {
            id: `${element.id}:vtitle`,
            text: valueTitle,
            x: round(plot.x + plot.width / 2),
            y: round(height - legend.inset.bottom),
            anchor: "middle",
            fontSize,
            fill: labelColor,
          }
        : {
            id: `${element.id}:vtitle`,
            text: valueTitle,
            x: round(legend.inset.left + fontSize),
            y: round(plot.y + plot.height / 2),
            anchor: "middle",
            rotate: -90,
            fontSize,
            fill: labelColor,
          },
    );
  }

  if (categoryTitle) {
    texts.push(
      horizontal
        ? {
            id: `${element.id}:ctitle`,
            text: categoryTitle,
            x: round(legend.inset.left + fontSize),
            y: round(plot.y + plot.height / 2),
            anchor: "middle",
            rotate: -90,
            fontSize,
            fill: labelColor,
          }
        : {
            id: `${element.id}:ctitle`,
            text: categoryTitle,
            x: round(plot.x + plot.width / 2),
            y: round(height - legend.inset.bottom),
            anchor: "middle",
            fontSize,
            fill: labelColor,
          },
    );
  }

  const baseline = zeroPosition ?? scale.project(scale.min);

  const isBarLike =
    chartType === "bar" ||
    chartType === "column" ||
    chartType === "stackedBar" ||
    chartType === "stackedColumn" ||
    chartType === "combo";

  if (isBarLike) {
    // combo draws series 0 as bars and the rest as lines, which is the whole
    // reason the type exists.
    const barSeries = chartType === "combo" ? series.slice(0, 1) : series;
    const lineSeries = chartType === "combo" ? series.slice(1) : [];

    const groupCount = stacked ? 1 : barSeries.length;
    const slotWidth = bands.bandWidth / Math.max(1, groupCount);

    const positiveOffsets = new Map<string, number>();
    const negativeOffsets = new Map<string, number>();

    barSeries.forEach((s, seriesIndex) => {
      s.points.forEach((point, categoryIndex) => {
        const bandStart = bands.start(categoryIndex);
        const slotStart = stacked ? bandStart : round(bandStart + seriesIndex * slotWidth);

        let from = baseline;
        let to = scale.project(point.value);

        if (stacked) {
          const offsets = point.value >= 0 ? positiveOffsets : negativeOffsets;
          const previous = offsets.get(point.category) ?? 0;
          from = scale.project(previous);
          to = scale.project(previous + point.value);
          offsets.set(point.category, previous + point.value);
        }

        const low = Math.min(from, to);
        const size = Math.abs(to - from);

        rects.push({
          id: `${element.id}:bar:${s.key}:${categoryIndex}`,
          x: horizontal ? round(low) : slotStart,
          y: horizontal ? slotStart : round(low),
          width: horizontal ? round(size) : round(stacked ? bands.bandWidth : slotWidth),
          height: horizontal ? round(stacked ? bands.bandWidth : slotWidth) : round(size),
          fill: s.color,
          // A radius taller than the bar produces a lozenge; clamp it.
          radius: round(Math.min(barRadius, size / 2, (horizontal ? bands.bandWidth : slotWidth) / 2)),
        });

        if (style.showDataLabels && !stacked) {
          texts.push({
            id: `${element.id}:dl:${s.key}:${categoryIndex}`,
            text: formatNumber(point.value, numberFormat),
            x: horizontal
              ? round(to + (point.value >= 0 ? AXIS_LABEL_GAP : -AXIS_LABEL_GAP))
              : round(slotStart + slotWidth / 2),
            y: horizontal
              ? round(slotStart + slotWidth / 2 + fontSize * 0.35)
              : round(to + (point.value >= 0 ? -AXIS_LABEL_GAP : AXIS_LABEL_GAP + fontSize * 0.8)),
            anchor: horizontal ? (point.value >= 0 ? "start" : "end") : "middle",
            fontSize,
            fill: labelColor,
            weight: 600,
          });
        }
      });
    });

    for (const s of lineSeries) {
      const coordinates = s.points.map(
        (point, index) => [bands.centre(index), scale.project(point.value)] as [number, number],
      );
      paths.push({
        id: `${element.id}:line:${s.key}`,
        d: linePath(coordinates, style.smoothing ?? 0),
        stroke: s.color,
        strokeWidth: lineWidth,
        fill: "none",
      });
      for (const [cx, cy] of coordinates) {
        points.push({ id: `${element.id}:pt:${s.key}:${cx}:${cy}`, cx, cy, r: pointSize, fill: s.color });
      }
    }
  } else if (chartType === "line" || chartType === "area") {
    for (const s of series) {
      const coordinates = s.points.map(
        (point, index) => [bands.centre(index), scale.project(point.value)] as [number, number],
      );

      if (chartType === "area") {
        const area =
          linePath(coordinates, style.smoothing ?? 0) +
          ` L ${coordinates.at(-1)![0]} ${baseline} L ${coordinates[0]![0]} ${baseline} Z`;
        paths.push({
          id: `${element.id}:area:${s.key}`,
          d: area,
          fill: s.color,
          fillOpacity: 0.22,
        });
      }

      paths.push({
        id: `${element.id}:line:${s.key}`,
        d: linePath(coordinates, style.smoothing ?? 0),
        stroke: s.color,
        strokeWidth: lineWidth,
        fill: "none",
      });

      for (const [cx, cy] of coordinates) {
        points.push({ id: `${element.id}:pt:${s.key}:${cx}:${cy}`, cx, cy, r: pointSize, fill: s.color });
      }
    }
  } else if (chartType === "scatter") {
    for (const s of series) {
      s.points.forEach((point, index) => {
        points.push({
          id: `${element.id}:pt:${s.key}:${index}`,
          cx: bands.centre(index),
          cy: scale.project(point.value),
          r: pointSize * 1.4,
          fill: s.color,
        });
      });
    }
  }

  return {
    kind: "chart",
    chartType,
    requestedType,
    plot,
    gridlines,
    axisLines,
    rects,
    paths,
    points,
    texts,
    legend: legend.items,
    labelTypography,
    altText: element.altText,
    warnings,
  };
}

export const CHART_INTERNALS = { arcPath, linePath, legendItems };
