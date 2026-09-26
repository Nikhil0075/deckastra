/**
 * Colour arithmetic for the visual picker (colour ramp, 2026-09-26).
 *
 * A person picks a colour by looking at it: a hue, then how vivid and how
 * bright. HSV is the model those two controls map onto directly (a square of
 * saturation against value, and a hue strip), so the picker works in HSV and
 * the document still stores what it always has — a hex.
 *
 * The ramp is the other half: the same hue from very light to very dark, which
 * is how a brand's palette is built (a tint for a card, a shade for text on it)
 * and a way to choose a colour without any control at all.
 */

export interface Hsv {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  v: number;
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

export function hexToRgb(hex: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!match) return undefined;
  let digits = match[1]!;
  if (digits.length === 3) digits = digits.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as [number, number, number];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function hexToHsv(hex: string): Hsv | undefined {
  const rgb = hexToRgb(hex);
  if (!rgb) return undefined;
  const [r, g, b] = rgb.map((channel) => channel / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** The pure hue at full saturation and brightness, for the picker's backdrop. */
export function hueHex(h: number): string {
  return hsvToHex({ h, s: 1, v: 1 });
}

/**
 * Nine steps of one colour, lightest to darkest, with the colour itself in the
 * middle. Mixed towards white and black in straight RGB — not perceptually
 * exact, and not meant to be: it is a set of neighbours to choose between, and
 * a result that is the colour you started from at step 5 matters more.
 */
export function colorRamp(hex: string, steps = 9): string[] {
  const rgb = hexToRgb(hex);
  if (!rgb) return [];
  const middle = Math.floor(steps / 2);
  return Array.from({ length: steps }, (_, index) => {
    if (index === middle) return rgbToHex(...rgb);
    const toward = index < middle ? 255 : 0;
    // Up to 85% of the way, so the ends are a tint and a shade, not white and black.
    const amount = (Math.abs(index - middle) / middle) * 0.85;
    return rgbToHex(...(rgb.map((channel) => channel + (toward - channel) * amount) as [number, number, number]));
  });
}
