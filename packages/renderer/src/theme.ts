import {
  TOKEN_PREFIX,
  isTokenRef,
  resolveToken,
  tokenPath,
  type ThemeDefinition,
  type TypographyStyle,
} from "@deckastra/presentation-schema";

/**
 * Theme resolution — pipeline stage 3 (doc 04 §6.1).
 *
 * Flattens a ThemeDefinition into a token map so the rest of the pipeline never
 * walks the theme object again. The scene must contain concrete values, not
 * references: an export adapter or a headless renderer has no business
 * re-deriving what a token meant.
 */

export interface ResolvedTheme {
  id: string;
  name: string;
  mode: "light" | "dark";
  /** Flat map, e.g. "colors.accent" -> "#4CC2FF". Values are concrete. */
  tokens: ReadonlyMap<string, unknown>;
  source: ThemeDefinition;
}

/**
 * Tokens that affect text measurement (doc 04 §6.2).
 *
 * The trap the spec calls out: a change to `typography.body.fontFamily`
 * invalidates measurement, while a change to `colors.accent` does not. Treating
 * every theme edit as metric-affecting makes recolouring re-measure the whole
 * deck; treating none as metric-affecting leaves stale metrics behind, which is
 * worse. So the distinction is explicit.
 */
const METRIC_AFFECTING = ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight"];

export function isMetricAffectingToken(path: string): boolean {
  return METRIC_AFFECTING.some((suffix) => path.endsWith(`.${suffix}`));
}

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value === null || typeof value !== "object") {
    out.set(prefix, value);
    return;
  }

  if (Array.isArray(value)) {
    // Arrays are kept whole — chartSeries is meaningful as an ordered list, and
    // splitting it into indexed keys would lose that.
    out.set(prefix, value);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    flatten(child, path, out);
    // Also keep the composite: "typography.h1" must resolve to a whole
    // TypographyStyle, since that is what a token reference on an element means.
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      out.set(path, child);
    }
  }
}

export function resolveTheme(theme: ThemeDefinition): ResolvedTheme {
  const tokens = new Map<string, unknown>();
  for (const group of ["colors", "typography", "spacing", "radii", "shadows", "grid"] as const) {
    flatten(theme[group], group, tokens);
  }
  for (const group of ["chart", "diagram", "imagery", "motion"] as const) {
    if (theme[group]) flatten(theme[group], group, tokens);
  }

  return {
    id: theme.id,
    name: theme.name,
    mode: theme.mode ?? "light",
    tokens,
    source: theme,
  };
}

/**
 * Resolve a possibly-token value against the theme.
 *
 * Resolution order is doc 02 §22.8, with the parts a renderer can see: a literal
 * wins over a token, and an unresolvable token falls back rather than throwing.
 * Throwing here would blank a slide over a typo; the validator already reports
 * unresolvable tokens as E202, which is the right place to fail loudly.
 */
export function resolveValue<T = unknown>(
  theme: ResolvedTheme,
  value: unknown,
  fallback?: T,
): T | undefined {
  if (value === undefined || value === null) return fallback;
  if (!isTokenRef(value)) return value as T;

  const path = tokenPath(value);
  const resolved = theme.tokens.get(path) ?? resolveToken(theme.source, path);
  return (resolved as T) ?? fallback;
}

/** True when a string is a token reference the theme cannot resolve. */
export function isDanglingToken(theme: ResolvedTheme, value: unknown): boolean {
  if (!isTokenRef(value)) return false;
  const path = tokenPath(value);
  return theme.tokens.get(path) === undefined && resolveToken(theme.source, path) === undefined;
}

/**
 * Resolve a typography style whose individual properties may be tokens.
 *
 * Both forms occur and both must work: `fontFamily: "token:typography.h1.fontFamily"`
 * picks one property out of a token, while `"token:typography.h1"` on the whole
 * style means "inherit the h1 style". v1.1 unified the naming specifically so a
 * token and an element property are directly assignable (doc 02 §22.3).
 */
export function resolveTypography(
  theme: ResolvedTheme,
  style: TypographyStyle,
): TypographyStyle {
  const out: Record<string, unknown> = { ...style };

  for (const [key, value] of Object.entries(style)) {
    if (isTokenRef(value)) out[key] = resolveValue(theme, value);
  }

  return out as unknown as TypographyStyle;
}

export { TOKEN_PREFIX };
