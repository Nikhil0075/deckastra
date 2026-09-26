"use client";

import { useMemo, useState } from "react";
import type { PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import type { TextMeasurer } from "@deckastra/renderer";

import { fixAllOperations, fixOperations, safeFixes, type DesignFinding, type FindingFix } from "../lib/design-check";
import { pptxFidelity } from "../lib/export-fidelity";
import { readingOrder } from "../lib/accessibility";
import { Button, Segmented, StatusChip } from "../ui";

/**
 * Design Check (design review, 2026-09-27): what on this slide, or this deck,
 * an author would want to fix before presenting it, with the fix one press
 * away. Each fix is one patch and undoes like any other edit; "Fix all" is one
 * patch too.
 */
export function DesignCheckPanel({
  document,
  slideId,
  findings,
  apply,
  onSelect,
  measurer,
}: {
  document: PresentationDocument;
  slideId?: string;
  findings: readonly DesignFinding[];
  apply: (operations: PatchOperation[], label: string) => void;
  onSelect: (slideId: string, elementId?: string) => void;
  /** The canvas's measurer, so "Make the box taller" sizes to what is drawn. */
  measurer?: TextMeasurer;
}) {
  const [scope, setScope] = useState<"slide" | "deck">("slide");
  const slideIndex = new Map(document.slides.map((slide, index) => [slide.id, index]));
  const shown = scope === "slide" ? findings.filter((finding) => finding.slideId === slideId && finding.code !== "THEME") : findings;
  const fixable = safeFixes(shown);
  const currentSlide = document.slides.find((slide) => slide.id === slideId);
  const order = currentSlide ? readingOrder(currentSlide.elements) : [];

  const run = (fixes: readonly FindingFix[], label: string) => {
    const operations = fixOperations(document, fixes, measurer);
    if (operations.length) apply(operations, label);
  };

  return (
    <section aria-label="Design check" className="dk-a11y dk-check" data-testid="design-check">
      <div className="dk-a11y__head">
        <span className="dk-check__summary" role="status">
          {shown.length === 0 ? "Nothing to fix" : `${shown.length} ${shown.length === 1 ? "issue" : "issues"}`}
          {fixable.length ? ` · ${fixable.length} can be fixed automatically` : ""}
        </span>
        <StatusChip tone={shown.some((f) => f.severity === "error") ? "danger" : shown.length ? "waiting" : "neutral"} aria-hidden="true">
          {shown.length}
        </StatusChip>
      </div>
      <Segmented
        label="Check"
        size="sm"
        value={scope}
        onChange={setScope}
        items={[
          { value: "slide", label: "This slide" },
          { value: "deck", label: `Whole deck (${findings.length})` },
        ]}
      />

      {shown.length === 0 ? (
        <p className="dk-muted">
          {scope === "slide"
            ? "No overlaps, overflowing or tiny text, low contrast or missing descriptions on this slide."
            : "No issues anywhere in the deck."}
        </p>
      ) : (
        <ul className="dk-a11y__list" aria-label="Issues">
          {shown.map((finding) => (
            <li key={finding.key} className={`dk-check__item dk-check__item--${finding.severity}`} data-code={finding.code}>
              <button type="button" className="dk-check__show" onClick={() => onSelect(finding.slideId, finding.elementId)}>
                <span className="dk-check__title">
                  {finding.title}
                  {scope === "deck" && finding.code !== "THEME" ? <span className="dk-muted"> · Slide {(slideIndex.get(finding.slideId) ?? 0) + 1}</span> : null}
                </span>
                <span className="dk-check__message">{finding.message}</span>
              </button>
              {finding.fix || finding.alternative ? (
                <span className="dk-check__actions">
                  {finding.fix ? (
                    <Button size="sm" variant="primary" onClick={() => run([finding.fix!], finding.fix!.label)} data-testid="check-fix">
                      {finding.fix.label}
                    </Button>
                  ) : null}
                  {finding.alternative ? (
                    <Button size="sm" onClick={() => run([finding.alternative!], finding.alternative!.label)}>
                      {finding.alternative.label}
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {fixable.length > 1 ? (
        <Button
          variant="primary"
          icon="check"
          onClick={() => {
            const operations = fixAllOperations(document, shown, measurer);
            if (operations.length) apply(operations, `Fix ${fixable.length} issues`);
          }}
          data-testid="check-fix-all"
        >
          Fix {fixable.length} {scope === "slide" ? "on this slide" : "in the deck"}
        </Button>
      ) : null}

      {currentSlide ? <PowerPointReadiness elements={currentSlide.elements} /> : null}

      {currentSlide ? (
        <details className="dk-a11y__order">
          <summary className="dk-export__summary">Reading order · {order.length} objects</summary>
          {order.length ? (
            <ol aria-label="Current slide reading order" className="dk-a11y__list">
              {order.map((element) => (
                <li key={element.id}>
                  <button type="button" className="dk-a11y__object" onClick={() => onSelect(currentSlide.id, element.id)}>
                    {labelFor(element)}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="dk-muted">This slide has no meaningful objects.</p>
          )}
        </details>
      ) : null}
    </section>
  );
}

/** What the objects on this slide become in PowerPoint, only where that is not "the same thing". */
function PowerPointReadiness({ elements }: { elements: readonly PresentationElement[] }) {
  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    const visit = (list: readonly PresentationElement[]) => {
      for (const element of list) {
        counts.set(element.type, (counts.get(element.type) ?? 0) + 1);
        const children = (element as { children?: PresentationElement[] }).children;
        if (Array.isArray(children)) visit(children);
      }
    };
    visit(elements);
    return [...counts].map(([kind, count]) => ({ kind, count, row: pptxFidelity(kind) })).filter(({ row }) => row.fidelity !== "native");
  }, [elements]);

  return (
    <div className="dk-check__pptx" aria-label="In PowerPoint">
      <h4 className="dk-label">In PowerPoint</h4>
      {kinds.length === 0 ? (
        <p className="dk-muted">Everything on this slide arrives as native, editable PowerPoint objects.</p>
      ) : (
        <ul className="dk-a11y__list">
          {kinds.map(({ kind, count, row }) => (
            <li key={kind} className="dk-check__pptxrow">
              <StatusChip tone={row.fidelity === "placeholder" ? "danger" : "waiting"}>{row.label}</StatusChip>
              <span>
                {count} {kind}
                {count === 1 ? "" : "s"}: {row.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function labelFor(element: PresentationElement): string {
  return element.name?.trim() || `${element.type} ${element.id.slice(3, 11)}`;
}
