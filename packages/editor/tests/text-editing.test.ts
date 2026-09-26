// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  emptyRichText,
  isSafeLink,
  plainTextToRichText,
  preserveBlockStyles,
  readEditable,
  richTextToPlain,
  sanitizePastedHtml,
  textChanged,
} from "../src/text-editing";

/**
 * Runs against a real HTML parser rather than a hand-built fake tree.
 *
 * The paste path is the security-relevant one: what arrives is markup someone
 * else wrote, and a fake tree would only ever contain the shapes the test author
 * thought of. jsdom parses it the way a browser would, including the parts that
 * are easy to forget — nested formatting, inline styles, and the mangled markup
 * real editors emit.
 */

function parse(html: string): Node {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

const paste = (html: string) => sanitizePastedHtml(html, parse);

describe("reading a contenteditable", () => {
  it("keeps paragraph structure", () => {
    const doc = paste("<p>First</p><p>Second</p>");
    expect(doc.blocks).toHaveLength(2);
    expect(richTextToPlain(doc)).toBe("First\nSecond");
  });

  it("treats a <br> as a line break, not a character", () => {
    // Browsers disagree about what a line is inside a contenteditable; getting
    // this wrong silently collapses a user's paragraphs into one.
    expect(richTextToPlain(paste("one<br>two"))).toBe("one\ntwo");
  });

  it("keeps the marks the schema has and drops the rest", () => {
    const doc = paste("<b>bold</b> <i>it</i> <u>u</u> <s>s</s> <code>c</code> <sup>x</sup>");
    const spans = doc.blocks[0]!.spans;

    expect(spans.find((span) => span.text === "bold")?.bold).toBe(true);
    expect(spans.find((span) => span.text === "it")?.italic).toBe(true);
    expect(spans.find((span) => span.text === "u")?.underline).toBe(true);
    expect(spans.find((span) => span.text === "s")?.strike).toBe(true);
    expect(spans.find((span) => span.text === "c")?.code).toBe(true);
    // Superscript is not in the mark set; the text survives, the mark does not.
    expect(richTextToPlain(doc)).toContain("x");
    expect(spans.some((span) => "superscript" in span)).toBe(false);
  });

  it("reads emphasis carried by inline styles", () => {
    // Real editors emit `<span style="font-weight:700">` at least as often as <b>.
    const doc = paste('<span style="font-weight:700">heavy</span>');
    expect(doc.blocks[0]!.spans[0]!.bold).toBe(true);
  });

  it("merges runs with identical marks so typing does not fragment a block", () => {
    const doc = paste("<b>a</b><b>b</b><b>c</b>");
    expect(doc.blocks[0]!.spans).toHaveLength(1);
    expect(doc.blocks[0]!.spans[0]).toMatchObject({ text: "abc", bold: true });
  });

  it("keeps an empty paragraph, because a blank line is deliberate", () => {
    const doc = paste("<p>a</p><p></p><p>b</p>");
    expect(doc.blocks).toHaveLength(3);
    expect(doc.blocks[1]!.spans).toEqual([{ text: "" }]);
  });

  it("never returns a document with no blocks", () => {
    expect(paste("").blocks).toHaveLength(1);
    expect(emptyRichText().blocks).toHaveLength(1);
  });
});

describe("paste sanitization", () => {
  it("drops scripts and their contents entirely", () => {
    const doc = paste('hello<script>alert(1)</script><style>p{}</style>world');
    expect(richTextToPlain(doc)).toBe("helloworld");
  });

  it("keeps a safe link and its text", () => {
    const doc = paste('<a href="https://example.com">docs</a>');
    expect(doc.blocks[0]!.spans[0]).toMatchObject({ text: "docs", link: "https://example.com" });
  });

  it("strips a dangerous href but keeps the words", () => {
    // The words are the user's content; the destination is not.
    for (const href of ["javascript:alert(1)", "data:text/html,<b>x", "vbscript:msgbox"]) {
      const doc = paste(`<a href="${href}">click</a>`);
      expect(richTextToPlain(doc)).toBe("click");
      expect(doc.blocks[0]!.spans[0]!.link).toBeUndefined();
    }
  });

  it("carries no attributes through at all", () => {
    const doc = paste('<p onclick="steal()" class="x" data-y="z">text</p>');
    const serialised = JSON.stringify(doc);
    expect(serialised).not.toContain("onclick");
    expect(serialised).not.toContain("steal");
    expect(serialised).not.toContain("class");
  });

  it("survives the mangled markup real editors emit", () => {
    const doc = paste(
      '<meta charset="utf-8"><b style="font-weight:normal"><div><span>A</span></div>' +
        "<div><span>B</span></div></b>",
    );
    expect(richTextToPlain(doc)).toBe("A\nB");
  });

  it("judges link safety on the scheme, not on a substring", () => {
    expect(isSafeLink("https://ok.example")).toBe(true);
    expect(isSafeLink("mailto:a@b.c")).toBe(true);
    expect(isSafeLink("/relative")).toBe(true);
    expect(isSafeLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLink("  JavaScript:alert(1)")).toBe(false);
    expect(isSafeLink("file:///etc/passwd")).toBe(false);
  });
});

describe("blank lines", () => {
  it("reads the <br> that holds an empty line open as nothing, so a blank line stays one line", () => {
    const host = document.createElement("div");
    host.innerHTML = "<div>one</div><div><br></div><div>two<br></div>";
    expect(readEditable(host).blocks.map((block) => block.spans[0]!.text)).toEqual(["one", "", "two"]);
  });

  it("still reads a <br> between words as a line break", () => {
    const host = document.createElement("div");
    host.innerHTML = "<div>one<br>two</div>";
    expect(readEditable(host).blocks.map((block) => block.spans[0]!.text)).toEqual(["one", "two"]);
  });
});

describe("lists", () => {
  it("reads an ordered list as numbered and an unordered one as bullets", () => {
    const host = document.createElement("div");
    host.innerHTML = "<ol><li>first</li><li>second</li></ol><ul><li>point</li></ul><div>after</div>";
    expect(readEditable(host).blocks.map((block) => [block.type, block.spans[0]!.text])).toEqual([
      ["numbered", "first"],
      ["numbered", "second"],
      ["bullet", "point"],
      ["paragraph", "after"],
    ]);
  });
});

describe("plain text paste", () => {
  it("makes one block per line", () => {
    expect(plainTextToRichText("a\nb\nc").blocks).toHaveLength(3);
  });

  it("recognises the list markers plain text uses", () => {
    const doc = plainTextToRichText("- one\n* two\n1. three\n2) four\nplain");
    expect(doc.blocks.map((block) => block.type)).toEqual([
      "bullet",
      "bullet",
      "numbered",
      "numbered",
      "paragraph",
    ]);
    expect(richTextToPlain(doc)).toBe("one\ntwo\nthree\nfour\nplain");
  });

  it("handles CRLF from a Windows source", () => {
    expect(plainTextToRichText("a\r\nb").blocks).toHaveLength(2);
  });
});

describe("change detection", () => {
  it("ignores regenerated block ids", () => {
    // Ids are new on every read of the editable. Comparing whole documents would
    // report a change every time the user clicks in and out.
    const before = plainTextToRichText("same");
    const after = plainTextToRichText("same");
    expect(before.blocks[0]!.id).not.toBe(after.blocks[0]!.id);
    expect(textChanged(before, after)).toBe(false);
  });

  it("sees a text change, a mark change and a structure change", () => {
    const before = paste("<p>a</p>");
    expect(textChanged(before, paste("<p>b</p>"))).toBe(true);
    expect(textChanged(before, paste("<p><b>a</b></p>"))).toBe(true);
    expect(textChanged(before, paste("<p>a</p><p>b</p>"))).toBe(true);
  });
});

describe("preserving block styling", () => {
  it("carries styling the editable cannot represent", () => {
    const before = plainTextToRichText("one");
    before.blocks[0]!.style = { align: "center", paragraphSpacing: 12 };
    before.blocks[0]!.listMarker = "→";

    const after = preserveBlockStyles(before, plainTextToRichText("one edited"));
    expect(after.blocks[0]!.style).toEqual({ align: "center", paragraphSpacing: 12 });
    expect(after.blocks[0]!.listMarker).toBe("→");
  });

  it("gives a newly typed block the previous block's style", () => {
    // What every editor does, and what a user expects: pressing Enter continues
    // the paragraph they were in rather than reverting to defaults.
    const before = plainTextToRichText("one");
    before.blocks[0]!.style = { align: "center" };

    const after = preserveBlockStyles(before, plainTextToRichText("one\ntwo"));
    expect(after.blocks[1]!.style).toEqual({ align: "center" });
  });

  it("does nothing when there was nothing to carry", () => {
    const after = preserveBlockStyles(emptyRichText(), plainTextToRichText("x"));
    expect(after.blocks[0]!.style).toBeUndefined();
  });
});
