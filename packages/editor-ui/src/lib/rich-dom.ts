/**
 * Rich text as DOM, for the two contenteditable surfaces (the canvas text
 * editor and the speaker notes).
 *
 * The elements chosen are the ones `readEditable` reads back to the same blocks
 * and marks — a line is a `<div>`, a list item sits in its `<ul>` or `<ol>`, a
 * heading is an `<h4>` — so rendering and reading are inverses, and opening a
 * text box and leaving it changes nothing. The canvas editor used to seed every
 * block as a plain `<div>`, which read back as a paragraph: a bulleted list
 * lost its bullets on the first edit (manual-authoring review, MA-08/09).
 *
 * Text goes in as text nodes and a link only with a permitted scheme: nothing
 * here is ever parsed as markup, so serialising what it builds is safe to hand
 * to the browser's `insertHTML`.
 */
import type { RichTextDocument, TextBlock, TextSpan } from "@deckastra/presentation-schema";
import { isSafeLink } from "@deckastra/editor";

export interface RenderRichTextOptions {
  /**
   * Make block elements take the editable's own typography. The notes field
   * wants a heading to look like one; the canvas editor sits exactly on top of
   * the rendered slide text, where a browser-default `<h4>` or a list's default
   * margin would make the words jump on entry.
   */
  inheritTypography?: boolean;
}

export function renderRichText(
  doc: Document,
  rich: RichTextDocument,
  options: RenderRichTextOptions = {},
): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  let list: HTMLElement | null = null;

  for (const block of rich.blocks) {
    const listTag = block.type === "bullet" ? "ul" : block.type === "numbered" ? "ol" : null;
    let line: HTMLElement;
    if (listTag) {
      if (!list || list.tagName.toLowerCase() !== listTag) {
        list = doc.createElement(listTag);
        if (options.inheritTypography) list.setAttribute("style", "margin:0;padding-left:1.2em");
        fragment.appendChild(list);
      }
      line = doc.createElement("li");
      list.appendChild(line);
    } else {
      list = null;
      line = doc.createElement(block.type === "heading" ? "h4" : block.type === "quote" ? "blockquote" : "div");
      if (options.inheritTypography && line.tagName !== "DIV") {
        line.setAttribute("style", "font:inherit;margin:0;padding:0");
      }
      fragment.appendChild(line);
    }
    appendSpans(doc, line, block);
  }
  return fragment;
}

/** The inline runs of one block, marks and all, without the block element. */
export function renderSpans(doc: Document, block: Pick<TextBlock, "spans">): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const span of block.spans) if (span.text !== "") fragment.appendChild(spanNode(doc, span));
  return fragment;
}

function appendSpans(doc: Document, line: HTMLElement, block: TextBlock): void {
  const spans = block.spans.filter((span) => span.text !== "");
  // An empty line still needs a line box, or the browser collapses it and a
  // deliberate blank line disappears.
  if (spans.length === 0) line.appendChild(doc.createElement("br"));
  for (const span of spans) line.appendChild(spanNode(doc, span));
}

function spanNode(doc: Document, span: TextSpan): Node {
  let node: Node = doc.createTextNode(span.text);
  const wrap = (tag: string) => {
    const element = doc.createElement(tag);
    element.appendChild(node);
    node = element;
  };
  if (span.code) wrap("code");
  if (span.strike) wrap("s");
  if (span.underline) wrap("u");
  if (span.italic) wrap("em");
  if (span.bold) wrap("strong");
  if (span.link && isSafeLink(span.link)) {
    const anchor = doc.createElement("a");
    anchor.setAttribute("href", span.link);
    anchor.appendChild(node);
    node = anchor;
  }
  return node;
}

// --------------------------------------------------------------------- paste

/**
 * Put an already-sanitized paste at the caret of `host`, keeping its marks and
 * its blocks.
 *
 * The browser's own `insertHTML` goes first, because it is the only insertion
 * the field's native Undo can take back as one edit. The HTML handed to it is
 * serialised from nodes this module built out of text nodes, so it carries
 * nothing the allowlist did not keep. Where the command is unavailable (jsdom,
 * an engine that refuses it) the paste is inserted structurally: a paste of
 * inline runs goes in at the caret, and a paste of several blocks splits the
 * line it lands in, so the words after the caret follow the last pasted line
 * rather than being pushed into a line of their own.
 */
