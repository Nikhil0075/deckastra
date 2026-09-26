import { useEffect, useRef, useState } from "react";
import type { EquationElement, PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { EQUATION_MAX_LENGTH } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";
import { typesetEquation } from "@deckastra/renderer";

import { Button, NumberField, Section, Segmented, TextField } from "../../ui";
import { ColorField, Hint } from "./controls";

/**
 * An equation's source and look (Design tab review, 2026-09-26).
 *
 * The LaTeX is a draft while it is being typed, with a live preview beside it,
 * and is committed once per intent — on blur, or Ctrl+Enter — so a formula typed
 * in forty keystrokes is one undo step rather than forty, and a half-typed
 * `\frac{` never reaches the slide. The templates and symbols insert at the
 * caret into that draft, for someone who knows what a fraction looks like but
 * not what LaTeX calls one.
 */

type Edit = (operations: PatchOperation[], label: string, coalesceKey?: string) => void;

const TEMPLATES: { label: string; latex: string; caret: number }[] = [
  { label: "Fraction", latex: "\\frac{}{}", caret: 6 },
  { label: "Square root", latex: "\\sqrt{}", caret: 6 },
  { label: "Power", latex: "^{}", caret: 2 },
  { label: "Subscript", latex: "_{}", caret: 2 },
  { label: "Sum", latex: "\\sum_{i=1}^{n} ", caret: 15 },
  { label: "Integral", latex: "\\int_{a}^{b} \\, dx", caret: 13 },
  { label: "Limit", latex: "\\lim_{x \\to \\infty} ", caret: 20 },
  { label: "Matrix", latex: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", caret: 16 },
  { label: "Cases", latex: "\\begin{cases} a & x > 0 \\\\ b & x \\le 0 \\end{cases}", caret: 14 },
];

const SYMBOLS: { shown: string; latex: string }[] = [
  { shown: "α", latex: "\\alpha " },
  { shown: "β", latex: "\\beta " },
  { shown: "γ", latex: "\\gamma " },
  { shown: "δ", latex: "\\delta " },
  { shown: "θ", latex: "\\theta " },
  { shown: "λ", latex: "\\lambda " },
  { shown: "μ", latex: "\\mu " },
  { shown: "π", latex: "\\pi " },
  { shown: "σ", latex: "\\sigma " },
  { shown: "Σ", latex: "\\Sigma " },
  { shown: "Ω", latex: "\\Omega " },
  { shown: "∞", latex: "\\infty " },
  { shown: "±", latex: "\\pm " },
  { shown: "×", latex: "\\times " },
  { shown: "÷", latex: "\\div " },
  { shown: "≤", latex: "\\le " },
  { shown: "≥", latex: "\\ge " },
  { shown: "≠", latex: "\\ne " },
  { shown: "≈", latex: "\\approx " },
  { shown: "→", latex: "\\to " },
  { shown: "∂", latex: "\\partial " },
  { shown: "∇", latex: "\\nabla " },
  { shown: "∈", latex: "\\in " },
  { shown: "·", latex: "\\cdot " },
];

export function EquationSection({
  document,
  element,
  edit,
  disabled,
}: {
  document: PresentationDocument;
  element: EquationElement;
  edit: Edit;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(element.latex);
  const field = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(element.latex);

  // A change from elsewhere (undo, an agent) replaces the draft; the field's own
  // commit does not, or the caret would jump on every save.
  useEffect(() => {
    if (element.latex !== committed.current) {
      committed.current = element.latex;
      setDraft(element.latex);
    }
  }, [element.latex]);

  const set = (property: string, value: unknown, label: string) =>
    edit(setPropertyDeep(document, element.id, property, value), label, `inspector:${element.id}:${property}`);

  const commit = (value = draft) => {
    if (value === element.latex) return;
    committed.current = value;
    set("latex", value, "Edit equation");
  };

  const insert = (latex: string, caret = latex.length) => {
    const input = field.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    const next = (draft.slice(0, start) + latex + draft.slice(end)).slice(0, EQUATION_MAX_LENGTH);
    setDraft(next);
    // Back into the field with the caret inside the braces just inserted, so the
    // next thing typed fills them.
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + caret, start + caret);
    });
  };

  const preview = typesetEquation(draft, element.display ?? true);

  return (
    <Section title="Equation" defaultOpen>
      <label className="dk-label" htmlFor={`latex-${element.id}`}>
        LaTeX
      </label>
      <textarea
        id={`latex-${element.id}`}
        ref={field}
        className="dk-input dk-textarea dk-equation__source"
        data-testid="equation-latex"
        value={draft}
        rows={3}
        spellCheck={false}
        maxLength={EQUATION_MAX_LENGTH}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit();
          }
        }}
      />
      <div
        className="dk-equation__preview"
        data-testid="equation-preview"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: preview.html }}
      />
      {preview.error ? (
        <span className="dk-field__hint dk-field__hint--error" role="status" data-testid="equation-error">
          {preview.error}
        </span>
      ) : (
        <Hint>Ctrl+Enter or leaving the field puts it on the slide.</Hint>
      )}

      <span className="dk-label">Insert</span>
      <div className="dk-equation__templates" role="group" aria-label="Insert a structure">
        {TEMPLATES.map((template) => (
          <Button
            key={template.label}
            size="sm"
            disabled={disabled}
            // Keeps the caret where it was: a pressed button would take focus.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insert(template.latex, template.caret)}
          >
            {template.label}
          </Button>
        ))}
      </div>
      <div className="dk-equation__symbols" role="group" aria-label="Insert a symbol">
        {SYMBOLS.map((symbol) => (
          <button
            key={symbol.latex}
            type="button"
            className="dk-equation__symbol"
            aria-label={`Insert ${symbol.latex.trim()}`}
            title={symbol.latex.trim()}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insert(symbol.latex)}
          >
            {symbol.shown}
          </button>
        ))}
      </div>

      <Segmented
        label="Equation style"
        size="sm"
        value={element.display === false ? "inline" : "display"}
        onChange={(value) => set("display", value === "inline" ? false : undefined, "Change equation style")}
        items={[
          { value: "display", label: "Display", disabled },
          { value: "inline", label: "Inline", disabled },
        ]}
      />
      <div className="dk-grid2">
        <NumberField
          label="Size"
          ariaLabel="Equation size"
          unit="px"
          value={element.fontSize ?? themeBodySize(document)}
          min={8}
          max={400}
          disabled={disabled}
          onCommit={(value) => set("fontSize", value, "Resize equation")}
        />
      </div>
      <ColorField
        label="Colour"
        value={element.color}
        theme={document.theme}
        disabled={disabled}
        data-testid="equation-color"
        onChange={(value) => set("color", value, "Change equation colour")}
      />
      <Segmented
        label="Equation alignment"
        size="sm"
        value={element.align ?? "center"}
        onChange={(value) => set("align", value === "center" ? undefined : value, "Align equation")}
        items={[
          { value: "left", label: "Left", disabled },
          { value: "center", label: "Centre", disabled },
          { value: "right", label: "Right", disabled },
        ]}
      />
      <TextField
        label="Description"
        value={typeof element.altText === "string" ? element.altText : ""}
        placeholder="In words, for PowerPoint and search"
        disabled={disabled}
        onChange={(value) => set("altText", value || undefined, "Describe equation")}
      />
    </Section>
  );
}

/** The size an equation with none of its own draws at: the theme's body size. */
function themeBodySize(document: PresentationDocument): number {
  const body = (document.theme.typography as unknown as Record<string, { fontSize?: unknown } | undefined>).body;
  return typeof body?.fontSize === "number" ? body.fontSize : 32;
}
