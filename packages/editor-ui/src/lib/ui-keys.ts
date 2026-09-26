/**
 * Keyboard and number rules shared by the UI primitives (`src/ui`).
 *
 * Pure on purpose, for the same reason the rest of `lib/` is: nothing in this
 * repository renders the editor shell in jsdom, so the only logic that can be
 * trusted is logic a test can call directly. The components below it only
 * translate DOM events into these calls.
 */

/** Keys that move a roving focus, mapped by `rovingIndex`. */
export type RovingKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export interface RovingOptions {
  /** Which arrow pair moves focus. A toolbar is horizontal, a menu vertical. */
  orientation: "horizontal" | "vertical";
  /** Wrap from the last item to the first. WAI-ARIA leaves it to the widget. */
  wrap?: boolean;
  /** Indices that cannot take focus — a disabled menu item is skipped, not landed on. */
  disabled?: ReadonlySet<number>;
}

/**
 * The index a roving-tabindex widget should move to for `key`, or `null` when
 * the key is not one it handles (so the caller leaves the event alone) or when
 * every item is disabled.
 *
 * Arrows on the *other* axis return `null` rather than moving: a vertical menu
 * that also moved on ArrowRight would steal the key a submenu or a text caret
 * needs.
 */
export function rovingIndex(current: number, count: number, key: string, options: RovingOptions): number | null {
  if (count <= 0) return null;
  const { orientation, wrap = true, disabled } = options;
  const prev = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const enabled = (i: number) => !disabled?.has(i);

  if (key === "Home" || key === "End") {
    const order = key === "Home" ? range(0, count) : range(0, count).reverse();
    return order.find(enabled) ?? null;
  }
  if (key !== prev && key !== next) return null;

  const direction = key === next ? 1 : -1;
  let index = current;
  for (let step = 0; step < count; step++) {
    index += direction;
    if (index < 0 || index >= count) {
      if (!wrap) return enabled(current) ? current : null;
      index = (index + count) % count;
    }
    if (enabled(index)) return index;
  }
  return null;
}

/**
 * First enabled index whose label starts with `typed` (case-insensitive),
 * searching forward from after `current`. Type-ahead for menus and selects.
 */
export function typeaheadIndex(
  labels: readonly string[],
  current: number,
  typed: string,
  disabled?: ReadonlySet<number>,
): number | null {
  const needle = typed.trim().toLowerCase();
  if (!needle) return null;
  for (let step = 1; step <= labels.length; step++) {
    const index = (current + step + labels.length) % labels.length;
    if (disabled?.has(index)) continue;
    if (labels[index]!.toLowerCase().startsWith(needle)) return index;
  }
  return null;
}

export interface NumberRules {
  min?: number;
  max?: number;
  /** Only whole numbers are accepted — pixel positions in logical units, milliseconds. */
  integer?: boolean;
}

/**
 * Read what someone typed into a number field. `null` means "not a number this
 * field accepts", and the field must then commit nothing and show the last good
 * value again — an inspector that wrote `NaN` or clamped silently to a value the
 * user never typed would be editing the document on a guess.
 *
 * Out-of-range input is refused rather than clamped for the same reason: typing
 * `-40` into a width and getting `0` is a different edit from the one asked for.
 */
export function parseNumberInput(text: string, rules: NumberRules = {}): number | null {
  const trimmed = text.trim().replace(/,/g, "");
  if (trimmed === "" || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (rules.integer && !Number.isInteger(value)) return null;
  if (rules.min !== undefined && value < rules.min) return null;
  if (rules.max !== undefined && value > rules.max) return null;
  return value;
}

/**
 * The value an arrow key produces. Unlike typed input this *does* clamp: the
 * user asked to go "one more" in a direction, and at the boundary one more is
 * the boundary. Rounded to the step's precision so 0.1 + 0.2 stays 0.3.
 */
export function stepNumber(
  value: number,
  direction: 1 | -1,
  { step = 1, large = false, min, max }: { step?: number; large?: boolean; min?: number; max?: number } = {},
): number {
  const amount = step * (large ? 10 : 1);
  const decimals = Math.max(0, (String(step).split(".")[1] ?? "").length);
  let next = Number((value + direction * amount).toFixed(decimals));
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}