export function insertRichText(host: HTMLElement, pasted: RichTextDocument, options: RenderRichTextOptions = {}): void {
  const doc = host.ownerDocument;
  const selection = doc.getSelection();
  if (!selection?.rangeCount) return;

  const inlineOnly = pasted.blocks.length === 1 && pasted.blocks[0]!.type === "paragraph";
  const html = serialise(doc, inlineOnly ? renderSpans(doc, pasted.blocks[0]!) : renderRichText(doc, pasted, options));
  if (html !== "" && tryExecInsert(doc, html)) return;

  const range = selection.getRangeAt(0);
  range.deleteContents();

  if (inlineOnly) {
    let fragment: Node = renderSpans(doc, pasted.blocks[0]!);
    let last = fragment.lastChild;
    // A caret between lines (directly in the host) takes a line of its own;
    // runs dropped loose into the host would sit beside the line boxes.
    if (!lineOf(host, range.startContainer)) {
      const line = doc.createElement("div");
      line.appendChild(fragment);
      fragment = line;
      last = line.lastChild;
    }
    range.insertNode(fragment);
    if (last) placeCaretAfter(selection, doc, last);
    return;
  }

  const line = lineOf(host, range.startContainer);
  if (!line) {
    // The caret is directly in the host (an empty field): the blocks are the lines.
    const fragment = renderRichText(doc, pasted, options);
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) placeCaretAfter(selection, doc, last);
    return;
  }

  // Everything after the caret on this line moves to the end of the paste.
  const tailRange = doc.createRange();
  tailRange.setStart(range.startContainer, range.startOffset);
  tailRange.setEnd(line, line.childNodes.length);
  const tail = tailRange.extractContents();
  dropPlaceholder(line);

  let blocks = pasted.blocks;
  if (blocks[0]!.type === "paragraph") {
    line.appendChild(renderSpans(doc, blocks[0]!));
    blocks = blocks.slice(1);
  }
  if (line.childNodes.length === 0) line.appendChild(doc.createElement("br"));

  // A line inside a list is split with its list, so the items after it keep
  // their order after the pasted blocks.
  let anchor: Element = line;
  if (line.tagName === "LI" && line.parentElement && line.parentElement !== host) {
    const list = line.parentElement;
    const after: Element[] = [];
    for (let next = line.nextElementSibling; next; next = next.nextElementSibling) after.push(next);
    if (after.length > 0) {
      const rest = doc.createElement(list.tagName.toLowerCase());
      const style = list.getAttribute("style");
      if (style) rest.setAttribute("style", style);
      for (const item of after) rest.appendChild(item);
      list.after(rest);
    }
    anchor = list;
  }

  const rendered = renderRichText(doc, { version: 1, blocks }, options);
  const inserted = Array.from(rendered.childNodes);
  anchor.after(rendered);

  let lastLine: Element = line;
  const lastInserted = inserted.at(-1);
  if (lastInserted instanceof Element) {
    lastLine = lastInserted.tagName === "UL" || lastInserted.tagName === "OL"
      ? (lastInserted.lastElementChild ?? lastInserted)
      : lastInserted;
  }
  const marker = doc.createTextNode("");
  if (tail.textContent !== "") dropPlaceholder(lastLine);
  lastLine.appendChild(marker);
  if (tail.textContent !== "") lastLine.appendChild(tail);
  placeCaretAfter(selection, doc, marker);
}

function tryExecInsert(doc: Document, html: string): boolean {
  if (typeof doc.execCommand !== "function") return false;
  try {
    return doc.execCommand("insertHTML", false, html) === true;
  } catch {
    return false;
  }
}

function serialise(doc: Document, fragment: DocumentFragment): string {
  const scratch = doc.createElement("div");
  scratch.appendChild(fragment);
  return scratch.innerHTML;
}

/** The line element holding `node`: a direct child of the host, or a list item. */
function lineOf(host: HTMLElement, node: Node | null): HTMLElement | null {
  let cursor: Node | null = node;
  while (cursor && cursor !== host) {
    const parent: Node | null = cursor.parentNode;
    if (cursor instanceof HTMLElement && (parent === host || cursor.tagName === "LI")) return cursor;
    cursor = parent;
  }
  return null;
}

/** A lone `<br>` only holds an empty line open; it goes once the line has words. */
function dropPlaceholder(line: Element): void {
  if (line.childNodes.length === 1 && line.firstChild?.nodeName === "BR") line.firstChild.remove();
}

function placeCaretAfter(selection: Selection, doc: Document, node: Node): void {
  const range = doc.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
