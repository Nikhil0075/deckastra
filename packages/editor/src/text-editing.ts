import { newId, type RichTextDocument, type TextBlock, type TextSpan } from "@deckastra/presentation-schema";

/**
 * In-place text editing (doc 04 §17, doc 02 §12).
 *
 * The editing surface is a `contenteditable`, which means the browser owns a DOM
 * tree while the user types and the document owns a `RichTextDocument` when they
 * stop. Everything that makes that safe lives here, as pure functions:
 *
 * - Reading a DOM subtree back into blocks and spans, keeping only the marks the
 *   schema has.
 * - Sanitizing a paste. This is the security-relevant one: pasted HTML is
 *   attacker-controlled content arriving in a document other people will open.
 * - Producing a patch, so a text edit goes through the same single mutation path
 *   as every other change rather than writing the document directly.
 *
 * Nothing here touches React or the live DOM. It takes a node (or a string) and
 * returns data, which is what makes it testable without a browser.
 */

/** Marks the schema understands. Anything else is dropped rather than carried. */
const INLINE_MARKS = ["bold", "italic", "underline", "strike", "code"] as const;
type InlineMark = (typeof INLINE_MARKS)[number];

const TAG_MARKS: Record<string, InlineMark> = {
  B: "bold",
  STRONG: "bold",
  I: "italic",
  EM: "italic",
  U: "underline",
  S: "strike",
  STRIKE: "strike",
  DEL: "strike",
  CODE: "code",
  KBD: "code",
  SAMP: "code",
};

const BLOCK_TAGS: Record<string, string> = {
  P: "paragraph",
  DIV: "paragraph",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  BLOCKQUOTE: "quote",
  LI: "bullet",
};

/**
 * URL schemes a link may use.
 *
 * `javascript:`, `data:` and `vbscript:` are the reason this is an allowlist and
 * not a denylist: a pasted link is content someone else wrote, and it ends up in
 * a document that other people open and click.
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

export function isSafeLink(href: string): boolean {
  const trimmed = href.trim();
  // A relative link cannot carry a scheme, so it cannot carry a dangerous one.
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return true;

  try {
    return SAFE_SCHEMES.has(new URL(trimmed, "https://deckastra.invalid").protocol);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ from DOM

interface Marks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

function spanFrom(text: string, marks: Marks): TextSpan {
  const span: TextSpan = { text };
  for (const mark of INLINE_MARKS) if (marks[mark]) span[mark] = true;
  if (marks.link) span.link = marks.link;
  return span;
}

/** Merge runs that carry identical marks, so typing does not fragment a block. */
function mergeSpans(spans: TextSpan[]): TextSpan[] {
  const out: TextSpan[] = [];

  for (const span of spans) {
    if (span.text === "") continue;
    const previous = out.at(-1);

    const sameMarks =
      previous !== undefined &&
      INLINE_MARKS.every((mark) => Boolean(previous[mark]) === Boolean(span[mark])) &&
      previous.link === span.link;

    if (sameMarks) previous.text += span.text;
    else out.push({ ...span });
  }

  return out;
}

/**
 * Read a contenteditable subtree back into blocks and spans.
 *
 * Browsers disagree about what a "line" is inside a contenteditable — some emit
 * `<div>`, some `<p>`, some bare text with `<br>` — so all three are handled.
 * Getting this wrong does not corrupt anything, but it does silently collapse a
 * user's paragraphs into one, which they notice immediately.
 */
export function readEditable(root: Node): RichTextDocument {
  const blocks: TextBlock[] = [];
  let current: { type: string; indentLevel: number; spans: TextSpan[] } | undefined;

  const startBlock = (type = "paragraph", indentLevel = 0): void => {
    if (current) blocks.push(finish(current));
    current = { type, indentLevel, spans: [] };
  };

  const finish = (block: {
    type: string;
    indentLevel: number;
    spans: TextSpan[];
  }): TextBlock => ({
    id: newId("blk"),
    type: block.type as TextBlock["type"],
    ...(block.indentLevel > 0 ? { indentLevel: block.indentLevel } : {}),
    // A block with no spans still exists — an empty paragraph is a deliberate
    // blank line, and dropping it silently deletes the user's spacing.
    spans: block.spans.length > 0 ? mergeSpans(block.spans) : [{ text: "" }],
  });

  const walk = (node: Node, marks: Marks, depth: number): void => {
    if (node.nodeType === 3 /* text */) {
      const text = node.nodeValue ?? "";
      if (text === "") return;
      if (!current) startBlock();
      current!.spans.push(spanFrom(text, marks));
      return;
    }

    if (node.nodeType !== 1 /* element */) return;
    const element = node as Element;
    const tag = element.tagName;

    if (tag === "BR") {
      // A <br> ends the line rather than emitting a character.
      startBlock(current?.type ?? "paragraph", current?.indentLevel ?? 0);
      return;
    }

    if (tag === "STYLE" || tag === "SCRIPT" || tag === "NOSCRIPT") return;

    const blockType = BLOCK_TAGS[tag];
    const nextMarks: Marks = { ...marks };

    const mark = TAG_MARKS[tag];
    if (mark) nextMarks[mark] = true;

    if (tag === "A") {
      const href = element.getAttribute("href") ?? "";
      if (isSafeLink(href)) nextMarks.link = href;
      // An unsafe href drops the link and keeps the text: the words are the
      // user's content, the destination is not.
    }

    // Inline styles are the other common carrier of emphasis in pasted HTML.
    const style = (element as HTMLElement).style;
    if (style) {
      const weight = style.fontWeight;
      if (weight === "bold" || Number(weight) >= 600) nextMarks.bold = true;
      if (style.fontStyle === "italic") nextMarks.italic = true;
      if (style.textDecorationLine?.includes("underline")) nextMarks.underline = true;
      if (style.textDecorationLine?.includes("line-through")) nextMarks.strike = true;
    }

    if (blockType && depth > 0) {
      startBlock(blockType, tag === "LI" ? Math.max(0, depth - 2) : 0);
    }

    for (const child of Array.from(element.childNodes)) walk(child, nextMarks, depth + 1);
  };

  for (const child of Array.from((root as Element).childNodes ?? [])) walk(child, {}, 1);
  if (current) blocks.push(finish(current));

  return { version: 1, blocks: blocks.length > 0 ? blocks : [emptyBlock()] };
}

