import {
  resolveToken,
  walkElements,
  type PresentationDocument,
  type PresentationElement,
  type ThemeDefinition,
} from "@deckastra/presentation-schema";

export type AccessibilitySeverity = "error" | "warning";

export interface AccessibilityIssue {
  code: "missing-alt-text" | "low-theme-contrast";
  severity: AccessibilitySeverity;
  message: string;
  fix: string;
  slideId?: string;
  elementId?: string;
}

const VISUAL_TYPES = new Set(["image", "chart", "diagram"]);

/** Meaningful objects in the order assistive technology should encounter them. */
export function readingOrder(elements: readonly PresentationElement[]): PresentationElement[] {
  return [...walkElements(elements)]
    .map(({ element }) => element)
    .filter((element) =>
      element.visible !== false &&
      element.semanticRole !== "decoration" &&
      element.type !== "group" &&
      element.type !== "line",
    );
}

export function altTextFor(element: PresentationElement): string {
  if (element.type === "image" || element.type === "chart") {
    const value = (element as { altText?: unknown }).altText;
    return typeof value === "string" ? value.trim() : "";
  }
  const value = element.metadata?.altText;
  return typeof value === "string" ? value.trim() : "";
}

export function altTextProperty(element: PresentationElement): "altText" | "metadata.altText" {
  return element.type === "image" || element.type === "chart" ? "altText" : "metadata.altText";
}

export function needsAltText(element: PresentationElement): boolean {
  return VISUAL_TYPES.has(element.type) && element.semanticRole !== "decoration";
}

export function auditAccessibility(document: PresentationDocument): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];

  for (const slide of document.slides) {
    for (const element of readingOrder(slide.elements)) {
      if (needsAltText(element) && !altTextFor(element)) {
        issues.push({
          code: "missing-alt-text",
          severity: "error",
          slideId: slide.id,
          elementId: element.id,
          message: `${element.name ?? labelFor(element)} has no alternative text.`,
          fix: "Describe the information this visual contributes, or mark it as decoration.",
        });
      }
    }
  }

  for (const pair of document.theme.contrastPairs ?? []) {
    const foreground = resolveThemeColor(document.theme, pair.foreground);
    const background = resolveThemeColor(document.theme, pair.background);
    if (!foreground || !background) continue;
    const ratio = contrastRatio(foreground, background);
    if (ratio + 0.005 < pair.minimumRatio) {
      issues.push({
        code: "low-theme-contrast",
        severity: "error",
        message: `${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1.`,
        fix: `Adjust the theme colors to reach at least ${pair.minimumRatio.toFixed(1)}:1.`,
      });
    }
  }

  return issues;
}

function labelFor(element: PresentationElement): string {
  return `${element.type} ${element.id.slice(3, 11)}`;
}

function resolveThemeColor(theme: ThemeDefinition, path: string): Rgba | null {
  const value = resolveToken(theme, path);
  if (typeof value !== "string") return null;
  return parseColor(value);
}

interface Rgba { r: number; g: number; b: number; a: number }

function parseColor(value: string): Rgba | null {
  const hex = value.match(/^#([0-9a-f]{3,8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 || hex.length === 4
      ? [...hex].map((part) => part + part).join("")
      : hex;
    if (expanded.length !== 6 && expanded.length !== 8) return null;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d*(?:\.\d+)?))?\s*\)$/i);
  if (!rgb) return null;
  return {
    r: clamp(Number(rgb[1]), 0, 255), g: clamp(Number(rgb[2]), 0, 255),
    b: clamp(Number(rgb[3]), 0, 255), a: clamp(rgb[4] === undefined ? 1 : Number(rgb[4]), 0, 1),
  };
}

/** WCAG contrast after compositing a translucent foreground onto its background. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const composite = {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
  };
  const lighter = Math.max(luminance(composite), luminance(background));
  const darker = Math.min(luminance(composite), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: Pick<Rgba, "r" | "g" | "b">): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
