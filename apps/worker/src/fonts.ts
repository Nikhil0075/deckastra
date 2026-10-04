/**
 * The fonts a render page declares (Design tab review, 2026-09-26).
 *
 * The render host has no network and the product's bundled families are not
 * installed on anyone's machine, so every face a deck uses is handed to the
 * page as a `data:` URL — the one scheme `render-page.ts` lets through. Two
 * sources, one stylesheet:
 *
 * - **Bundled** families the deck names (`BUNDLED_FONTS`), read from the same
 *   Fontsource stylesheets the editor imports, so an export draws the exact
 *   files the author saw. Only the Latin and Latin Extended subsets are
 *   embedded; a face is still declared in full, but a PDF of a deck in Greek
 *   would draw those glyphs in the fallback, as the degradation report would
 *   say if it could know — it cannot, which is written here instead.
 * - **Uploaded** faces the deck carries in its asset manifest, from the bytes
 *   the API handed the `AssetLibrary`.
 *
 * Declared once in the page head. `SlideView` would otherwise declare uploaded
 * faces once per slide, and a sixty-slide PDF page is one HTML string: sixty
 * copies of a megabyte font is a page Chromium parses slowly for nothing.
 *
 * In a checkout the stylesheets resolve through `node_modules`. A packaged app
 * has none, so the desktop build copies the same files and names the directory
 * in `DECKASTRA_FONTS_DIR` — the same arrangement as `DECKASTRA_MEASURER_JS`.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { ExportWarning } from "@deckastra/export-core";
import { localeScript, sourceLocale, type PresentationDocument } from "@deckastra/presentation-schema";
import { BUNDLED_FONTS, SCRIPT_FALLBACKS, bundledFont, type BundledFont } from "@deckastra/renderer";

import type { AssetLibrary } from "./assets";


/** Every family name a document asks for, from any `fontFamily` anywhere in it. */
export function requestedFamilies(document: PresentationDocument): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "fontFamily" && typeof inner === "string" && !inner.startsWith("token:")) {
        for (const part of inner.split(",")) {
          const name = part.trim().replace(/^["']|["']$/g, "");
          if (name) names.add(name);
        }
      } else {
        walk(inner);
      }
    }
  };
  walk(document);
  return names;
}

/** The bundled families a document uses, in library order so the stylesheet is byte-stable. */
export function bundledFamiliesUsed(document: PresentationDocument): BundledFont[] {
  // Inter is the page's own default (`pageStyles`), so it is always there.
  const used = new Set<string>(["Inter"]);
  for (const name of requestedFamilies(document)) {
    const font = bundledFont(name);
    if (font) used.add(font.family);
  }
  // The faces that draw the deck's language: the scene's font stack names them
  // after the brand face (`SCRIPT_FALLBACKS`), so the render page must declare
  // them or the fallback lands on whatever the render host has (plan 01 §3.9).
  const script = localeScript(sourceLocale(document));
  for (const face of SCRIPT_FALLBACKS[script] ?? []) {
    const font = bundledFont(face);
    if (font) used.add(font.family);
  }
  return BUNDLED_FONTS.filter((font) => used.has(font.family));
}

const cache = new Map<string, Promise<string>>();

function stylesheetPath(css: string): string {
  const root = process.env.DECKASTRA_FONTS_DIR;
  if (root) return join(root, css);
  return createRequire(import.meta.url).resolve(css);
}

/**
 * The static package beside a family's variable one: `@fontsource-variable/x`
 * → `@fontsource/x`, one stylesheet per weight (`400.css`). A family that only
 * ships static is its own (`@fontsource/mukta/index.css` → `@fontsource/mukta`).
 */
export function staticPackage(font: BundledFont): string {
  return font.css.replace("@fontsource-variable/", "@fontsource/").replace(/\/[^/]+\.css$/, "");
}

/**
 * The weights a document draws in: regular and bold always (a bold span needs
 * no `fontWeight` to be bold), and every weight it names. Snapped to the
 * hundreds a static family is cut at.
 */
