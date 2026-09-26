import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { newId, validateDocument } from "@deckastra/presentation-schema";
import { expect, it } from "vitest";

import { buildDocumentScene, documentDigest, typesetEquation } from "../src/index";
import { SlideView } from "../src/react/index";

/** Equations (Design tab review, 2026-09-26): typeset in the scene, drawn as given. */

function deckWith(latex: string, extra: Record<string, unknown> = {}) {
  const document = structuredClone(loadFixture("technical"));
  const id = newId("el");
  document.slides[0]!.elements.push({
    id,
    type: "equation",
    latex,
    transform: { x: 100, y: 100, width: 600, height: 160 },
    ...extra,
  } as never);
  return { document, id };
}

it("is a valid element, typeset into the scene with MathML beside the drawing", () => {
  const { document, id } = deckWith(String.raw`E = mc^2`);
  expect(validateDocument(document).errors).toEqual([]);
  const node = buildDocumentScene(document).slides[0]!.nodes.find((one) => one.id === id)!;
  expect(node.renderPayload).toMatchObject({ kind: "equation", display: true, align: "center" });
  const payload = node.renderPayload as { html: string; error?: string };
  expect(payload.error).toBeUndefined();
  // The accessible form a screen reader reads.
  expect(payload.html).toContain("<math");
  expect(payload.html).toContain("katex-display");

  const markup = renderToStaticMarkup(<SlideView scene={buildDocumentScene(document).slides[0]!} mode="export" />);
  expect(markup).toContain('class="deckastra-equation"');
  expect(markup).toContain("katex");
});

it("names a source that does not typeset, and still draws what was typed", () => {
  const { document, id } = deckWith(String.raw`\frac{1}{`);
  const node = buildDocumentScene(document).slides[0]!.nodes.find((one) => one.id === id)!;
  const payload = node.renderPayload as { html: string; error?: string };
  expect(payload.error).toMatch(/expected/i);
  expect(payload.html).toContain("katex-error");
  expect(documentDigest(buildDocumentScene(document))).toContain(" error");
});

it("refuses the commands that reach outside the maths", () => {
  // `trust: false`: a deck is a document someone else wrote.
  for (const latex of [String.raw`\href{https://example.com}{x}`, String.raw`\url{https://example.com}`, String.raw`\includegraphics{a.png}`, String.raw`\htmlClass{x}{y}`]) {
    const result = typesetEquation(latex, true);
    expect(result.html, latex).not.toContain("example.com\"");
    expect(result.html, latex).not.toMatch(/<a |<img /);
  }
});

it("digests a change to the source even when its length does not change", () => {
  const a = documentDigest(buildDocumentScene(deckWith("a+b").document));
  const b = documentDigest(buildDocumentScene(deckWith("a-b").document));
  const line = (digest: string) => digest.split("\n").find((one) => one.includes("equation latex="));
  expect(line(a)).toBeDefined();
  expect(line(a)).not.toBe(line(b));
});

it("rejects a source longer than the schema's bound", () => {
  const { document } = deckWith("x".repeat(5000));
  expect(validateDocument(document).errors.length).toBeGreaterThan(0);
});
