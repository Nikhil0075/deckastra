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
  /** The theme `source.extends` names, when the caller supplied it. */
  parent?: ThemeDefinition;
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

/**
 * Resolve a theme, optionally over the theme it extends (doc 02 §22.8).
 *
 * `extends` is an id, and this package has no theme registry, so the parent is
 * supplied by whoever does know the workspace. Inheritance is a *token-level*
 * merge rather than a top-level object merge: a child that overrides one colour
 * must not lose the parent's typography, which is exactly what
 * `{ ...parent, ...child }` would do to `colors`.
 */
export function resolveTheme(theme: ThemeDefinition, parent?: ThemeDefinition): ResolvedTheme {
  const tokens = new Map<string, unknown>();

  const load = (definition: ThemeDefinition): void => {
    for (const group of ["colors", "typography", "spacing", "radii", "shadows", "grid"] as const) {
      flatten(definition[group], group, tokens);
    }
    for (const group of ["chart", "diagram", "imagery", "motion"] as const) {
      if (definition[group]) flatten(definition[group], group, tokens);
    }
  };

  // Parent first so the child's tokens overwrite it key by key.
  if (parent) load(parent);
  load(theme);

  return {
    id: theme.id,
    name: theme.name,
    mode: theme.mode ?? parent?.mode ?? "light",
    tokens,
    source: theme,
    parent,
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
  let current: unknown = value;
  // A token may name another token: a role such as "On primary" is an alias of
  // a primitive (design review, 2026-09-27). Follow the chain a few steps; a
  // cycle or a dangling link falls back rather than drawing a token string.
  for (let depth = 0; depth < 8; depth += 1) {
    if (!isTokenRef(current)) return current as T;
    const path = tokenPath(current);
    const resolved =
      theme.tokens.get(path) ??
      resolveToken(theme.source, path) ??
      (theme.parent ? resolveToken(theme.parent, path) : undefined);
    if (resolved === undefined || resolved === null) return fallback;
    current = resolved;
  }
  return fallback;
}

/**
 * The theme a slide draws with: the deck's, or the deck's with a colour mode's
 * colours over it. Only colour tokens change, so every size, face and space is
 * the same in every mode.
 */
export function themeForMode(theme: ThemeDefinition, mode: string | undefined, parent?: ThemeDefinition): ResolvedTheme {
  const modes = (theme as { modes?: Record<string, { appearance?: "light" | "dark"; colors?: Record<string, unknown> }> }).modes;
  const chosen = mode ? modes?.[mode] : undefined;
  if (!chosen) return resolveTheme(theme, parent);
  return resolveTheme(
    {
      ...theme,
      mode: chosen.appearance ?? theme.mode,
      colors: { ...theme.colors, ...(chosen.colors ?? {}) } as ThemeDefinition["colors"],
    },
    parent,
  );
}

/** True when a string is a token reference the theme cannot resolve. */
export function isDanglingToken(theme: ResolvedTheme, value: unknown): boolean {
  if (!isTokenRef(value)) return false;
  const path = tokenPath(value);
  return (
    theme.tokens.get(path) === undefined &&
    resolveToken(theme.source, path) === undefined &&
    (!theme.parent || resolveToken(theme.parent, path) === undefined)
  );
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


/**
 * A Paint as a CSS value.
 *
 * Lives with theme resolution rather than in the scene builder because charts,
 * diagrams and the scene all need it, and three implementations of "what colour
 * is this fill" is three chances to disagree about a gradient.
 *
 * An unknown paint variant returns `undefined` rather than a guess: the schema
 * preserves it for a newer reader (doc 02 §0.8), and painting it wrong here
 * would be worse than leaving it unpainted.
 */
export function paintToCss(theme: ResolvedTheme, paint: unknown): string | undefined {
  if (!paint || typeof paint !== "object") return undefined;
  const p = paint as { type: string; color?: unknown; stops?: { offset: number; color: unknown }[]; angle?: number };

  switch (p.type) {
    case "none":
      return undefined;
    case "solid":
      return resolveValue<string>(theme, p.color);
    case "linearGradient": {
      const stops = (p.stops ?? [])
        .map((s) => `${resolveValue<string>(theme, s.color) ?? "transparent"} ${(s.offset * 100).toFixed(1)}%`)
        .join(", ");
      return `linear-gradient(${p.angle ?? 180}deg, ${stops})`;
    }
    case "radialGradient": {
      const stops = (p.stops ?? [])
        .map((s) => `${resolveValue<string>(theme, s.color) ?? "transparent"} ${(s.offset * 100).toFixed(1)}%`)
        .join(", ");
      return `radial-gradient(circle, ${stops})`;
    }
    default:
      // Unknown paint variants are preserved by the schema and skipped here rather
      // than painted wrong.
      return undefined;
  }
}

export { TOKEN_PREFIX };
