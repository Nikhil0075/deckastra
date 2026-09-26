import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RichTextDocument } from "@deckastra/presentation-schema";
import { TextEditor } from "../src/components/TextEditor";

/**
 * The canvas text editor (manual-authoring review MA-09 to MA-12).
 *
 * The first three cases here were the review's reproducers, written against
 * the component before it was fixed and promoted from its evidence directory.
 */

afterEach(cleanup);

const BEFORE: RichTextDocument = {
  version: 1,
  blocks: [{ id: "blk_01JAAAAAAAAAAAAAAAAAAAAAAA", type: "paragraph", spans: [{ text: "Before" }] }],
};

function setup(value: RichTextDocument = BEFORE, extra: Partial<Parameters<typeof TextEditor>[0]> = {}) {
  const commit = vi.fn();
  const cancel = vi.fn();
  const view = render(
    <TextEditor
      value={value}
      typography={{ fontFamily: "Arial", fontSize: 24, fontWeight: 400, color: "#ffffff" }}
      rect={{ x: 0, y: 0, width: 300, height: 80 }}
      scale={1}
      onCommit={commit}
      onCancel={cancel}
      {...extra}
    />,
  );
  return { host: view.getByRole("textbox"), commit, cancel, view };
}

const texts = (doc: RichTextDocument) => doc.blocks.map((block) => block.spans.map((span) => span.text).join(""));

it("control: ordinary text commits on blur", () => {
  const { host, commit } = setup();
  host.textContent = "Changed";
  fireEvent.blur(host);
  expect(texts(commit.mock.calls[0]![0])).toEqual(["Changed"]);
});

it("does not commit a partially composed word on blur, and commits the finished one once", () => {
  const { host, commit } = setup();
  fireEvent.compositionStart(host);
  host.textContent = "Before partial";
  fireEvent.blur(host);
  expect(commit).not.toHaveBeenCalled();

  host.textContent = "Before 完成";
  fireEvent.compositionEnd(host);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(texts(commit.mock.calls[0]![0])).toEqual(["Before 完成"]);

  // A second blur after the commit is not a second transaction.
  fireEvent.blur(host);
  expect(commit).toHaveBeenCalledTimes(1);
});

it("a save or close mid-composition commits the text from before the composition", () => {
  let flush: (() => void) | undefined;
  const { host, commit } = setup(BEFORE, {
    registerDraft: (fn) => {
      flush = fn;
      return () => {
        flush = undefined;
      };
    },
  });
  host.textContent = "Typed";
  fireEvent.compositionStart(host);
  host.textContent = "Typed かな";
  act(() => flush!());
  expect(texts(commit.mock.calls[0]![0])).toEqual(["Typed"]);
});

it("hands its draft to the save barrier without needing a blur", () => {
  let flush: (() => void) | undefined;
  const { host, commit } = setup(BEFORE, { registerDraft: (fn) => ((flush = fn), () => (flush = undefined)) });
  host.textContent = "Last keystroke";
  act(() => flush!());
  expect(texts(commit.mock.calls[0]![0])).toEqual(["Last keystroke"]);
});

it("keeps typed words when it unmounts without a blur", () => {
  const { host, commit, view } = setup();
  host.textContent = "Kept on unmount";
  view.unmount();
  expect(texts(commit.mock.calls[0]![0])).toEqual(["Kept on unmount"]);
});

it("an untouched editor unmounting commits nothing and cancels nothing", () => {
  const { commit, cancel, view } = setup();
  view.unmount();
  expect(commit).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});