function emptyBlock(): TextBlock {
  return { id: newId("blk"), type: "paragraph", spans: [{ text: "" }] };
}

/** An empty document, for a newly created text box. */
export function emptyRichText(): RichTextDocument {
  return { version: 1, blocks: [emptyBlock()] };
}

// --------------------------------------------------------------------- paste

/**
 * Sanitize pasted content.
 *
 * Pasted HTML is attacker-controlled: a user copies from a web page and the
 * markup arrives whole, scripts, event handlers, styles and all. Rather than
 * trying to remove the dangerous parts — a denylist that is always one trick
 * behind — this reads the tree for the handful of things the schema can hold and
 * throws the rest away. Nothing survives that is not a block, a mark, or a link
 * with an allowed scheme.
 *
 * The plain-text fallback is not a lesser path: it is what runs when the source
 * offered no HTML, and it must produce the same block structure.
 */
export function sanitizePastedHtml(html: string, parse: (html: string) => Node): RichTextDocument {
  return readEditable(parse(html));
}

export function plainTextToRichText(text: string): RichTextDocument {
  // A blank line between paragraphs is the convention every plain-text source
  // uses; single newlines stay inside their block as a soft break would.
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const blocks: TextBlock[] = lines.map((line) => {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (bullet) {
      return { id: newId("blk"), type: "bullet", spans: [{ text: bullet[1]! }] };
    }
    if (numbered) {
      return { id: newId("blk"), type: "numbered", spans: [{ text: numbered[1]! }] };
    }
    return { id: newId("blk"), type: "paragraph", spans: [{ text: line }] };
  });

  return { version: 1, blocks: blocks.length > 0 ? blocks : [emptyBlock()] };
}

// ---------------------------------------------------------------- comparison

/** Plain text of a document, for comparison and for accessibility labels. */
export function richTextToPlain(document: RichTextDocument): string {
  return document.blocks
    .map((block) => block.spans.map((span) => span.text).join(""))
    .join("\n");
}

/**
 * Whether an edit actually changed anything.
 *
 * Block ids are regenerated on every read of the editable, so comparing whole
 * documents would report a change every time the user clicks in and out. The
 * comparison is over what a reader would see: block types, indent, and the
 * marked runs.
 */
export function textChanged(before: RichTextDocument, after: RichTextDocument): boolean {
  const shape = (document: RichTextDocument): string =>
    JSON.stringify(
      document.blocks.map((block) => [
        block.type,
        block.indentLevel ?? 0,
        block.spans.map((span) => [
          span.text,
          span.bold ?? false,
          span.italic ?? false,
          span.underline ?? false,
          span.strike ?? false,
          span.code ?? false,
          span.link ?? "",
        ]),
      ]),
    );

  return shape(before) !== shape(after);
}

/**
 * Carry the original document's per-block styling onto an edited one.
 *
 * The editable surface cannot represent everything a block can hold — paragraph
 * spacing, a custom list marker, an alignment override. Reading it back would
 * drop them, so they are re-applied positionally. A user who typed a new
 * paragraph at the end gets the previous block's style rather than nothing,
 * which is what every editor does and what they expect.
 */
export function preserveBlockStyles(
  before: RichTextDocument,
  after: RichTextDocument,
): RichTextDocument {
  if (before.blocks.length === 0) return after;

  return {
    ...after,
    blocks: after.blocks.map((block, index) => {
      const source = before.blocks[index] ?? before.blocks.at(-1)!;
      const carried: Partial<TextBlock> = {};

      if (source.style) carried.style = source.style;
      if (source.listMarker) carried.listMarker = source.listMarker;

      return { ...block, ...carried };
    }),
  };
}
