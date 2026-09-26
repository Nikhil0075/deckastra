"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { RichTextDocument, TypographyStyle } from "@deckastra/presentation-schema";
import {
  plainTextToRichText,
  preserveBlockStyles,
  readEditable,
  sanitizePastedHtml,
  textChanged,
} from "@deckastra/editor";
import { insertRichText, renderRichText } from "../lib/rich-dom";
import { useColorStudio } from "../lib/color-studio";
import { THEME_COLOR_ROLES, deckColors, namedColors, resolveColorValue, themeColorToken } from "../lib/colors";

/**
 * In-place text editing (doc 04 §17).
 *
 * A `contenteditable` positioned exactly over the rendered element and styled to
 * match it, so the text does not jump when editing starts. The rendered element
 * is hidden while this is up; anything else double-renders the glyphs.
 *
 * Things here that are not incidental:
 *
 * - **The DOM is never treated as the document.** The user's keystrokes go into
 *   a browser-owned tree; on commit that tree is read back into blocks and spans
 *   and handed to the caller as a patch. There is no path where the editable
 *   writes the document directly (doc 05 §10).
 * - **Composition is respected, on every exit.** An IME holds partial text in
 *   the DOM for the duration of a composition. A blur during one used to commit
 *   straight away, writing half a character (MA-10). Now a blur waits for the
 *   composition to end and commits the finished word; anything that cannot wait
 *   — a save, a close, the editor unmounting — commits the text as it was when
 *   the composition began.
 * - **The draft belongs to the save barrier.** Words typed here are in no
 *   document until they commit, so the editor registers the field with
 *   `registerDraft`: saving, exporting and closing hand the draft over without
 *   depending on a blur that a close never sends (MA-11).
 * - **Paste is sanitized, always, and keeps what the allowlist keeps.** Pasted
 *   HTML is content someone else wrote. It is parsed detached, read for blocks
 *   and marks, and re-rendered from text nodes — so bold survives a paste and a
 *   script never does (MA-09).
 * - **It sits where the text is drawn**, rotation and group transforms included
 *   (MA-12): the editable takes the element's composed world matrix, the same
 *   one the renderer puts on the element's box.
 */

export interface TextEditorProps {
  /** The document being edited. Read once on mount; the DOM owns it after that. */
  value: RichTextDocument;
  typography: TypographyStyle;
  /**
   * The rendered text's axis-aligned box, in CSS pixels already scaled for the
   * canvas. Used for placement when no `matrix` is given, and for the toolbar.
   */
  rect: { x: number; y: number; width: number; height: number };
  /**
   * The element's own box and composed world transform, in slide units. When
   * present the editable is laid out in the element's local space and carried
   * by the same matrix the renderer uses, so a rotated text box is edited
   * rotated rather than as an axis-aligned rectangle somewhere near it.
   */
  local?: { width: number; height: number; matrix: { a: number; b: number; c: number; d: number; e: number; f: number } };
  scale: number;
  align?: string;
  verticalAlign?: string;
  padding?: { top: number; right: number; bottom: number; left: number };
  /** Called with the edited document when it actually changed. */
  onCommit: (next: RichTextDocument) => void;
  onCancel: () => void;
  /** The editor's draft registry (`useEditor.registerDraft`). */
  registerDraft?: (flush: () => void) => () => void;
}

type CommitMode = "wait" | "use-before";

