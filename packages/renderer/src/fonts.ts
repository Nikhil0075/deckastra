/**
 * Font handling (doc 04 §18).
 *
 * Three things live here, and the third is the one that is easy to miss.
 *
 * 1. **A curated set.** A deck may name any family, but only these are known to
 *    be present wherever the renderer runs, which is what makes a render
 *    reproducible outside the machine that made it.
 * 2. **Metric-matched fallbacks.** When a family is missing, the substitute is
 *    chosen for similar advance width and cap height rather than by CSS's
 *    "whatever is next in the list". A fallback with a different advance reflows
 *    every text box on the slide.
 * 3. **Availability is a determinism input.** Two renders of the same document
 *    are only comparable if the same fonts were available to both. The scene
 *    therefore records which families resolved and which fell back, and that
 *    record participates in the render digest — otherwise a visual-regression
 *    failure caused by a missing font is indistinguishable from a code
 *    regression, and someone spends an afternoon on it.
 */

export type FontCategory = "sans" | "serif" | "mono";

export interface FontMetrics {
  /** Mean advance width as a fraction of font size. Drives the text estimator. */
  averageAdvance: number;
  /** Cap height as a fraction of font size. Used for optical vertical centring. */
  capHeight: number;
  /** Default line height when the document does not state one. */
  lineHeight: number;
}

export interface CuratedFont {
  family: string;
  category: FontCategory;
  metrics: FontMetrics;
  /** Families to try, in order, before the generic category. Metric-matched. */
  fallbacks: string[];
  /** Weights the renderer will request. Asking for a weight a face lacks makes
   *  the browser synthesise it, which looks wrong and measures wrong. */
  weights: number[];
}

/**
 * The curated set.
 *
 * Small on purpose. Every family here is either a system font on the major
 * platforms or one the render service ships, so "the font was missing" is a
 * reportable condition rather than the normal case. Adding a family means
 * shipping it to the export service too — that is the cost, and it is why this
 * list does not grow casually.
 */
const CURATED: CuratedFont[] = [
  {
    family: "Inter",
    category: "sans",
    metrics: { averageAdvance: 0.515, capHeight: 0.727, lineHeight: 1.35 },
    fallbacks: ["Helvetica Neue", "Arial", "Roboto", "Segoe UI"],
    weights: [400, 500, 600, 700],
  },
  {
    family: "Söhne",
    category: "sans",
    metrics: { averageAdvance: 0.52, capHeight: 0.72, lineHeight: 1.35 },
    fallbacks: ["Inter", "Helvetica Neue", "Arial"],
    weights: [400, 500, 600, 700],
  },
  {
    family: "Helvetica Neue",
    category: "sans",
    metrics: { averageAdvance: 0.513, capHeight: 0.717, lineHeight: 1.32 },
    fallbacks: ["Helvetica", "Arial"],
    weights: [400, 500, 700],
  },
  {
    family: "Arial",
    category: "sans",
    metrics: { averageAdvance: 0.52, capHeight: 0.716, lineHeight: 1.32 },
    fallbacks: ["Helvetica", "Liberation Sans"],
    weights: [400, 700],
  },
  {
    family: "Segoe UI",
    category: "sans",
    metrics: { averageAdvance: 0.505, capHeight: 0.7, lineHeight: 1.36 },
    fallbacks: ["Inter", "Arial"],
    weights: [400, 600, 700],
  },
  {
    family: "Georgia",
    category: "serif",
    metrics: { averageAdvance: 0.545, capHeight: 0.692, lineHeight: 1.4 },
    fallbacks: ["Times New Roman", "Liberation Serif"],
    weights: [400, 700],
  },
  {
    family: "Times New Roman",
    category: "serif",
    metrics: { averageAdvance: 0.494, capHeight: 0.662, lineHeight: 1.38 },
    fallbacks: ["Liberation Serif", "Georgia"],
    weights: [400, 700],
  },
  {
    family: "JetBrains Mono",
    category: "mono",
    metrics: { averageAdvance: 0.6, capHeight: 0.73, lineHeight: 1.5 },
    fallbacks: ["SF Mono", "Menlo", "Consolas", "Liberation Mono"],
    weights: [400, 500, 700],
  },
  {
    family: "Consolas",
    category: "mono",
    metrics: { averageAdvance: 0.55, capHeight: 0.719, lineHeight: 1.5 },
    fallbacks: ["Menlo", "Liberation Mono"],
    weights: [400, 700],
  },
  {
    family: "Menlo",
    category: "mono",
    metrics: { averageAdvance: 0.602, capHeight: 0.729, lineHeight: 1.5 },
    fallbacks: ["Consolas", "Liberation Mono"],
    weights: [400, 700],
  },
];

const BY_FAMILY = new Map(CURATED.map((font) => [font.family.toLowerCase(), font]));

