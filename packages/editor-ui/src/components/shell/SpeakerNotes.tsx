import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RichTextDocument } from "@deckastra/presentation-schema";
import { plainTextToRichText, readEditable, richTextToPlain, sanitizePastedHtml, textChanged } from "@deckastra/editor";

import {
  notesDocument,
  notesEditOperations,
  notesHaveUnsupportedFormatting,
  notesPlainText,
  renderNotes,
} from "../../lib/notes-rich";
import { speakingEstimate } from "../../lib/slide-actions";
import { insertRichText } from "../../lib/rich-dom";
import type { EditorApi } from "../../lib/useEditor";
import { IconButton } from "../../ui";
import type { IconName } from "../../ui/icons";

/** Idle time after the last keystroke before a draft is committed. */
const COMMIT_AFTER_MS = 700;

/** The formatting the field offers, each a browser editing command on the current selection. */
const FORMATS: ReadonlyArray<{ command: string; icon: IconName; label: string; shortcut?: string }> = [
  { command: "bold", icon: "bold", label: "Bold", shortcut: "Ctrl+B" },
  { command: "italic", icon: "italic", label: "Italic", shortcut: "Ctrl+I" },
  { command: "underline", icon: "underline", label: "Underline", shortcut: "Ctrl+U" },
  { command: "insertUnorderedList", icon: "listBullet", label: "Bulleted list" },
  { command: "insertOrderedList", icon: "listNumbered", label: "Numbered list" },
];

/**
 * Speaker notes for the current slide, under the canvas (Figma: "speaker notes
 * editing" — SPEAKER NOTES, "Slide 1 · about 45 seconds", a character count).
 *
 * Rich text, on the canvas text editor's contract (audit P2, 2026-09-19; the
 * model is `lib/notes-rich.ts`):
 *
 * - **The DOM is never the document.** The person types into a browser-owned
 *   tree; a commit reads it back with `readEditable` and hands a patch to
 *   `editor.apply`. Nothing writes the document from the editable.
 * - **An IME composition defers the commit.** Committing mid-composition writes
 *   half a character — for Japanese, Chinese or Korean, every word.
 * - **Paste is the allowlist**: `sanitizePastedHtml` keeps blocks, the schema's
 *   marks and safe links, and nothing else reaches the field.
 * - **One undo step per editing session**, via a coalesce key, and a pending
 *   draft is committed to the slide it was written on before the slide changes.
 *
 * Formatting uses the browser's own editing commands (`execCommand`). They are
 * deprecated in name and still the only way to toggle a mark on a live
 * selection in a contenteditable, and what they produce (`<b>`, `<ul><li>`) is
 * exactly what `readEditable` reads — the output is re-read and re-validated,
 * so the browser's choice of markup never reaches the document as markup.
 *
 * An outside change (undo, an agent's edit) replaces the field only when there
 * is nothing unsaved in it, the same rule the head watcher follows.
 */