it("retains supported formatting pasted into canvas text, and drops the rest", () => {
  const { host, commit } = setup();
  fireEvent.paste(host, {
    clipboardData: {
      getData: (format: string) =>
        format === "text/html" ? '<b>Bold</b> <i>it</i> <u>un</u><img src=x onerror="alert(1)">' : "Bold it un",
    },
  });
  expect(host.querySelector("img, [onerror]")).toBeNull();
  fireEvent.blur(host);
  const spans = commit.mock.calls[0]![0].blocks.flatMap((block: RichTextDocument["blocks"][number]) => block.spans);
  expect(spans.some((span: { text: string; bold?: boolean }) => span.text === "Bold" && span.bold)).toBe(true);
  expect(spans.some((span: { text: string; italic?: boolean }) => span.text === "it" && span.italic)).toBe(true);
  expect(spans.some((span: { text: string; underline?: boolean }) => span.text === "un" && span.underline)).toBe(true);
});

it("a pasted list lands in the middle of a line and the rest of the line follows it", () => {
  const { host, commit } = setup({
    version: 1,
    blocks: [{ id: "blk_01JAAAAAAAAAAAAAAAAAAAAAAA", type: "paragraph", spans: [{ text: "HeadTail" }] }],
  });
  // Caret between "Head" and "Tail".
  const text = host.querySelector("div")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 4);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);

  fireEvent.paste(host, {
    clipboardData: { getData: (format: string) => (format === "text/html" ? "<ul><li>One</li><li><b>Two</b></li></ul>" : "") },
  });
  fireEvent.blur(host);
  const next: RichTextDocument = commit.mock.calls[0]![0];
  expect(next.blocks.map((block) => [block.type, block.spans.map((span) => span.text).join("")])).toEqual([
    ["paragraph", "Head"],
    ["bullet", "One"],
    ["bullet", "TwoTail"],
  ]);
  expect(next.blocks[2]!.spans[0]).toMatchObject({ text: "Two", bold: true });
});

it("opens a bulleted list as a list, so editing one word keeps the bullets and block ids", () => {
  const value: RichTextDocument = {
    version: 1,
    blocks: [
      { id: "blk_01JAAAAAAAAAAAAAAAAAAAAAA1", type: "bullet", spans: [{ text: "Alpha " }, { text: "bold", bold: true }] },
      { id: "blk_01JAAAAAAAAAAAAAAAAAAAAAA2", type: "bullet", spans: [{ text: "Beta" }], style: { paragraphSpacing: 12 } },
    ],
  };
  const { host, commit } = setup(value);
  expect(host.querySelectorAll("ul > li")).toHaveLength(2);
  host.querySelectorAll("li")[1]!.textContent = "Gamma";
  fireEvent.blur(host);
  const next: RichTextDocument = commit.mock.calls[0]![0];
  expect(next.blocks.map((block) => block.type)).toEqual(["bullet", "bullet"]);
  expect(next.blocks.map((block) => block.id)).toEqual(value.blocks.map((block) => block.id));
  expect(next.blocks[0]!.spans).toEqual(value.blocks[0]!.spans);
  expect(next.blocks[1]!.style).toEqual({ paragraphSpacing: 12 });
});

it("sits on the element's own rotated box rather than its axis-aligned bounds", () => {
  const angle = (30 * Math.PI) / 180;
  const matrix = { a: Math.cos(angle), b: Math.sin(angle), c: -Math.sin(angle), d: Math.cos(angle), e: 200, f: 100 };
  const { host } = setup(BEFORE, { local: { width: 400, height: 90, matrix }, scale: 0.5 });
  expect(host.style.width).toBe("200px");
  expect(host.style.height).toBe("45px");
  expect(host.style.transform).toBe(`matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, 100, 50)`);
  expect(host.style.transformOrigin).toBe("0 0");
});

it("the formatting toolbar keeps focus in the text, so using it does not close the editor", () => {
  const { host, commit, view } = setup();
  const exec = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
  const bold = view.getByRole("button", { name: "Bold" });
  const down = fireEvent.pointerDown(bold);
  expect(down).toBe(false); // default prevented: the button never takes focus
  fireEvent.click(bold);
  expect(exec).toHaveBeenCalledWith("bold");
  expect(commit).not.toHaveBeenCalled();
  expect(host).toBeTruthy();
  Reflect.deleteProperty(document, "execCommand");
});
