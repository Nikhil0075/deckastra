/**
 * Scatter, bubble and bubble map (image-led visual systems, item 5, 2026-10-13).
 */
import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { ChartElement } from "@deckastra/presentation-schema";

import { buildChartPayload, type ChartPayload } from "../src/charts";
import { resolveTheme } from "../src/theme";
import { WORLD_LAND } from "../src/world-map";

const theme = resolveTheme(loadFixture("repository").theme);

function chartOf(element: Partial<ChartElement>, width = 1200, height = 600): ChartPayload {
  const full = {
    id: "el_01JB8Z9K2QW4RN7F3XG5HTMD01",
    type: "chart",
    transform: { x: 0, y: 0, width, height },
    chartType: "scatter",
    data: { type: "inline", rows: [] },
    encoding: { category: "name", value: "y" },
    ...element,
  } as ChartElement;
  return buildChartPayload(full, width, height, { theme });
}

const COUNTRIES = [
  { name: "A", gdp: 12, life: 71, pop: 140, region: "North" },
  { name: "B", gdp: 45, life: 81, pop: 60, region: "North" },
  { name: "C", gdp: 8, life: 64, pop: 210, region: "South" },
  { name: "D", gdp: 30, life: 77, pop: 35, region: "South" },
];

const CITIES = [
  { city: "London", lat: 51.5, lon: -0.13, revenue: 42 },
  { city: "Tokyo", lat: 35.68, lon: 139.69, revenue: 47 },
  { city: "São Paulo", lat: -23.55, lon: -46.63, revenue: 21 },
];

const point = (payload: ChartPayload, label: string, rows: { name?: string; city?: string }[]) => {
  const index = rows.findIndex((row) => (row.name ?? row.city) === label);
  return payload.points.find((mark) => mark.id.endsWith(`:${index}`))!;
};

describe("a scatter on numeric axes", () => {
  const scatter = chartOf({ data: { type: "inline", rows: COUNTRIES }, encoding: { category: "name", x: "gdp", value: "life" } });

  it("places each point by its own numbers, not in a band", () => {
    const [a, b, c] = ["A", "B", "C"].map((name) => point(scatter, name, COUNTRIES));
    // Further right for a larger x, higher (smaller y on screen) for a larger value.
    expect(c!.cx).toBeLessThan(a!.cx);
    expect(a!.cx).toBeLessThan(b!.cx);
    expect(b!.cy).toBeLessThan(a!.cy);
    // Distances follow the numbers: A→B covers 33 units, C→A 4.
    expect((b!.cx - a!.cx) / (a!.cx - c!.cx)).toBeCloseTo(33 / 4, 1);
    expect(scatter.texts.some((text) => text.id.includes(":xtick:"))).toBe(true);
    expect(scatter.warnings).toEqual([]);
  });

  it("reads the category as the horizontal number when it is one", () => {
    const rows = [{ name: 1, y: 5 }, { name: 4, y: 6 }];
    const payload = chartOf({ data: { type: "inline", rows } });
    expect(payload.points[1]!.cx).toBeGreaterThan(payload.points[0]!.cx);
    expect(payload.texts.some((text) => text.id.includes(":xtick:"))).toBe(true);
  });

  it("keeps the banded scatter for words along the bottom", () => {
    const payload = chartOf({ data: { type: "inline", rows: [{ name: "Mon", y: 1 }, { name: "Tue", y: 2 }] } });
    expect(payload.texts.some((text) => text.id.includes(":ctick:"))).toBe(true);
  });
});

describe("a bubble chart", () => {
  const bubble = chartOf({
    chartType: "bubble",
    data: { type: "inline", rows: COUNTRIES },
    encoding: { category: "name", x: "gdp", value: "life", size: "pop", series: "region" },
  });

  it("sizes by area, not radius", () => {
    const single = chartOf({ chartType: "bubble", data: { type: "inline", rows: COUNTRIES }, encoding: { category: "name", x: "gdp", value: "life", size: "pop" } });
    const c = point(single, "C", COUNTRIES);
    const d = point(single, "D", COUNTRIES);
    // 210 against 35: six times the area is about 2.45 times the radius.
    expect(c.r / d.r).toBeCloseTo(Math.sqrt(210 / 35), 1);
  });

  it("draws the largest first, translucent and ringed, so small ones stay visible", () => {
    const radii = bubble.points.map((mark) => mark.r);
    expect(radii).toEqual([...radii].sort((a, b) => b - a));
    expect(bubble.points.every((mark) => mark.fillOpacity === 0.72 && mark.stroke && mark.strokeWidth === 1.5)).toBe(true);
  });

  it("colours and keys by series", () => {
    expect(bubble.legend.map((item) => item.label)).toEqual(["North", "South"]);
    expect(new Set(bubble.points.map((mark) => mark.fill)).size).toBe(2);
  });

  it("leaves out a bubble with no positive size, and says so", () => {
    const payload = chartOf({
      chartType: "bubble",
      data: { type: "inline", rows: [...COUNTRIES, { name: "E", gdp: 5, life: 60, pop: 0 }] },
      encoding: { category: "name", x: "gdp", value: "life", size: "pop" },
    });
    expect(payload.points).toHaveLength(4);
    expect(payload.warnings).toContain("1 bubble has no positive size and was left out.");
  });

  it("keeps every bubble inside the plot", () => {
    for (const mark of bubble.points) {
      expect(mark.cx - mark.r).toBeGreaterThanOrEqual(bubble.plot.x - 0.01);
      expect(mark.cx + mark.r).toBeLessThanOrEqual(bubble.plot.x + bubble.plot.width + 0.01);
      expect(mark.cy - mark.r).toBeGreaterThanOrEqual(bubble.plot.y - 0.01);
      expect(mark.cy + mark.r).toBeLessThanOrEqual(bubble.plot.y + bubble.plot.height + 0.01);
    }
  });
});

