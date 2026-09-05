import type { BrandRule, ThemeDefinition } from "@deckastra/presentation-schema";

import type { DocumentScene, SceneNode, SlideScene } from "./scene";
import { resolveValue, type ResolvedTheme } from "./theme";

/**
 * The semantic validation pass (doc 02 §42, doc 04 §33).
 *
 * `validateDocument` in the schema package checks what a document says. This
 * checks what it *renders as*, which is a different question and needs the
 * resolved scene: contrast between two tokens, whether text overflows its box at
 * the applied font size, how many distinct font sizes a slide actually uses.
 *
 * Those rules are marked `REQUIRES_RENDER_CONTEXT` in the rule catalog precisely
 * so they run here rather than being approximated earlier. This is what turns
 * "brand enforcement" from a paragraph an agent is handed into something that
 * fails a check.
 */

export interface SemanticIssue {
  /** A code from the schema's RULES catalog. */
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  slideId?: string;
  elementId?: string;
  /** Set when the fix is mechanical enough for a one-click repair. */
  suggestedFix?: string;
}

// ------------------------------------------------------------------- colour

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse the colour forms the renderer actually emits.
 *
 * Deliberately narrow: hex and rgb/rgba, which is what `paintToCss` produces
 * from a resolved token. Named CSS colours and gradients return `undefined`, and
 * an unparseable colour is skipped rather than guessed — reporting a contrast
 * failure against a colour nobody measured would be worse than reporting
 * nothing.
 */
export function parseColor(value: string | undefined): Rgb | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1]!;
    const expand = (part: string): number => parseInt(part.length === 1 ? part + part : part, 16);

    if (digits.length === 3 || digits.length === 4) {
      return { r: expand(digits[0]!), g: expand(digits[1]!), b: expand(digits[2]!) };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
      };
    }
    return undefined;
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return undefined;
    return { r: parts[0]!, g: parts[1]!, b: parts[2]! };
  }

  return undefined;
}

/** WCAG 2.1 relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const normalised = value / 255;
    return normalised <= 0.04045 ? normalised / 12.92 : ((normalised + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const light = Math.max(luminance(a), luminance(b));
  const dark = Math.min(luminance(a), luminance(b));
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

// ------------------------------------------------------------- theme checks

/**
 * Contrast pairs (W210).
 *
 * Declared on the theme so brand enforcement is mechanical rather than
 * heuristic. Checking pairs the theme itself names — rather than guessing which
 * text sits on which background — is what keeps this from producing a wall of
 * false positives that everyone learns to ignore.
 */
export function checkContrastPairs(theme: ResolvedTheme): SemanticIssue[] {
  const pairs = theme.source.contrastPairs ?? [];
  const issues: SemanticIssue[] = [];

  for (const pair of pairs) {
    const foreground = parseColor(
      resolveValue<string>(theme, `token:${pair.foreground}`) ?? pair.foreground,
    );
    const background = parseColor(
      resolveValue<string>(theme, `token:${pair.background}`) ?? pair.background,
    );

    if (!foreground || !background) {
      issues.push({
        code: "W210",
        severity: "warning",
        message: `Contrast pair ${pair.foreground} on ${pair.background} could not be measured; one of them is not a plain colour.`,
      });
      continue;
    }

    const ratio = contrastRatio(foreground, background);
    if (ratio < pair.minimumRatio) {
      issues.push({
        code: "W210",
        severity: "warning",
        message: `${pair.foreground} on ${pair.background} is ${ratio}:1, below the theme's required ${pair.minimumRatio}:1.`,
        suggestedFix: `Darken or lighten ${pair.foreground} until it reaches ${pair.minimumRatio}:1.`,
      });
    }
  }

  return issues;
}

// ------------------------------------------------------------- brand checks