export const CURATED_FONTS: readonly CuratedFont[] = CURATED;
export const CURATED_FAMILIES = CURATED.map((font) => font.family);

const GENERIC: Record<FontCategory, string> = {
  sans: "ui-sans-serif, system-ui, sans-serif",
  serif: "ui-serif, Georgia, serif",
  mono: "ui-monospace, SFMono-Regular, monospace",
};

/**
 * Metrics for a family, curated or not.
 *
 * An unknown family gets its category's metrics rather than a hard failure. The
 * estimate will be a little off, which is exactly what `metricsEstimated` on the
 * scene exists to communicate.
 */
export function fontMetrics(family: string | undefined): FontMetrics {
  const known = family ? BY_FAMILY.get(normalise(family)) : undefined;
  if (known) return known.metrics;

  const category = guessCategory(family);
  return (
    BY_FAMILY.get(category === "mono" ? "jetbrains mono" : category === "serif" ? "georgia" : "inter")!
      .metrics
  );
}

function normalise(family: string): string {
  // A document may carry a full CSS stack; the first name is the request.
  return family.split(",")[0]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

function guessCategory(family: string | undefined): FontCategory {
  if (!family) return "sans";
  const name = normalise(family);
  if (/mono|code|courier|consol|menlo/.test(name)) return "mono";
  if (/serif|georgia|times|garamond|charter|book/.test(name) && !/sans/.test(name)) return "serif";
  return "sans";
}

/**
 * The CSS font stack for a requested family.
 *
 * Fallbacks come from the curated entry when there is one, so a substitution is
 * metric-matched rather than alphabetical. An unknown family still gets its
 * generic category appended, because a stack that ends in a specific name has no
 * answer when that name is also missing.
 */
export function resolveFontStack(family: string | undefined): string {
  if (!family) return GENERIC.sans;

  const requested = family.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
  const known = BY_FAMILY.get(requested.toLowerCase());
  const category = known?.category ?? guessCategory(family);
  const chain = known ? known.fallbacks : [];

  const quote = (name: string): string => (/[^A-Za-z0-9-]/.test(name) ? `"${name}"` : name);

  return [quote(requested), ...chain.map(quote), GENERIC[category]].join(", ");
}

// ------------------------------------------------------------- availability

export interface FontAvailability {
  /** Families the host reported as present. */
  available: ReadonlySet<string>;
  /** True when the host could not be asked — Node, or a browser without the API. */
  unknown: boolean;
}

export interface FontUsage {
  family: string;
  /** False when the family is missing and a metric-matched substitute is used. */
  resolved: boolean;
  substitute?: string;
}

/**
 * Ask the host which families are present.
 *
 * `document.fonts.check` is the only reliable answer in a browser, and there is
 * no answer at all in Node — which is *not* a failure. The headless renderer
 * installs the curated set, so "unknown" there means "assume curated", and the
 * report says so rather than claiming knowledge it does not have.
 */
export function detectFontAvailability(): FontAvailability {
  const fonts = (globalThis as { document?: { fonts?: { check(font: string): boolean } } }).document
    ?.fonts;

  if (!fonts || typeof fonts.check !== "function") {
    return { available: new Set(), unknown: true };
  }

  const available = new Set<string>();
  for (const font of CURATED) {
    try {
      if (fonts.check(`16px "${font.family}"`)) available.add(font.family);
    } catch {
      // A malformed shorthand throws in some engines; treat it as unavailable
      // rather than aborting the whole probe.
    }
  }

  return { available, unknown: false };
}

/**
 * What each requested family resolved to.
 *
 * This is the record that makes a font-caused visual diff explicable. Without
 * it, a snapshot failure on a machine missing one face looks exactly like a
 * regression in the layout code.
 */
export function describeFontUsage(
  families: readonly string[],
  availability: FontAvailability,
): FontUsage[] {
  const unique = [...new Set(families.map((family) => family.split(",")[0]!.trim()))].sort();

  return unique.map((family) => {
    if (availability.unknown) return { family, resolved: true };

    if (availability.available.has(family)) return { family, resolved: true };

    const known = BY_FAMILY.get(family.toLowerCase());
    const substitute = known?.fallbacks.find((candidate) => availability.available.has(candidate));

    return {
      family,
      resolved: false,
      substitute: substitute ?? GENERIC[known?.category ?? guessCategory(family)],
    };
  });
}

/**
 * A stable digest of the font situation, for inclusion in a render digest.
 *
 * Deliberately a plain string rather than a hash: when a visual test fails, the
 * useful output is "Inter was missing", not a hex value someone has to look up.
 */
export function fontDigest(usage: readonly FontUsage[]): string {
  return usage
    .map((entry) => (entry.resolved ? entry.family : `${entry.family}->${entry.substitute}`))
    .join("|");
}
