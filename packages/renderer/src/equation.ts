/**
 * Typesetting an equation (Design tab review, 2026-09-26).
 *
 * KaTeX, because it is a pure function of its input: the same LaTeX gives the
 * same markup in Node, in the editor and in the render host, so an equation is
 * typeset in the scene build like every other piece of geometry and the React
 * layer only inserts it. It emits MathML beside the visual markup, which is what
 * a screen reader reads.
 *
 * The source is a document someone else may have written, so KaTeX runs with
 * everything that reaches outside the maths turned off: `trust: false` refuses
 * `\href`, `\url`, `\includegraphics` and the HTML-attribute commands, and the
 * expansion and size limits stop a short source from asking for a great deal of
 * work on every open.
 */

import katex from "katex";

export interface TypesetEquation {
  html: string;
  /** Why the source could not be typeset; the markup then shows it in red. */
  error?: string;
}

const OPTIONS = {
  output: "htmlAndMathml" as const,
  trust: false,
  strict: "ignore" as const,
  maxExpand: 500,
  maxSize: 40,
  throwOnError: true,
};

/** Bounded: a deck has few equations, and an editor retypesets one per keystroke. */
const cache = new Map<string, TypesetEquation>();
const CACHE_LIMIT = 256;

export function typesetEquation(latex: string, display: boolean): TypesetEquation {
  const key = `${display ? "D" : "I"}${latex}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let result: TypesetEquation;
  try {
    result = { html: katex.renderToString(latex, { ...OPTIONS, displayMode: display }) };
  } catch (error) {
    // The same source again with errors drawn rather than thrown, so the box
    // shows what was typed, in red, where the equation should be.
    const message = error instanceof Error ? error.message.replace(/^KaTeX parse error:\s*/, "") : String(error);
    let html: string;
    try {
      html = katex.renderToString(latex, { ...OPTIONS, displayMode: display, throwOnError: false });
    } catch {
      html = "";
    }
    result = { html, error: message };
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, result);
  return result;
}