describe("a bubble map", () => {
  const map = (extra: Partial<ChartElement> = {}, rows: Record<string, unknown>[] = CITIES) =>
    chartOf({
      chartType: "bubbleMap",
      data: { type: "inline", rows },
      encoding: { category: "city", value: "revenue", latitude: "lat", longitude: "lon" },
      ...extra,
    });

  it("places each city by latitude and longitude", () => {
    const payload = map({ chartStyle: { mapExtent: "world" } });
    const london = point(payload, "London", CITIES);
    const tokyo = point(payload, "Tokyo", CITIES);
    const saoPaulo = point(payload, "São Paulo", CITIES);
    expect(saoPaulo.cx).toBeLessThan(london.cx);
    expect(london.cx).toBeLessThan(tokyo.cx);
    expect(london.cy).toBeLessThan(tokyo.cy);
    expect(tokyo.cy).toBeLessThan(saoPaulo.cy);
    // London is near the prime meridian, so near the middle of a world map.
    expect(Math.abs(london.cx - (payload.plot.x + payload.plot.width / 2))).toBeLessThan(payload.plot.width * 0.02);
  });

  it("draws the land as one shape that stays inside the frame", () => {
    for (const extent of ["world", "data"] as const) {
      const payload = map({ chartStyle: { mapExtent: extent } });
      expect(payload.paths).toHaveLength(1);
      const numbers = payload.paths[0]!.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
      for (let i = 0; i < numbers.length; i += 2) {
        expect(numbers[i]!).toBeGreaterThanOrEqual(payload.plot.x - 0.01);
        expect(numbers[i]!).toBeLessThanOrEqual(payload.plot.x + payload.plot.width + 0.01);
        expect(numbers[i + 1]!).toBeGreaterThanOrEqual(payload.plot.y - 0.01);
        expect(numbers[i + 1]!).toBeLessThanOrEqual(payload.plot.y + payload.plot.height + 0.01);
      }
    }
  });

  it("draws no land the long way round the world", () => {
    // A ring crossing the 180° meridian, drawn as stored, is a hairline across
    // the whole map. The first version did exactly that, at Fiji's latitude.
    const payload = map({ chartStyle: { mapExtent: "world" } });
    for (const sub of payload.paths[0]!.d.split("M").filter(Boolean)) {
      const numbers = sub.match(/-?\d+(\.\d+)?/g)!.map(Number);
      const xs = numbers.filter((_, i) => i % 2 === 0);
      const ys = numbers.filter((_, i) => i % 2 === 1);
      const wide = Math.max(...xs) - Math.min(...xs) > payload.plot.width * 0.8;
      const flat = Math.max(...ys) - Math.min(...ys) < 6;
      expect(wide && flat).toBe(false);
    }
  });

  it("stores a meridian-crossing ring unwrapped, never jumping across the map", () => {
    for (const ring of WORLD_LAND) {
      let jumps = 0;
      for (let i = 2; i < ring.length; i += 2) if (Math.abs(ring[i]! - ring[i - 2]!) > 1800) jumps += 1;
      // Antarctica's single crossing is its own edge along the pole.
      expect(jumps).toBeLessThanOrEqual(1);
    }
  });

  it("zooms to where the data is, but never narrower than a continent", () => {
    const europe = [
      { city: "Paris", lat: 48.86, lon: 2.35, revenue: 28 },
      { city: "Berlin", lat: 52.52, lon: 13.4, revenue: 19 },
    ];
    const world = map({ chartStyle: { mapExtent: "world" } }, europe);
    const data = map({}, europe);
    const gap = (payload: ChartPayload) => Math.abs(payload.points[0]!.cx - payload.points[1]!.cx);
    expect(gap(data)).toBeGreaterThan(gap(world) * 4);
    // Eleven degrees apart, in a frame at least 45 degrees wide.
    expect(gap(data)).toBeLessThan(data.plot.width * 0.3);
  });

  it("says what it needs when it has no coordinates", () => {
    const payload = chartOf({ chartType: "bubbleMap", data: { type: "inline", rows: CITIES }, encoding: { category: "city", value: "revenue" } });
    expect(payload.notice).toBe("A bubble map needs latitude and longitude fields.");
  });

  it("leaves out a place it cannot locate, and says so", () => {
    const payload = map({}, [...CITIES, { city: "Nowhere", lat: 120, lon: 0, revenue: 5 }]);
    expect(payload.points).toHaveLength(3);
    expect(payload.warnings).toContain("1 row has no usable latitude and longitude and was left out.");
  });

  it("drops a label that would overlap a bigger bubble's, and says so", () => {
    const close = [
      { city: "London", lat: 51.5, lon: -0.13, revenue: 42 },
      { city: "Paris", lat: 48.86, lon: 2.35, revenue: 28 },
    ];
    const payload = map({ chartStyle: { mapExtent: "world", showDataLabels: true } }, close);
    expect(payload.texts.map((text) => text.text)).toEqual(["London 42"]);
    expect(payload.warnings).toContain("1 label was left off where it would overlap another.");
  });

  it("is the same every time", () => {
    expect(JSON.stringify(map({ chartStyle: { showDataLabels: true } }))).toBe(JSON.stringify(map({ chartStyle: { showDataLabels: true } })));
  });
});