export function documentWeights(document: PresentationDocument): number[] {
  const weights = new Set<number>([400, 700]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "fontWeight") {
        const weight = inner === "bold" ? 700 : inner === "normal" ? 400 : Number(inner);
        if (Number.isFinite(weight)) weights.add(Math.min(900, Math.max(100, Math.round(weight / 100) * 100)));
      } else {
        walk(inner);
      }
    }
  };
  walk(document);
  return [...weights].sort((a, b) => a - b);
}

async function readFaces(path: string, font: BundledFont, rename: boolean): Promise<string[]> {
  const source = await readFile(path, "utf8");
  // Latin always; a script face's own script too (integration plan 01
  // §3.9) — a Hindi PDF must carry the Devanagari file, not only the Latin.
  const wanted = new RegExp(`-(latin|latin-ext${(font.subsets ?? []).map((subset) => `|${subset}`).join("")})-`);
  const blocks = source.split(/(?=\/\*)/).filter((block) => wanted.test(block.split("*/")[0] ?? ""));
  const rules: string[] = [];
  for (const block of blocks) {
    const match = /url\(\.\/([^)]+\.woff2)\)/.exec(block);
    if (!match) continue;
    const bytes = await readFile(join(dirname(path), match[1]!));
    const data = `data:font/woff2;base64,${bytes.toString("base64")}`;
    let rule = block
      .slice(block.indexOf("@font-face"))
      // woff2 only: the woff beside it is never needed by Chromium.
      .replace(/src:[^;]*;/, `src: url(${data}) format('woff2');`)
      // `swap` draws the fallback first; a capture must wait for the face.
      .replace(/font-display:\s*swap/, "font-display: block")
      .trim();
    // Under the face name the scene's font stacks already use, so the static
    // file stands exactly where the variable one did.
    if (rename) rule = rule.replace(/font-family:\s*'[^']*'/, `font-family: '${font.face}'`);
    rules.push(rule);
  }
  return rules;
}

/**
 * One bundled family's `@font-face` rules for the render page, files inlined.
 *
 * **Static files, not the variable ones the editor draws with** (plan 01
 * recheck, 2026-10-03). Chromium's PDF backend embeds a variable font as
 * Type3, whose character map is only the font's reverse cmap: every glyph
 * shaping made that the cmap does not name — a reordered Devanagari vowel
 * sign, Arabic contextual forms and ligatures — came out of a copy or a search
 * as U+0000, and Latin lost its spaces. The same text in a static TrueType is
 * embedded as Type0 and reads back whole. Fontsource's static files are cut
 * from the same sources at each weight, so the metrics at a weight match and
 * nothing moves. A weight the family is not cut at takes the nearest one; a
 * family with no static package at all keeps its variable file.
 */
