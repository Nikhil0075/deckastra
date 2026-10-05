/**
 * The Bauhaus palette is a set of promises, and this file keeps them.
 *
 * It reads `tokens.css` itself rather than a TypeScript copy of the values, so
 * there is one definition and a changed colour is checked the moment it is
 * changed. Three kinds of promise:
 *
 * 1. Every text/background pair the primitives actually use passes WCAG AA
 *    (4.5:1 for text, 3:1 for field outlines, which are non-text UI).
 * 2. Yellow is never a text colour — it fails on cream, which is why it only
 *    ever appears as a fill behind black.
 * 3. The component stylesheet reaches colours only through tokens and has no
 *    rounded corners except the status dot, which is a circle by definition.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(join(here, "../src/styles/tokens.css"), "utf8");
const componentsCss = readFileSync(join(here, "../src/styles/components.css"), "utf8");
const shellCss = readFileSync(join(here, "../src/styles/shell.css"), "utf8");
const presentCss = readFileSync(join(here, "../src/styles/present.css"), "utf8");
const decksCss = readFileSync(join(here, "../src/styles/decks.css"), "utf8");
/** Every stylesheet held to the discipline below. */
const STYLESHEETS: Array<[string, string]> = [
  ["components.css", componentsCss],
  ["shell.css", shellCss],
  ["present.css", presentCss],
  ["decks.css", decksCss],
];

function tokens(css: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of css.matchAll(/(--dk-[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1]!, match[2]!.trim());
  }
  return found;
}

/** The body of the first block whose selector is exactly `selector`. */
function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`tokens.css has no ${selector} block`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

/** Every token, as the light theme resolves it: the whole :root block. */
const TOKENS = tokens(block(tokensCss, ":root"));
/**
 * The dark theme: the light set with the dark block's overrides on top, which
 * is exactly what the cascade gives an element under `[data-dk-theme="dark"]`.
 */
const DARK_OVERRIDES = tokens(block(tokensCss, ':root[data-dk-theme="dark"]'));
const DARK = new Map([...TOKENS, ...DARK_OVERRIDES]);
const THEMES: Array<[string, Map<string, string>]> = [
  ["light", TOKENS],
  ["dark", DARK],
];

function hexIn(set: Map<string, string>, name: string): string {
  const value = set.get(name);
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a 6-digit hex colour: ${value}`);
  return value;
}

function hex(name: string): string {
  return hexIn(TOKENS, name);
}

function luminance(colour: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(colour.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe.each(THEMES)("palette contrast (%s)", (_theme, set) => {
  // [foreground, background] — the pairs components.css actually draws.
  const textPairs: Array<[string, string]> = [
    ["--dk-ink", "--dk-ground"],
    ["--dk-ink", "--dk-surface"],
    ["--dk-ink", "--dk-stage"],
    ["--dk-ink", "--dk-sunk"],
    ["--dk-ink-muted", "--dk-ground"],
    ["--dk-ink-muted", "--dk-surface"],
    ["--dk-ink-muted", "--dk-stage"],
    ["--dk-ink-muted", "--dk-sunk"],
    ["--dk-ink-inverse", "--dk-ink"],
    // The audience view: white text and rules on the slide backdrop.
    ["--dk-on-backdrop", "--dk-backdrop"],
    ["--dk-blue", "--dk-ground"],
    ["--dk-blue", "--dk-surface"],
    ["--dk-on-blue", "--dk-blue"],
    ["--dk-on-yellow", "--dk-yellow"],
    ["--dk-on-red", "--dk-red"],
    ["--dk-red", "--dk-ground"],
    ["--dk-red", "--dk-surface"],
    ["--dk-ochre", "--dk-ground"],
    ["--dk-ochre", "--dk-surface"],
    ["--dk-ochre", "--dk-sunk"],
  ];

  it.each(textPairs)("%s on %s passes AA for text (4.5:1)", (fg, bg) => {
    expect(contrast(hexIn(set, fg), hexIn(set, bg))).toBeGreaterThanOrEqual(4.5);
  });

  it("field outlines pass 3:1 against every surface a field sits on (WCAG 1.4.11)", () => {
    for (const bg of ["--dk-ground", "--dk-surface"]) {
      expect(contrast(hexIn(set, "--dk-rule-soft"), hexIn(set, bg)), bg).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("the dark set", () => {
  it("redefines only colours, and every one it redefines exists in the light set", () => {
    for (const name of DARK_OVERRIDES.keys()) {
      expect(TOKENS.has(name), `${name} is only in the dark set`).toBe(true);
    }
    // Structure is one design in two lights: no space, size or type token moves.
    expect([...DARK_OVERRIDES.keys()].filter((name) => !/^#|rgb/.test(DARK_OVERRIDES.get(name)!))).toEqual([]);
  });

  it("gives every colour token a dark value, so nothing is left light by omission", () => {
    const colours = [...TOKENS.entries()].filter(([, value]) => /^#|^rgb/.test(value)).map(([name]) => name);
    expect(colours.filter((name) => !DARK_OVERRIDES.has(name))).toEqual([]);
  });
});

/**
 * Tokens v1, frozen 2026-10-04 (roadmap 08 §1.2, rule 3). Until launch the set
 * may grow and may change value, and may not lose or rename a name: a rename is
 * a find-and-replace across both shells and every host stylesheet, and the one
 * place it is missed draws in the browser's default colour with nothing failing.
 * `tokens.v1.json` is the record; never regenerate it to make this pass.
 */
const FROZEN = JSON.parse(readFileSync(join(here, "../src/styles/tokens.v1.json"), "utf8")) as {
  light: string[];
  dark: string[];
};

describe("tokens v1 are frozen", () => {
  it("keeps every v1 name in the light set", () => {
    expect(FROZEN.light.filter((name) => !TOKENS.has(name))).toEqual([]);
  });

  it("keeps a dark value for every v1 colour that had one", () => {
    expect(FROZEN.dark.filter((name) => !DARK_OVERRIDES.has(name))).toEqual([]);
  });
});

describe("palette rules", () => {
  it("yellow would fail as text on cream, which is why it never is", () => {
    // If this ever passes, the rule below can be relaxed deliberately — not by accident.
    expect(contrast(hex("--dk-yellow"), hex("--dk-ground"))).toBeLessThan(4.5);
    for (const [name, css] of STYLESHEETS) {
      expect(css, name).not.toMatch(/(?<![-\w])color:\s*var\(--dk-yellow\)/);
    }
  });
});

describe.each(STYLESHEETS)("%s discipline", (_name, css) => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("uses no colour literals — every colour comes from a token", () => {
    expect(withoutComments).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(withoutComments).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  it("references only tokens that exist", () => {
    const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!));
    for (const name of used) {
      expect(name.startsWith("--dk-"), `${name} is a legacy token`).toBe(true);
      expect(TOKENS.has(name), `${name} is not defined in tokens.css`).toBe(true);
    }
  });

  it("has square corners everywhere except the status dot", () => {
    const rules = [...withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const rounded = rules
      .filter(([, , body]) =>
        [...body!.matchAll(/border-radius:\s*([^;]+);/g)].some(([, value]) => value!.trim() !== "0"),
      )
      .map(([, selector]) => selector!.trim());
    expect(rounded.filter((selector) => selector !== ".dk-dot")).toEqual([]);
  });
});