export function SpeakerNotes({ editor }: { editor: EditorApi }) {
  const id = useId();
  const slide = editor.document.slides[editor.slideIndex];
  const slideId = slide?.id;
  const stored = slide?.speakerNotes;
  const storedKey = JSON.stringify(stored ?? null);
  const [text, setText] = useState(() => notesPlainText(stored));
  const [marks, setMarks] = useState<Record<string, boolean>>({});

  const host = useRef<HTMLDivElement | null>(null);
  const dirty = useRef(false);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which slide the field is showing, and so which slide a pending edit
  // belongs to. Read at commit time, including from the slide-change cleanup,
  // when the field still holds the old slide's words.
  const shown = useRef<string | undefined>(undefined);
  // The field as last read, taken on every edit. A commit uses this rather
  // than reading the element, because the element is gone by the time a
  // collapse or an unmount runs its cleanup.
  const draft = useRef<RichTextDocument | null>(null);
  // Always the latest editor, so a commit from a timer or cleanup does not
  // apply against a stale document.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const seed = useCallback((notes: typeof stored) => {
    const element = host.current;
    if (!element) return;
    // No notes means an empty field, so its placeholder shows.
    element.replaceChildren(...(notes === undefined ? [] : [renderNotes(document, notesDocument(notes))]));
    setText(notesPlainText(notes));
  }, []);

  // The field as it was when an IME composition began. A close during one
  // commits this — the words before the composition — never half a character.
  const beforeComposition = useRef<RichTextDocument | null>(null);

  const commit = useCallback((duringComposition: "wait" | "use-before" = "wait") => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const target = shown.current;
    let next = draft.current;
    if (composing.current) {
      if (duringComposition === "wait") return;
      next = beforeComposition.current;
    }
    if (!next || !target) return;
    draft.current = null;
    dirty.current = false;
    const current = editorRef.current;
    const operations = notesEditOperations(current.document, target, next);
    if (operations.length === 0) return;
    current.apply(operations, { label: "Edit speaker notes", coalesceKey: `notes:${target}` });
  }, []);

  // Hand the draft over whenever the editor saves or the window closes, so
  // neither depends on the field having been blurred first (item 01).
  const { registerDraft } = editor;
  useEffect(() => registerDraft(() => commit("use-before")), [registerDraft, commit]);

  const schedule = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(commit, COMMIT_AFTER_MS);
  }, [commit]);

  /** Something in the field changed: typing, a format, a paste. */
  const edited = useCallback(() => {
    const element = host.current;
    if (!element) return;
    dirty.current = true;
    draft.current = readEditable(element);
    setText(richTextToPlain(draft.current));
    if (!composing.current) schedule();
  }, [schedule]);

  // Slide change (or unmount, which is also the dock being put away): commit what was
  // written to the slide it was written on, then show the new slide's notes.
  useEffect(() => {
    shown.current = slideId;
    dirty.current = false;
    draft.current = null;
    seed(editorRef.current.document.slides.find((candidate) => candidate.id === slideId)?.speakerNotes);
    return () => {
      composing.current = false;
      commit();
    };
    // `stored` is deliberately not a dependency: it is read when the slide
    // changes, and outside edits to the same slide are the next effect's job.
  }, [slideId, commit, seed]);

  // Outside change to this slide's notes: adopt it only if nothing is unsaved,
  // and only if the field shows something different. The field's own commit
  // changes `stored` too, and re-seeding then would throw the caret to the start
  // of the notes every time a pause in typing committed.
  useEffect(() => {
    const element = host.current;
    if (dirty.current || !element) return;
    if (!textChanged(readEditable(element), notesDocument(stored)) && element.childNodes.length > 0) return;
    seed(stored);
    // `storedKey` stands for `stored`, which is a fresh object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey, seed]);

  // Which marks the caret is in, so the toolbar's toggles say what is on.
  useEffect(() => {
    const update = () => {
      if (!host.current || !host.current.contains(document.getSelection()?.anchorNode ?? null)) return;
      const next: Record<string, boolean> = {};
      for (const format of FORMATS) {
        try {
          next[format.command] = document.queryCommandState(format.command);
        } catch {
          next[format.command] = false;
        }
      }
      setMarks(next);
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const format = (command: string) => {
    const element = host.current;
    if (!element) return;
    // Focus first: a toolbar button reached by Tab has taken focus, and the
    // editing command acts on the focused editable's selection.
    element.focus();
    try {
      document.execCommand(command);
    } catch {
      return;
    }
    // Chromium fires `input` for the command; this covers engines that do not.
    edited();
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const html = event.clipboardData.getData("text/html");
    const plain = event.clipboardData.getData("text/plain");
    const parsed = html
      ? sanitizePastedHtml(html, (markup) => {
          // A detached element: the markup is parsed but never connected, so
          // nothing in it can load, run or observe anything.
          const scratch = document.createElement("div");
          scratch.innerHTML = markup;
          return scratch;
        })
      : plainTextToRichText(plain);

    const element = host.current;
    if (!element) return;
    insertRichText(element, parsed);
    edited();
  };

  if (!slide) return null;

  const unsupported = notesHaveUnsupportedFormatting(slide.speakerNotes);
  const characters = text.length;

  return (
    // The dock (Dock.tsx) owns the tab name and the collapse. This is the
    // field and its toolbar; putting the dock away unmounts it, and the
    // unmount commits the draft.
    <section className="dk-notes" aria-labelledby={`${id}-title`}>
      <span className="dk-visually-hidden" id={`${id}-title`}>
        Speaker notes
      </span>
      <div className="dk-notes__body">
          <div className="dk-notes__tools" role="toolbar" aria-label="Format speaker notes">
            {FORMATS.map((item) => (
              <IconButton
                key={item.command}
                icon={item.icon}
                label={item.label}
                shortcut={item.shortcut}
                size="sm"
                pressed={Boolean(marks[item.command])}
                // Keeps the selection in the field for a pointer press.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => format(item.command)}
                data-testid={`notes-${item.command}`}
              />
            ))}
          </div>
          <div
            ref={host}
            className="dk-notes__input dk-scroll"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-labelledby={`${id}-title`}
            data-placeholder="What to say on this slide. Only you see these, in the presenter view."
            spellCheck
            data-testid="speaker-notes"
            onInput={() => {
              if (!composing.current) edited();
            }}
            onCompositionStart={() => {
              // What is committed if the window closes mid-composition.
              beforeComposition.current = draft.current ?? (host.current ? readEditable(host.current) : null);
              composing.current = true;
              if (timer.current !== null) clearTimeout(timer.current);
            }}
            onCompositionEnd={() => {
              composing.current = false;
              edited();
            }}
            onPaste={onPaste}
            onBlur={() => commit()}
          />
          <footer className="dk-notes__foot">
            {unsupported ? (
              <span className="dk-notes__warning">
                Some formatting here (a colour, a highlight, superscript) cannot be shown in this field and is removed
                if you edit these notes.
              </span>
            ) : (
              <span />
            )}
            <span>
              Slide {editor.slideIndex + 1} · {speakingEstimate(text)} · {characters} character{characters === 1 ? "" : "s"}
            </span>
          </footer>
      </div>
    </section>
  );
}
