import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { indentLess, indentMore } from "@codemirror/commands";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter } from "@codemirror/lint";
import { EditorState, Prec } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { EditorView, keymap } from "@codemirror/view";
import { jsonSchemaAssist } from "./json-schema-assist";

/**
 * Syntax colours as the app's own tokens, by class (`shell.css`). CodeMirror's
 * default palette is for a white page: its dark red strings measured 2.1:1 on
 * the dark theme's surface, which the accessibility audit refused. Classes
 * rather than colours, because the palette gate allows no colour literal.
 */
const TOKEN_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.propertyName, class: "dk-tok-key" },
  { tag: tags.string, class: "dk-tok-string" },
  { tag: [tags.number, tags.bool, tags.null], class: "dk-tok-literal" },
  { tag: [tags.punctuation, tags.brace, tags.squareBracket, tags.separator], class: "dk-tok-punct" },
  { tag: tags.invalid, class: "dk-tok-invalid" },
]);

export interface JsonCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onApply: () => void;
  disabled?: boolean;
  schema?: Record<string, unknown>;
}

/**
 * CodeMirror is kept behind this small controlled adapter. Text undo belongs to
 * CodeMirror; document undo only begins when CodePanel calls editor.apply.
 */
export function JsonCodeEditor({ value, onChange, onApply, disabled = false, schema }: JsonCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onApplyRef = useRef(onApply);
  const syncingRef = useRef(false);

  onChangeRef.current = onChange;
  onApplyRef.current = onApply;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          // Above basicSetup's default style, which would otherwise win.
          Prec.high(syntaxHighlighting(TOKEN_HIGHLIGHT)),
          json(),
          linter(jsonParseLinter()),
          ...(schema ? jsonSchemaAssist(schema) : []),
          EditorView.contentAttributes.of({
            "aria-label": "Editable canonical JSON",
            "aria-keyshortcuts": "Control+Enter Meta+Enter",
            spellcheck: "false",
            autocapitalize: "off",
            autocomplete: "off",
          }),
          EditorState.readOnly.of(disabled),
          // basicSetup also binds Ctrl+Enter. This command is the product's
          // explicit Apply gesture, so it must win before standard bindings.
          Prec.highest(keymap.of([
            { key: "Mod-Enter", run: () => (onApplyRef.current(), true) },
            { key: "Mod-]", run: indentMore },
            { key: "Mod-[", run: indentLess },
          ])),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncingRef.current) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    // A read-only editor has no focusable content, which leaves its scroll area
    // out of reach of a keyboard (WCAG 2.1.1). The scroller takes focus then.
    if (disabled) {
      view.scrollDOM.tabIndex = 0;
      view.scrollDOM.setAttribute("aria-label", "Canonical JSON, read only");
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Recreating CodeMirror on every keystroke would discard its text history.
    // Props that need to change are synchronized through refs and transactions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    syncingRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    syncingRef.current = false;
  }, [value]);

  return <div ref={hostRef} className="dk-code-editor" data-testid="code-json" />;
}
