import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { RichTextDocument } from "@deckastra/presentation-schema";
import { readEditable, sanitizePastedHtml, textChanged } from "@deckastra/editor";

import { TextEditor } from "../src/components/TextEditor";
import { ColorStudioProvider } from "../src/lib/color-studio";
import { renderRichText } from "../src/lib/rich-dom";

/**
 * Colour on some words of a text box (colour wizard, 2026-09-26). The run keeps
 * its colour as written — a token stays a token — because it travels through the
 * DOM as `data-color`, never as the computed CSS colour.
 */

afterEach(cleanup);

const doc = (spans: RichTextDocument["blocks"][number]["spans"]): RichTextDocument => ({
  version: 1,
  blocks: [{ id: "blk_01JB8Z9K2QW4RN7F3XG5HTM901", type: "paragraph", spans }],
});

it("renders and reads a coloured run as the same document, token included", () => {
  const original = doc([
    { text: "Revenue " },
    { text: "grew", bold: true, color: "token:colors.custom.Brand red" },
    { text: " 40%", color: "#00A36C" },
  ]);
  const host = document.createElement("div");
  host.appendChild(renderRichText(document, original, { resolveColor: (value) => (value.startsWith("#") ? value : "rgb(210, 0, 30)") }));
  expect(host.querySelector('[data-color="token:colors.custom.Brand red"]')?.getAttribute("style")).toContain("color");
  const back = readEditable(host);
  expect(back.blocks[0]!.spans).toEqual(original.blocks[0]!.spans);
  expect(textChanged(original, back)).toBe(false);
});

it("treats recolouring words, and nothing else, as an edit", () => {
  const before = doc([{ text: "Hello" }]);
  const after = doc([{ text: "Hello", color: "token:colors.accent" }]);
  expect(textChanged(before, after)).toBe(true);
});

it("keeps only colours the schema can hold from pasted markup", () => {
  const parse = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host;
  };
  const pasted = sanitizePastedHtml(
    '<span data-color="#123456">a</span><span data-color="url(javascript:x)">b</span><span style="color:red">c</span>',
    parse,
  );
  expect(pasted.blocks[0]!.spans).toEqual([{ text: "a", color: "#123456" }, { text: "bc" }]);
});

it("colours the selected words from the toolbar, with the deck's own palette", () => {
  const deck = structuredClone(loadFixture("technical"));
  (deck.theme.colors as unknown as { custom: Record<string, string> }).custom = { "Brand red": "#D2001E" };
  let committed: RichTextDocument | undefined;
  render(
    <ColorStudioProvider value={{ document: deck, apply: () => {}, open: () => {} }}>
      <TextEditor
        value={doc([{ text: "Hello world" }])}
        typography={{ fontFamily: "Inter", fontSize: 32 } as never}
        rect={{ x: 0, y: 0, width: 400, height: 80 }}
        scale={1}
        onCommit={(next) => (committed = next)}
        onCancel={() => {}}
      />
    </ColorStudioProvider>,
  );
  const field = screen.getByRole("textbox", { name: "Edit text" });
  // Select "world".
  const text = field.querySelector("div")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 11);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);

  fireEvent.click(screen.getByTestId("text-color-button"));
  fireEvent.click(screen.getByRole("button", { name: "Brand red" }));
  fireEvent.blur(field);

  expect(committed?.blocks[0]!.spans).toEqual([{ text: "Hello " }, { text: "world", color: "token:colors.custom.Brand red" }]);
});