export function bundledFontCss(font: BundledFont, weights: readonly number[] = [400, 700]): Promise<string> {
  const key = `${font.family}:${weights.join(",")}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const pkg = staticPackage(font);
      const available: number[] = [];
      for (const weight of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
        try {
          await readFile(stylesheetPath(`${pkg}/${weight}.css`), "utf8");
          available.push(weight);
        } catch {
          // Not cut at this weight.
        }
      }
      if (available.length) {
        const chosen = [...new Set(weights.map((weight) => available.reduce((best, one) => (Math.abs(one - weight) < Math.abs(best - weight) ? one : best))))];
        const rules: string[] = [];
        for (const weight of chosen) rules.push(...(await readFaces(stylesheetPath(`${pkg}/${weight}.css`), font, true)));
        return rules.join("\n");
      }
      return (await readFaces(stylesheetPath(font.css), font, false)).join("\n");
    })();
    // A failed read is not cached: the next export tries again.
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}

/** KaTeX's stylesheet, as the package ships it; its fonts sit beside it in `fonts/`. */
export const EQUATION_STYLESHEET = "katex/dist/katex.min.css";

let equationStyles: Promise<string> | undefined;

/** Whether any slide carries an equation, anywhere in its tree. */
export function hasEquation(document: PresentationDocument): boolean {
  const walk = (elements: readonly unknown[] | undefined): boolean =>
    (elements ?? []).some((element) => {
      const node = element as { type?: string; children?: unknown[] };
      return node.type === "equation" || walk(node.children);
    });
  return document.slides.some((slide) => walk(slide.elements as unknown[]));
}

/**
 * KaTeX's rules with its fonts inlined, woff2 only. Loaded only for a deck
 * that has an equation: the stylesheet and its twenty faces are the better part
 * of a megabyte, and a page that declares them is a page Chromium parses.
 */
export function equationCss(): Promise<string> {
  if (!equationStyles) {
    equationStyles = (async () => {
      const path = stylesheetPath(EQUATION_STYLESHEET);
      const source = await readFile(path, "utf8");
      const files = [...new Set([...source.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map((match) => match[1]!))];
      const inlined = new Map<string, string>();
      for (const file of files) {
        inlined.set(file, (await readFile(join(dirname(path), "fonts", file))).toString("base64"));
      }
      return source.replace(
        /src:url\(fonts\/([^)]+\.woff2)\) format\("woff2"\)[^;}]*/g,
        (_rule, file: string) => `src:url(data:font/woff2;base64,${inlined.get(file)}) format("woff2")`,
      );
    })();
    equationStyles.catch(() => {
      equationStyles = undefined;
    });
  }
  return equationStyles;
}

/** The deck's uploaded faces, from the bytes the library accepted. */
export function uploadedFontCss(document: PresentationDocument, library: AssetLibrary): string {
  const rules: string[] = [];
  for (const asset of document.assets ?? []) {
    const font = asset as { type?: string; id: string; storageKey?: string; fontFamily?: string; fontWeight?: number | string; fontStyle?: string };
    if (font.type !== "font" || !font.fontFamily) continue;
    const url = library.resolve(font.id, font.storageKey);
    if (!url) continue;
    const weight = /^\d{1,4}( \d{1,4})?$/.test(String(font.fontWeight ?? "")) ? String(font.fontWeight) : "100 900";
    rules.push(
      `@font-face{font-family:"${font.fontFamily.replace(/["\\\n]/g, "")}";src:url("${url}");` +
        `font-weight:${weight};font-style:${font.fontStyle === "italic" ? "italic" : "normal"};font-display:block}`,
    );
  }
  return rules.join("\n");
}

/**
 * Everything a render page for this deck declares. A bundled family whose files
 * cannot be read is left out rather than failing the export: the text draws in
 * the fallback, which is what a missing font has always meant here.
 */
export async function pageFontCss(document: PresentationDocument, library: AssetLibrary): Promise<string> {
  const parts: string[] = [];
  const weights = documentWeights(document);
  for (const font of bundledFamiliesUsed(document)) {
    try {
      parts.push(await bundledFontCss(font, weights));
    } catch {
      // Named in the scene's font digest as unavailable, which the report reads.
    }
  }
  if (hasEquation(document)) {
    try {
      parts.push(await equationCss());
    } catch {
      // The equation then draws in the page's text face, still legible.
    }
  }
  parts.push(uploadedFontCss(document, library));
  return parts.filter(Boolean).join("\n");
}

/**
 * A `.pptx` names its fonts and does not carry them: PowerPoint substitutes a
 * family the recipient's machine lacks. Said per family, before download,
 * because a deck set in Playfair arriving in Calibri looks like a broken export
 * when it is a missing install.
 */
export function fontsNotEmbedded(document: PresentationDocument): ExportWarning[] {
  const requested = requestedFamilies(document);
  const families = BUNDLED_FONTS.filter((font) => [...requested].some((name) => bundledFont(name) === font)).map(
    (font) => font.family,
  );
  for (const asset of document.assets ?? []) {
    const family = (asset as { type?: string; fontFamily?: string }).type === "font" ? (asset as { fontFamily?: string }).fontFamily : undefined;
    if (family && !families.includes(family)) families.push(family);
  }
  return families.map((family) => ({
    severity: "info" as const,
    slideId: "",
    feature: `font:${family}`,
    action: "approximated" as const,
    message: `The font "${family}" is named in the PowerPoint file but not embedded. A computer without it installed shows a substitute.`,
  }));
}
