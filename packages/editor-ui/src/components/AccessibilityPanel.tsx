"use client";

import { useMemo } from "react";
import type { PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { auditAccessibility, readingOrder } from "../lib/accessibility";
import { StatusChip } from "../ui";

export function AccessibilityPanel({
  document,
  slideId,
  onSelect,
}: {
  document: PresentationDocument;
  slideId?: string;
  onSelect: (slideId: string, elementId?: string) => void;
}) {
  const issues = useMemo(() => auditAccessibility(document), [document]);
  const currentSlide = document.slides.find((slide) => slide.id === slideId);
  const order = currentSlide ? readingOrder(currentSlide.elements) : [];

  return (
    <section aria-label="Accessibility review" className="dk-a11y">
      <div className="dk-a11y__head">
        <h3 className="dk-label dk-export__heading">Accessibility</h3>
        <StatusChip tone={issues.length ? "danger" : "neutral"} aria-label={`${issues.length} accessibility issues`}>{issues.length}</StatusChip>
      </div>

      {issues.length === 0 ? (
        <p role="status" className="dk-muted">No automated accessibility issues found.</p>
      ) : (
        <ul className="dk-a11y__list">
          {issues.map((issue, index) => (
            <li key={`${issue.code}:${issue.slideId ?? "deck"}:${issue.elementId ?? index}`}>
              <button
                type="button"
                className="dk-a11y__issue"
                onClick={() => issue.slideId && onSelect(issue.slideId, issue.elementId)}
                disabled={!issue.slideId}
              >
                <span className="dk-a11y__severity">Error</span>
                <span>{issue.message}</span>
                <span className="dk-muted">{issue.fix}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {currentSlide ? (
        <details className="dk-a11y__order">
          <summary className="dk-export__summary">
            Reading order · {order.length} objects
          </summary>
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
          ) : <p className="dk-muted">This slide has no meaningful objects.</p>}
        </details>
      ) : null}
    </section>
  );
}

function labelFor(element: PresentationElement): string {
  return element.name?.trim() || `${element.type} ${element.id.slice(3, 11)}`;
}

