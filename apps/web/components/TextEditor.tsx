"use client";

import { useCallback, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { RichTextDocument, TypographyStyle } from "@deckastra/presentation-schema";
import {
  plainTextToRichText,
  preserveBlockStyles,
  readEditable,
  sanitizePastedHtml,
  textChanged,
} from "@deckastra/editor";

/**
 * In-place text editing (doc 04 §17).
 *
 * A `contenteditable` positioned exactly over the rendered element and styled to
 * match it, so the text does not jump when editing starts. The rendered element
 * is hidden while this is up; anything else double-renders the glyphs.
 *
 * Three things here are not incidental:
 *
 * - **The DOM is never treated as the document.** The user's keystrokes go into
 *   a browser-owned tree; on commit that tree is read back into blocks and spans
 *   and handed to the caller as a patch. There is no path where the editable
 *   writes the document directly (doc 05 §10).
 * - **Composition is respected.** An IME holds partial text in the DOM for the
 *   duration of a composition. Reading during one commits half a character, so
 *   commits are deferred until `compositionend`. This is not an edge case in
 *   Japanese, Chinese or Korean — it is every word.
 * - **Paste is sanitized, always.** Pasted HTML is content someone else wrote,
 *   arriving in a document other people will open. The default paste is
 *   prevented and replaced with a parsed, allowlisted version.
 */

export interface TextEditorProps {
  /** The document being edited. Read once on mount; the DOM owns it after that. */
  value: RichTextDocument;
  typography: TypographyStyle;
  /** Position and size in CSS pixels, already scaled for the canvas. */
  rect: { x: number; y: number; width: number; height: number };
  scale: number;
  align?: string;
  verticalAlign?: string;
  padding?: { top: number; right: number; bottom: number; left: number };
  /** Called with the edited document when it actually changed. */
  onCommit: (next: RichTextDocument) => void;
  onCancel: () => void;
}

export function TextEditor({
  value,
  typography,
  rect,
  scale,
  align,
  verticalAlign,
  padding,
  onCommit,
  onCancel,
}: TextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const original = useRef(value);
  const committed = useRef(false);

  // Seed the editable once. Re-seeding on every render would move the caret to
  // the start on each keystroke.
  useEffect(() => {
    const host = ref.current;
    if (!host) return;

    host.innerHTML = "";
    for (const block of value.blocks) {
      const line = document.createElement("div");
      // A block with no text still needs a line box, or the browser collapses it
      // and the user's blank line disappears.
      if (block.spans.every((span) => span.text === "")) {
        line.appendChild(document.createElement("br"));
      } else {
        for (const span of block.spans) {
          let node: Node = document.createTextNode(span.text);
          if (span.code) node = wrap("code", node);
          if (span.strike) node = wrap("s", node);
          if (span.underline) node = wrap("u", node);
          if (span.italic) node = wrap("em", node);
          if (span.bold) node = wrap("strong", node);
          line.appendChild(node);
        }
      }
      host.appendChild(line);
    }

    host.focus();

    // Select everything on entry: the overwhelmingly common intent when opening
    // a generated text box is to replace what the model wrote.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(host);
    selection?.removeAllRanges();
    selection?.addRange(range);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = useCallback(() => {
    if (committed.current) return;
    committed.current = true;

    const host = ref.current;
    if (!host) {
      onCancel();
      return;
    }

    const read = readEditable(host);
    const next = preserveBlockStyles(original.current, read);

    // An unchanged edit produces no transaction. Otherwise clicking into a text
    // box and out again fills the history with entries that undo nothing.
    if (textChanged(original.current, next)) onCommit(next);
    else onCancel();
  }, [onCancel, onCommit]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // While an IME is composing, Enter and Escape belong to the IME.
      if (composing.current) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        committed.current = true;
        onCancel();
        return;
      }

      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commit();
        return;
      }

      if (event.key === "Tab") {
        // Tab moves between elements on a slide, not into the text.
        event.preventDefault();
        commit();
        return;
      }

      // Everything else is typing, and must not reach the canvas's shortcuts:
      // Delete would remove the element the user is typing into.
      event.stopPropagation();
    },
    [commit, onCancel],
  );

  const onPaste = useCallback((event: React.ClipboardEvent) => {
    event.preventDefault();

    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");

    const parsed = html
      ? sanitizePastedHtml(html, (markup) => {
          // A detached element: the markup is parsed but never connected, so
          // nothing in it can load, run or observe anything.
          const host = document.createElement("div");
          host.innerHTML = markup;
          return host;
        })
      : plainTextToRichText(text);

    const selection = window.getSelection();
    if (!selection?.rangeCount) return;

    const range = selection.getRangeAt(0);
    range.deleteContents();

    const fragment = document.createDocumentFragment();
    parsed.blocks.forEach((block, index) => {
      if (index > 0) fragment.appendChild(document.createElement("br"));
      fragment.appendChild(
        document.createTextNode(block.spans.map((span) => span.text).join("")),
      );
    });

    const last = fragment.lastChild;
    range.insertNode(fragment);

    // Caret after the pasted content, which is where the user expects it.
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, []);

  const style: CSSProperties = {
    position: "absolute",
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    padding: padding
      ? `${padding.top * scale}px ${padding.right * scale}px ${padding.bottom * scale}px ${padding.left * scale}px`
      : undefined,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    justifyContent:
      verticalAlign === "middle" ? "center" : verticalAlign === "bottom" ? "flex-end" : "flex-start",
    // Matched to the rendered element so the text does not shift on entry.
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize * scale,
    fontWeight: typography.fontWeight,
    fontStyle: typography.fontStyle,
    lineHeight: typography.lineHeight ?? 1.3,
    letterSpacing: typography.letterSpacing ? `${typography.letterSpacing * scale}px` : undefined,
    color: typography.color,
    textAlign: align as CSSProperties["textAlign"],
    textTransform: typography.textTransform as CSSProperties["textTransform"],
    outline: "2px solid var(--accent)",
    outlineOffset: 2,
    background: "rgba(0,0,0,0.25)",
    caretColor: "var(--accent)",
    overflowWrap: "break-word",
    whiteSpace: "pre-wrap",
    zIndex: 1200,
    cursor: "text",
  };

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      spellCheck
      style={style}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onBlur={commit}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
    />
  );
}

function wrap(tag: string, node: Node): Node {
  const element = document.createElement(tag);
  element.appendChild(node);
  return element;
}
