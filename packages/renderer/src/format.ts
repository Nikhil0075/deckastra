import type { NumberFormat } from "@deckastra/presentation-schema";

/**
 * Number formatting for axes, data labels and table cells (doc 02 §29.5).
 *
 * **This deliberately does not use `Intl.NumberFormat`.** Intl output depends on
 * the ICU data compiled into the runtime, so the same document formats one way
 * in Node 22, another in a browser, and a third in a slimmed-down container. A
 * renderer whose output changes with its host cannot produce byte-identical
 * renders (doc 04 §31.2), and a chart axis that reads "24.1K" in the editor and
 * "24,1 K" in the exported PDF is a bug the user cannot explain.
 *
 * `NumberFormat.locale` is therefore recorded in the document but not honoured
 * here. Localised formatting is a real requirement and belongs behind an
 * explicit, versioned locale table rather than behind whatever ICU the process
 * happens to carry.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  INR: "₹",
  KRW: "₩",
  CHF: "CHF ",
  CAD: "CA$",
  AUD: "A$",
  SEK: "kr ",
  NOK: "kr ",
  DKK: "kr ",
  BRL: "R$",
  MXN: "MX$",
  ZAR: "R",
  NGN: "₦",
  SGD: "S$",
  HKD: "HK$",
  NZD: "NZ$",
  PLN: "zł ",
  RUB: "₽",
  TRY: "₺",
  ILS: "₪",
  THB: "฿",
};

/** Compact suffixes, ascending. Stops at T: beyond that a chart wants a unit label. */
const COMPACT_STEPS: { limit: number; divisor: number; suffix: string }[] = [
  { limit: 1e12, divisor: 1e12, suffix: "T" },
  { limit: 1e9, divisor: 1e9, suffix: "B" },
  { limit: 1e6, divisor: 1e6, suffix: "M" },
  { limit: 1e3, divisor: 1e3, suffix: "K" },
];

function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/** Fixed-point with grouping. `-0` is normalised to `0`; a chart axis reading "-0" is noise. */
function fixed(value: number, decimals: number): string {
  const rounded = Number(value.toFixed(decimals));
  const normalised = rounded === 0 ? 0 : rounded;
  const text = Math.abs(normalised).toFixed(decimals);
  const [whole = "0", fraction] = text.split(".");
  const grouped = groupThousands(whole);
  const sign = normalised < 0 ? "-" : "";
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

/**
 * Decimals when the document does not say.
 *
 * Chosen so an axis of small values keeps its resolution and an axis of large
 * ones does not spray zeros: a tick at 0.25 must not render as "0".
 */
function defaultDecimals(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return 0;
  if (magnitude >= 100) return 0;
  if (magnitude >= 10) return Number.isInteger(value) ? 0 : 1;
  if (magnitude >= 1) return Number.isInteger(value) ? 0 : 2;
  return 2;
}

export function formatNumber(value: number, format?: NumberFormat): string {
  if (!Number.isFinite(value)) return "—";

  const style = format?.style ?? "decimal";
  const prefix = format?.prefix ?? "";
  const suffix = format?.suffix ?? "";

  let body: string;

  switch (style) {
    case "percent": {
      // The document carries the ratio, not the display number: 0.42 -> "42%".
      const scaled = value * 100;
      body = `${fixed(scaled, format?.decimals ?? defaultDecimals(scaled))}%`;
      break;
    }

    case "currency": {
      const code = format?.currency?.toUpperCase();
      const symbol = code ? (CURRENCY_SYMBOLS[code] ?? `${code} `) : "";
      const decimals = format?.decimals ?? 2;
      const negative = value < 0;
      body = `${negative ? "-" : ""}${symbol}${fixed(Math.abs(value), decimals)}`;
      break;
    }

    case "compact": {
      const magnitude = Math.abs(value);
      const step = COMPACT_STEPS.find((candidate) => magnitude >= candidate.limit);

      if (!step) {
        body = fixed(value, format?.decimals ?? defaultDecimals(value));
        break;
      }

      const scaled = value / step.divisor;
      // One decimal below 100 ("24.1K"), none above ("240K") — the point of
      // compact notation is a short label, and "240.0K" is not shorter.
      const decimals = format?.decimals ?? (Math.abs(scaled) < 100 ? 1 : 0);
      const text = fixed(scaled, decimals);
      // Trim a trailing ".0" that survives the rounding: "24.0K" reads as noise.
      body = `${text.endsWith(".0") ? text.slice(0, -2) : text}${step.suffix}`;
      break;
    }

    default:
      body = fixed(value, format?.decimals ?? defaultDecimals(value));
  }

  return `${prefix}${body}${suffix}`;
}

/**
 * Coerce a data cell to a number.
 *
 * Returns `undefined` rather than `NaN` for anything unusable, so callers have to
 * decide what a missing point means instead of silently plotting it at zero — a
 * gap in a line and a real zero are different claims about the data.
 */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

  if (typeof value === "string") {
    const cleaned = value.replace(/[\s,%$€£¥]/g, "");
    if (cleaned === "") return undefined;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (typeof value === "boolean") return value ? 1 : 0;
  return undefined;
}

/** Category labels. Non-strings become their formatted or JSON form, never "[object Object]". */
export function toLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return formatNumber(value);
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}