export function TextEditor({
  value,
  typography,
  rect,
  local,
  scale,
  align,
  verticalAlign,
  padding,
  onCommit,
  onCancel,
  registerDraft,
}: TextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const studio = useColorStudio();
  const resolveColor = (color: string) => (studio ? resolveColorValue(studio.document, color) : undefined);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The element, kept past unmount: React clears `ref` before the unmount
  // cleanup runs, and that cleanup is exactly when the words must be read.
  const hostElement = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  /** The field as it was when the current composition began. */
  const beforeComposition = useRef<RichTextDocument | null>(null);
  /** A blur arrived mid-composition; commit when it ends. */
  const blurPending = useRef(false);
  const original = useRef(value);
  const committed = useRef(false);
  // The latest callbacks, for the paths that run outside a render (unmount, a
  // draft flush from the save barrier).
  const callbacks = useRef({ onCommit, onCancel });
  callbacks.current = { onCommit, onCancel };

  // Seed the editable once. Re-seeding on every render would move the caret to
  // the start on each keystroke.
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    hostElement.current = host;

    host.replaceChildren(renderRichText(document, value, { inheritTypography: true, resolveColor }));
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

  /** What the field holds now, or what it held before a composition in progress. */
  const read = useCallback((mode: CommitMode): RichTextDocument | null => {
    const host = ref.current ?? hostElement.current;
    if (composing.current) {
      if (mode === "wait") return null;
      return beforeComposition.current ?? original.current;
    }
    if (!host) return null;
    return withOriginalIds(original.current, preserveBlockStyles(original.current, readEditable(host)));
  }, []);

  const commit = useCallback(
    (mode: CommitMode = "wait") => {
      if (committed.current) return;
      const next = read(mode);
      if (!next) {
        // Mid-composition and able to wait: the blur is honoured once the
        // composition ends, with the finished word.
        if (composing.current) blurPending.current = true;
        return;
      }
      committed.current = true;
      // An unchanged edit produces no transaction. Otherwise clicking into a
      // text box and out again fills the history with entries that undo nothing.
      if (textChanged(original.current, next)) callbacks.current.onCommit(next);
      else callbacks.current.onCancel();
    },
    [read],
  );

  // The save barrier and a close hand the draft over through here.
  useEffect(() => registerDraft?.(() => commit("use-before")), [registerDraft, commit]);

  // Unmounting without a commit — the slide changed, the mode changed, the
  // editor left the deck — still keeps the words. Only a real change commits:
  // React's development double-mount runs this cleanup with nothing typed, and
  // cancelling there would close the editor the moment it opened.
  useEffect(
    () => () => {
      if (committed.current) return;
      const next = read("use-before");
      if (next && textChanged(original.current, next)) {
        committed.current = true;
        callbacks.current.onCommit(next);
      }
    },
    [read],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // While an IME is composing, Enter and Escape belong to the IME.
      if (composing.current || event.nativeEvent.isComposing) return;

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

      // Formatting keys are the field's own; the canvas must not see them.
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        const command = key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null;
        if (command) {
          event.preventDefault();
          format(command);
        }
      }

      // Everything else is typing, and must not reach the canvas's shortcuts:
      // Delete would remove the element the user is typing into.
      event.stopPropagation();
    },
    [commit, onCancel],
  );

  const onPaste = useCallback((event: React.ClipboardEvent) => {
    event.preventDefault();
    const host = ref.current;
    if (!host) return;

    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");

    const parsed = html
      ? sanitizePastedHtml(html, (markup) => {
          // A detached element: the markup is parsed but never connected, so
          // nothing in it can load, run or observe anything.
          const scratch = document.createElement("div");
          scratch.innerHTML = markup;
          return scratch;
        })
      : plainTextToRichText(text);

    insertRichText(host, parsed, { inheritTypography: true, resolveColor });
  }, []);

  const matrix = local?.matrix;
  const placement: CSSProperties = matrix && local
    ? {
        left: 0,
        top: 0,
        width: local.width * scale,
        height: local.height * scale,
        // The renderer's own matrix, with the translation carried into canvas
        // pixels; the linear part (rotation, flip) applies as it does to the box.
        transform: `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e * scale}, ${matrix.f * scale})`,
        transformOrigin: "0 0",
      }
    : { left: rect.x, top: rect.y, width: rect.width, height: rect.height };

  const style: CSSProperties = {
    position: "absolute",
    ...placement,
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
    outline: "2px solid var(--dk-blue)",
    outlineOffset: 2,
    background: "rgba(0,0,0,0.25)",
    caretColor: "var(--dk-blue)",
    overflowWrap: "break-word",
    whiteSpace: "pre-wrap",
    zIndex: 1200,
    cursor: "text",
  };

  const format = (command: string) => {
    const host = ref.current;
    if (!host) return;
    // The toolbar never takes focus (pointer-down is prevented), so the
    // selection the command acts on is still the one the author made.
    if (document.activeElement !== host) host.focus();
    try {
      document.execCommand(command);
    } catch {
      // An engine without editing commands leaves the text as it was; the
      // field still commits whatever the author typed.
    }
  };

  /**
   * Colour the selected words (colour wizard, 2026-09-26). The selection is
   * lifted out and put back inside a `data-color` span, which is what
   * `readEditable` reads a run's colour from: a token stays a token, so a named
   * colour on three words follows its name. Colours nested inside the selection
   * are unwrapped first, so the new colour is the one that shows. "Box colour"
   * writes an empty `data-color`, which ends a colour the words sat inside.
   */
  const colorSelection = (color: string) => {
    const host = ref.current;
    const selection = window.getSelection();
    if (!host || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !host.contains(range.commonAncestorContainer)) return;
    const fragment = range.extractContents();
    for (const inner of Array.from(fragment.querySelectorAll("[data-color]"))) inner.replaceWith(...Array.from(inner.childNodes));
    const run = document.createElement("span");
    run.setAttribute("data-color", color);
    const drawn = color ? resolveColor(color) : undefined;
    if (drawn) run.style.color = drawn;
    else if (!color) run.style.color = "inherit";
    run.appendChild(fragment);
    range.insertNode(run);
    const after = document.createRange();
    after.selectNodeContents(run);
    selection.removeAllRanges();
    selection.addRange(after);
  };

  const palette: { name: string; value: string }[] = studio
    ? [
        ...THEME_COLOR_ROLES.filter(
          (role) =>
            ["Text", "Brand", "Status"].includes(role.group) &&
            typeof (studio.document.theme.colors as unknown as Record<string, unknown>)[role.token] === "string",
        ).map((role) => ({ name: role.label, value: themeColorToken(role.token) })),
        ...namedColors(studio.document).map((color) => ({ name: color.name, value: color.token })),
        ...deckColors(studio.document).slice(0, 6).map((color) => ({ name: color.value, value: color.value })),
      ]
    : [];

  return (
    <>
      <div
        className="dk-text-toolbar"
        role="toolbar"
        aria-label="Text formatting"
        data-testid="text-toolbar"
        style={{ position: "absolute", left: rect.x, top: Math.max(0, rect.y - 40), zIndex: 1300 }}
        // Keep focus and the selection in the editable: a toolbar that takes
        // focus blurs the field, which commits and closes the editor.
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onMouseDown={(event) => event.preventDefault()}
      >
        {TOOLBAR.map((item) => (
          <button
            key={item.command}
            type="button"
            className="dk-text-toolbar__button"
            aria-label={item.label}
            title={item.label}
            data-command={item.command}
            tabIndex={-1}
            onClick={() => format(item.command)}
            style={item.style}
          >
            {item.glyph}
          </button>
        ))}
        {palette.length ? (
          <button
            type="button"
            className="dk-text-toolbar__button"
            aria-label="Text colour"
            title="Text colour"
            aria-expanded={paletteOpen}
            data-testid="text-color-button"
            tabIndex={-1}
            onClick={() => setPaletteOpen((open) => !open)}
            style={{ textDecoration: "underline", textDecorationThickness: 3 }}
          >
            A
          </button>
        ) : null}
        {paletteOpen ? (
          <div className="dk-text-toolbar__palette" role="group" aria-label="Text colours" data-testid="text-color-palette">
            <button
              type="button"
              className="dk-swatch dk-swatch--none"
              aria-label="Box colour"
              title="The text box's own colour"
              tabIndex={-1}
              onClick={() => {
                colorSelection("");
                setPaletteOpen(false);
              }}
            />
            {palette.map((option) => (
              <button
                key={option.value}
                type="button"
                className="dk-swatch"
                aria-label={option.name}
                title={option.name}
                tabIndex={-1}
                style={{ background: resolveColor(option.value) }}
                onClick={() => {
                  colorSelection(option.value);
                  setPaletteOpen(false);
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Edit text"
        spellCheck
        style={style}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => commit("wait")}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onCompositionStart={() => {
          const host = ref.current;
          beforeComposition.current = host
            ? withOriginalIds(original.current, preserveBlockStyles(original.current, readEditable(host)))
            : null;
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          beforeComposition.current = null;
          if (blurPending.current) {
            blurPending.current = false;
            commit("wait");
          }
        }}
      />
    </>
  );
}

const TOOLBAR: { command: string; label: string; glyph: string; style?: CSSProperties }[] = [
  { command: "bold", label: "Bold", glyph: "B", style: { fontWeight: 700 } },
  { command: "italic", label: "Italic", glyph: "I", style: { fontStyle: "italic" } },
  { command: "underline", label: "Underline", glyph: "U", style: { textDecoration: "underline" } },
  { command: "insertUnorderedList", label: "Bulleted list", glyph: "•" },
  { command: "insertOrderedList", label: "Numbered list", glyph: "1." },
];

/**
 * Keep each block's id where the block survived.
 *
 * Reading the editable mints fresh ids, so without this every edit renamed
 * every block — a version diff showed the whole text box replaced, and anything
 * keyed on a block id (a binding, a provenance record) lost its target.
 */
function withOriginalIds(before: RichTextDocument, after: RichTextDocument): RichTextDocument {
  const seen = new Set<string>();
  return {
    ...after,
    blocks: after.blocks.map((block, index) => {
      const id = before.blocks[index]?.id;
      if (!id || seen.has(id)) return block;
      seen.add(id);
      return { ...block, id };
    }),
  };
}