function textNodes(nodes: SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (list: SceneNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Brand rules that carry a `check` (doc 02 §22.7).
 *
 * Rules without one are prompt context for the Creative Director and the Critic,
 * and are deliberately not evaluated here — inventing an interpretation of a
 * prose rule would produce confident nonsense.
 */
export function checkBrandRules(
  slide: SlideScene,
  rules: readonly BrandRule[],
  theme: ThemeDefinition,
): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const nodes = textNodes(slide.nodes);

  for (const rule of rules) {
    if (!rule.check) continue;
    const severity: SemanticIssue["severity"] = rule.kind === "should" ? "info" : "warning";

    switch (rule.check.type) {
      case "maxFontSizesPerSlide": {
        const sizes = new Set(
          nodes
            .filter((node) => node.renderPayload.kind === "text")
            .map((node) =>
              node.renderPayload.kind === "text" ? node.renderPayload.metrics.appliedFontSize : 0,
            ),
        );
        if (sizes.size > rule.check.value) {
          issues.push({
            code: "W211",
            severity,
            slideId: slide.slideId,
            message: `${rule.statement} — this slide uses ${sizes.size} font sizes (${[...sizes]
              .sort((a, b) => a - b)
              .join(", ")}).`,
          });
        }
        break;
      }

      case "allowedFontFamilies": {
        const allowed = new Set(rule.check.value.map((family) => family.toLowerCase()));
        for (const node of nodes) {
          const payload = node.renderPayload;
          if (payload.kind !== "text") continue;
          // The scene carries the full stack; the requested family is its head.
          const family = String(payload.typography.fontFamily ?? "")
            .split(",")[0]!
            .trim()
            .replace(/^["']|["']$/g, "");
          if (family && !allowed.has(family.toLowerCase())) {
            issues.push({
              code: "W212",
              severity,
              slideId: slide.slideId,
              elementId: node.id,
              message: `${rule.statement} — "${family}" is not in the allowed set.`,
              suggestedFix: `Use ${rule.check.value[0]}.`,
            });
          }
        }
        break;
      }

      case "minContrastRatio": {
        const background = parseColor(slide.background?.color);
        if (!background) break;

        for (const node of nodes) {
          const payload = node.renderPayload;
          if (payload.kind !== "text") continue;
          const foreground = parseColor(String(payload.typography.color ?? ""));
          if (!foreground) continue;

          const ratio = contrastRatio(foreground, background);
          if (ratio < rule.check.value) {
            issues.push({
              code: "W210",
              severity,
              slideId: slide.slideId,
              elementId: node.id,
              message: `${rule.statement} — this text is ${ratio}:1 against the slide background.`,
            });
          }
        }
        break;
      }

      case "forbiddenColorLiterals": {
        if (!rule.check.value) break;
        // Every token resolves to a literal by the time it reaches the scene, so
        // the document is the only place this can be checked honestly. Flagging
        // resolved values here would report every slide.
        break;
      }

      case "maxTextDensity": {
        const characters = nodes.reduce((sum, node) => {
          const payload = node.renderPayload;
          if (payload.kind !== "text") return sum;
          return (
            sum +
            payload.blocks.reduce(
              (blockSum, block) =>
                blockSum + block.spans.reduce((spanSum, span) => spanSum + span.text.length, 0),
              0,
            )
          );
        }, 0);

        if (characters > rule.check.value) {
          issues.push({
            code: "W213",
            severity,
            slideId: slide.slideId,
            message: `${rule.statement} — this slide carries ${characters} characters.`,
          });
        }
        break;
      }

      case "requiredElements": {
        const present = new Set(nodes.map((node) => node.semanticRole).filter(Boolean));
        const missing = rule.check.value.filter((role) => !present.has(role));
        if (missing.length > 0) {
          issues.push({
            code: "W214",
            severity,
            slideId: slide.slideId,
            message: `${rule.statement} — missing ${missing.join(", ")}.`,
          });
        }
        break;
      }

      case "logoPlacement": {
        const logo = nodes.find((node) => node.semanticRole === "logo");
        if (!logo) break;
        if (Math.min(logo.bounds.width, logo.bounds.height) < rule.check.value.minSize) {
          issues.push({
            code: "W215",
            severity,
            slideId: slide.slideId,
            elementId: logo.id,
            message: `${rule.statement} — the logo is smaller than ${rule.check.value.minSize}px.`,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  // Theme is accepted for symmetry with the document-level checks and to keep
  // the signature stable as rules start needing token lookups.
  void theme;
  return issues;
}

// ---------------------------------------------------------------- render pass

/**
 * Every rule that needs a resolved scene, in one pass.
 *
 * Overflow (W103) is included because the applied font size is only known after
 * fit resolution, and because it is the single most common thing wrong with a
 * generated slide.
 */
export function validateScene(scene: DocumentScene): SemanticIssue[] {
  const issues: SemanticIssue[] = [...checkContrastPairs(scene.theme)];
  const rules = scene.theme.source.brandRules ?? [];

  for (const slide of scene.slides) {
    for (const node of textNodes(slide.nodes)) {
      if (node.flags.overflow) {
        issues.push({
          code: "W103",
          severity: "warning",
          slideId: slide.slideId,
          elementId: node.id,
          message: `Text overflows its box${
            node.renderPayload.kind === "text"
              ? ` at ${node.renderPayload.metrics.appliedFontSize}px`
              : ""
          }.`,
          suggestedFix: "Set fit to shrinkToFit, enlarge the box, or shorten the text.",
        });
      }

      if (node.flags.outOfBounds) {
        issues.push({
          code: "W104",
          severity: "warning",
          slideId: slide.slideId,
          elementId: node.id,
          message: "This element extends outside the slide.",
        });
      }
    }

    issues.push(...checkBrandRules(slide, rules, scene.theme.source));
  }

  // A font that fell back changes every measurement on the slide, so it is
  // reported once for the deck rather than buried per element.
  for (const usage of scene.fonts) {
    if (!usage.resolved) {
      issues.push({
        code: "W250",
        severity: "warning",
        message: `"${usage.family}" is not available; rendered with ${usage.substitute}. Text metrics will differ from a machine that has it.`,
      });
    }
  }

  return issues;
}
